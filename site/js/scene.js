// The drawing as data: elements, geometry and undo history. No DOM in here.
//
// Elements are never mutated. An edit produces a new array, which makes undo a
// matter of keeping old arrays.
//
//   { id, type: 'pencil', points: [[x, y], ...], color, size }
//   { id, type: 'rect' | 'ellipse', x, y, w, h, color, size }
//   { id, type: 'text', x, y, w, h, text, color, size }

const HISTORY_LIMIT = 200;
const TYPES = new Set(['pencil', 'rect', 'ellipse', 'text']);

export const newId = () => Math.random().toString(36).slice(2, 10);

export function bounds(el) {
  if (el.type === 'pencil') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of el.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const pad = el.size / 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + el.size, h: maxY - minY + el.size };
  }
  const pad = el.type === 'text' ? 0 : el.size / 2;
  return { x: el.x - pad, y: el.y - pad, w: el.w + pad * 2, h: el.h + pad * 2 };
}

export function boundsOfAll(elements) {
  if (!elements.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    const b = bounds(el);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Everything a selection box touches. Touching is enough, because a fingertip
// cannot be expected to enclose a drawing exactly.
export function intersecting(elements, box) {
  return elements.filter((el) => {
    const b = bounds(el);
    return b.x <= box.x + box.w && b.x + b.w >= box.x && b.y <= box.y + box.h && b.y + b.h >= box.y;
  });
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// `inside` also counts the area enclosed by a shape, for grabbing it to move.
export function hit(el, x, y, tolerance, inside = false) {
  const reach = tolerance + el.size / 2;
  const b = bounds(el);
  if (x < b.x - reach || x > b.x + b.w + reach || y < b.y - reach || y > b.y + b.h + reach) return false;
  switch (el.type) {
    case 'pencil': {
      const pts = el.points;
      if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
      for (let i = 1; i < pts.length; i++) {
        if (distanceToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true;
      }
      return false;
    }
    case 'rect': {
      const inX = x >= el.x && x <= el.x + el.w, inY = y >= el.y && y <= el.y + el.h;
      if (inside && inX && inY) return true;
      const nearV = Math.min(Math.abs(x - el.x), Math.abs(x - (el.x + el.w))) <= reach;
      const nearH = Math.min(Math.abs(y - el.y), Math.abs(y - (el.y + el.h))) <= reach;
      return (nearV && y >= el.y - reach && y <= el.y + el.h + reach)
        || (nearH && x >= el.x - reach && x <= el.x + el.w + reach);
    }
    case 'ellipse': {
      const rx = el.w / 2, ry = el.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const r = Math.hypot((x - el.x - rx) / rx, (y - el.y - ry) / ry);
      if (inside && r <= 1) return true;
      return Math.abs(r - 1) * Math.min(rx, ry) <= reach;
    }
    default:
      return x >= b.x - tolerance && x <= b.x + b.w + tolerance
        && y >= b.y - tolerance && y <= b.y + b.h + tolerance;
  }
}

export function topmostAt(elements, x, y, tolerance, inside = false) {
  for (let i = elements.length - 1; i >= 0; i--) {
    if (hit(elements[i], x, y, tolerance, inside)) return elements[i];
  }
  return null;
}

export function translated(el, dx, dy) {
  if (el.type === 'pencil') {
    return { ...el, points: el.points.map(([x, y]) => [x + dx, y + dy]) };
  }
  return { ...el, x: el.x + dx, y: el.y + dy };
}

export class History {
  constructor(elements = []) {
    this.elements = elements;
    this.past = [];
    this.future = [];
  }

  commit(next) {
    this.past.push(this.elements);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.elements = next;
    this.future = [];
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(this.elements);
    this.elements = this.past.pop();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(this.elements);
    this.elements = this.future.pop();
    return true;
  }
}

// Saved drawings come back through localStorage, so nothing about them is assumed.
export function sanitize(saved) {
  if (!Array.isArray(saved)) return [];
  const finite = (...values) => values.every(Number.isFinite);
  return saved.filter((el) => {
    if (!el || !TYPES.has(el.type) || !finite(el.size)) return false;
    if (el.type === 'pencil') {
      return Array.isArray(el.points) && el.points.length > 0
        && el.points.every((p) => Array.isArray(p) && finite(p[0], p[1]));
    }
    if (el.type === 'text' && typeof el.text !== 'string') return false;
    return finite(el.x, el.y, el.w, el.h);
  });
}
