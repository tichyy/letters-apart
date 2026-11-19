import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/viewport.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { cameraZoomFor, canvasSize } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

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
  // The world is drawn on the canvas, whose size depends on display scaling: at
  // 1280x800 and 1.5x scaling the canvas is 960x600, so 2x would show only 300.
  for (const ratio of [1, 1.25, 1.5, 1.75, 2, 2.625, 3]) {
    for (const [cssWidth, cssHeight] of [[1280, 800], [1366, 768], [1920, 1080], [2560, 1440], [1024, 700], [390, 844]]) {
      const { width, height } = canvasSize(cssWidth, cssHeight, ratio);
      const zoom = cameraZoomFor(width, height);
      assert.ok(Number.isInteger(zoom) && zoom >= 1);
      if (zoom > 1) assert.ok(height / zoom >= 400, `${cssWidth}x${cssHeight} @${ratio}: ${height / zoom} units tall`);
    }
  }
  assert.deepEqual(canvasSize(1280, 800, 1.5), { width: 960, height: 600 });
  assert.equal(cameraZoomFor(960, 600), 1);
});
