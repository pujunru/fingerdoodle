import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History, boundsOfAll, hit, intersecting, sanitize, topmostAt, translated } from '../site/js/scene.js';

const stroke = { id: 'a', type: 'pencil', points: [[0, 0], [100, 0]], color: 'ink', size: 4 };
const box = { id: 'b', type: 'rect', x: 0, y: 0, w: 100, h: 50, color: 'ink', size: 4 };
const ring = { id: 'c', type: 'ellipse', x: 0, y: 0, w: 100, h: 100, color: 'ink', size: 4 };

test('hit finds a stroke within finger reach and misses beyond it', () => {
  assert.equal(hit(stroke, 50, 10, 14), true);
  assert.equal(hit(stroke, 50, 40, 14), false);
});

test('a shape is hit on its outline, and its middle only when grabbing', () => {
  assert.equal(hit(box, 50, 25, 5), false);
  assert.equal(hit(box, 50, 25, 5, true), true);
  assert.equal(hit(box, 0, 25, 5), true);
  assert.equal(hit(ring, 50, 50, 5), false);
  assert.equal(hit(ring, 50, 50, 5, true), true);
  assert.equal(hit(ring, 100, 50, 5), true);
});

test('topmostAt prefers the most recently drawn element', () => {
  assert.equal(topmostAt([stroke, box], 50, 0, 5).id, 'b');
});

test('translated moves an element without changing the original', () => {
  assert.deepEqual(translated(stroke, 5, 5).points, [[5, 5], [105, 5]]);
  assert.deepEqual(stroke.points, [[0, 0], [100, 0]]);
  assert.equal(translated(box, 5, 0).x, 5);
});

test('boundsOfAll spans every element and is null for an empty page', () => {
  assert.equal(boundsOfAll([]), null);
  const b = boundsOfAll([box, translated(box, 100, 0)]);
  assert.equal(b.w, 204);
});

test('a selection box picks up everything it touches and nothing else', () => {
  const far = translated(box, 500, 500);
  const picked = intersecting([box, far], { x: 90, y: 40, w: 20, h: 20 });
  assert.deepEqual(picked.map((el) => el.id), ['b']);
  assert.equal(intersecting([box, far], { x: 200, y: 200, w: 50, h: 50 }).length, 0);
});

test('history undoes and redoes, and a new edit clears redo', () => {
  const h = new History();
  h.commit([stroke]);
  h.commit([stroke, box]);
  h.undo();
  assert.equal(h.elements.length, 1);
  h.redo();
  assert.equal(h.elements.length, 2);
  h.undo();
  h.commit([box]);
  assert.equal(h.redo(), false);
});

test('sanitize drops damaged saved elements and keeps good ones', () => {
  const out = sanitize([stroke, null, { type: 'pencil', size: 1, points: [[1]] }, { type: 'virus', size: 1 }, { type: 'text', size: 1, x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepEqual(out, [stroke]);
  assert.deepEqual(sanitize('nope'), []);
});
