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

function createScene() {
  const images = [];
  const defaultFrames = { trees: '__BASE', soil: '__BASE', clouds: '__BASE' };
  const frames = {
    trees: { __BASE: { width: 320, height: 180 }, foreground: { width: 75, height: 69 } },
    clouds: { __BASE: { width: 960, height: 540 } },
    soil: { __BASE: { width: 640, height: 180 }, soil: { width: 640, height: 12 } },
  };
  const getFrame = (texture, name = defaultFrames[texture]) => frames[texture][name];
  function object(x, y, frame) {
    return {
      ...frame, x, y, destroyed: false,
      setOrigin(origin) { this.origin = origin; return this; },
      setScale(scale) { this.scale = scale; return this; },
      setDepth(depth) { this.depth = depth; return this; },
      setPosition(x, y) { this.x = x; this.y = y; return this; },
      setCrop(...crop) { this.crop = crop; return this; },
      setFlipX(flip) { this.flipX = flip; return this; },
      setFlipY(flip) { this.flipY = flip; return this; },
      destroy() { this.destroyed = true; },
    };
  }
  return {
    images, defaultFrames,
    textures: { get: key => ({ get: name => getFrame(key, name) }) },
    add: {
      image(x, y, texture, frame) {
        const image = object(x, y, getFrame(texture, frame));
        images.push(image);
        return image;
      },
    },
  };
}

test('fractional world offsets preserve single screen pixel steps at desktop zoom', () => {
  const scene = createScene();
  const layer = createRepeatingLayer(scene, { texture: 'trees', y: -477, depth: -1 });
  const zoom = 1.5;
  layer.resize(1280 / zoom, 540);
  for (let step = 0; step < 20; step++) {
    const left = 100 + step / zoom;
    layer.scroll(left, step / zoom);
    const screenX = (scene.images[0].x - left) * zoom;
    assert.ok(Math.abs(screenX + step) < 1e-9, `step ${step}: got ${screenX}`);
  }
});

test('reuses images and wraps the pattern in either direction', () => {
  const scene = createScene();
  const layer = createRepeatingLayer(scene, { texture: 'trees', y: -477, depth: -1 });
  layer.resize(390, 540);
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

test('copies keep the base artwork when foreground frames are added later', () => {
  const scene = createScene();
  const layer = createRepeatingLayer(scene, { texture: 'trees', y: -477, depth: -1 });
  scene.defaultFrames.trees = 'foreground';
  layer.resize(390, 540);
  for (const image of scene.images) {
    assert.deepEqual([image.width, image.height], [320, 180]);
  }
});

test('repeats soil vertically, crops the last row, and releases excess images after resize', () => {
  const scene = createScene();
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

test('already upscaled art is drawn at its own size and keeps fractional offsets', () => {
  const scene = createScene();
  const layer = createRepeatingLayer(scene, { texture: 'clouds', y: -477, depth: -3, scale: 1 });
  layer.resize(390, 540);
  assert.equal(scene.images.length, 2);
  assert.ok(scene.images.every(image => image.scale === 1));
  layer.scroll(100, 0.25);
  assert.equal(scene.images[0].x, 99.75);
  layer.scroll(100, 960.25);
  assert.equal(scene.images[0].x, 99.75, 'the pattern wraps at the upscaled width');
});

test('mirrored rows flip upside down, stagger sideways, and draw a flipped last row whole', () => {
  const scene = createScene();
  const layer = createRepeatingLayer(scene, { texture: 'soil', frame: 'soil', y: 55, depth: 9, mirrorRows: true, staggerRows: true });
  layer.resize(390, 84);
  assert.deepEqual(scene.images.map(image => image.flipY), [true, true, false, false, true, true]);
  // Phaser would draw a flipped crop at the bottom of the tile and leave a gap above it.
  assert.deepEqual(scene.images[4].crop, [], 'the flipped last row is not cropped');
  layer.scroll(0, 0);
  assert.equal(scene.images[0].x, 0, 'the first row stays aligned with the ground above');
  assert.notEqual(scene.images[2].x, scene.images[0].x, 'the next row is shifted sideways');
  const before = scene.images.map(image => image.x - 0);
  layer.scroll(1920, 1920);
  assert.deepEqual(scene.images.map(image => image.x - 1920), before, 'the stagger stays fixed in the world while scrolling');
});

test('mirrored layers flip alternate tiles by world position, without canvas copies', () => {
  const scene = createScene();
  const layer = createRepeatingLayer(scene, { texture: 'trees', y: -477, depth: -1, mirror: true });
  layer.resize(390, 540);
  // A tile keeps its flip as it scrolls past, in either direction.
  const flipAt = (offset, worldTile) => {
    layer.scroll(0, offset);
    const first = Math.floor(offset / 960);
    return scene.images[worldTile - first].flipX;
  };
  assert.equal(flipAt(0, 0), false);
  assert.equal(flipAt(0, 1), true);
  assert.equal(flipAt(500, 1), true);
  assert.equal(flipAt(1000, 1), true);
  assert.equal(flipAt(1000, 2), false);
  assert.equal(flipAt(-10, -1), true);
  assert.equal(flipAt(-10, 0), false);
  const plain = createScene();
  createRepeatingLayer(plain, { texture: 'trees', y: 0, depth: 0 }).resize(390, 540);
  assert.ok(plain.images.every(image => image.flipX === undefined), 'unmirrored layers never flip');
});
