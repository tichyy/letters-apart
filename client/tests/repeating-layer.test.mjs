import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The layer module uses Phaser only for types, so its behavior can be checked
// without a DOM or an additional test runner.
const source = await readFile(new URL('../src/repeating-layer.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { createRepeatingLayer } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function createScene(iOS) {
  const images = [];
  const tiles = [];
  const defaultFrames = { trees: '__BASE', soil: '__BASE' };
  const frames = {
    trees: { __BASE: { width: 320, height: 180 }, foreground: { width: 75, height: 69 } },
    soil: { __BASE: { width: 640, height: 180 }, soil: { width: 640, height: 12 } },
  };
  const getFrame = (texture, name = defaultFrames[texture]) => frames[texture][name];
  function object(x, y, frame) {
    return {
      ...frame, x, y, destroyed: false,
      setOrigin(origin) { this.origin = origin; return this; },
      setScale(scale) { this.scale = scale; return this; },
      setTileScale(scale) { this.tileScale = scale; return this; },
      setDepth(depth) { this.depth = depth; return this; },
      setSize(width, height) { this.width = width; this.height = height; return this; },
      setX(x) { this.x = x; return this; },
      setPosition(x, y) { this.x = x; this.y = y; return this; },
      setCrop(...crop) { this.crop = crop; return this; },
      destroy() { this.destroyed = true; },
    };
  }
  return {
    images, tiles, defaultFrames,
    sys: { game: { device: { os: { iOS } } } },
    textures: { get: key => ({ get: name => getFrame(key, name) }) },
    add: {
      image(x, y, texture, frame) {
        const image = object(x, y, getFrame(texture, frame));
        images.push(image);
        return image;
      },
      tileSprite(x, y, width, height) {
        const tile = object(x, y, { width, height });
        tiles.push(tile);
        return tile;
      },
    },
  };
}

test('desktop retains one TileSprite with the shared scroll offset', () => {
  const scene = createScene(false);
  const layer = createRepeatingLayer(scene, { texture: 'trees', y: -477, depth: -1 });
  layer.resize(390.2, 540);
  layer.scroll(150, 67);
  assert.equal(scene.images.length, 0);
  assert.equal(scene.tiles.length, 1);
  const tile = scene.tiles[0];
  assert.deepEqual([tile.x, tile.y, tile.width, tile.height, tile.depth], [150, -477, 391, 540, -1]);
  assert.equal(tile.tileScale, 3);
  assert.equal(tile.tilePositionX, 67 / 3);
});

test('iOS reuses images and wraps the pattern in either direction', () => {
  const scene = createScene(true);
  const layer = createRepeatingLayer(scene, { texture: 'trees', y: -477, depth: -1 });
  layer.resize(390, 540);
  assert.equal(scene.tiles.length, 0);
  assert.equal(scene.images.length, 2);
  for (const [offset, expectedX] of [[0, 150], [1, 149], [959, -809], [960, 150], [1921, 149], [-1, -809]]) {
    layer.scroll(150, offset);
    assert.equal(scene.images[0].x, expectedX);
    assert.equal(scene.images[1].x, expectedX + 960);
    assert.equal(scene.images.length, 2, 'scrolling must not allocate more images');
  }
  for (const image of scene.images) {
    assert.deepEqual([image.y, image.origin, image.scale, image.depth], [-477, 0, 3, -1]);
  }
});

test('iOS copies keep the base artwork when foreground frames are added later', () => {
  const scene = createScene(true);
  const layer = createRepeatingLayer(scene, { texture: 'trees', y: -477, depth: -1 });
  scene.defaultFrames.trees = 'foreground';
  layer.resize(390, 540);
  for (const image of scene.images) {
    assert.deepEqual([image.width, image.height], [320, 180]);
  }
});

test('iOS repeats soil vertically, crops the last row, and releases excess images after resize', () => {
  const scene = createScene(true);
  const layer = createRepeatingLayer(scene, { texture: 'soil', frame: 'soil', y: 55, depth: 9 });
  layer.resize(390, 100);
  assert.equal(scene.images.length, 6);
  assert.deepEqual(scene.images.map(image => image.y), [55, 55, 91, 91, 127, 127]);
  assert.deepEqual(scene.images[4].crop, [0, 0, 640, 28 / 3]);
  layer.resize(4000, 100);
  assert.equal(scene.images.filter(image => !image.destroyed).length, 12);
  assert.ok(scene.images.every(image => image.depth === 9), 'new copies retain the layer depth');
  layer.resize(390, 36);
  assert.equal(scene.images.filter(image => !image.destroyed).length, 2);
  assert.deepEqual(scene.images[0].crop, [], 'a full row must clear the previous crop');
});
