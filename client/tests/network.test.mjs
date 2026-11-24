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
const code = stubs + await source('movement') + await source('pixel-grid') + await source('partner-playback') + await source('world-view') + await source('scene');
const { WorldScene, WorldView, frameTiming } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const dt = 1000 / 60;
const player = (side, x = world.desks[side], ack = 0) => ({
  side, x, ack, step: ack, y: 0, vy: 0, jumpChain: 0, landingTicks: 0,
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
  const scene = new WorldScene(connection, { setHint() {}, setGalleryAvailable() {}, setDropAvailable() {} });
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

const runSpeed = world.speed / world.tickRate;
// The partner's state after `step` steps of running right from x = 1000.
const running = (step, extra = {}) => ({ ...player('left', 1000 + step * runSpeed, step), moving: true, ...extra });

// Deliver `stream` ([arrival ms, state]) to a partner view, drawing at 60 Hz until `until` ms.
function play(stream, until) {
  globalThis.networkTestTime = 0;
  const view = remoteView();
  const frames = [];
  let next = 0, flips = 0, flip;
  const sprite = view.sprites.get('left');
  sprite.setFlipX = function (value) { if (flip !== undefined && value !== flip) flips++; flip = value; return this; };
  for (let now = 0; now <= until; now += dt) {
    while (next < stream.length && stream[next][0] <= now) {
      view.recordPartner(stream[next][1], next === 0);
      next++;
    }
    if (next === 0) continue;
    drawRemote(view, stream[next - 1][1], now);
    frames.push({ now, x: sprite.x, y: sprite.y, animation: sprite.anims.currentAnim.key });
  }
  return { frames, flips: () => flips };
}

// Seeded jitter, so every run sees the same "bad connection".
function jittered(maxMs, seed = 7) {
  let value = seed, due = 0;
  return time => {
    value = (value * 16807) % 2147483647;
    due = Math.max(due, time + (value / 2147483647) * maxMs); // TCP delivers in order.
    return due;
  };
}

test('partner moves evenly despite late, bursty delivery from both connections', () => {
  const delay = jittered(120);
  const stream = [];
  for (let step = 0; step <= 300; step++) stream.push([delay(step * dt), running(step)]);
  const { frames, flips } = play(stream, 5000);
  const steps = frames.slice(60, 280).map((frame, i, all) => i && frame.x - all[i - 1].x).slice(1);
  assert.equal(steps.filter(dx => dx < 0).length, 0, 'never moves backwards');
  assert.equal(flips(), 0, 'never turns around');
  const uneven = steps.filter(dx => Math.abs(dx - runSpeed) > runSpeed * 0.5).length;
  assert.ok(uneven / steps.length < 0.05, `uneven frames: ${uneven}/${steps.length}`);
});

test('a late partner keeps running briefly, then stands instead of running in place', () => {
  const stream = [];
  for (let step = 0; step <= 60; step++) stream.push([step * dt, running(step)]);
  // Their uplink stalls: the server keeps repeating the last state.
  for (let frame = 61; frame < 180; frame++) stream.push([frame * dt, running(60)]);
  const { frames } = play(stream, 3000);
  const last = frames.at(-1);
  assert.match(last.animation, /-idle$/);
  assert.ok(last.x <= 1000 + (60 + 15) * runSpeed + 0.5);
});

test('a partner stalled mid-jump still falls and lands', () => {
  const state = running(10, { y: -60, vy: -200 });
  const stream = Array.from({ length: 120 }, (_, frame) => [frame * dt, state]);
  const { frames } = play(stream, 2000);
  assert.equal(frames.at(-1).y, 9); // groundY, exactly
  assert.match(frames.at(-1).animation, /-idle$/);
});

test('a paused partner waits, then sets off without lurching', () => {
  const resting = { ...player('left', 1000, 100) };
  const stream = Array.from({ length: 120 }, (_, frame) => [frame * dt, resting]);
  for (let step = 1; step <= 60; step++) {
    stream.push([(120 + step) * dt, { ...running(step), x: 1000 + step * runSpeed, step: 100 + step }]);
  }
  const { frames } = play(stream, 3500);
  const after = frames.filter(frame => frame.now >= 120 * dt);
  for (let i = 1; i < after.length; i++) {
    assert.ok(after[i].x - after[i - 1].x <= runSpeed * 1.6, `lurch at frame ${i}`);
  }
});

test('after a long stall the partner catches up and returns to normal speed', () => {
  const stream = [];
  for (let step = 0; step <= 360; step++) {
    // Steps 60-120 are held back and arrive together at the end of a 1 s stall.
    const time = step * dt;
    stream.push([step >= 60 && step <= 120 ? 121 * dt : time, running(step)]);
  }
  const { frames, flips } = play(stream, 6000);
  // Whole-pixel drawing makes single frames alternate 2 and 3 px; compare 15-frame averages.
  const settled = frames.filter(frame => frame.now >= 2500 && frame.now <= 5500);
  for (let i = 15; i < settled.length; i += 15) {
    const speed = (settled[i].x - settled[i - 15].x) / 15;
    assert.ok(Math.abs(speed - runSpeed) <= runSpeed * 0.1, `speed ${speed} at ${settled[i].now}`);
  }
  assert.equal(flips(), 0);
  // ...and the delay drops back too: within 100 ms of their latest real position.
  const end = frames.find(frame => frame.now >= 5500);
  const latest = 1000 + Math.floor(end.now / dt) * runSpeed;
  assert.ok(latest - end.x <= 6 * runSpeed, `${((latest - end.x) / runSpeed).toFixed(1)} steps behind`);
});

test('own movement advances every frame on a high-refresh display', () => {
  const { scene } = client();
  scene.controls.value = 1;
  const frame = 1000 / 144, xs = [];
  for (let i = 0; i < 144; i++) {
    scene.update(i * frame, frame);
    xs.push(scene.drawn.x);
  }
  const steps = xs.slice(10).map((x, i, all) => i && x - all[i - 1]).slice(1);
  const ideal = world.speed / 144;
  for (const dx of steps) assert.ok(Math.abs(dx - ideal) < ideal * 0.05, `frame moved ${dx}, expected ${ideal}`);
});

test('a hidden tab keeps receiving for ten minutes without growing or lurching on return', () => {
  globalThis.networkTestTime = 0;
  const view = remoteView();
  // Rendering stops while hidden; snapshots keep arriving at 60 Hz.
  view.recordPartner(running(0), true);
  for (let step = 1; step <= 10 * 60 * 60; step++) view.recordPartner(running(step), false);
  assert.ok(view.partner.samples.length <= 64, `${view.partner.samples.length} snapshots retained`);
  const latest = running(10 * 60 * 60);
  const sprite = drawRemote(view, latest, 0);
  // The fade-out is bounded: the first visible frame is near the partner, not 10 minutes back.
  assert.ok(Math.abs(sprite.x - latest.x) < 100, `drawn ${(latest.x - sprite.x).toFixed(0)} units behind`);
});

test('the partner animation follows the drawn height after a delayed landing', () => {
  // Mid-jump at the apex, then a snapshot arrives showing they landed long ago.
  const air = { ...player('left', 1000, 0), y: -44, vy: 0 };
  const landed = { ...player('left', 1000, 40) };
  const stream = [[0, air], [3 * dt, landed]];
  for (let frame = 4; frame < 120; frame++) stream.push([frame * dt, landed]);
  const { frames } = play(stream, 2000);
  for (const frame of frames) {
    if (frame.y < 9) assert.match(frame.animation, /-(jump|fall)$/, `${frame.animation} at y ${frame.y}`);
  }
  assert.ok(frames.some(frame => /-land$/.test(frame.animation)), 'shows the landing');
  assert.equal(frames.at(-1).y, 9);
  assert.match(frames.at(-1).animation, /-idle$/);
});

test("Phaser reports real elapsed time on a slow device, even right after loading", async () => {
  const { createRequire } = await import('node:module');
  const TimeStep = createRequire(import.meta.url)('phaser/src/core/TimeStep.js');
  let clock = 0;
  const previousWindow = globalThis.window;
  globalThis.window = { performance: { now: () => clock } };
  try {
    const step = new TimeStep({}, frameTiming);
    let gameTime = 0;
    step.callback = (_time, delta) => { gameTime += delta; };
    // As TimeStep.start() does, without a browser animation loop.
    for (let i = 0; i < step.deltaSmoothingMax; i++) step.deltaHistory[i] = step._target;
    step.resetDelta();
    // A phone still loading: 30 fps for the first 4 seconds (120 frames).
    for (let frame = 1; frame <= 120; frame++) step.step(clock = frame * 1000 / 30);
    assert.ok(Math.abs(gameTime - 4000) < 1, `game time ${gameTime.toFixed(0)} ms after 4000 ms`);
  } finally {
    globalThis.window = previousWindow;
  }
});
