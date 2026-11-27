import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/bubble-layout.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { layoutBubbles } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const options = { own: 'left', typing: false, width: 1280, height: 720, tipInset: 10, tailHeight: 12, gap: 8 };
const box = (x, width = 240, height = 44, y = 400) => ({ x, y, width, height });
const right = p => p.left + 240;
const apart = (a, b, aHeight = 44, bHeight = 44) =>
  right(a) <= b.left || right(b) <= a.left || a.top + aHeight <= b.top || b.top + bHeight <= a.top;

test('the tail tip is over the head and the bubble sits above it', () => {
  const { left } = layoutBubbles({ left: box(300) }, options);
  // Alone on the left half: opens right, so its left edge is the tip inset left of the head.
  assert.deepEqual(left, { left: 290, top: 400 - 12 - 44, tail: 'left' });
});

test('side by side, each bubble opens away from the other speaker', () => {
  // Meeting halfway: the left home's player usually stands on the left.
  const placed = layoutBubbles({ left: box(600), right: box(660) }, options);
  assert.equal(placed.left.tail, 'right');
  assert.equal(placed.right.tail, 'left');
  assert.ok(apart(placed.left, placed.right));
  // And the other way round.
  const swapped = layoutBubbles({ left: box(660), right: box(600) }, options);
  assert.equal(swapped.left.tail, 'left');
  assert.ok(apart(swapped.left, swapped.right));
});

test('on a narrow screen both bubbles stay over their heads, even overlapping', () => {
  const narrow = { ...options, width: 390 };
  const placed = layoutBubbles({ left: box(200), right: box(240) }, narrow);
  assert.equal(placed.left.top, 400 - 12 - 44);
  assert.equal(placed.right.top, 400 - 12 - 44);
});

test('a draft taller than the space above the keyboard keeps its bottom line in view', () => {
  // Keyboard up: 300 px visible. The bubble is 400 px tall and the head is near the bottom.
  const keyboard = { ...options, height: 300, typing: true };
  const typing = layoutBubbles({ left: box(300, 240, 400, 290) }, keyboard).left;
  assert.equal(typing.top + 400, 300 - 8);
  // Not typing (or the partner's bubble), its top stays in view instead.
  const reading = layoutBubbles({ left: box(300, 240, 400, 290) }, { ...keyboard, typing: false }).left;
  assert.equal(reading.top, 8);
});

test('walking, a bubble keeps its side as the head crosses the middle of the screen', () => {
  // The camera follows the player: their head jitters around the middle (640).
  let previous = {};
  const tails = [];
  for (const x of [641, 639, 640.5, 638, 642]) {
    const placed = layoutBubbles({ left: box(x) }, { ...options, previous });
    previous = { left: placed.left.tail };
    tails.push(placed.left.tail);
  }
  assert.deepEqual(new Set(tails), new Set([tails[0]]));
});

test('a showing bubble keeps its side when the players swap places', () => {
  const previous = { left: 'right', right: 'left' };
  const placed = layoutBubbles({ left: box(700), right: box(600) }, { ...options, previous });
  assert.deepEqual([placed.left.tail, placed.right.tail], ['right', 'left']);
});

test('a showing bubble slides along the screen edge rather than turning', () => {
  const placed = layoutBubbles({ left: box(1270) }, { ...options, previous: { left: 'left' } }).left;
  assert.equal(placed.tail, 'left');
  assert.equal(right(placed), 1280 - 8);
});

test('a new bubble by the screen edge opens the other way', () => {
  const placed = layoutBubbles({ left: box(1270) }, options).left;
  assert.equal(placed.tail, 'right');
  assert.ok(right(placed) <= 1280 - 8);
});
