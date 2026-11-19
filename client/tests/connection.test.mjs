import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// A phone opening the camera backgrounds the page; the server then drops the game
// connection. These tests drive the real Connection with a fake socket and fetch.
const source = await readFile(new URL('../src/connection.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { Connection } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const sockets = [];
class FakeSocket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  deliver(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
const storage = new Map();
Object.assign(globalThis, {
  window: globalThis,
  WebSocket: FakeSocket,
  location: { protocol: 'https:', host: 'game.test', assign() {} },
  sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
});
const welcome = { type: 'welcome', side: 'left', players: [] };
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (status, body = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(t, responses) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  sockets.length = 0;
  // A fresh document per test: earlier connections must not hear this test's events.
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  const requests = [];
  globalThis.fetch = async (path, options) => {
    requests.push({ path, options });
    return responses.shift() ?? response(500);
  };
  const connection = new Connection(() => {}, () => {});
  connection.connect('left');
  return { connection, requests };
}

const join = socket => { socket.open(); socket.deliver(welcome); };
const file = new Blob(['photo']);

test('a photo chosen while reconnecting waits for the connection, then uploads', async t => {
  const { connection, requests } = setup(t, [response(200, { id: 'a'.repeat(32), width: 1, height: 1 })]);
  const upload = connection.uploadPhoto(file, 'a'.repeat(32), new AbortController().signal);
  await settle();
  assert.equal(requests.length, 0, 'does not fail or send before the game connection is live');
  join(sockets[0]);
  assert.equal((await upload).id, 'a'.repeat(32));
  assert.equal(requests.length, 1);
});

test('the token goes in a hello message, not the socket URL', async t => {
  setup(t, []);
  sockets[0].open();
  assert.ok(!sockets[0].url.includes('token'));
  assert.equal(sockets[0].sent[0].type, 'hello');
});

test('a session the server dropped is reconnected and the upload retried once', async t => {
  const { connection, requests } = setup(t, [
    response(401, { detail: 'Reconnect to the game to use photos.' }),
    response(200, { id: 'b'.repeat(32), width: 1, height: 1 }),
  ]);
  join(sockets[0]);
  const upload = connection.uploadPhoto(file, 'b'.repeat(32), new AbortController().signal);
  await settle();
  assert.equal(sockets.length, 2, 'reconnects after the 401');
  join(sockets[1]);
  assert.equal((await upload).id, 'b'.repeat(32));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.get('X-Upload-ID'), 'b'.repeat(32), 'the retry reuses the upload ID');
});

test('a server that keeps refusing gets one retry, then a clear error', async t => {
  const { connection, requests } = setup(t, [
    response(401, { detail: 'Reconnect to the game to use photos.' }),
    response(401, { detail: 'Reconnect to the game to use photos.' }),
    response(401, { detail: 'Reconnect to the game to use photos.' }),
  ]);
  join(sockets[0]);
  const upload = connection.uploadPhoto(file, 'c'.repeat(32), new AbortController().signal);
  await settle();
  join(sockets[1]);
  await assert.rejects(upload, /Reconnect to the game to use photos/);
  assert.equal(requests.length, 2, 'no retry loop');
});

test('if the connection never comes back, the photo fails after 15 seconds', async t => {
  const { connection, requests } = setup(t, []);
  const upload = connection.uploadPhoto(file, 'd'.repeat(32), new AbortController().signal);
  const failure = assert.rejects(upload, /Reconnect to the game to use photos/);
  await settle();
  t.mock.timers.tick(15000);
  await failure;
  assert.equal(requests.length, 0);
});

test('cancelling while waiting for the connection stops the request', async t => {
  const { connection, requests } = setup(t, []);
  const controller = new AbortController();
  const upload = connection.uploadPhoto(file, 'e'.repeat(32), controller.signal);
  controller.abort();
  await assert.rejects(upload, { name: 'AbortError' });
  join(sockets[0]);
  await settle();
  assert.equal(requests.length, 0);
});

test('returning to a page whose socket went quiet reconnects at once', async t => {
  const { connection } = setup(t, []);
  join(sockets[0]);
  t.mock.timers.tick(1500); // hidden: no messages arrived
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sockets.length, 2);
  assert.equal(connection.ready, false);
});

test('a request cancelled before it starts fails at once, even while disconnected', async t => {
  const { connection, requests } = setup(t, []);
  const controller = new AbortController();
  controller.abort();
  // No timers advance: it must reject without waiting out the reconnect timeout.
  await assert.rejects(connection.uploadPhoto(file, 'f'.repeat(32), controller.signal), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});
