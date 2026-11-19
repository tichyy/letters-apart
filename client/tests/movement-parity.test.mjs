import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The server's physics generates this fixture (tests/test_movement_parity.py).
// Client prediction must reproduce it exactly, or players rubber-band.
const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/movement.json', import.meta.url), 'utf8'));
const world = JSON.parse(await readFile(new URL('../../world.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/movement.ts', import.meta.url), 'utf8');
const code = `
const world=${JSON.stringify(world)};
const Phaser={Math:{Clamp:(v,a,b)=>Math.max(a,Math.min(b,v))}};
${ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace(/^import .*;\n/gm, '')}`;
const { move } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('client movement matches the server frame for frame', () => {
  let state = fixture.start;
  fixture.inputs.forEach(([direction, jump], frame) => {
    state = move(state, { seq: frame + 1, direction, jump });
    const actual = [state.x, state.y, state.vy, state.jumpChain, state.landingTicks];
    fixture.states[frame].forEach((expected, i) => {
      assert.ok(Math.abs(actual[i] - expected) < 1e-9,
        `frame ${frame} field ${i}: client ${actual[i]} != server ${expected}`);
    });
  });
});
