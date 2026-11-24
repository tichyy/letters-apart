import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/viewport.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { cameraZoomFor, canvasSize, canvasZoomFor } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

// Artwork is drawn at 2x, 3x and 6x. Any fractional camera zoom (the old 1.5x on
// desktop) gives art pixels of uneven width, e.g. 4 and 5 screen pixels at 4.5x.
test('the camera zoom is always a whole number, so every art pixel has the same size', () => {
  for (let width = 320; width <= 3840; width += 37) {
    for (let height = 320; height <= 2160; height += 41) {
      const zoom = cameraZoomFor(width, height);
      assert.ok(Number.isInteger(zoom) && zoom >= 1, `${width}x${height} -> ${zoom}`);
    }
  }
});

test('phones keep today\'s 1x view; larger screens zoom while showing at least 400 units of height', () => {
  assert.equal(cameraZoomFor(390, 844), 1);
  assert.equal(cameraZoomFor(600, 1000), 1);
  assert.equal(cameraZoomFor(1280, 800), 2);
  assert.equal(cameraZoomFor(1920, 1080), 2);
  assert.equal(cameraZoomFor(2560, 1440), 3);
  assert.equal(cameraZoomFor(1024, 700), 1);
});

test('on scaled displays the zoom still shows at least 400 world units of height', () => {
  // At 1280x800 and 1.5x scaling the canvas is 1920x1200 device pixels: zoom 3 shows 400 units.
  for (const ratio of [1, 1.25, 1.5, 1.75, 2, 2.625, 3]) {
    for (const [cssWidth, cssHeight] of [[1280, 800], [1366, 768], [1920, 1080], [2560, 1440], [1024, 700], [390, 844]]) {
      const { width, height } = canvasSize(cssWidth, cssHeight, ratio);
      const zoom = canvasZoomFor(width, height, ratio);
      assert.ok(Number.isInteger(zoom) && zoom >= 1);
      if (zoom > Math.max(1, Math.round(ratio))) assert.ok(height / zoom >= 400, `${cssWidth}x${cssHeight} @${ratio}: ${height / zoom} units tall`);
    }
  }
  assert.deepEqual(canvasSize(1280, 800, 1.5), { width: 1920, height: 1200 });
  assert.equal(canvasZoomFor(1920, 1200, 1.5), 3);
});

test('the full-resolution canvas shows the same world as before, with one canvas pixel per device pixel', () => {
  // A 390x844 phone at 3x: 1170x2532 canvas pixels, zoom 3, so still 390 world units wide.
  assert.deepEqual(canvasSize(390, 844, 3), { width: 1170, height: 2532 });
  assert.equal(canvasZoomFor(1170, 2532, 3), 3);
  // A 1920x1080 desktop at 1x keeps zoom 2.
  assert.equal(canvasZoomFor(1920, 1080, 1), 2);
});

test('browser zoom and display scaling resize the interface, not the world', () => {
  // A 2x laptop window of 1470x760 CSS pixels: zoom 3 shows 507 world units of
  // height. Rounding to multiples of 2 gave zoom 2 there (760 units) at 100%, and
  // zoom 3 only at 125% browser zoom.
  for (const ratio of [2, 2.5]) assert.equal(canvasZoomFor(2940, 1520, ratio), 3);
  // The same 1920x955 window at 100% and 125% browser zoom.
  assert.equal(canvasZoomFor(1920, 955, 1), 2);
  assert.equal(canvasZoomFor(1920, 955, 1.25), 2);
  // A 4K display at 2x: 432 world units of height.
  assert.equal(canvasZoomFor(3840, 2160, 2), 5);
});
