import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/pixel-grid.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { snapFollowerX } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('steady following stays still on screen while the camera tracks the owner', () => {
  for (const zoom of [1, 1.5]) {
    for (const speed of [-175, -140, 140, 175]) {
      for (const gap of [-91.2, -52.2, 52.2, 91.2]) {
        let initialScreenX;
        for (let frame = 0; frame < 600; frame++) {
          const ownerX = 1700 + speed * frame / 60;
          const dogX = ownerX - gap;
          const cameraScroll = Math.round(ownerX * zoom) / zoom - 640 / zoom;
          const screenX = (snapFollowerX(dogX, ownerX, zoom) - cameraScroll) * zoom;
          initialScreenX ??= screenX;
          assert.ok(Math.abs(screenX - initialScreenX) < 1e-9,
            `following shimmer: zoom=${zoom}, speed=${speed}, gap=${gap}, frame=${frame}`);
          assert.ok(Math.abs(screenX - Math.round(screenX)) < 1e-9);
        }
      }
    }
  }
});

test('accelerating and turning remain precise within one rendered pixel', () => {
  for (const zoom of [1, 1.5]) {
    for (let frame = 0; frame < 600; frame++) {
      const ownerX = 800 + Math.sin(frame / 40) * 300;
      const dogX = ownerX - 52 + Math.cos(frame / 20) * 35;
      const drawn = snapFollowerX(dogX, ownerX, zoom);
      assert.ok(Math.abs(drawn - dogX) * zoom <= 1 + 1e-9);
    }
  }
});

test('a still follower stays on one pixel while its anchor moves around it', () => {
  // The dog sits; the player taps A/D and jumps around it. Its drawn position must
  // not follow the player's rounding.
  for (const zoom of [1, 2, 3]) {
    const dogX = 1000.37;
    const drawn = new Set();
    for (let frame = 0; frame < 600; frame++) {
      const ownerX = dogX + 40 + Math.sin(frame / 3) * 30 + frame % 7 * 0.13;
      drawn.add(snapFollowerX(dogX, ownerX, zoom, true));
    }
    assert.deepEqual([...drawn], [Math.round(dogX * zoom) / zoom], `zoom ${zoom}`);
  }
});
