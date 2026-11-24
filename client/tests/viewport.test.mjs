import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/viewport.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { canvasSize, canvasZoomFor, fontPixelFor } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const browserZoomLevels = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const displayScales = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.625, 3];

// Artwork is drawn at 2x, 3x and 6x. Any fractional camera zoom (the old 1.5x on
// desktop) gives art pixels of uneven width, e.g. 4 and 5 screen pixels at 4.5x.
test('the camera zoom is always a whole number, so every art pixel has the same size', () => {
  for (const scale of displayScales) {
    for (const zoom of browserZoomLevels) {
      for (const touch of [false, true]) {
        const cameraZoom = canvasZoomFor(scale * zoom, touch);
        assert.ok(Number.isInteger(cameraZoom) && cameraZoom >= 1, `${scale} x ${zoom} -> ${cameraZoom}`);
      }
    }
  }
});

test('at 100% browser zoom a world unit is about 1.5 CSS pixels, or 1 on touch screens', () => {
  assert.equal(canvasZoomFor(1, false), 2); // 1x desktop
  assert.equal(canvasZoomFor(1.25, false), 2);
  assert.equal(canvasZoomFor(1.5, false), 2);
  assert.equal(canvasZoomFor(2, false), 3); // 2x laptop: 1470x760 CSS shows 507 world units of height
  assert.equal(canvasZoomFor(3, true), 3); // 390x844 phone at 3x: still 390 world units wide
  assert.equal(canvasZoomFor(2.625, true), 3);
  assert.equal(canvasZoomFor(2, true), 2);
});

test('browser zoom zooms the world with the interface, never the other way', () => {
  for (const scale of displayScales) {
    for (const touch of [false, true]) {
      let previous = 0;
      for (const zoom of browserZoomLevels) {
        const cameraZoom = canvasZoomFor(scale * zoom, touch);
        assert.ok(cameraZoom >= previous, `${scale}x display: ${zoom} -> ${cameraZoom} after ${previous}`);
        previous = cameraZoom;
      }
    }
  }
  // A 2x laptop going from 90% to 200%.
  assert.deepEqual([0.9, 1, 1.25, 1.5, 2].map(zoom => canvasZoomFor(2 * zoom, false)), [3, 3, 4, 5, 6]);
});

test('the world unit is the nearest whole number of device pixels to its target size', () => {
  for (const scale of displayScales) {
    for (const zoom of browserZoomLevels) {
      const ratio = scale * zoom;
      for (const [touch, target] of [[false, 1.5], [true, 1]]) {
        if (target * ratio < 1) continue;
        const error = Math.abs(canvasZoomFor(ratio, touch) - target * ratio);
        assert.ok(error <= 0.5 + 1e-9, `${ratio}: ${canvasZoomFor(ratio, touch)} for ${target * ratio}`);
      }
    }
  }
});

test('interface font pixels are whole device pixels and grow with browser zoom', () => {
  for (const scale of displayScales) {
    for (const touch of [false, true]) {
      let previous = 0;
      for (const zoom of browserZoomLevels) {
        const ratio = scale * zoom;
        const devicePixels = fontPixelFor(ratio, touch) * ratio;
        assert.ok(Math.abs(devicePixels - Math.round(devicePixels)) < 1e-9 && Math.round(devicePixels) >= 1, `${ratio}: ${devicePixels}`);
        assert.ok(devicePixels >= previous - 1e-9);
        previous = devicePixels;
      }
    }
  }
  assert.equal(fontPixelFor(2, false) * 16, 40); // 2x laptop: 40px text, up from 32px
  assert.equal(fontPixelFor(1, false) * 16, 32); // 1x desktop keeps 32px
  assert.equal(fontPixelFor(3, true) * 16, 32); // phones keep 32px
});

test('the canvas has one pixel per device pixel', () => {
  assert.deepEqual(canvasSize(390, 844, 3), { width: 1170, height: 2532 });
  assert.deepEqual(canvasSize(1280, 800, 1.5), { width: 1920, height: 1200 });
});
