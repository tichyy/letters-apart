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

function remoteView() {
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
  return view;
}

function drawRemote(view, state, now) {
  globalThis.networkTestTime = now;
  view.renderPlayers([state, player('right')], 'right', player('right'), 0, dt);
  return view.sprites.get('left');
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

test('a local landing correction also finishes exactly instead of keeping a fall pose', () => {
  const { scene } = client();
  scene.local.y = -40;
  scene.receive({ type: 'state', time: dt, players: [player('left'), player('right')] });
  for (let frame = 0; frame < 60; frame++) scene.update(frame * dt, dt);
  assert.equal(scene.drawn.y, 0);
  assert.equal(scene.correction.y, 0);
});

test('remote snapshots remain smooth and time never rewinds during delayed packet bursts', () => {
  globalThis.networkTestTime = 50;
  const view = remoteView();
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

test('a remote landing reaches ground exactly and leaves the falling animation', () => {
  globalThis.networkTestTime = 0;
  const view = remoteView();
  let state = { ...player('left', 1000, 1), y: -40, vy: 200 };
  view.recordPartner(state, true, 0);
  for (let frame = 0; frame < 120; frame++) {
    const now = frame * dt;
    globalThis.networkTestTime = now;
    if (frame === 6) state = { ...state, y: 0, vy: 0, landingTicks: 9 };
    if (frame >= 6 && frame % 2 === 0) {
      state = { ...state, ack: frame, landingTicks: Math.max(0, 15 - frame) };
      view.recordPartner(state, false, now);
    }
    drawRemote(view, state, now);
  }
  const sprite = view.sprites.get('left');
  assert.equal(view.remoteRendered.y, 0);
  assert.equal(sprite.y, 12);
  assert.match(sprite.anims.currentAnim.key, /-idle$/);
});

test('repeated stale run flags settle to idle instead of running in place', () => {
  globalThis.networkTestTime = 0;
  const view = remoteView();
  view.recordPartner(player('left', 995), true, 0);
  const state = { ...player('left', 1000, 2), moving: true };
  for (let frame = 1; frame < 180; frame++) {
    const now = frame * dt;
    globalThis.networkTestTime = now;
    if (frame % 2 === 0) view.recordPartner(state, false, now);
    drawRemote(view, state, now);
  }
  assert.match(view.sprites.get('left').anims.currentAnim.key, /-idle$/);
  assert.ok(view.remoteRendered.x < 1025);
});

test('a stalled mid-jump pose falls, lands, and settles without fresh inputs', () => {
  globalThis.networkTestTime = 0;
  const view = remoteView();
  const state = { ...player('left', 1000, 10), y: -60, vy: -200, moving: true };
  view.recordPartner(state, true, 0);
  for (let frame = 1; frame < 180; frame++) {
    const now = frame * dt;
    globalThis.networkTestTime = now;
    // The server can still send snapshots while the owner's inputs are stalled.
    if (frame % 2 === 0) view.recordPartner(state, false, now);
    drawRemote(view, state, now);
  }
  assert.equal(view.remoteRendered.y, 0);
  assert.match(view.sprites.get('left').anims.currentAnim.key, /-idle$/);
});
