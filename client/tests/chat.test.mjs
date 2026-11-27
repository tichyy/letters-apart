import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// chat.ts imports only chat.json (and types); supply the real file in its place.
const config = await readFile(new URL('../../chat.json', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/chat.ts', import.meta.url), 'utf8');
const code = `const chat = ${config};\n${ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace(/^import .*;\n/gm, '')}`;
const { ChatLog, cleanChat, lineLifetime } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const line = (side, id, text, remaining = 5000) => ({ side, id, text, remaining });
const texts = bubble => bubble.lines.map(line => line.text);

test('cleaning matches the server: Czech kept, emoji dropped, whitespace flattened', () => {
  // The same case as tests/test_chat.py.
  assert.equal(cleanChat('Ahoj, jak se máš? Čau 👋\tŽluťoučký\n'), 'Ahoj, jak se máš? Čau  Žluťoučký ');
  assert.equal(cleanChat('č'), 'č');
  assert.equal(cleanChat('x'.repeat(150)), 'x'.repeat(100));
});

test('lifetime grows with length up to ten seconds', () => {
  assert.equal(lineLifetime(''), 4000);
  assert.equal(lineLifetime('x'.repeat(50)), 7000);
  assert.equal(lineLifetime('x'.repeat(100)), 10000);
});

test('a bubble holds three lines, the draft included', () => {
  const log = new ChatLog();
  for (const id of ['1', '2', '3', '4']) log.said(line('right', id, `line ${id}`), 0);
  assert.deepEqual(texts(log.bubble('right', 0)), ['line 2', 'line 3', 'line 4']);
  log.draft('right', 'typing');
  const bubble = log.bubble('right', 0);
  assert.deepEqual(texts(bubble), ['line 3', 'line 4']);
  assert.equal(bubble.draft, 'typing');
});

test('lines fade out and disappear when they expire', () => {
  const log = new ChatLog();
  log.said(line('left', 'a', 'Ahoj', 1000), 0);
  assert.equal(log.bubble('left', 500).lines[0].opacity, 1);
  assert.equal(log.bubble('left', 850).lines[0].opacity, 0.5);
  assert.deepEqual(log.bubble('left', 1000).lines, []);
});

test('the partner saying a line ends their draft', () => {
  const log = new ChatLog();
  log.draft('right', 'Ahoj');
  log.said(line('right', 'a', 'Ahoj'), 0);
  assert.equal(log.bubble('right', 0).draft, null);
});

test('our confirmed line keeps its place and leaves what we type next', () => {
  const log = new ChatLog();
  log.pending('left', 'a', 'first', 0);
  log.pending('left', 'b', 'second', 0);
  log.draft('left', 'third, being typed');
  log.said(line('left', 'a', 'first', 4000), 100);
  const bubble = log.bubble('left', 100);
  assert.deepEqual(texts(bubble), ['first', 'second']);
  assert.equal(bubble.draft, 'third, being typed');
});

test('a refused line leaves every confirmed line in place', () => {
  const log = new ChatLog();
  for (const id of ['1', '2', '3']) log.said(line('left', id, `line ${id}`), 0);
  log.pending('left', 'p', 'too fast', 0);
  assert.deepEqual(texts(log.bubble('left', 0)), ['line 2', 'line 3', 'too fast']);
  log.fail('p');
  assert.deepEqual(texts(log.bubble('left', 0)), ['line 1', 'line 2', 'line 3']);
  // Once confirmed, the server has dropped its oldest line, and so do we.
  log.pending('left', 'q', 'later', 0);
  log.said(line('left', 'q', 'later'), 0);
  log.fail('q');
  assert.deepEqual(texts(log.bubble('left', 0)), ['line 2', 'line 3', 'later']);
});

test('a refused line is taken back; unknown ids are not ours', () => {
  const log = new ChatLog();
  log.pending('left', 'a', 'too fast', 0);
  assert.equal(log.fail('unknown'), false);
  assert.equal(log.fail('a'), true);
  assert.deepEqual(log.bubble('left', 0).lines, []);
  // Confirmed lines are the server's; a late error can't remove them.
  log.said(line('left', 'b', 'kept'), 0);
  assert.equal(log.fail('b'), false);
});

test('a sync replaces everything, with empty drafts meaning nobody is typing', () => {
  const log = new ChatLog();
  log.pending('left', 'old', 'lost in the reconnect', 0);
  log.sync([line('right', 'r', 'still up', 2000)], { left: '', right: 'píšu' }, 0);
  assert.deepEqual(log.bubble('left', 0), { lines: [], draft: null });
  assert.deepEqual(texts(log.bubble('right', 0)), ['still up']);
  assert.equal(log.bubble('right', 0).draft, 'píšu');
  assert.deepEqual(log.bubble('right', 2000).lines, []);
});
