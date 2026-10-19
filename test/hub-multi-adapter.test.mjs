import test from 'node:test';
import assert from 'node:assert/strict';
import { HubStore } from '../lib/hub/store.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';

test('device capability intersection blocks cross-adapter commands even for the owner', async t => {
  const store = new HubStore({ filePath: ':memory:' });
  let dispatched = 0;
  const base = { subscribe: () => () => {}, start: async () => {}, close: async () => {}, execute: async (_request, ctx) => { ctx.assertDispatch(); dispatched++; return { requestAccepted: true }; } };
  const token = 'O'.repeat(43);
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(token), devices: [
    { id: 'tv', label: 'TV', adapterName: 'lg-webos', config: {}, adapter: { ...base, supportedActions: ['audio.mute.set'] } },
    { id: 'vacuum', label: 'Vacuum', adapterName: 'ecovacs-x11', config: {}, adapter: { ...base, supportedActions: ['vacuum.pause', 'vacuum.dock'] } },
  ] });
  t.after(() => runtime.close());
  const owner = runtime.authenticate(token);
  await runtime.start();
  assert.deepEqual(Object.keys(runtime.capabilities(owner, 'vacuum').actions), ['vacuum.pause', 'vacuum.dock']);
  assert.equal(runtime.capabilities(owner, 'vacuum').read.includes('screen.read'), false);
  assert.deepEqual(Object.keys(runtime.capabilities(owner, 'tv').actions), ['audio.mute.set']);
  assert.throws(() => runtime.submit(owner, 'tv', { action: 'vacuum.dock', idempotencyKey: 'wrong-device' }), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => runtime.submit(owner, 'vacuum', { action: 'navigation.key', args: { key: 'ENTER' }, idempotencyKey: 'wrong-action' }), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => runtime.issueGrant(owner, { label: 'wrong', deviceIds: ['vacuum'], capabilities: ['audio.mute.set'], expiresAt: new Date(Date.now()+60000).toISOString() }), { code: 'INVALID_ARGUMENTS' });
  const issued = runtime.issueGrant(owner, { label: 'vacuum-only', deviceIds: ['vacuum'], capabilities: ['state.read', 'vacuum.dock'], expiresAt: new Date(Date.now()+60000).toISOString() });
  const client = runtime.authenticate(issued.token);
  assert.throws(() => runtime.submit(client, 'tv', { action: 'audio.mute.set', args: { muted: true }, idempotencyKey: 'cross-device' }), { code: 'ACCESS_DENIED' });
  const op = runtime.submit(client, 'vacuum', { action: 'vacuum.dock', idempotencyKey: 'valid-device' });
  const result = await runtime.wait(client, op.operation.id);
  assert.equal(result.state, 'unconfirmed');
  assert.equal(dispatched, 1);
});
