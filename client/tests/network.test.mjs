import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const world = JSON.parse(await readFile(new URL('../../world.json', import.meta.url), 'utf8'));
async function source(name) {
  const text = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/^import .*;\n/gm, '');
}
// Exercise the real prediction/interpolation code without booting a canvas or DOM.
const stubs = `
const world=${JSON.stringify(world)};
const Phaser={Scene:class{},Math:{Clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),Linear:(a,b,t)=>a+(b-a)*t}};
const performance={now:()=>globalThis.networkTestTime};
class Controls {value=0;direction(){return this.value}jump(){return false}release(){this.value=0}}
`;
const code = stubs + await source('movement') + await source('world-view') + await source('scene');
const { WorldScene, WorldView } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const dt = 1000 / 60;
const player = (side, x = world.desks[side], ack = 0) => ({
  side, x, ack, y: 0, vy: 0, jumpChain: 0, landingTicks: 0,
  facing: 1, moving: false, connected: true, carrying: false, unread: 0,
});

function client() {
  globalThis.networkTestTime = 0;
  const sent = [];
  const connection = {
    ready: true, side: 'left', reconnects: 0,
    send(message) { sent.push(structuredClone(message)); return true; },
    connect() { this.reconnects++; this.ready = false; },
  };
  const scene = new WorldScene(connection, { setHint() {}, setGalleryAvailable() {} });
  scene.active = true;
  scene.view.renderPlayers = (_players, _side, motion) => { scene.drawn = motion; };
  scene.view.followPlayer = () => {};
  scene.receive({ type: 'welcome', side: 'left', time: 0, players: [player('left'), player('right')] });
  return { scene, connection, sent };
}

test('interaction sends its input dependency immediately, without waiting for a round trip', () => {
  const { scene, sent } = client();
  scene.update(0, dt);
  scene.interact('gallery');
  assert.deepEqual(sent.map(message => message.type), ['input', 'gallery']);
  assert.equal(sent[1].after, 1);
});

test('stop preserves pending prediction and sends an ordered sequence barrier', () => {
  const { scene, sent } = client();
  scene.controls.value = 1;
  scene.update(0, dt);
  scene.update(dt, dt);
  const x = scene.local.x;
  scene.stop();
  assert.equal(scene.local.x, x);
  assert.equal(scene.pending.length, 2);
  assert.deepEqual(sent.at(-1), { type: 'stop', after: 2 });
});

test('reconciliation blends the rendered position while applying authority immediately', () => {
  const { scene } = client();
  scene.controls.value = 1;
  scene.update(0, dt);
  const predicted = scene.local.x;
  scene.receive({ type: 'state', time: dt, players: [player('left', world.desks.left, 1), player('right')] });
  assert.equal(scene.local.x, world.desks.left);
  scene.controls.value = 0;
  scene.update(dt, dt);
  assert.ok(scene.drawn.x > world.desks.left && scene.drawn.x < predicted);
  for (let frame = 0; frame < 60; frame++) scene.update(frame * dt, dt);
  assert.ok(Math.abs(scene.drawn.x - world.desks.left) < 0.001);
});

test('prolonged acknowledgement loss reconnects once instead of accumulating frozen time', () => {
  const { scene, connection } = client();
  for (let frame = 0; frame < 130; frame++) scene.update(frame * dt, dt);
  assert.equal(connection.reconnects, 1);
  assert.equal(scene.accumulator, 0);
  connection.ready = true;
  scene.receive({ type: 'welcome', side: 'left', time: 2200, players: [player('left'), player('right')] });
  scene.controls.value = 1;
  scene.update(2200, dt);
  assert.equal(scene.pending.length, 1);
  assert.ok(scene.local.x > world.desks.left);
});

test('remote snapshots remain smooth and time never rewinds during delayed packet bursts', () => {
  globalThis.networkTestTime = 50;
  const view = new WorldView({ cameras: { main: { zoom: 1 } } });
  const sprite = () => ({
    anims: { currentAnim: null, setProgress() {} },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setAlpha() { return this; }, setFlipX() { return this; },
    play(key) { this.anims.currentAnim = { key }; return this; },
  });
  view.sprites.set('left', sprite());
  view.sprites.set('right', sprite());
  view.renderDog = () => {};
  const initial = player('left', 1000);
  view.recordPartner(initial, true, 0);
  let due = 0;
  const packets = [];
  for (let time = 1000 / 30; time <= 2000; time += 1000 / 30) {
    due = Math.max(due, time + 50 + (time >= 500 && time <= 650 ? 180 : 0));
    packets.push({ due, time, player: { ...initial, x: 1000 + world.speed * time / 1000, moving: true } });
  }
  let latest = initial, previousX, clock = -Infinity;
  for (let now = 50; now < 2200; now += dt) {
    globalThis.networkTestTime = now;
    while (packets.length && packets[0].due <= now) {
      const packet = packets.shift(); latest = packet.player;
      view.recordPartner(latest, false, packet.time);
    }
    view.renderPlayers([latest, player('right')], 'right', player('right'), 0, dt);
    assert.ok(view.remoteTime >= clock);
    clock = view.remoteTime;
    const x = view.sprites.get('left').x;
    if (previousX !== undefined) assert.ok(Math.abs(x - previousX) <= 6);
    previousX = x;
  }
});
