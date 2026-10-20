import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TVController } from '../lib/tv-controller.mjs';
import { LGWebOSAdapter } from '../lib/adapters/lg-webos.mjs';
import { HubStore } from '../lib/hub/store.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';
import { createMovieRequest, MoviePlaybackWorkflow } from '../lib/hub/movie-workflow.mjs';

const HOST = '192.168.77.80', NOW = Date.parse('2026-10-20T00:00:00.000Z');
const flush = async () => { for (let i = 0; i < 36; i++) await Promise.resolve(); };
async function drive(t, pending) {
  let settled = false, value, error;
  pending.then(result => { settled = true; value = result; }, failed => { settled = true; error = failed; });
  for (let i = 0; i < 40 && !settled; i++) { await flush(); if (!settled) t.mock.timers.tick(250); }
  assert.equal(settled, true, 'bounded synthetic sequence must settle'); if (error) throw error; return value;
}
function fixture(t, { failAt, afterSend, holdPointer = false } = {}) {
  const frames = [], requests = [], sockets = []; let allowed = true, closes = 0;
  const client = { registered: false, timeoutMs: 8000, sanitize: value => value,
    async connect() { this.registered = true; }, close() { this.registered = false; closes++; },
    async request(uri) { requests.push(uri); return { returnValue: true, socketPath: `wss://${HOST}:3001/pointer` }; } };
  const controller = new TVController({ host: HOST, ssapClient: client, pointerWebSocketFactory: () => {
    const socket = new EventEmitter(); socket.readyState = 0; sockets.push(socket);
    socket.send = (frame, done) => { frames.push(frame); done(frames.length === failAt ? Error('synthetic send failure') : undefined); afterSend?.(frames.length); };
    socket.terminate = () => { if (socket.readyState !== 3) { socket.readyState = 3; socket.emit('close'); } };
    if (!holdPointer) queueMicrotask(() => { socket.readyState = 1; socket.emit('open'); }); return socket;
  } });
  const adapter = new LGWebOSAdapter({ deviceId: 'fixture-tv', features: ['observer'], config: { host: HOST }, controllerFactory: async () => controller });
  const context = { assertDispatch() { if (!allowed) throw Object.assign(Error('denied'), { code: 'GRANT_REVOKED' }); } };
  t.after(() => adapter.close());
  return { adapter, controller, client, frames, requests, sockets, context, revoke: () => { allowed = false; }, closes: () => closes };
}

test('twelve fixed keys share one queued operation and pointer connection without claiming UI or atomic completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW }); const f = fixture(t);
  const keys = ['LEFT', 'RIGHT', 'UP', 'DOWN', 'ENTER', 'BACK', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'ENTER', 'BACK'];
  const pending = f.adapter.execute({ action: 'navigation.sequence', args: { keys } }, f.context); keys[11] = 'POWER';
  const following = f.adapter.execute({ action: 'navigation.key', args: { key: 'HOME' } }, f.context);
  const result = await drive(t, pending); await drive(t, following);
  assert.equal(result.confirmed, false); assert.equal(result.sequenceComplete, true); assert.equal(result.atomic, false); assert.equal(result.uiVerified, false);
  assert.equal(result.keysRequested, 12); assert.equal(result.keysAttempted, 12); assert.equal(result.transportSentCount, 12); assert.equal(result.uncertain, false);
  assert.equal(result.verificationScope, 'pointer_sequence_transport'); assert.equal(f.sockets.length, 1);
  assert.equal(f.frames.length, 13); assert.match(f.frames[11], /name:BACK/); assert.match(f.frames[12], /name:HOME/);
  assert.equal(Date.now() - NOW, 2750); assert.equal(f.requests.length, 1);
});

test('complete input validation rejects malformed arrays, getters and proxies before creating a controller or sending a prefix', async t => {
  const f = fixture(t); let invoked = 0;
  const accessor = ['LEFT']; Object.defineProperty(accessor, '0', { enumerable: true, get() { invoked++; return 'ENTER'; } });
  const extra = ['LEFT']; extra.endpoint = 'not-allowed';
  const hidden = ['LEFT']; Object.defineProperty(hidden, 'private', { value: true });
  for (const keys of [[], Array(1), Array(13).fill('LEFT'), ['LEFT', 'POWER'], ['left'], ['SEARCH'], extra, hidden, accessor,
    new Proxy(['LEFT'], { ownKeys() { invoked++; return []; } }), Object.assign(['LEFT'], { [Symbol('hidden')]: true })]) {
    await assert.rejects(f.adapter.execute({ action: 'navigation.sequence', args: { keys } }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(invoked, 0); assert.deepEqual(f.requests, []); assert.deepEqual(f.frames, []);
});

test('revocation after one callback stops the suffix and preserves partial progress as uncertain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const f = fixture(t, { afterSend: count => { if (count === 1) f.revoke(); } });
  const result = await drive(t, f.adapter.execute({ action: 'navigation.sequence', args: { keys: ['LEFT', 'RIGHT', 'ENTER'] } }, f.context));
  assert.equal(result.error.code, 'GRANT_REVOKED'); assert.equal(result.transportSentCount, 1); assert.equal(result.keysAttempted, 1);
  assert.equal(result.sequenceComplete, false); assert.equal(result.partial, true); assert.equal(result.uncertain, true); assert.equal(f.frames.length, 1);
  assert.equal(f.requests.length, 1, 'no recovery status read bypasses revoked authority');
});

test('a third-key callback failure records two completed transports and three attempts without replay or suffix', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW }); const f = fixture(t, { failAt: 3 });
  const result = await drive(t, f.adapter.execute({ action: 'navigation.sequence', args: { keys: ['LEFT', 'RIGHT', 'ENTER', 'BACK'] } }, f.context));
  assert.equal(result.transportSentCount, 2); assert.equal(result.keysAttempted, 3); assert.equal(result.uncertain, true); assert.equal(result.partial, true);
  assert.equal(result.sequenceComplete, false); assert.equal(f.frames.length, 3); assert.equal(f.closes(), 1); assert.equal(f.requests.length, 1);
});

test('the earlier Hub or absolute evidence deadline stops remaining keys even when the other deadline is later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  for (const visualFirst of [true, false]) {
    const f = fixture(t), started = Date.now();
    const result = await drive(t, f.adapter.execute({ action: 'navigation.sequence', args: { keys: ['UP', 'DOWN', 'ENTER'],
      notAfter: new Date(started + (visualFirst ? 400 : 10000)).toISOString() } },
    { deadlineAt: new Date(started + (visualFirst ? 10000 : 400)).toISOString(), ...f.context }));
    assert.equal(result.error.code, 'DEADLINE_EXCEEDED'); assert.equal(result.transportSentCount, 2); assert.equal(result.keysAttempted, 2);
    assert.equal(result.sequenceComplete, false); assert.equal(result.uncertain, true); assert.equal(f.frames.length, 2);
  }
});

test('revocation during initial pointer preparation denies every frame after the final handshake check', async t => {
  const f = fixture(t, { holdPointer: true });
  const pending = f.adapter.execute({ action: 'navigation.sequence', args: { keys: ['LEFT', 'ENTER'] } }, f.context);
  const denied = assert.rejects(pending, { code: 'GRANT_REVOKED' }); await flush(); f.revoke();
  f.sockets[0].readyState = 1; f.sockets[0].emit('open'); await denied; assert.deepEqual(f.frames, []);
});

test('aborting between keys preserves the completed prefix and sends no additional key', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW }); const abort = new AbortController();
  const f = fixture(t, { afterSend: count => { if (count === 1) abort.abort(); } });
  const result = await drive(t, f.adapter.execute({ action: 'navigation.sequence', args: { keys: ['LEFT', 'ENTER'] } }, { ...f.context, signal: abort.signal }));
  assert.equal(result.error.code, 'ABORTED'); assert.equal(result.transportSentCount, 1); assert.equal(result.uncertain, true); assert.equal(f.frames.length, 1);
});

test('Hub records partial sequence as unknown and an identical idempotency key never replays its prefix', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW }); const f = fixture(t, { failAt: 3 });
  const store = new HubStore({ filePath: ':memory:' }), runtime = new HubRuntime({ store, ownerTokenHash: tokenHash('O'.repeat(43)),
    devices: [{ id: 'fixture-tv', label: 'Synthetic TV', adapter: f.adapter, config: {} }] });
  t.after(() => runtime.close()); const principal = runtime.authenticate('O'.repeat(43));
  const request = { action: 'navigation.sequence', args: { keys: ['LEFT', 'RIGHT', 'ENTER', 'BACK'] }, idempotencyKey: 'synthetic-sequence' };
  const first = runtime.submit(principal, 'fixture-tv', request);
  const result = await drive(t, runtime.wait(principal, first.operation.id));
  assert.equal(result.state, 'unknown'); assert.equal(result.result.transportSentCount, 2); assert.equal(result.result.keysAttempted, 3);
  assert.equal(runtime.submit(principal, 'fixture-tv', request).created, false); assert.equal(f.frames.length, 3);
});

test('a grant that expires between keys stops the suffix and leaves the Hub operation unknown with its real prefix count', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW }); const f = fixture(t);
  const store = new HubStore({ filePath: ':memory:' }), runtime = new HubRuntime({ store, ownerTokenHash: tokenHash('O'.repeat(43)),
    devices: [{ id: 'fixture-tv', label: 'Synthetic TV', adapter: f.adapter, config: {} }] });
  t.after(() => runtime.close()); const owner = runtime.authenticate('O'.repeat(43));
  const grant = runtime.issueGrant(owner, { label: 'Synthetic sequence', deviceIds: ['fixture-tv'], capabilities: ['navigation.sequence'], expiresAt: new Date(NOW + 400).toISOString() });
  const principal = runtime.authenticate(grant.token), submitted = runtime.submit(principal, 'fixture-tv', {
    action: 'navigation.sequence', args: { keys: ['LEFT', 'RIGHT', 'ENTER'] }, idempotencyKey: 'synthetic-grant-expiry' });
  const result = await drive(t, runtime.wait(owner, submitted.operation.id));
  assert.equal(result.state, 'unknown'); assert.equal(result.result.error.code, 'GRANT_EXPIRED'); assert.equal(result.result.transportSentCount, 2); assert.equal(f.frames.length, 2);
});

test('failure before the final pointer gate reports zero transports despite Hub authorization preflight having run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW }); const f = fixture(t, { holdPointer: true });
  const store = new HubStore({ filePath: ':memory:' }), runtime = new HubRuntime({ store, ownerTokenHash: tokenHash('O'.repeat(43)),
    devices: [{ id: 'fixture-tv', label: 'Synthetic TV', adapter: f.adapter, config: {} }] });
  t.after(() => runtime.close()); const principal = runtime.authenticate('O'.repeat(43));
  const submitted = runtime.submit(principal, 'fixture-tv', { action: 'navigation.sequence', args: { keys: ['LEFT', 'ENTER'] }, idempotencyKey: 'synthetic-no-transport' });
  await flush(); f.sockets[0].emit('error', Error('synthetic handshake failure'));
  const result = await drive(t, runtime.wait(principal, submitted.operation.id));
  assert.equal(result.state, 'failed'); assert.equal(result.result.uncertain, false); assert.equal(result.result.transportSentCount, 0);
  assert.equal(result.result.keysAttempted, 1); assert.equal(result.result.partial, false); assert.deepEqual(f.frames, []);
});

test('a delayed workflow HTTP submission cannot extend frame expiry for the batch suffix', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const f = fixture(t, { afterSend: count => { if (count === 1) t.mock.timers.tick(100); } });
  const store = new HubStore({ filePath: ':memory:' }), runtime = new HubRuntime({ store, ownerTokenHash: tokenHash('O'.repeat(43)),
    devices: [{ id: 'fixture-tv', label: 'Synthetic TV', adapter: f.adapter, config: {} }] });
  t.after(() => runtime.close()); const principal = runtime.authenticate('O'.repeat(43));
  const journal = createMovieRequest({ deviceId: 'fixture-tv', title: 'Frozen', year: 2013, requestId: 'synthetic-visual-deadline' }, NOW);
  journal.stage = 'navigating'; journal.frame = { id: 'synthetic-frame', deviceId: 'fixture-tv', byteLength: 4,
    createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1500).toISOString() };
  journal.observation = { startedAt: new Date(NOW).toISOString(), imageReceivedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString() };
  const submissions = []; let saved;
  const client = { capabilities: async () => runtime.capabilities(principal, 'fixture-tv'), frame: async () => Buffer.from([255, 216, 255, 217]),
    operation: async id => runtime.operation(principal, id),
    submit: async (id, action, args, options) => {
      submissions.push({ action, args, ...options }); t.mock.timers.tick(1200); // Simulated loopback request delay, before Hub receipt.
      return runtime.submit(principal, id, { action, args, ...options });
    } };
  const workflow = new MoviePlaybackWorkflow({ client, journal, save: async value => { saved = value; } });
  await assert.rejects(drive(t, workflow.step({ kind: 'keys', frameId: 'synthetic-frame', screen: 'home', keys: ['LEFT', 'RIGHT', 'ENTER'] })), { code: 'MOVIE_KEY_RECONCILE' });
  assert.equal(submissions.length, 1); assert.equal(submissions[0].timeoutMs, 500); assert.equal(submissions[0].args.notAfter, new Date(NOW + 1500).toISOString());
  assert.equal(f.frames.length, 1); assert.equal(saved.lastOperation.state, 'unknown'); assert.equal(saved.lastOperation.transportSentCount, 1);
  assert.equal(saved.lastOperation.sequenceComplete, false);
});
