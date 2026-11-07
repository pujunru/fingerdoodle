// Replays real finger gestures recorded on a touchscreen MacBook Pro through the
// input interpreter. The fixtures came from site/probe.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InputInterpreter } from '../site/js/input.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}-macbook-touch.json`, import.meta.url))).log;

function recorder() {
  const log = { strokes: [], cancelled: 0, pans: [], zoom: 1, zooms: 0 };
  let open = null;
  return {
    log,
    out: {
      strokeStart(x, y) { open = [[x, y]]; },
      strokeMove(x, y) { open.push([x, y]); },
      strokeEnd() { log.strokes.push(open); open = null; },
      strokeCancel() { log.cancelled++; open = null; },
      pan(dx, dy) { log.pans.push([dx, dy]); },
      zoom(f) { log.zoom *= f; log.zooms++; },
    },
  };
}

function replay(events, { steps } = {}) {
  const rec = recorder();
  const input = new InputInterpreter(rec.out);
  let now = 0;
  for (const r of events) {
    if (steps && !steps.includes(r.s)) continue;
    now = Math.max(now, r.t);
    const e = {
      t: r.t, x: r.x, y: r.y, button: r.b, buttons: r.bs, pointerType: r.pt, pointerId: r.id,
      deltaX: r.dx, deltaY: r.dy, deltaMode: r.dm ?? 0, ctrlKey: !!r.ctrl, scale: r.scale,
      overSurface: r.z === 'pad' || r.z === 'doc',
    };
    if (r.e === 'pointerdown') input.pointerDown(e);
    else if (r.e === 'pointermove') input.pointerMove(e);
    else if (r.e === 'pointerup') input.pointerUp(e);
    else if (r.e === 'pointercancel') input.pointerCancel(e);
    else if (r.e === 'wheel') input.wheelEvent(e);
    else if (r.e === 'gesturestart') input.gestureStart(e);
    else if (r.e === 'gesturechange') input.gestureChange(e);
    else if (r.e === 'gestureend') input.gestureEnd(e);
    input.tick(now);
  }
  input.tick(now + 10000);
  return rec.log;
}

const extent = (stroke) => {
  const xs = stroke.map((p) => p[0]), ys = stroke.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

test('Chrome: quick finger drags become strokes with the inertia removed', () => {
  const log = replay(load('chrome'), { steps: ['scroll'] });
  assert.equal(log.strokes.length, 4);
  // The raw wheel totals were 1664, 2266, 1210 and 1958 px on a 964 px window.
  // Only the finger's own travel of about 340 to 420 px should remain.
  for (const s of log.strokes) {
    const { h } = extent(s);
    assert.ok(h > 300 && h < 450, `stroke height ${h}`);
    assert.ok(s.length >= 10 && s.length <= 20, `stroke samples ${s.length}`);
  }
  // Up strokes start low and end high, down strokes the reverse, and each one
  // lands inside the window near where the finger really stopped.
  const ends = log.strokes.map((s) => s.at(-1)[1]);
  assert.ok(ends[0] > 220 && ends[0] < 300);
  assert.ok(ends[1] > 220 && ends[1] < 300);
  assert.ok(ends[2] > 630 && ends[2] < 710);
  assert.ok(ends[3] > 620 && ends[3] < 700);
});

test('Chrome: a held or slow drag becomes a stroke from the right button', () => {
  const log = replay(load('chrome'), { steps: ['drag', 'hold'] });
  assert.equal(log.strokes.length, 2);
  for (const s of log.strokes) {
    assert.ok(s.length > 200, `samples ${s.length}`);
    assert.ok(extent(s).w > 300);
  }
});

test('Chrome: three taps make three zero-length strokes', () => {
  const log = replay(load('chrome'), { steps: ['tap'] });
  assert.equal(log.strokes.filter((s) => extent(s).w === 0 && extent(s).h === 0).length, 3);
});

test('Chrome: pinch zooms and draws nothing', () => {
  const log = replay(load('chrome'), { steps: ['pinch'] });
  assert.equal(log.strokes.length, 0);
  assert.equal(log.zooms, 288);
});

test('Chrome: ordinary trackpad scrolling at the cursor pans instead of drawing', () => {
  const rec = recorder();
  const input = new InputInterpreter(rec.out);
  input.pointerMove({ t: 0, x: 300, y: 300, buttons: 0, pointerType: 'mouse' });
  for (let i = 1; i <= 5; i++) {
    input.wheelEvent({ t: i * 8, x: 300, y: 300, deltaX: 0, deltaY: 10, deltaMode: 0, ctrlKey: false, overSurface: true });
  }
  assert.equal(rec.log.strokes.length, 0);
  assert.equal(rec.log.pans.length, 5);
});

test('a finger that pauses mid-stroke keeps its ink', () => {
  const rec = recorder();
  const input = new InputInterpreter(rec.out);
  input.pointerMove({ t: 0, x: 10, y: 10, buttons: 0, pointerType: 'mouse' });
  const wheel = (t, dy) => input.wheelEvent({ t, x: 500, y: 500, deltaX: 0, deltaY: dy, deltaMode: 0, ctrlKey: false, overSurface: true });
  let t = 100;
  for (let i = 0; i < 8; i++) wheel(t += 8, 10);
  t += 40;                                    // the finger pauses
  for (let i = 0; i < 8; i++) wheel(t += 8, 10);  // then carries on at 120 Hz
  input.pointerMove({ t: t + 10, x: 10, y: 10, buttons: 0, pointerType: 'mouse' });
  assert.equal(rec.log.strokes.length, 1);
  assert.equal(rec.log.strokes[0].length, 17);
  assert.equal(rec.log.strokes[0].at(-1)[1], 500 - 160);
});

test('Safari: one-finger drag and press-and-hold become strokes', () => {
  const log = replay(load('safari'), { steps: ['hold'] });
  assert.equal(log.strokes.length, 1);
  assert.ok(extent(log.strokes[0]).w > 300);
});

test('Safari: pinch zooms, moves with the fingers and leaves no ink', () => {
  const log = replay(load('safari'), { steps: ['pinch'] });
  assert.equal(log.strokes.length, 0);
  assert.equal(log.cancelled, 1);
  assert.ok(log.zooms > 100);
  assert.ok(Math.abs(log.zoom - 0.45) < 0.03, `final zoom ${log.zoom}`);
  assert.ok(log.pans.length > 100);
});

test('Safari: a two-finger slide pans and leaves no ink', () => {
  const log = replay(load('safari'), { steps: ['two'] });
  assert.equal(log.strokes.length, 0);
  assert.ok(log.pans.length > 100);
});

test('Safari: fast two-finger swipes pan even without gesture events', () => {
  const log = replay(load('safari'), { steps: ['scroll'] });
  assert.equal(log.strokes.length, 2, 'the two one-finger drags');
  assert.equal(log.cancelled, 2);
  assert.ok(log.pans.length > 20);
});

test('real multi-touch pointers draw with one finger and pinch with two', () => {
  const rec = recorder();
  const input = new InputInterpreter(rec.out);
  const p = (pointerId, x, y) => ({ t: 0, x, y, pointerId, pointerType: 'touch', button: 0, buttons: 1, overSurface: true });
  input.pointerDown(p(1, 100, 100));
  input.pointerMove(p(1, 120, 100));
  input.pointerUp(p(1, 120, 100));
  assert.equal(rec.log.strokes.length, 1);
  input.pointerDown(p(2, 100, 100));
  input.pointerDown(p(3, 200, 100));
  assert.equal(rec.log.cancelled, 1);
  input.pointerMove(p(3, 300, 100));
  assert.ok(Math.abs(rec.log.zoom - 2) < 1e-9);
});
