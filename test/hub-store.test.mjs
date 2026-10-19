import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../lib/hub/store.mjs';

const request = (id, overrides = {}) => ({
  id, clientId: 'client-1', deviceId: 'living-room-tv', action: 'volume.set',
  args: { volume: 20 }, idempotencyKey: `key-${id}`, requestHash: `hash-${id}`,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(), ...overrides,
});

function memoryStore(t) {
  const store = new HubStore({ filePath: ':memory:' });
  t.after(() => store.close());
  return store;
}

function diskStore(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'home-hub-store-'));
  const filePath = path.join(directory, 'private', 'hub.sqlite');
  const store = new HubStore({ filePath });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, filePath };
}

function frame(id, overrides = {}) {
  return {
    id, deviceId: 'living-room-tv', operationId: null,
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

test('snapshots and ordered event cursors survive reopening without sharing mutable input', t => {
  const { store, filePath } = diskStore(t);
  const snapshot = { revision: 2, observed: { volume: 20 } };
  assert.deepEqual(store.putSnapshot('tv', snapshot), snapshot);
  snapshot.observed.volume = 99;
  const first = store.appendEvent({ type: 'device.observed', deviceId: 'tv', data: { revision: 2 } });
  const second = store.appendEvent({ type: 'device.observed', deviceId: 'other', data: { revision: 3 } });
  assert.equal(store.events({ afterId: first.id, limit: 1 })[0].id, second.id);
  assert.deepEqual(store.events({ deviceIds: ['tv'] }).map(event => event.id), [first.id]);
  assert.deepEqual(store.events({ deviceIds: [] }), []);
  store.close();
  const reopened = new HubStore({ filePath });
  try {
    assert.deepEqual(reopened.getSnapshot('tv'), { revision: 2, observed: { volume: 20 } });
    assert.equal(reopened.events().length, 2);
    assert.equal(reopened.getSnapshot('missing'), null);
    if (process.platform !== 'win32') assert.equal(statSync(filePath).mode & 0o777, 0o600);
  } finally { reopened.close(); }
});

test('idempotency is scoped to the client, preserves original clocks, and rejects a different request hash', t => {
  const store = memoryStore(t);
  const initial = store.createOperation(request('a', { idempotencyKey: 'same-key' }));
  const duplicate = store.createOperation(request('different-id', { idempotencyKey: 'same-key', requestHash: 'hash-a' }));
  assert.equal(initial.created, true);
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.operation, initial.operation);
  assert.equal(store.events().length, 1);
  assert.throws(() => store.createOperation(request('conflict', { idempotencyKey: 'same-key' })), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(store.createOperation(request('other-client', { clientId: 'client-2', idempotencyKey: 'same-key' })).created, true);
  assert.equal(store.getOperation('different-id'), null);
});

test('idempotency lookup is read-only, client-scoped, and binds opaque keys as SQL values', t => {
  const store = memoryStore(t);
  const key = "key'); DROP TABLE operations; --";
  const original = store.createOperation(request('lookup', { idempotencyKey: key })).operation;
  const before = store.events();
  assert.deepEqual(store.findOperationByIdempotency('client-1', key), original);
  assert.equal(store.findOperationByIdempotency('client-2', key), null);
  assert.equal(store.findOperationByIdempotency('client-1', 'missing'), null);
  assert.deepEqual(store.events(), before);
  assert.throws(() => store.findOperationByIdempotency('', key), { code: 'INVALID_INPUT' });
  assert.throws(() => store.findOperationByIdempotency('client-1', null), { code: 'INVALID_INPUT' });
});

test('operation state and its journal entry commit or roll back together', t => {
  const { store, filePath } = diskStore(t);
  const inspection = new DatabaseSync(filePath);
  try {
    inspection.exec("CREATE TRIGGER refuse_creation BEFORE INSERT ON events WHEN NEW.type = 'operation.created' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => store.createOperation(request('atomic')), { code: 'STORE_FAILURE' });
    assert.equal(store.getOperation('atomic'), null);
    assert.equal(store.events().length, 0);
    inspection.exec('DROP TRIGGER refuse_creation');
    store.createOperation(request('atomic'));
    inspection.exec("CREATE TRIGGER refuse_update BEFORE INSERT ON events WHEN NEW.type = 'operation.updated' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => store.updateOperation('atomic', { state: 'running' }), { code: 'STORE_FAILURE' });
    assert.equal(store.getOperation('atomic').state, 'queued');
    assert.equal(store.events().length, 1);
  } finally { inspection.close(); }
});

test('operation updates preserve execution clocks, allow later evidence, and reject unknown patch fields', t => {
  const store = memoryStore(t);
  const original = store.createOperation(request('clock')).operation;
  const running = store.updateOperation('clock', { state: 'running' });
  assert.ok(running.startedAt);
  const unknown = store.updateOperation('clock', { state: 'unknown', error: { code: 'TIMEOUT' } });
  const confirmed = store.updateOperation('clock', {
    state: 'confirmed', result: { volume: 20 }, startedAt: '2001-01-01T00:00:00.000Z', finishedAt: '2002-01-01T00:00:00.000Z',
  });
  assert.equal(confirmed.createdAt, original.createdAt);
  assert.equal(confirmed.startedAt, running.startedAt);
  assert.equal(confirmed.finishedAt, unknown.finishedAt);
  assert.equal(store.events().at(-1).data.previousState, 'unknown');
  assert.throws(() => store.updateOperation('clock', { state: 'done' }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.updateOperation('clock', { state: undefined }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.updateOperation('clock', { createdAt: '2001-01-01' }), { code: 'INVALID_INPUT' });
  assert.equal(store.updateOperation('absent', { state: 'failed' }), null);
});

test('restart recovery cancels undispatched commands and marks interrupted execution unknown without replay', t => {
  const { store, filePath } = diskStore(t);
  store.createOperation(request('queued'));
  store.createOperation(request('running'));
  const running = store.updateOperation('running', { state: 'running' });
  store.createOperation(request('finished'));
  store.updateOperation('finished', { state: 'confirmed', result: { verified: true } });
  store.close();
  const reopened = new HubStore({ filePath });
  try {
    const recovered = reopened.recoverInterrupted();
    assert.equal(recovered.length, 2);
    assert.equal(reopened.getOperation('queued').state, 'cancelled');
    assert.equal(reopened.getOperation('running').state, 'unknown');
    assert.equal(reopened.getOperation('running').startedAt, running.startedAt);
    assert.equal(reopened.getOperation('finished').state, 'confirmed');
    assert.ok(recovered.every(operation => operation.error.code === 'HUB_RESTARTED'));
    assert.equal(reopened.events().filter(event => event.type === 'operation.recovered').length, 2);
    assert.deepEqual(reopened.recoverInterrupted(), []);
  } finally { reopened.close(); }
});

test('operation listing filters devices and inputs are bound SQL parameters', t => {
  const store = memoryStore(t);
  const deviceId = "tv'); DROP TABLE operations; --";
  store.createOperation(request('one', { deviceId }));
  store.createOperation(request('two', { deviceId: 'second-tv' }));
  assert.deepEqual(store.listOperations({ deviceId }).map(operation => operation.id), ['one']);
  assert.equal(store.listOperations({ limit: 1 })[0].id, 'two');
  store.putSnapshot(deviceId, { safe: true });
  assert.deepEqual(store.getSnapshot(deviceId), { safe: true });
});

test('grant metadata never exposes the token hash and revocation survives reopening', t => {
  const { store, filePath } = diskStore(t);
  const tokenHash = 'fixture-private-token-hash';
  const metadata = store.putGrant({
    id: 'grant-1', tokenHash, label: 'Local assistant', deviceIds: ['tv'], capabilities: ['observe'],
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null,
  });
  assert.equal('tokenHash' in metadata, false);
  assert.equal(JSON.stringify(store.listGrants()).includes(tokenHash), false);
  assert.equal(store.getGrantByHash(tokenHash).id, 'grant-1');
  const revoked = store.revokeGrant('grant-1');
  assert.ok(revoked.revokedAt);
  assert.equal('tokenHash' in revoked, false);
  assert.equal(store.revokeGrant('grant-1').revokedAt, revoked.revokedAt);
  store.close();
  const reopened = new HubStore({ filePath });
  try {
    assert.equal(reopened.getGrantByHash(tokenHash).revokedAt, revoked.revokedAt);
    assert.equal(reopened.getGrantByHash('absent'), null);
  } finally { reopened.close(); }
});

test('JPEG frames are copied, expire, and retain only the latest five per device', t => {
  const store = memoryStore(t);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const metadata = store.putFrame(frame('copy', { bytes }));
  assert.equal(metadata.byteLength, 4);
  assert.equal('bytes' in metadata, false);
  bytes[0] = 0;
  const saved = store.getFrame('copy');
  assert.ok(Buffer.isBuffer(saved.bytes));
  assert.equal(saved.bytes[0], 0xff);
  saved.bytes[0] = 0;
  assert.equal(store.getFrame('copy').bytes[0], 0xff);
  for (let i = 0; i < 6; i += 1) store.putFrame(frame(`frame-${i}`));
  assert.equal(store.getFrame('copy'), null);
  assert.equal(store.getFrame('frame-0'), null);
  assert.ok(store.getFrame('frame-5'));
  store.putFrame(frame('expired', { createdAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-02T00:00:00Z' }));
  assert.equal(store.getFrame('expired'), null);
  assert.equal(store.pruneFrames({ perDevice: 2 }), 3);
  assert.equal(store.getFrame('frame-3'), null);
  assert.ok(store.getFrame('frame-4'));
});

test('frame retention caps payloads at 32 MiB and refuses oversized individual frames', t => {
  const store = memoryStore(t);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0xff);
  for (let i = 0; i < 5; i += 1) store.putFrame(frame(`large-${i}`, { deviceId: `tv-${i}`, bytes }));
  assert.equal(store.getFrame('large-0'), null);
  assert.ok(store.getFrame('large-1'));
  assert.equal(store.pruneFrames({ maxBytes: 8 * 1024 * 1024 }), 3);
  assert.ok(store.getFrame('large-4'));
  assert.throws(() => store.putFrame(frame('too-large', { bytes: Buffer.alloc(10 * 1024 * 1024 + 1) })), { code: 'INVALID_INPUT' });
  assert.throws(() => store.putFrame(frame('wrong-type', { mimeType: 'text/html' })), { code: 'INVALID_INPUT' });
  assert.throws(() => store.pruneFrames({ maxBytes: 33 * 1024 * 1024 }), { code: 'INVALID_INPUT' });
});

test('bounded JSON and sanitized errors do not reflect private input', t => {
  const store = memoryStore(t);
  const privateText = 'fixture-sensitive-value';
  const oversized = privateText.repeat(20_000);
  assert.throws(() => store.putSnapshot('tv', { body: oversized }), error => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.equal(error.message.includes(privateText), false);
    return true;
  });
  assert.throws(() => store.createOperation(request('oversized', { args: { body: oversized } })), { code: 'INVALID_INPUT' });
  assert.equal(store.getOperation('oversized'), null);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => store.appendEvent({ type: 'fixture', data: cycle }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.events({ afterId: -1 }), { code: 'INVALID_INPUT' });
  store.close();
  assert.throws(() => store.events(), { code: 'STORE_CLOSED' });
  store.close();
});

test('event retention keeps the newest 10000 entries without discarding operation idempotency', t => {
  const { store, filePath } = diskStore(t);
  const original = store.createOperation(request('retained-operation')).operation;
  const inspection = new DatabaseSync(filePath);
  try {
    // Seed the boundary efficiently; the next public write must enforce retention.
    inspection.exec('BEGIN');
    const insert = inspection.prepare('INSERT INTO events(type, device_id, operation_id, data, at) VALUES (?, ?, ?, ?, ?)');
    for (let index = 0; index < 10000; index += 1) insert.run('fixture.seed', 'tv', null, '{}', '2020-01-01T00:00:00.000Z');
    inspection.exec('COMMIT');
    const latest = store.appendEvent({ type: 'fixture.latest', deviceId: 'tv' });
    const count = inspection.prepare('SELECT COUNT(*) AS count FROM events').get().count;
    assert.equal(count, 10000);
    assert.ok(store.events({ limit: 1 })[0].id > 1);
    assert.equal(inspection.prepare('SELECT MAX(id) AS id FROM events').get().id, latest.id);
    assert.deepEqual(store.getOperation(original.id), original);
    const duplicate = store.createOperation(request('new-id', {
      idempotencyKey: original.idempotencyKey, requestHash: original.requestHash,
    }));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.operation.id, original.id);
    assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM operations').get().count, 1);
  } finally { inspection.close(); }
});
