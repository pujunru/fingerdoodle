import { attachInput } from './input.js';
import { History, bounds, boundsOfAll, hit, intersecting, newId, sanitize, topmostAt, translated } from './scene.js';
import { LINE_HEIGHT, drawElement, drawPaper, fontFor } from './render.js';

const STORAGE_KEY = 'fingerdoodle.v1';
const LINE_SIZES = [3, 6, 12];
const TEXT_SIZES = [24, 36, 56];
const COLORS = ['ink', 'red', 'blue', 'green', 'yellow'];
const TOOLS = ['pencil', 'rect', 'ellipse', 'text', 'eraser', 'select', 'hand'];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const FINGER_TOLERANCE = 14;   // screen px around a fingertip when picking things
const MIN_SHAPE = 4;           // screen px; anything smaller was a stray tap
const TRAY_CLEARANCE = 96;
const TOP_CLEARANCE = 72;      // keeps the bubble clear of the pan mode banner

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const sceneCanvas = $('#scene');
const liveCanvas = $('#live');
const sceneCtx = sceneCanvas.getContext('2d', { alpha: false });
const liveCtx = liveCanvas.getContext('2d');
const editor = $('#editor');
const hint = $('#hint');

// Pan is home. Fingers roam the canvas freely, and ink needs a deliberate choice.
const prefs = { tool: 'hand', color: 'ink', size: 1 };
const camera = { x: 0, y: 0, z: 1 };
let history = new History();
let view = { width: innerWidth, height: innerHeight, dpr: 1 };
let colors = {};
let gesture = null;            // what the finger is doing right now
let selection = new Set();     // ids of the selected elements
let editing = null;            // the text box in progress
let hasShift = false;
let spaceHeld = false;         // holding Space borrows pan without leaving the tool

const toWorld = (sx, sy) => ({ x: (sx - camera.x) / camera.z, y: (sy - camera.y) / camera.z });

// ---- rendering -----------------------------------------------------------

let sceneDirty = false, liveDirty = false, frame = 0;

function requestRender({ scene = false, live = false } = {}) {
  sceneDirty ||= scene;
  liveDirty ||= live;
  if (!frame) frame = requestAnimationFrame(render);
}

function render() {
  frame = 0;
  if (sceneDirty) renderScene();
  if (liveDirty) renderLive();
  sceneDirty = liveDirty = false;
}

function applyCamera(ctx) {
  const { dpr } = view;
  ctx.setTransform(dpr * camera.z, 0, 0, dpr * camera.z, dpr * camera.x, dpr * camera.y);
}

function renderScene() {
  const { width, height, dpr } = view;
  sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPaper(sceneCtx, width, height, camera, colors);
  applyCamera(sceneCtx);
  const left = -camera.x / camera.z, top = -camera.y / camera.z;
  const right = left + width / camera.z, bottom = top + height / camera.z;
  const hidden = gesture?.hidden;
  for (const el of history.elements) {
    if (hidden?.has(el.id)) continue;
    const b = bounds(el);
    if (b.x > right || b.y > bottom || b.x + b.w < left || b.y + b.h < top) continue;
    drawElement(sceneCtx, el, colors);
  }
}

function renderLive() {
  const { width, height, dpr } = view;
  liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  liveCtx.clearRect(0, 0, width, height);
  applyCamera(liveCtx);
  if (gesture?.el) drawElement(liveCtx, gesture.el, colors);
  for (const el of gesture?.els ?? []) drawElement(liveCtx, el, colors);
  drawSelection();
}

// Line widths and dashes are divided by the zoom so they stay the same on screen.
function drawSelection() {
  const pad = 6 / camera.z;
  liveCtx.strokeStyle = colors.blue;
  liveCtx.fillStyle = colors.blue;
  liveCtx.lineWidth = 2 / camera.z;
  liveCtx.setLineDash([7 / camera.z, 5 / camera.z]);
  for (const el of gesture?.els ?? selectedElements()) {
    const b = bounds(el);
    liveCtx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  }
  if (gesture?.box) {
    const { x, y, w, h } = gesture.box;
    liveCtx.strokeRect(x, y, w, h);
    liveCtx.globalAlpha = 0.12;
    liveCtx.fillRect(x, y, w, h);
    liveCtx.globalAlpha = 1;
  }
  liveCtx.setLineDash([]);
}

function selectedElements() {
  return history.elements.filter((el) => selection.has(el.id));
}

function isOnSelection(p) {
  const box = boundsOfAll(selectedElements());
  const tolerance = FINGER_TOLERANCE / camera.z;
  return !!box && p.x >= box.x - tolerance && p.x <= box.x + box.w + tolerance
    && p.y >= box.y - tolerance && p.y <= box.y + box.h + tolerance;
}

// ---- the bubble of quick actions -----------------------------------------

function openBubble() {
  const box = boundsOfAll(selectedElements());
  if (!box) return closeBubble();
  const bubble = $('#bubble');
  bubble.hidden = false;
  const { width, height } = bubble.getBoundingClientRect();
  const gap = 14;
  const margin = 8;
  const centre = (box.x + box.w / 2) * camera.z + camera.x;
  const top = box.y * camera.z + camera.y - gap - height;
  const below = (box.y + box.h) * camera.z + camera.y + gap;
  bubble.style.left = `${Math.min(view.width - width - margin, Math.max(margin, centre - width / 2))}px`;
  bubble.style.top = `${top >= TOP_CLEARANCE ? top : Math.min(below, view.height - TRAY_CLEARANCE - height)}px`;
}

function closeBubble() {
  $('#bubble').hidden = true;
}

function duplicateSelection() {
  const offset = 24 / camera.z;
  const copies = selectedElements().map((el) => ({ ...translated(el, offset, offset), id: newId() }));
  history.commit([...history.elements, ...copies]);
  selection = new Set(prefs.tool === 'select' ? copies.map((el) => el.id) : []);
  changed();
  if (selection.size) openBubble();
  else closeBubble();
}

function readColors() {
  const css = getComputedStyle(document.documentElement);
  colors = {};
  for (const name of [...COLORS, 'paper', 'dot']) colors[name] = css.getPropertyValue(`--${name}`).trim();
  requestRender({ scene: true, live: true });
}

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 3);
  view = { width: innerWidth, height: innerHeight, dpr };
  for (const canvas of [sceneCanvas, liveCanvas]) {
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  requestRender({ scene: true, live: true });
}

// ---- turning gestures into drawing ---------------------------------------

function normalizedBox(from, to) {
  let w = to.x - from.x, h = to.y - from.y;
  if (hasShift) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * side;
    h = Math.sign(h || 1) * side;
  }
  return {
    x: Math.min(from.x, from.x + w), y: Math.min(from.y, from.y + h),
    w: Math.abs(w), h: Math.abs(h),
  };
}

function eraseAt(p) {
  const tolerance = FINGER_TOLERANCE / camera.z;
  for (const el of history.elements) {
    if (!gesture.hidden.has(el.id) && hit(el, p.x, p.y, tolerance)) {
      gesture.hidden.add(el.id);
      requestRender({ scene: true });
    }
  }
}

const strokeHandlers = {
  strokeStart(sx, sy) {
    hideHint();
    if (editing) {
      commitEditor();
      gesture = { kind: 'ignored' };
      return;
    }
    closeBubble();
    if (prefs.tool === 'hand' && selection.size) {   // pan mode has no lasting selection
      selection = new Set();
      requestRender({ live: true });
      changedSelection();
    }
    const p = toWorld(sx, sy);
    const size = LINE_SIZES[prefs.size] / camera.z;
    const base = { id: newId(), color: prefs.color, size };
    switch (spaceHeld ? 'hand' : prefs.tool) {
      case 'pencil':
        gesture = { kind: 'draw', el: { ...base, type: 'pencil', points: [[p.x, p.y]] } };
        break;
      case 'rect':
      case 'ellipse':
        gesture = { kind: 'shape', origin: p, el: { ...base, type: prefs.tool, x: p.x, y: p.y, w: 0, h: 0 } };
        break;
      case 'eraser':
        gesture = { kind: 'erase', hidden: new Set() };
        eraseAt(p);
        break;
      case 'select': {
        if (!isOnSelection(p)) {
          const el = topmostAt(history.elements, p.x, p.y, FINGER_TOLERANCE / camera.z, true);
          selection = new Set(el ? [el.id] : []);
        }
        const sources = selectedElements();
        gesture = sources.length
          ? { kind: 'move', sources, els: sources, from: p, hidden: new Set(selection) }
          : { kind: 'marquee', origin: p, box: { x: p.x, y: p.y, w: 0, h: 0 } };
        requestRender({ scene: true });
        break;
      }
      case 'hand':
        gesture = { kind: 'pan', x: sx, y: sy };
        break;
      case 'text':
        gesture = { kind: 'text', start: p, moved: false, sx, sy };
        break;
    }
    requestRender({ live: true });
  },

  strokeMove(sx, sy) {
    if (!gesture) return;
    const p = toWorld(sx, sy);
    switch (gesture.kind) {
      case 'draw':
        gesture.el.points.push([p.x, p.y]);
        break;
      case 'shape':
        gesture.el = { ...gesture.el, ...normalizedBox(gesture.origin, p) };
        break;
      case 'erase':
        eraseAt(p);
        return;
      case 'move':
        gesture.moved = true;
        gesture.els = gesture.sources.map((el) => translated(el, p.x - gesture.from.x, p.y - gesture.from.y));
        break;
      case 'marquee':
        gesture.box = normalizedBox(gesture.origin, p);
        break;
      case 'pan':
        panBy(sx - gesture.x, sy - gesture.y);
        gesture.x = sx;
        gesture.y = sy;
        return;
      case 'text':
        gesture.moved ||= Math.hypot(sx - gesture.sx, sy - gesture.sy) > 10;
        return;
      default:
        return;
    }
    requestRender({ live: true });
  },

  strokeEnd() {
    const g = gesture;
    gesture = null;
    if (!g) return;
    const elements = history.elements;
    switch (g.kind) {
      case 'draw':
        history.commit([...elements, g.el]);
        break;
      case 'shape':
        if (g.el.w * camera.z >= MIN_SHAPE && g.el.h * camera.z >= MIN_SHAPE) {
          history.commit([...elements, g.el]);
        }
        break;
      case 'erase':
        if (g.hidden.size) history.commit(elements.filter((el) => !g.hidden.has(el.id)));
        break;
      case 'move':
        if (g.moved) {
          const moved = new Map(g.els.map((el) => [el.id, el]));
          history.commit(elements.map((el) => moved.get(el.id) ?? el));
        }
        break;
      case 'marquee':
        selection = new Set(intersecting(elements, g.box).map((el) => el.id));
        break;
      case 'ignored':
        break;
      case 'text':
        if (!g.moved) openEditorAt(g.start);
        break;
    }
    changed();
    if (prefs.tool === 'select' && selection.size) openBubble();
  },

  // Only pan and select answer a long press. While drawing, press and hold is how
  // a slow line starts in Chrome.
  longPress(sx, sy) {
    if (spaceHeld || !['hand', 'select'].includes(prefs.tool)) return;
    const p = toWorld(sx, sy);
    if (!isOnSelection(p)) {
      const el = topmostAt(history.elements, p.x, p.y, FINGER_TOLERANCE / camera.z, true);
      if (!el) return;
      selection = new Set([el.id]);
    }
    gesture = { kind: 'ignored' };
    changed();
    openBubble();
  },

  strokeCancel() {
    gesture = null;
    requestRender({ scene: true, live: true });
    syncHint();
  },

  pan(dx, dy) {
    if (editing) commitEditor();
    hideHint();
    panBy(dx, dy);
  },

  zoom(factor, x, y) {
    if (editing) commitEditor();
    hideHint();
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.z * factor));
    const applied = z / camera.z;
    camera.x = x - (x - camera.x) * applied;
    camera.y = y - (y - camera.y) * applied;
    camera.z = z;
    cameraMoved();
  },
};

function panBy(dx, dy) {
  camera.x += dx;
  camera.y += dy;
  cameraMoved();
}

function cameraMoved() {
  closeBubble();
  requestRender({ scene: true, live: true });
  $('#zoom').textContent = `${Math.round(camera.z * 100)}%`;
  scheduleSave();
}

function changed() {
  selection = new Set(selectedElements().map((el) => el.id));   // undo may have removed some
  requestRender({ scene: true, live: true });
  $('#undo').disabled = !history.past.length;
  $('#redo').disabled = !history.future.length;
  const empty = !history.elements.length;
  $('#save').disabled = empty;
  $('#clear').disabled = empty;
  changedSelection();
  syncHint();
  scheduleSave();
}

function changedSelection() {
  const label = selection.size ? 'Delete the selection' : 'Clear the canvas';
  $('#clear').setAttribute('aria-label', label);
  $('#clear').title = selection.size ? `${label} (Delete)` : `${label} (undo brings it back)`;
  if (!selection.size) closeBubble();
}

function hideHint() { hint.classList.add('gone'); }
function syncHint() { hint.classList.toggle('gone', history.elements.length > 0 || !!editing); }

// ---- text ----------------------------------------------------------------

function textMetrics(text, size) {
  liveCtx.save();
  liveCtx.font = fontFor(size);
  const lines = text.split('\n');
  const w = Math.max(...lines.map((line) => liveCtx.measureText(line).width));
  liveCtx.restore();
  return { w, h: lines.length * size * LINE_HEIGHT };
}

function placeEditor() {
  const { el } = editing;
  const screenSize = el.size * camera.z;
  const { w, h } = textMetrics(editor.value || ' ', el.size);
  editor.style.left = `${el.x * camera.z + camera.x}px`;
  editor.style.top = `${el.y * camera.z + camera.y}px`;
  editor.style.fontSize = `${screenSize}px`;
  editor.style.width = `${w * camera.z + screenSize}px`;
  editor.style.height = `${h * camera.z + 4}px`;
  editor.style.color = colors[el.color];
  editor.style.caretColor = colors[el.color];
}

function openEditorAt(p) {
  const existing = topmostAt(history.elements, p.x, p.y, FINGER_TOLERANCE / camera.z);
  if (existing?.type === 'text') {
    openEditor(existing, existing);
    return;
  }
  const size = TEXT_SIZES[prefs.size] / camera.z;
  openEditor({ id: newId(), type: 'text', x: p.x, y: p.y - size * LINE_HEIGHT / 2, w: 0, h: 0, text: '', color: prefs.color, size }, null);
}

function openEditor(el, source) {
  editing = { el, source };
  editor.value = el.text;
  editor.hidden = false;
  placeEditor();
  hideHint();
  if (source) {
    gesture = { kind: 'editing', hidden: new Set([source.id]) };
    requestRender({ scene: true });
  }
  // Waits a tick because Chrome delivers a tap's mouse events all at once, and
  // focus must land after the browser finishes handling them.
  setTimeout(() => editor.focus(), 0);
}

function commitEditor() {
  if (!editing) return;
  const { el, source } = editing;
  const text = editor.value.replace(/\s+$/, '');
  editing = null;
  editor.hidden = true;
  editor.blur();
  if (gesture?.kind === 'editing') gesture = null;
  const elements = history.elements;
  if (text) {
    const next = { ...el, text, ...textMetrics(text, el.size) };
    if (!source || source.text !== text) {
      history.commit(source ? elements.map((e) => (e === source ? next : e)) : [...elements, next]);
    }
  } else if (source) {
    history.commit(elements.filter((e) => e !== source));
  }
  changed();
}

editor.addEventListener('input', placeEditor);
editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    leaveTool();
  } else if (e.key === 'Enter' && e.metaKey) {
    e.preventDefault();
    commitEditor();
  }
});

// ---- view, export, persistence -------------------------------------------

function fitToScreen() {
  const box = boundsOfAll(history.elements);
  if (!box) {
    Object.assign(camera, { x: 0, y: 0, z: 1 });
    return cameraMoved();
  }
  const margin = 48;
  const z = Math.min(
    1,
    (view.width - margin * 2) / Math.max(box.w, 1),
    (view.height - margin * 2 - TRAY_CLEARANCE) / Math.max(box.h, 1),
  );
  camera.z = Math.max(MIN_ZOOM, z);
  camera.x = (view.width - box.w * camera.z) / 2 - box.x * camera.z;
  camera.y = (view.height - TRAY_CLEARANCE - box.h * camera.z) / 2 - box.y * camera.z;
  cameraMoved();
}

function savePng() {
  const box = boundsOfAll(history.elements);
  if (!box) return;
  const pad = 40, scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((box.w + pad * 2) * scale);
  canvas.height = Math.ceil((box.h + pad * 2) * scale);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, (pad - box.x) * scale, (pad - box.y) * scale);
  for (const el of history.elements) drawElement(ctx, el, colors);
  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `fingerdoodle-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  });
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

function save() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ elements: history.elements, camera, prefs }));
  } catch {
    // Private windows and full storage still get a working session, just not a saved one.
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return;
    history = new History(sanitize(saved.elements));
    const { x, y, z } = saved.camera ?? {};
    if ([x, y, z].every(Number.isFinite) && z > 0) Object.assign(camera, { x, y, z });
    if (COLORS.includes(saved.prefs?.color)) prefs.color = saved.prefs.color;
    if (LINE_SIZES[saved.prefs?.size]) prefs.size = saved.prefs.size;
  } catch {
    // Unreadable save data: start with a clean page.
  }
}

// ---- the tray ------------------------------------------------------------

function syncTray() {
  const tool = spaceHeld ? 'hand' : prefs.tool;
  document.body.dataset.cursor = tool;
  document.body.dataset.pan = String(tool === 'hand');
  $('#pan-text').textContent = spaceHeld && prefs.tool !== 'hand'
    ? 'Let go of Space to keep drawing'
    : 'Tap a tool to draw';
  for (const b of $$('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  for (const b of $$('[data-color]')) b.setAttribute('aria-pressed', String(b.dataset.color === prefs.color));
  for (const b of $$('[data-size]')) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === prefs.size));
  const active = $(`[data-tool="${tool}"]`);
  $('#indicator').style.transform = `translateX(${active.offsetLeft}px)`;
  scheduleSave();
}

function setTool(tool) {
  if (editing) commitEditor();
  prefs.tool = tool;
  selection = new Set();
  changed();
  syncTray();
}

// Esc drops whatever is in progress and returns to pan. Text being typed is kept,
// since it took keystrokes to write.
function leaveTool() {
  if (gesture && gesture.kind !== 'editing') {
    gesture = null;
    requestRender({ scene: true, live: true });
  }
  setTool('hand');
}

function undo() {
  if (editing) commitEditor();
  if (history.undo()) changed();
}

function redo() {
  if (editing) commitEditor();
  if (history.redo()) changed();
}

function deleteSelection() {
  history.commit(history.elements.filter((el) => !selection.has(el.id)));
  changed();
}

// The trash button removes the selection when there is one, so that deleting
// never needs the keyboard.
function clearAll() {
  if (editing) commitEditor();
  if (selection.size) {
    deleteSelection();
  } else if (history.elements.length) {
    history.commit([]);
    changed();
  }
}

// Chrome delivers a tap's press and release in the same instant, so CSS :active
// never paints. This gives every tap a visible response anyway.
function pressFeedback(button) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  button.animate(
    [{ transform: 'scale(0.86)' }, { transform: 'scale(1)' }],
    { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

$('#tray').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  pressFeedback(button);
  if (button.dataset.tool) setTool(button.dataset.tool);
  if (button.dataset.color) {
    prefs.color = button.dataset.color;
    if (editing) { editing.el = { ...editing.el, color: prefs.color }; placeEditor(); editor.focus(); }
    syncTray();
  }
  if (button.dataset.size) {
    prefs.size = Number(button.dataset.size);
    if (editing) { editing.el = { ...editing.el, size: TEXT_SIZES[prefs.size] / camera.z }; placeEditor(); editor.focus(); }
    syncTray();
  }
});
$('#bubble').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) pressFeedback(button);
});
$('#bubble-delete').addEventListener('click', deleteSelection);
$('#bubble-duplicate').addEventListener('click', duplicateSelection);
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#clear').addEventListener('click', clearAll);
$('#save').addEventListener('click', savePng);
$('#zoom').addEventListener('click', fitToScreen);

const SHORTCUTS = { p: 'pencil', r: 'rect', c: 'ellipse', o: 'ellipse', t: 'text', e: 'eraser', v: 'select', h: 'hand' };

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') hasShift = true;
  if (e.key === 'Escape') {
    leaveTool();
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && selection.size) {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();          // keeps Space from pressing a focused tray button
    if (!spaceHeld) {
      spaceHeld = true;
      syncTray();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    }
    return;
  }
  if (e.key === '0') fitToScreen();
  const tool = SHORTCUTS[e.key.toLowerCase()];
  if (tool) setTool(tool);
});
function releaseSpace() {
  if (!spaceHeld) return;
  spaceHeld = false;
  syncTray();
}

window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') hasShift = false;
  if (e.key === ' ' && spaceHeld) {
    e.preventDefault();
    releaseSpace();
  }
});
window.addEventListener('blur', () => {
  hasShift = false;
  releaseSpace();
});

// ---- start ---------------------------------------------------------------

restore();
resize();
readColors();
changed();
cameraMoved();
syncTray();
attachInput(sceneCanvas, strokeHandlers);

window.addEventListener('resize', () => { resize(); syncTray(); });
window.addEventListener('pagehide', save);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
document.fonts?.load(fontFor(32)).then(() => requestRender({ scene: true }));
