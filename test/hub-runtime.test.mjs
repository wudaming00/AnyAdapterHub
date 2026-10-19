import test from 'node:test';
import assert from 'node:assert/strict';
import { HubStore } from '../lib/hub/store.mjs';
import { HubRuntime, HubError, tokenHash } from '../lib/hub/runtime.mjs';
import { READ_CAPABILITIES, ACTIONS } from '../lib/hub/policy.mjs';

const ownerToken = 'O'.repeat(43);
function setup(t, adapter = {}) {
  const store = new HubStore({ filePath: ':memory:' });
  const defaults = { subscribe: () => () => {}, start: async () => {}, close: async () => {},
    execute: async (_request, context) => { context.assertDispatch(); return { confirmed: false, requestAccepted: true }; } };
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(ownerToken), devices: [{ id: 'tv', label: 'Test TV',
    config: { allowTemporaryObserver: true }, adapter: { ...defaults, ...adapter } }] });
  t.after(() => runtime.close());
  const owner = runtime.authenticate(ownerToken);
  function grant(capabilities = [...READ_CAPABILITIES, ...Object.keys(ACTIONS)]) {
    const issued = runtime.issueGrant(owner, { label: 'test', deviceIds: ['tv'], capabilities, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    return { ...issued, principal: runtime.authenticate(issued.token) };
  }
  return { store, runtime, owner, grant };
}
const submit = (runtime, principal, key = 'test', timeoutMs = 30000) => runtime.submit(principal, 'tv', { action: 'navigation.key', args: { key: 'ENTER' }, idempotencyKey: key, timeoutMs }).operation;
async function storedFinished(store, id) {
  for (let i = 0; i < 200; i++) { const op = store.getOperation(id); if (!['queued', 'running'].includes(op.state)) return op; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Operation did not finish.');
}

test('revoked grant queued behind another operation never reaches the adapter', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve; }); let calls = 0;
  const { runtime, store, owner, grant } = setup(t, { execute: async (_req, context) => { context.assertDispatch(); calls++; await blocked; return { confirmed: true }; } });
  const first = submit(runtime, owner, 'first');
  await new Promise(resolve => setTimeout(resolve, 5));
  const client = grant(); const second = submit(runtime, client.principal, 'second');
  runtime.revokeGrant(owner, client.grant.id); release();
  await storedFinished(store, first.id);
  assert.equal((await storedFinished(store, second.id)).state, 'cancelled'); assert.equal(calls, 1);
});

test('queued expiry is not dispatched and args are omitted from public operation', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve; }); let calls = 0;
  const { runtime, store, owner } = setup(t, { execute: async (_req, context) => { context.assertDispatch(); calls++; if (calls === 1) await blocked; return { confirmed: false }; } });
  submit(runtime, owner, 'first'); await new Promise(resolve => setTimeout(resolve, 5));
  const second = submit(runtime, owner, 'second', 100);
  await new Promise(resolve => setTimeout(resolve, 130)); release();
  const expired = await storedFinished(store, second.id);
  assert.equal(expired.state, 'expired'); assert.equal(calls, 1);
  assert.equal(Object.hasOwn(runtime.operation(owner, second.id), 'args'), false);
});

test('adapter queue rechecks current grant immediately before first dispatch', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let effects = 0;
  const { runtime, store, owner, grant } = setup(t, { execute: async (_req, context) => { await waiting; context.assertDispatch(); effects++; return { confirmed: true }; } });
  const client = grant(); const operation = submit(runtime, client.principal);
  await new Promise(resolve => setTimeout(resolve, 5)); runtime.revokeGrant(owner, client.grant.id); release();
  assert.equal((await storedFinished(store, operation.id)).state, 'cancelled'); assert.equal(effects, 0);
});

test('failure after any device dispatch is uncertain even if later step loses grant', async t => {
  const { runtime, store, owner } = setup(t, { execute: async (_req, context) => { context.assertDispatch(); throw new HubError('GRANT_REVOKED', 'secret text'); } });
  const operation = submit(runtime, owner);
  const result = await storedFinished(store, operation.id);
  assert.equal(result.state, 'unknown'); assert.doesNotMatch(JSON.stringify(result), /secret text/);
});

test('observation stores bounded frame separately and never treats ACB as title proof', async t => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const { runtime, store, owner, grant } = setup(t, { observe: async (_args, context) => { context.assertDispatch(); return {
    image, mimeType: 'image/jpeg', metadata: { communicationVerified: true, completed: true, overlayClosed: true, restored: true,
      screenshotVerified: true, cleanupVerified: true, sample: { state: 'playing' }, token: 'private' } }; } });
  const client = grant(['screen.observe']);
  const operation = runtime.submit(client.principal, 'tv', { action: 'screen.observe', idempotencyKey: 'capture' }).operation;
  const done = await storedFinished(store, operation.id);
  assert.equal(done.state, 'confirmed'); assert.equal(done.result.titlePlaybackVerified, false);
  assert.equal(done.result.observation.token, '[redacted]'); assert.equal(Object.hasOwn(done.result, 'image'), false);
  assert.throws(() => runtime.frame(client.principal, done.result.frame.id), { code: 'ACCESS_DENIED' });
  assert.deepEqual(runtime.frame(owner, done.result.frame.id).bytes, image);
});

test('restart recovery does not dispatch or replay a durable running operation', async t => {
  let effects = 0;
  const { runtime, store } = setup(t, { execute: async () => { effects++; } });
  store.createOperation({ id: 'previous', clientId: 'owner', deviceId: 'tv', action: 'navigation.key', args: {}, idempotencyKey: 'old', requestHash: 'hash' });
  store.updateOperation('previous', { state: 'running' });
  await runtime.start(); assert.equal(store.getOperation('previous').state, 'unknown'); assert.equal(effects, 0);
});

test('missing screenshot or incomplete cleanup cannot confirm an observation', async t => {
  const { runtime, store, owner } = setup(t, { observe: async (_args, context) => { context.assertDispatch(); return {
    metadata: { communicationVerified: true, completed: true, overlayClosed: true, restored: true, cleanupVerified: true, screenshotVerified: false } }; } });
  const captured = runtime.submit(owner, 'tv', { action: 'screen.observe', idempotencyKey: 'capture' }).operation;
  assert.equal((await storedFinished(store, captured.id)).state, 'unconfirmed');
  const stateOnly = runtime.submit(owner, 'tv', { action: 'screen.observe', args: { screenshot: false }, idempotencyKey: 'state-only' }).operation;
  assert.equal((await storedFinished(store, stateOnly.id)).state, 'confirmed');
});

test('device reports uncertain result as unknown, not successful or safe-to-retry', async t => {
  const { runtime, store, owner } = setup(t, { execute: async (_req, context) => { context.assertDispatch(); return { uncertain: true, confirmed: false, error: { code: 'CONNECTION_CLOSED' } }; } });
  const operation = submit(runtime, owner);
  assert.equal((await storedFinished(store, operation.id)).state, 'unknown');
});

test('retries recover the accepted operation even when the device queue is full', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const { runtime, store, owner } = setup(t, { execute: async (_req, context) => { context.assertDispatch(); await waiting; return { confirmed: true }; } });
  t.after(() => release());
  const first = submit(runtime, owner, 'key0');
  for (let i = 1; i < 16; i++) submit(runtime, owner, 'key' + i);
  assert.throws(() => submit(runtime, owner, 'overflow'), { code: 'BUSY' });
  assert.equal(submit(runtime, owner, 'key0').id, first.id);
  release(); await storedFinished(store, first.id);
});

test('a forged owner flag cannot disclose another client operation', async t => {
  const { runtime, store, owner, grant } = setup(t);
  const operation = submit(runtime, owner);
  await storedFinished(store, operation.id);
  const client = grant();
  assert.throws(() => runtime.operation({ ...client.principal, owner: true }, operation.id), { code: 'NOT_FOUND' });
});

test('shutdown requires owner identity and prevents new device dispatch', async t => {
  const { runtime, owner, grant } = setup(t);
  assert.throws(() => runtime.requestShutdown(grant().principal), { code: 'ACCESS_DENIED' });
  assert.deepEqual(runtime.requestShutdown(owner), { accepted: true });
  assert.throws(() => submit(runtime, owner), { code: 'HUB_CLOSING' });
});
