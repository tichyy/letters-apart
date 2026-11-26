import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The outbox's only runtime import is randomId; supply a counting one so tests can
// tell requests apart.
const source = await readFile(new URL('../src/postcard-outbox.ts', import.meta.url), 'utf8');
const code = `let ids = 0;
const randomId = () => String(++ids).padStart(32, '0');
${ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace(/^import .*;\n/gm, '')}`;
const { PostcardOutbox } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const card = {
  title: 'Hi', body: 'Wish you were here', stamp: 2, to: 'Babi', from: 'Míša',
  imageId: null, crop: { x: 0.5, y: 0.5, zoom: 1 },
};
const draft = { title: card.title, body: card.body, stamp: card.stamp, to: card.to, from: card.from };

// sessionStorage outlives one outbox: a new outbox on the same storage is a reload.
function storage() {
  const values = new Map();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}
function outbox(store = storage(), accept = () => true) {
  const sent = [];
  const box = new PostcardOutbox(message => { sent.push(structuredClone(message)); return accept(); }, store);
  return { box, sent, store };
}

test('a packed postcard survives a reload and is sent again, under the same request ID', () => {
  const first = outbox();
  first.box.resume('left');
  assert.equal(first.box.submit(card), true);
  const [write] = first.sent;
  assert.equal(write.type, 'write');
  assert.match(write.requestId, /^[0-9a-f]{32}$/);

  const reloaded = outbox(first.store);
  reloaded.box.resume('left');
  assert.equal(reloaded.box.waiting, true);
  assert.deepEqual(reloaded.sent, [write]);
});

test("another home's packed postcard is not sent from this one", () => {
  const first = outbox();
  first.box.resume('left');
  first.box.submit(card);
  const other = outbox(first.store);
  other.box.resume('right');
  assert.equal(other.box.waiting, false);
  assert.deepEqual(other.sent, []);
});

test('a postcard the socket refused is not kept as packed, and the draft stays', () => {
  const { box, store } = outbox(storage(), () => false);
  box.resume('left');
  box.saveDraft(draft);
  assert.equal(box.submit(card), false);
  assert.equal(box.waiting, false);
  assert.equal(store.getItem('letters-pending-write'), null);
  assert.deepEqual(box.readDraft(), draft);
});

test('a postcard keeps waiting while every reconnect fails to reach the server', () => {
  let online = true;
  const first = outbox(storage(), () => online);
  first.box.resume('left');
  first.box.submit(card);
  const requestId = first.sent[0].requestId;
  online = false;
  // Reconnect after reconnect, each send refused.
  for (let attempt = 0; attempt < 20; attempt++) first.box.resume('left');
  assert.equal(first.box.waiting, true);
  assert.equal(first.sent.length, 21);
  assert.ok(first.sent.every(message => message.requestId === requestId), 'retries reuse the request ID');
  // A general error meanwhile doesn't drop it either.
  assert.equal(first.box.fail(), 'unrelated');
  assert.equal(first.box.waiting, true);
  online = true;
  first.box.resume('left');
  assert.equal(first.box.settle(requestId), true);
  assert.equal(first.box.waiting, false);
});

test("the server's answer settles only the request it names", () => {
  const { box, store } = outbox();
  box.resume('left');
  box.saveDraft(draft);
  store.setItem(box.photoDraftKey, '{"id":"x"}');
  box.submit(card);
  const ownId = store.getItem('letters-pending-write') && JSON.parse(store.getItem('letters-pending-write')).message.requestId;
  assert.equal(box.settle('f'.repeat(32)), false);
  assert.equal(box.waiting, true);
  assert.equal(box.settle(ownId), true);
  assert.equal(box.waiting, false);
  // The draft it was written from, photo included, is gone; nothing is sent on reconnect.
  assert.deepEqual([...store.values.keys()], []);
  // Names included: the desk offers the sent card's names for the next one.
  assert.deepEqual(box.readDraft(), { title: '', body: '', stamp: null, to: null, from: null });
});

test('errors: stale answers are ignored, a rejection of ours drops it but keeps the draft', () => {
  const { box, sent, store } = outbox();
  box.resume('left');
  assert.equal(box.fail(), 'final', 'nothing waiting: show the error');
  box.saveDraft(draft);
  box.submit(card);
  const ownId = sent.at(-1).requestId;
  assert.equal(box.fail('f'.repeat(32)), 'stale');
  assert.equal(box.waiting, true);
  assert.equal(box.fail(ownId), 'final');
  assert.equal(box.waiting, false);
  assert.deepEqual(box.readDraft(), draft);
  // A late duplicate of the same rejection no longer matches anything.
  assert.equal(box.fail(ownId), 'stale');
  const reloaded = outbox(store);
  reloaded.box.resume('left');
  assert.deepEqual(reloaded.sent, []);
});

test('a corrupt saved postcard is discarded instead of breaking the connection', () => {
  const store = storage();
  store.setItem('letters-pending-write', '{not json');
  const { box, sent } = outbox(store);
  box.resume('left');
  assert.equal(box.waiting, false);
  assert.deepEqual(sent, []);
  assert.equal(store.getItem('letters-pending-write'), null);
});

test('drafts round-trip, and an unknown saved stamp reads as none', () => {
  const { box, store } = outbox();
  box.saveDraft(draft);
  assert.deepEqual(box.readDraft(), draft);
  // Names cleared on purpose stay cleared, unlike names never saved (null).
  box.saveDraft({ ...draft, to: '', from: '' });
  assert.deepEqual(box.readDraft(), { ...draft, to: '', from: '' });
  box.saveDraft({ ...draft, stamp: null });
  assert.equal(store.getItem('letters-draft-stamp'), null);
  store.setItem('letters-draft-stamp', '7');
  assert.equal(box.readDraft().stamp, null);
});
