import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const world = JSON.parse(await readFile(new URL('../../world.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/dog-follower.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { DogFollower } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const dt = 1 / 60;

test('hesitates before following, accelerates, and stays behind the owner', () => {
  const dog = new DogFollower(300, 1, world);
  const start = dog.x;
  for (let frame = 0; frame < 6; frame++) dog.update({ x: 400, y: 0 }, 1, true, dt);
  assert.equal(dog.x, start);
  let previousStep = 0;
  for (let frame = 0; frame < 180; frame++) {
    const before = dog.x;
    const owner = { x: 400 + frame * world.speed * dt, y: 0 };
    const pose = dog.update(owner, 1, true, dt);
    const step = dog.x - before;
    assert.ok(step >= 0 && step <= world.speed * dt + 1e-9);
    assert.ok(step - previousStep <= 700 * dt * dt + 1e-9);
    assert.ok(owner.x - dog.x >= 52 - 1e-9);
    assert.equal(pose.flipX, false);
    previousStep = step;
  }
  assert.ok(dog.x > start);
});

test('sits when approached, watches the owner pass, and waits for a clear gap', () => {
  const dog = new DogFollower(300, 1, world);
  const start = dog.x;
  let turnElapsed = 0;
  for (let x = 299; x >= 180; x--) {
    const pose = dog.update({ x, y: 0 }, -1, true, dt);
    assert.equal(dog.x, start);
    assert.equal(pose.sitting, (300 - x) * dt >= 0.16);
    if (x < start) turnElapsed += dt;
    assert.equal(pose.flipX, turnElapsed >= 0.16);
  }
  for (let frame = 0; frame < 60; frame++) dog.update({ x: 150, y: 0 }, -1, true, dt);
  assert.ok(dog.x < start);
  assert.ok(dog.x - 150 >= 52 - 1e-9);
});

test('stops an existing chase immediately but hesitates before sitting', () => {
  const dog = new DogFollower(300, 1, world);
  for (let frame = 0; frame < 60; frame++) dog.update({ x: 400 + frame * 2, y: 0 }, 1, true, dt);
  const start = dog.x;
  const pose = dog.update({ x: 515, y: 0 }, -1, true, dt);
  assert.equal(dog.x, start);
  assert.equal(pose.moving, false);
  assert.equal(pose.sitting, false);
  let settled;
  for (let frame = 0; frame < 12; frame++) settled = dog.update({ x: 515, y: 0 }, -1, true, dt);
  assert.equal(settled.sitting, true);
});

test('turns after a short delay and ignores a brief crossing', () => {
  const dog = new DogFollower(300, 1, world);
  for (let frame = 0; frame < 3; frame++) {
    assert.equal(dog.update({ x: 240, y: 0 }, -1, true, dt).flipX, false);
  }
  assert.equal(dog.update({ x: 300, y: 0 }, 1, true, dt).flipX, false);
  for (let frame = 0; frame < 6; frame++) {
    assert.equal(dog.update({ x: 240, y: 0 }, -1, true, dt).flipX, false);
  }
  let pose;
  for (let frame = 0; frame < 6; frame++) pose = dog.update({ x: 240, y: 0 }, -1, true, dt);
  assert.equal(pose.flipX, true);
});

test('resumes if the owner changes their mind before passing', () => {
  const dog = new DogFollower(300, 1, world);
  dog.update({ x: 290, y: 0 }, -1, true, dt);
  const start = dog.x;
  for (let frame = 0; frame < 60; frame++) dog.update({ x: 400, y: 0 }, 1, true, dt);
  assert.ok(dog.x > start);
});

test('catches up after a stop without overtaking, then stays idle', () => {
  const dog = new DogFollower(300, 1, world);
  let pose;
  for (let frame = 0; frame < 300; frame++) pose = dog.update({ x: 500, y: 0 }, 0, true, dt);
  assert.ok(Math.abs(dog.x - 448) < 1);
  assert.equal(pose.moving, false);
  assert.equal(pose.sitting, false);
});

test('jumps after a reaction delay and lands independently', () => {
  const dog = new DogFollower(300, 1, world);
  for (let frame = 0; frame < 6; frame++) dog.update({ x: 300, y: -40 }, 0, true, dt);
  assert.equal(dog.y, 0);
  for (let frame = 0; frame < 6; frame++) dog.update({ x: 300, y: -40 }, 0, true, dt);
  assert.ok(dog.y < 0);
  for (let frame = 0; frame < 120; frame++) dog.update({ x: 300, y: 0 }, 0, true, dt);
  assert.equal(dog.y, 0);
  assert.equal(dog.vy, 0);
});

test('sitting while the owner passes takes priority over copying a jump', () => {
  const dog = new DogFollower(300, 1, world);
  for (let frame = 0; frame < 30; frame++) {
    const pose = dog.update({ x: 280, y: -40 }, -1, true, dt);
    assert.equal(pose.y, 0);
    assert.equal(pose.sitting, (frame + 1) * dt >= 0.16);
  }
});

test('disconnection stops movement and large frame gaps cannot cause a teleport', () => {
  const dog = new DogFollower(300, 1, world);
  for (let frame = 0; frame < 60; frame++) dog.update({ x: 600, y: 0 }, 1, true, dt);
  const start = dog.x;
  assert.equal(dog.update({ x: 600, y: 0 }, 1, false, dt).sitting, false);
  assert.equal(dog.x, start);
  dog.update({ x: 1000, y: 0 }, 1, true, 10);
  assert.ok(Math.abs(dog.x - start) <= world.speed * 0.05);
});
