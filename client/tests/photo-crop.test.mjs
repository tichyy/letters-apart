import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/photo-crop.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { defaultCrop, photoLayout, panPhoto, zoomPhoto, validCrop } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('portrait and landscape photos fill the card and cannot be dragged past an edge', () => {
  const viewport = { width: 522, height: 384 };
  for (const image of [{ width: 1600, height: 900 }, { width: 900, height: 1600 }]) {
    for (const zoom of [1, 2, 5]) {
      for (const [dx, dy] of [[10000, 10000], [-10000, -10000], [32, -47]]) {
        const crop = panPhoto(image, viewport, { ...defaultCrop(), zoom }, dx, dy);
        const result = photoLayout(image, viewport, crop);
        assert.ok(result.left <= 0.001 && result.top <= 0.001);
        assert.ok(result.left + result.width >= viewport.width - 0.001);
        assert.ok(result.top + result.height >= viewport.height - 0.001);
      }
    }
  }
});

test('zoom preserves the image point under the pointer and clamps magnification', () => {
  const image = { width: 1600, height: 900 };
  const viewport = { width: 522, height: 384 };
  const anchor = { x: 170, y: 140 };
  const before = photoLayout(image, viewport, defaultCrop());
  const crop = zoomPhoto(image, viewport, defaultCrop(), 2, anchor);
  const after = photoLayout(image, viewport, crop);
  assert.ok(Math.abs((anchor.x - before.left) / before.width - (anchor.x - after.left) / after.width) < 1e-10);
  assert.ok(Math.abs((anchor.y - before.top) / before.height - (anchor.y - after.top) / after.height) < 1e-10);
  assert.equal(zoomPhoto(image, viewport, crop, 1000, anchor).zoom, 5);
  assert.equal(zoomPhoto(image, viewport, crop, 0, anchor).zoom, 1);
});

test('saved crop has the same framing when the postcard resizes', () => {
  const image = { width: 900, height: 1600 };
  const crop = { x: 0.25, y: 0.7, zoom: 2.3 };
  const large = photoLayout(image, { width: 522, height: 384 }, crop);
  const small = photoLayout(image, { width: 261, height: 192 }, crop);
  for (const key of ['width', 'height', 'left', 'top']) assert.equal(large[key], small[key] * 2);
  for (const bad of [null, {}, { x: NaN, y: 0.5, zoom: 1 }, { x: 0, y: -1, zoom: 1 }, { x: 0, y: 0, zoom: 6 }]) {
    assert.equal(validCrop(bad), false);
  }
});
