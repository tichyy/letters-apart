import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/card-zoom.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { cardWidth, maxCardZoom, pinchedWidth, scrollAround } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('the card grows and shrinks with the fingers', () => {
  // A 390px phone's dialog is 358px wide: fingers twice as far apart double the card.
  assert.equal(pinchedWidth(358, 100, 200, 358), 716);
  assert.equal(pinchedWidth(716, 200, 150, 358), 537);
});

test('the card is never smaller than the whole card on screen, or larger than the largest zoom', () => {
  assert.equal(pinchedWidth(716, 200, 20, 358), 358);
  assert.equal(pinchedWidth(358, 50, 1000, 358), maxCardZoom * cardWidth);
  // A dialog wider than the largest zoom still shows the whole card.
  assert.equal(pinchedWidth(2000, 100, 300, 2000), 2000);
});

test('pinching keeps the content between the fingers in place', () => {
  // 100px into the view, 300px scrolled: content at 400 of 800. At 1600 wide it is at
  // 800, so the view scrolls to 700 to keep it 100px in.
  assert.equal(scrollAround(300, 100, 800, 1600), 700);
  // Unchanged size, unchanged scroll; zooming out from the left edge stays at 0.
  assert.equal(scrollAround(300, 100, 800, 800), 300);
  assert.equal(scrollAround(0, 50, 800, 400), 0);
});
