import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

// Load the module with its one runtime dependency, the shared physics, the same way
// movement-parity.test.mjs loads that.
const world = JSON.parse(await readFile(new URL('../../world.json', import.meta.url), 'utf8'));
async function source(name) {
  const text = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/^import .*;\n/gm, '');
}
const code = `
const world=${JSON.stringify(world)};
const Phaser={Math:{Clamp:(v,a,b)=>Math.max(a,Math.min(b,v))}};
${await source('movement')}
${await source('local-prediction')}`;
const { LocalPrediction, frameTiming } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const dt = 1000 / 60;
const player = (x = world.desks.left, ack = 0, extra = {}) => ({
  side: 'left', x, ack, step: ack, y: 0, vy: 0, jumpChain: 0, landingTicks: 0,
  facing: 1, moving: false, connected: true, carrying: false, unread: 0, ...extra,
});

function predict() {
  const sent = [];
  const prediction = new LocalPrediction({ send(message) { sent.push(structuredClone(message)); return true; } });
  const controls = { value: 0, direction() { return this.value; }, jump() { return false; } };
  prediction.reconcile(player(), true);
  const advance = (ms = dt) => prediction.advance(ms, controls);
  return { prediction, controls, sent, advance };
}

test('interaction sends its input dependency immediately, without waiting for a round trip', () => {
  const { prediction, sent, advance } = predict();
  advance();
  prediction.sendAfterInputs('gallery');
  assert.deepEqual(sent.map(message => message.type), ['input', 'gallery']);
  assert.equal(sent[1].after, 1);
});

test('stop keeps pending prediction and sends an ordered sequence barrier', () => {
  const { prediction, controls, sent, advance } = predict();
  controls.value = 1;
  advance();
  advance();
  const x = prediction.position.x;
  prediction.stop();
  assert.equal(prediction.position.x, x);
  assert.deepEqual(sent.at(-1), { type: 'stop', after: 2 });
  // Both steps are still pending: replaying them on an unchanged authority keeps us in place.
  prediction.reconcile(player(), false);
  assert.equal(prediction.position.x, x);
});

test('inputs that cannot be sent wait and go out in order once the socket accepts them', () => {
  const sent = [];
  let open = false;
  const prediction = new LocalPrediction({ send(message) { if (open) sent.push(message); return open; } });
  const controls = { direction: () => 1, jump: () => false };
  prediction.reconcile(player(), true);
  for (let frame = 0; frame < 10; frame++) prediction.advance(dt, controls);
  open = true;
  prediction.advance(dt, controls);
  const inputs = sent.flatMap(message => message.inputs);
  assert.ok(sent.every(message => message.type === 'input' && message.inputs.length <= 8));
  assert.deepEqual(inputs.map(input => input.seq), inputs.map((_, i) => i + 1));
  assert.ok(inputs.length >= 10);
});

test('a socket that never accepts inputs ends in a stall, not an ever-growing queue', () => {
  let attempts = 0;
  const prediction = new LocalPrediction({ send() { attempts++; return false; } });
  const controls = { direction: () => 1, jump: () => false };
  prediction.reconcile(player(), true);
  const frames = Array.from({ length: 600 }, () => prediction.advance(dt, controls));
  const firstStall = frames.findIndex(frame => frame.stalled);
  assert.ok(firstStall > 0 && firstStall <= 121, `stalled at frame ${firstStall}`);
  assert.ok(frames.slice(firstStall).every(frame => frame.stalled));
  // Prediction stops at the server's input limit: 2 s ahead, however long the outage.
  const x = prediction.position.x;
  assert.ok(Math.abs(x - (world.desks.left + world.speed * 2)) < 1e-6, `ran to ${x}`);
  // Each frame tries once and gives up at the first refusal, so a dead socket costs one call.
  assert.equal(attempts, firstStall);
});

test('reconciliation blends the drawn position while applying authority immediately', () => {
  const { prediction, controls, advance } = predict();
  controls.value = 1;
  advance();
  const predicted = prediction.position.x;
  prediction.reconcile(player(world.desks.left, 1), false);
  assert.equal(prediction.position.x, world.desks.left);
  controls.value = 0;
  const { pose } = advance();
  assert.ok(pose.x > world.desks.left && pose.x < predicted);
  let last;
  for (let frame = 0; frame < 60; frame++) last = advance().pose;
  assert.ok(Math.abs(last.x - world.desks.left) < 0.001);
});

test('prolonged acknowledgement loss reports a stall instead of accumulating frozen time', () => {
  const { prediction, controls, sent, advance } = predict();
  const frames = Array.from({ length: 130 }, () => advance());
  const firstStall = frames.findIndex(frame => frame.stalled);
  // Two seconds of unacknowledged steps; floating-point time may land a frame either side.
  assert.ok(firstStall >= 119 && firstStall <= 121, `stalled at frame ${firstStall}`);
  assert.ok(frames.slice(firstStall).every(frame => frame.stalled));
  // After the reconnect's welcome, the clock starts fresh: one frame, one step.
  prediction.reconcile(player(), true);
  controls.value = 1;
  advance();
  assert.deepEqual(sent.at(-1).inputs.map(input => input.seq), [1]);
  assert.ok(prediction.position.x > world.desks.left);
});

test('a local landing correction also finishes exactly instead of keeping a fall pose', () => {
  const { prediction, advance } = predict();
  prediction.reconcile(player(world.desks.left, 0, { y: -40 }), true);
  prediction.reconcile(player(), false);
  let last;
  for (let frame = 0; frame < 60; frame++) last = advance().pose;
  assert.equal(last.y, 0);
});

test('own movement advances every frame on a high-refresh display', () => {
  const { controls, advance } = predict();
  controls.value = 1;
  const frame = 1000 / 144, xs = [];
  for (let i = 0; i < 144; i++) xs.push(advance(frame).pose.x);
  const steps = xs.slice(10).map((x, i, all) => i && x - all[i - 1]).slice(1);
  const ideal = world.speed / 144;
  for (const dx of steps) assert.ok(Math.abs(dx - ideal) < ideal * 0.05, `frame moved ${dx}, expected ${ideal}`);
});

test("Phaser reports real elapsed time on a slow device, even right after loading", () => {
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
