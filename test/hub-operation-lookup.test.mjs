import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HubStore } from '../lib/hub/store.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';
import { HubServer } from '../lib/hub/server.mjs';
import { HubClient } from '../lib/hub/client.mjs';

const OWNER = 'fixture_lookup_owner_abcdefghijklmnopqrstuvwxyz';
const future = () => new Date(Date.now() + 60000).toISOString();

async function fixture(t) {
  const store = new HubStore({ filePath: ':memory:' });
  const effects = [];
  const adapter = {
    supportedActions: ['audio.volume.set', 'screen.observe'],
    subscribe: () => () => {}, start: async () => {}, close: async () => {},
    execute: async (request, context) => { context.assertDispatch(); effects.push(request); return { confirmed: true }; },
  };
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(OWNER), devices: ['tv-one', 'tv-two'].map(id => ({ id, label: id, adapter, config: {} })) });
  await runtime.start();
  const server = new HubServer({ runtime, allowInsecureLoopback: true });
  const address = await server.listen({ port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); });
  const ownerPrincipal = runtime.authenticate(OWNER);
  const owner = new HubClient({ url: address.url, token: OWNER, allowInsecureLoopback: true });
  const grant = (capabilities = ['audio.volume.set'], deviceIds = ['tv-one']) => {
    const issued = runtime.issueGrant(ownerPrincipal, { label: 'Offline lookup fixture', capabilities, deviceIds, expiresAt: future() });
    return { ...issued, principal: runtime.authenticate(issued.token),
      client: new HubClient({ url: address.url, token: issued.token, allowInsecureLoopback: true }) };
  };
  return { ...address, store, runtime, owner, ownerPrincipal, grant, effects };
}

test('HTTP key lookup returns only the original public operation and never dispatches or appends events', async t => {
  const f = await fixture(t), caller = f.grant();
  const key = 'movie:fixed-fixture:1';
  const original = await caller.client.execute('tv-one', 'audio.volume.set', { volume: 27 }, { idempotencyKey: key });
  const before = { events: f.store.events().length, operations: f.store.listOperations().length, effects: f.effects.length };
  const recovered = await caller.client.operationByKey('tv-one', key);
  assert.deepEqual(recovered, original);
  for (const field of ['args', 'requestHash', 'idempotencyKey']) assert.equal(Object.hasOwn(recovered, field), false);
  assert.equal(JSON.stringify(recovered).includes(key), false);
  assert.deepEqual({ events: f.store.events().length, operations: f.store.listOperations().length, effects: f.effects.length }, before);
});

test('key lookup separates clients, exact devices and the owner namespace', async t => {
  const f = await fixture(t), first = f.grant(['audio.volume.set'], ['tv-one', 'tv-two']), second = f.grant();
  const key = 'same-key-private-to-principal';
  const original = await first.client.execute('tv-one', 'audio.volume.set', { volume: 31 }, { idempotencyKey: key });
  for (const [client, deviceId] of [[second.client, 'tv-one'], [first.client, 'tv-two'], [f.owner, 'tv-one']]) {
    await assert.rejects(client.operationByKey(deviceId, key), { code: 'NOT_FOUND', status: 404 });
  }
  const other = await second.client.execute('tv-one', 'audio.volume.set', { volume: 32 }, { idempotencyKey: key });
  assert.notEqual(other.id, original.id);
  assert.equal((await second.client.operationByKey('tv-one', key)).id, other.id);
  assert.equal((await first.client.operationByKey('tv-one', key)).id, original.id);
  assert.equal(f.effects.length, 2);
});

test('current action and device authorization is required when reading an old operation', async t => {
  const f = await fixture(t), caller = f.grant();
  const key = 'lookup-reauthorizes-original-action';
  await caller.client.execute('tv-one', 'audio.volume.set', { volume: 33 }, { idempotencyKey: key });
  const stored = f.store.getGrantByHash(tokenHash(caller.token));
  f.store.putGrant({ ...stored, capabilities: ['state.read'] });
  await assert.rejects(caller.client.operationByKey('tv-one', key), { code: 'ACCESS_DENIED', status: 403 });
  assert.throws(() => f.runtime.operationByKey(caller.principal, 'tv-one', key), { code: 'ACCESS_DENIED' });
  f.store.putGrant({ ...stored, deviceIds: ['tv-two'] });
  await assert.rejects(caller.client.operationByKey('tv-one', key), { code: 'ACCESS_DENIED', status: 403 });
  assert.equal(f.effects.length, 1);
});

test('revocation and expiry stop HTTP and existing-principal key lookups', async t => {
  const f = await fixture(t), revoked = f.grant(), expired = f.grant();
  for (const [caller, key] of [[revoked, 'revoked-operation'], [expired, 'expired-operation']]) await caller.client.execute('tv-one', 'audio.volume.set', { volume: 34 }, { idempotencyKey: key });
  f.runtime.revokeGrant(f.ownerPrincipal, revoked.grant.id);
  await assert.rejects(revoked.client.operationByKey('tv-one', 'revoked-operation'), { code: 'GRANT_REVOKED', status: 403 });
  assert.throws(() => f.runtime.operationByKey(revoked.principal, 'tv-one', 'revoked-operation'), { code: 'GRANT_REVOKED' });
  f.store.putGrant({ ...f.store.getGrantByHash(tokenHash(expired.token)), expiresAt: '2000-01-01T00:00:00.000Z' });
  await assert.rejects(expired.client.operationByKey('tv-one', 'expired-operation'), { code: 'GRANT_EXPIRED', status: 403 });
  assert.throws(() => f.runtime.operationByKey(expired.principal, 'tv-one', 'expired-operation'), { code: 'GRANT_EXPIRED' });
  assert.equal(f.effects.length, 2);
});

test('missing keys return 404 without creating work, while invalid keys and query shapes are rejected', async t => {
  const f = await fixture(t), caller = f.grant();
  await assert.rejects(caller.client.operationByKey('tv-one', 'not-submitted'), { code: 'NOT_FOUND', status: 404 });
  for (const key of ['', 'a'.repeat(129), 'bad/key', 'bad key', 'bad?key', '冰雪奇缘']) {
    assert.throws(() => caller.client.operationByKey('tv-one', key), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => f.runtime.operationByKey(caller.principal, 'tv-one', key), { code: 'INVALID_ARGUMENTS' });
    const response = await fetch(`${f.url}/v1/devices/tv-one/operations/by-key?${new URLSearchParams({ key })}`, { headers: { Authorization: 'Bearer ' + caller.token } });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_ARGUMENTS');
  }
  for (const suffix of ['', '?key=a&key=b', '?key=a&token=not-a-credential', '?other=a', '?key=%ZZ']) {
    const response = await fetch(`${f.url}/v1/devices/tv-one/operations/by-key${suffix}`, { headers: { Authorization: 'Bearer ' + caller.token } });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal((await fetch(`${f.url}/v1/devices/tv-one/operations/by-key?key=not-submitted`)).status, 401);
  assert.equal(f.store.listOperations().length, 0);
  assert.equal(f.effects.length, 0);
});

test('all accepted key syntax including dot-only keys round-trips without URL path normalization', async t => {
  const f = await fixture(t), caller = f.grant();
  for (const key of ['.', '..', ':-._', 'x'.repeat(128)]) {
    const original = await caller.client.execute('tv-one', 'audio.volume.set', { volume: 35 }, { idempotencyKey: key });
    assert.equal((await caller.client.operationByKey('tv-one', key)).id, original.id);
  }
  assert.equal(f.effects.length, 4);
});

test('lookup of an interrupted operation survives frame expiry without new effects or frame access', async t => {
  const f = await fixture(t), caller = f.grant(['screen.observe']);
  const operationId = randomUUID(), frameId = randomUUID(), key = 'lost-observation-response';
  f.store.createOperation({ id: operationId, clientId: caller.grant.id, deviceId: 'tv-one', action: 'screen.observe', args: { screenshot: true }, idempotencyKey: key, requestHash: 'offline-fixture-hash' });
  f.store.updateOperation(operationId, { state: 'running' });
  const frame = f.store.putFrame({ id: frameId, operationId, deviceId: 'tv-one', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg', createdAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:05:00.000Z' });
  f.store.updateOperation(operationId, { state: 'confirmed', result: { frame } });
  assert.equal(f.store.getFrame(frameId), null);
  const result = await caller.client.operationByKey('tv-one', key);
  assert.equal(result.id, operationId); assert.equal(result.result.frame.id, frameId);
  assert.equal(Object.hasOwn(result, 'args'), false);
  assert.equal(f.effects.length, 0);
  assert.equal(f.store.listOperations().length, 1);
  await assert.rejects(caller.client.frame(frameId), { code: 'NOT_FOUND', status: 404 });
});
