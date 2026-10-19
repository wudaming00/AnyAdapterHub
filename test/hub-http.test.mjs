import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HubStore } from '../lib/hub/store.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';
import { HubServer } from '../lib/hub/server.mjs';
import { HubClient } from '../lib/hub/client.mjs';

const OWNER_TOKEN = 'fixture_owner_credential_abcdefghijklmnopqrstuvwxyz';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const future = () => new Date(Date.now() + 60_000).toISOString();
const grantRequest = (capabilities, deviceIds = ['tv-one']) => ({
  label: 'Offline integration fixture', deviceIds, capabilities, expiresAt: future(),
});

class FakeAdapter {
  listeners = new Set();
  calls = [];
  observations = [];
  constructor(deviceId) { this.deviceId = deviceId; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emitState(fields = {}) {
    const data = {
      deviceId: this.deviceId, connection: { phase: 'connected' }, assembledAt: new Date().toISOString(),
      fields: { volume: { value: 20, observedAt: new Date().toISOString(), expiresAt: future(), source: 'fake' }, ...fields },
    };
    for (const listener of this.listeners) listener({ type: 'device.state', deviceId: this.deviceId, data });
  }
  async start() { this.emitState(); }
  async execute(command, context) {
    context.assertDispatch();
    this.calls.push(command);
    return { confirmed: true, verification: 'fake-observed-state', value: command.args.volume ?? null };
  }
  async observe(args, context) {
    context.assertDispatch();
    this.observations.push(args);
    return {
      image: args.screenshot ? JPEG : null, mimeType: 'image/jpeg',
      metadata: {
        communicationVerified: true, completed: true, overlayClosed: true, restored: true,
        screenshotVerified: true, cleanupVerified: true, foregroundApp: 'com.example.video',
      },
    };
  }
  async close() { this.closed = true; }
}

async function fixture(t) {
  const store = new HubStore({ filePath: ':memory:' });
  const first = new FakeAdapter('tv-one');
  const second = new FakeAdapter('tv-two');
  const runtime = new HubRuntime({
    store, ownerTokenHash: tokenHash(OWNER_TOKEN),
    devices: [first, second].map(adapter => ({
      id: adapter.deviceId, label: adapter.deviceId, adapter,
      adapterName: 'offline-fixture', config: { allowTemporaryObserver: true, allowedUrlOrigins: ['https://media.example'] },
    })),
  });
  await runtime.start({ pollMs: 60_000 });
  let shutdownCalls = 0;
  const server = new HubServer({ allowInsecureLoopback: true, runtime, onShutdown: () => { shutdownCalls++; } });
  const address = await server.listen({ port: 0 });
  const owner = new HubClient({ allowInsecureLoopback: true, url: address.url, token: OWNER_TOKEN });
  t.after(async () => { await server.close(); await runtime.close(); });
  async function grant(capabilities, deviceIds) {
    const issued = await owner.issueGrant(grantRequest(capabilities, deviceIds));
    return { ...issued, client: new HubClient({ allowInsecureLoopback: true, url: address.url, token: issued.token }) };
  }
  return { store, runtime, server, owner, first, second, grant, get shutdownCalls() { return shutdownCalls; }, ...address };
}

function rawRequest(port, target, { method = 'GET', token, headers = {}, value, rawBody } = {}) {
  const payload = rawBody ?? (value === undefined ? undefined : JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: target, method,
      headers: { Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let body;
        try { body = JSON.parse(bytes.toString('utf8')); } catch { body = null; }
        resolve({ status: response.statusCode, headers: response.headers, bytes, body });
      });
      response.on('error', reject);
    });
    request.setTimeout(3000, () => request.destroy(new Error('Offline hub fixture HTTP timeout.')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function bounded(promise, milliseconds = 2500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Offline hub fixture event timeout.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('unready runtime refuses API work until recovery has completed', async t => {
  const store = new HubStore({ filePath: ':memory:' }); const adapter = new FakeAdapter('tv-one');
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(OWNER_TOKEN), devices: [{ id: 'tv-one', label: 'TV', adapter, config: {} }] });
  const server = new HubServer({ allowInsecureLoopback: true, runtime }); const address = await server.listen({ port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); });
  assert.equal((await rawRequest(address.port, '/health')).status, 503);
  assert.equal((await rawRequest(address.port, '/v1/devices', { token: OWNER_TOKEN })).status, 503);
  assert.equal(adapter.calls.length, 0);
  await runtime.start(); assert.equal((await rawRequest(address.port, '/health')).status, 200);
});

test('shutdown endpoint permits only owner identity and stops accepting new work immediately', async t => {
  const hub = await fixture(t); const reader = await hub.grant(['state.read']);
  await assert.rejects(reader.client.shutdown(), { code: 'ACCESS_DENIED' });
  assert.deepEqual(await hub.owner.shutdown(), { accepted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.shutdownCalls, 1);
  assert.equal((await rawRequest(hub.port, '/v1/devices', { token: OWNER_TOKEN })).status, 503);
});

test('HTTP health is public while missing, malformed and unknown bearer credentials cannot access devices', async t => {
  const hub = await fixture(t);
  assert.equal((await rawRequest(hub.port, '/health')).status, 200);
  for (const options of [{}, { headers: { Authorization: 'Bearer short' } }, { token: 'unknown_fixture_credential_abcdefghijklmnopqrstuvwxyz' }]) {
    const denied = await rawRequest(hub.port, '/v1/devices', options);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, 'UNAUTHORIZED');
  }
  assert.equal(hub.first.calls.length, 0);
});

test('a scoped state reader sees only its device and cannot control, capture, or retrieve an existing image', async t => {
  const hub = await fixture(t);
  const { client } = await hub.grant(['state.read']);
  assert.deepEqual((await client.devices()).devices.map(device => device.id), ['tv-one']);
  await assert.rejects(client.state('tv-two'), { code: 'ACCESS_DENIED', status: 403 });
  await assert.rejects(client.submit('tv-one', 'audio.volume.set', { volume: 21 }), { code: 'ACCESS_DENIED', status: 403 });
  await assert.rejects(client.submit('tv-one', 'screen.observe', { screenshot: true }), { code: 'ACCESS_DENIED', status: 403 });
  const observed = await hub.owner.execute('tv-one', 'screen.observe', { screenshot: true });
  assert.equal(observed.state, 'confirmed');
  await assert.rejects(client.frame(observed.result.frame.id), { code: 'ACCESS_DENIED', status: 403 });
  assert.equal(hub.first.calls.length, 0);
  assert.equal(hub.first.observations.length, 1);
  assert.deepEqual((await client.capabilities('tv-one')).read, ['state.read']);
  assert.deepEqual((await client.capabilities('tv-one')).actions, {});
});

test('state responses recompute stale flags from evidence expiry without changing stored evidence', async t => {
  const hub = await fixture(t);
  const { client } = await hub.grant(['state.read']);
  hub.first.emitState({
    fresh: { value: 'recent', observedAt: new Date().toISOString(), expiresAt: future(), source: 'fake' },
    old: { value: 'last-known', observedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:01.000Z', source: 'fake' },
    undated: { value: 'unknown-age', source: 'fake' },
  });
  const state = await client.state('tv-one');
  assert.equal(state.fields.fresh.stale, false);
  assert.equal(state.fields.old.stale, true);
  assert.equal(state.fields.undated.stale, true);
  assert.equal(state.fields.old.value, 'last-known');
  assert.equal(Object.hasOwn(hub.store.getSnapshot('tv-one').fields.old, 'stale'), false);
});

test('scoped HTTP control executes only the exact permitted action and device', async t => {
  const hub = await fixture(t);
  const { client } = await hub.grant(['audio.volume.set']);
  const operation = await client.execute('tv-one', 'audio.volume.set', { volume: 31 });
  assert.equal(operation.state, 'confirmed');
  assert.equal(operation.result.value, 31);
  assert.deepEqual(hub.first.calls, [{ action: 'audio.volume.set', args: { volume: 31 } }]);
  await assert.rejects(client.submit('tv-one', 'audio.mute.set', { muted: true }), { code: 'ACCESS_DENIED', status: 403 });
  await assert.rejects(client.submit('tv-two', 'audio.volume.set', { volume: 32 }), { code: 'ACCESS_DENIED', status: 403 });
  assert.equal(hub.second.calls.length, 0);
});

test('capture permission and image-read permission are separately enforced', async t => {
  const hub = await fixture(t);
  const captureOnly = await hub.grant(['screen.observe']);
  const observed = await captureOnly.client.execute('tv-one', 'screen.observe', { screenshot: true });
  assert.equal(observed.state, 'confirmed');
  assert.equal(observed.result.observation.cleanupVerified, true);
  await assert.rejects(captureOnly.client.frame(observed.result.frame.id), { code: 'ACCESS_DENIED', status: 403 });
  const imageReader = await hub.grant(['screen.read']);
  assert.deepEqual(await imageReader.client.frame(observed.result.frame.id), JPEG);
  await assert.rejects(imageReader.client.submit('tv-one', 'screen.observe', {}), { code: 'ACCESS_DENIED', status: 403 });
  const response = await rawRequest(hub.port, `/v1/frames/${observed.result.frame.id}`, { token: imageReader.token });
  assert.equal(response.headers['content-type'], 'image/jpeg');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('duplicate HTTP submissions execute once and a changed request conflicts without another dispatch', async t => {
  const hub = await fixture(t);
  const { client } = await hub.grant(['audio.volume.set']);
  const options = { idempotencyKey: 'same-request', timeoutMs: 5000 };
  const submissions = await Promise.all([
    client.submit('tv-one', 'audio.volume.set', { volume: 40 }, options),
    client.submit('tv-one', 'audio.volume.set', { volume: 40 }, options),
  ]);
  assert.equal(submissions[0].operation.id, submissions[1].operation.id);
  assert.deepEqual(submissions.map(result => result.created).sort(), [false, true]);
  const finished = await client.execute('tv-one', 'audio.volume.set', { volume: 40 }, options);
  assert.equal(finished.state, 'confirmed');
  assert.equal(hub.first.calls.length, 1);
  await assert.rejects(client.submit('tv-one', 'audio.volume.set', { volume: 41 }, options), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  assert.equal(hub.first.calls.length, 1);
  for (const field of ['args', 'requestHash', 'idempotencyKey']) assert.equal(Object.hasOwn(finished, field), false);
});

test('operation evidence is private to its submitting client while the owner can inspect it', async t => {
  const hub = await fixture(t);
  const first = await hub.grant(['audio.volume.set']);
  const second = await hub.grant(['audio.volume.set']);
  const operation = await first.client.execute('tv-one', 'audio.volume.set', { volume: 45 });
  await assert.rejects(second.client.operation(operation.id), { code: 'NOT_FOUND', status: 404 });
  assert.equal((await first.client.operation(operation.id)).id, operation.id);
  assert.equal((await hub.owner.operation(operation.id)).id, operation.id);
});

test('only owner credentials can list, issue and revoke grants, and revocation immediately blocks HTTP use', async t => {
  const hub = await fixture(t);
  const issued = await hub.grant(['state.read']);
  assert.equal(typeof issued.token, 'string');
  const listed = await hub.owner.grants();
  assert.equal(listed.grants.length, 1);
  assert.equal(JSON.stringify(listed).includes(issued.token), false);
  assert.equal(JSON.stringify(listed).includes(tokenHash(issued.token)), false);
  await assert.rejects(issued.client.grants(), { code: 'ACCESS_DENIED', status: 403 });
  await assert.rejects(issued.client.issueGrant(grantRequest(['state.read'])), { code: 'ACCESS_DENIED', status: 403 });
  await assert.rejects(issued.client.revokeGrant(issued.grant.id), { code: 'ACCESS_DENIED', status: 403 });
  const revoked = await hub.owner.revokeGrant(issued.grant.id);
  assert.ok(revoked.revokedAt);
  await assert.rejects(issued.client.devices(), { code: 'GRANT_REVOKED', status: 403 });
});

test('expired grants are rejected by the HTTP authentication boundary', async t => {
  const hub = await fixture(t);
  const issued = await hub.grant(['state.read']);
  hub.store.putGrant({ ...issued.grant, tokenHash: tokenHash(issued.token), expiresAt: '2020-01-01T00:00:00.000Z' });
  await assert.rejects(issued.client.devices(), { code: 'GRANT_EXPIRED', status: 403 });
});

test('SSE sends scoped events with cursors and closes an existing stream after grant revocation', async t => {
  const hub = await fixture(t);
  const issued = await hub.grant(['events.read']);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const iterator = issued.client.events({ signal: controller.signal })[Symbol.asyncIterator]();
  const initial = await bounded(iterator.next());
  assert.equal(initial.done, false);
  assert.equal(initial.value.deviceId, 'tv-one');
  assert.equal(initial.value.type, 'device.state');
  const cursor = initial.value.id;
  hub.second.emitState({ unrelated: { value: 'must-not-leak', expiresAt: future() } });
  hub.first.emitState({ changed: { value: 99, expiresAt: future() } });
  const next = await bounded(iterator.next());
  assert.equal(next.value.deviceId, 'tv-one');
  assert.ok(next.value.id > cursor);
  assert.equal(next.value.data.fields.changed.value, 99);
  await hub.owner.revokeGrant(issued.grant.id);
  assert.deepEqual(await bounded(iterator.next()), { value: undefined, done: true });
});

test('SSE cursor replay excludes earlier events and state-only grants cannot open the stream', async t => {
  const hub = await fixture(t);
  const stateOnly = await hub.grant(['state.read']);
  const denied = await rawRequest(hub.port, '/v1/events', { token: stateOnly.token });
  assert.equal(denied.status, 403);
  const reader = await hub.grant(['events.read']);
  const firstId = hub.store.events({ deviceIds: ['tv-one'] }).at(-1).id;
  hub.first.emitState({ replay: { value: 'newer', expiresAt: future() } });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const iterator = reader.client.events({ afterId: firstId, signal: controller.signal })[Symbol.asyncIterator]();
  const event = await bounded(iterator.next());
  assert.ok(event.value.id > firstId);
  assert.equal(event.value.data.fields.replay.value, 'newer');
  controller.abort();
  await iterator.return().catch(error => assert.equal(error.name, 'AbortError'));
});

test('SSE replays more than a full output buffer and batch, then continues delivering live events', async t => {
  const hub = await fixture(t);
  const reader = await hub.grant(['events.read']);
  const afterId = hub.store.events({ deviceIds: ['tv-one'] }).at(-1).id;
  const count = 150;
  for (let sequence = 0; sequence < count; sequence++) hub.store.appendEvent({
    type: 'device.state', deviceId: 'tv-one', data: { sequence, padding: 'x'.repeat(16 * 1024) },
  });
  const controller = new AbortController();
  const iterator = reader.client.events({ afterId, signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await bounded((async () => {
      let last = afterId;
      for (let sequence = 0; sequence < count; sequence++) {
        const event = await iterator.next();
        assert.equal(event.done, false, `replay ended at event ${sequence}`);
        assert.equal(event.value.deviceId, 'tv-one');
        assert.equal(event.value.data.sequence, sequence);
        assert.ok(event.value.id > last);
        last = event.value.id;
      }
    })(), 6000);
    hub.first.emitState({ liveAfterReplay: { value: 'still-connected', expiresAt: future() } });
    const live = await bounded(iterator.next());
    assert.equal(live.done, false);
    assert.equal(live.value.data.fields.liveAfterReplay.value, 'still-connected');
  } finally {
    controller.abort(); await iterator.return().catch(() => {});
  }
});

test('an authorized empty SSE replay flushes response headers immediately', async t => {
  const hub = await fixture(t);
  const reader = await hub.grant(['events.read']);
  const afterId = hub.store.events({ deviceIds: ['tv-one'] }).at(-1).id;
  const controller = new AbortController();
  let response;
  try {
    response = await bounded(fetch(`${hub.url}/v1/events?after=${afterId}`, {
      headers: { Authorization: `Bearer ${reader.token}` }, signal: controller.signal, redirect: 'error',
    }), 1000);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
  } finally {
    controller.abort(); await response?.body.cancel().catch(() => {});
  }
});

test('hostile HTTP Host and Origin values are rejected before authentication or health access', async t => {
  const hub = await fixture(t);
  for (const headers of [
    { Host: 'attacker.example' },
    { Origin: 'https://attacker.example' },
    { Origin: `http://127.0.0.1:${hub.port}.attacker.example` },
    { Upgrade: 'websocket' },
  ]) {
    const denied = await rawRequest(hub.port, '/health', { token: OWNER_TOKEN, headers });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'ACCESS_DENIED');
  }
  assert.equal((await rawRequest(hub.port, '/v1/devices', { token: OWNER_TOKEN, headers: { Origin: hub.url } })).status, 200);
});

test('tokens in query strings, foreign absolute targets, malformed bodies and unapproved body URLs are denied', async t => {
  const hub = await fixture(t);
  for (const target of [`/v1/devices?token=${OWNER_TOKEN}`, `/v1/events?token=${OWNER_TOKEN}`, 'http://attacker.example/v1/devices']) {
    const denied = await rawRequest(hub.port, target, { token: OWNER_TOKEN });
    assert.equal(denied.status, 400);
    assert.equal(denied.bytes.includes(Buffer.from(OWNER_TOKEN)), false);
  }
  const endpoint = '/v1/devices/tv-one/actions';
  const base = { action: 'audio.volume.set', args: { volume: 50 }, idempotencyKey: 'body-validation' };
  for (const options of [
    { rawBody: '[]' }, { rawBody: '{broken' },
    { value: base, headers: { 'Content-Type': 'text/plain' } },
    { value: { ...base, callbackUrl: 'https://attacker.example/callback' } },
    { value: { ...base, args: { volume: 50, url: 'https://attacker.example/' } } },
  ]) assert.equal((await rawRequest(hub.port, endpoint, { token: OWNER_TOKEN, method: 'POST', ...options })).status, 400);
  for (const url of ['http://127.0.0.1/private', 'https://media.example@attacker.example/private', 'file:///private', 'https://attacker.example/private']) {
    const denied = await rawRequest(hub.port, endpoint, { token: OWNER_TOKEN, method: 'POST', value: { action: 'url.open', args: { url }, idempotencyKey: 'url-validation' } });
    assert.ok([400, 403].includes(denied.status));
  }
  assert.equal(hub.first.calls.length, 0);
});

test('HubClient rejects remote origins and credential-bearing URLs before making requests', () => {
  for (const url of ['https://127.0.0.1:8765', 'http://attacker.example:8765', 'http://127.0.0.1:8765/?token=secret', 'http://user:pass@127.0.0.1:8765', 'http://127.0.0.1:8765/v1']) {
    assert.throws(() => new HubClient({ allowInsecureLoopback: true, url, token: OWNER_TOKEN }), /loopback HTTPS origin|certificate|buffer/);
  }
});
