import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
import { PlexAdapter, projectPlexIdentity } from '../lib/adapters/plex.mjs';

const store = testSecretStore(), ID = 'synthetic-selected-machine-identifier';
const response = changes => ({ MediaContainer: { size: 1, machineIdentifier: ID, claimed: true, version: '1.40.2.8395-c67dce28e',
  privateName: 'private household label', accessToken: 'private unrequested token', ...changes } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, extra = {}) {
  const identity = await testIdentity(store), calls = [];
  const config = { origin: 'https://127.0.0.1:32400', certificate: identity.certificate, certificatePin: identity.certificatePin,
    machineIdentifier: ID, timeoutMs: extra.timeoutMs ?? 8000 };
  const adapter = new PlexAdapter({ deviceId: 'fixture-plex', config, request: extra.request ?? (async options => { calls.push(options); options.beforeDispatch(); return response(); }) });
  t?.after(() => adapter.close()); return { adapter, calls, config };
}

test('Plex constructor/listeners remain inert, use no credentials and expose only selected identity status with receipt freshness', async t => {
  const { adapter, calls } = await fixture(t), events = []; adapter.subscribe(event => events.push(event));
  assert.equal(calls.length, 0); assert.equal(events.length, 0); assert.deepEqual(adapter.supportedActions, []);
  const state = await adapter.snapshot();
  assert.deepEqual(state.fields.server.value, { available: true, claimed: true, version: '1.40.2.8395-c67dce28e' });
  assert.equal(state.fields.server.verification, 'server-reported-selected-identity');
  assert.equal(Date.parse(state.fields.server.expiresAt) - Date.parse(state.fields.server.observedAt), 30000);
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].path, '/identity'); assert.deepEqual(calls[0].headers, { Accept: 'application/json' });
  assert.equal(Object.hasOwn(calls[0], 'body'), false);
  for (const privateText of [ID, '127.0.0.1', 'private household', 'private unrequested']) assert.equal(JSON.stringify([state, events]).includes(privateText), false);
});

test('Plex cannot execute a control action or advertise optional effects', async t => {
  const { adapter, calls, config } = await fixture(t);
  for (const action of ['light.power.set', 'media.play', 'app.list', 'plex.library.read', 'screen.observe']) await assert.rejects(adapter.execute({ action, args: {} }, { assertDispatch() { throw Error('Must stay inert'); } }), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => new PlexAdapter({ deviceId: 'fixture-plex', config, features: ['control'] }), { code: 'INVALID_FEATURES' });
  assert.equal(calls.length, 0);
});

test('Plex options reject getters, proxies, inherited/unknown fields and routes without invoking code', async t => {
  const { adapter, config } = await fixture(t); let touched = 0;
  const base = { deviceId: 'fixture-plex', config }, getter = { ...base };
  Object.defineProperty(getter, 'request', { enumerable: true, get() { touched++; return () => {}; } });
  for (const options of [getter, new Proxy(base, { ownKeys() { touched++; throw Error('private'); } }), Object.assign(Object.create({ route: '/library' }), base), { ...base, endpoint: '/library' }]) assert.throws(() => new PlexAdapter(options));
  await assert.rejects(adapter.start({ get pollMs() { touched++; return 10000; } }), { code: 'INVALID_POLL_INTERVAL' });
  await assert.rejects(adapter.snapshot({ get refresh() { touched++; return false; } }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(touched, 0);
});

test('Plex foreign identity, malformed state and executable response properties cannot become fresh server evidence', async t => {
  for (const raw of [response({ machineIdentifier: 'private-other-server' }), response({ size: 2 }), response({ claimed: 'true' }), { MediaContainer: [] }, {}]) {
    assert.throws(() => projectPlexIdentity(raw, ID), { code: 'INVALID_DEVICE_RESPONSE' });
    const { adapter } = await fixture(t, { request: async options => { options.beforeDispatch(); return raw; } });
    await assert.rejects(adapter.snapshot(), error => error.code === 'STATE_UNAVAILABLE' && !String(error).includes('private'));
    assert.deepEqual((await adapter.snapshot({ refresh: false })).fields, {});
  }
  let touched = 0; const raw = response(); Object.defineProperty(raw.MediaContainer, 'machineIdentifier', { enumerable: true, get() { touched++; return ID; } });
  assert.throws(() => projectPlexIdentity(raw, ID), { code: 'INVALID_DEVICE_RESPONSE' });
  assert.throws(() => projectPlexIdentity(new Proxy(response(), { ownKeys() { touched++; } }), ID), { code: 'INVALID_DEVICE_RESPONSE' });
  assert.equal(touched, 0);
  assert.equal(projectPlexIdentity(response({ version: 'https://private.invalid/?token=secret' }), ID).version, null);
});

test('Plex failed refresh cannot extend expiry and polling shares one queue with explicit reads', async t => {
  const gate = deferred(), entered = deferred(); let failRead = false, first = true, active = 0, maximum = 0;
  const { adapter } = await fixture(t, { request: async options => {
    active++; maximum = Math.max(maximum, active);
    try { if (first) { first = false; entered.resolve(); await gate.promise; } options.beforeDispatch(); if (failRead) throw Error('private transport failure'); return response(); }
    finally { active--; }
  } });
  const polling = adapter.start(); await entered.promise; const reading = adapter.snapshot(); gate.resolve(); await polling;
  const before = await reading; assert.equal(maximum, 1); failRead = true;
  await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' });
  const after = await adapter.snapshot({ refresh: false }); assert.deepEqual(after.fields, before.fields); assert.equal(after.connection.phase, 'offline');
});

test('Plex close aborts an active read, rejects queued work and ignores a late transport response', async () => {
  const gate = deferred(), entered = deferred(); const { adapter } = await fixture(null, { request: async options => { entered.resolve(); await gate.promise; options.beforeDispatch(); return response(); } });
  const events = []; adapter.subscribe(event => events.push(event));
  const reading = adapter.snapshot(); await entered.promise; const queued = adapter.snapshot();
  const assertions = [assert.rejects(reading, { code: 'ADAPTER_CLOSED' }), assert.rejects(queued, { code: 'ADAPTER_CLOSED' })];
  await adapter.close(); await Promise.all(assertions); gate.resolve(); await nextTurn(); assert.equal(events.length, 0);
  await assert.rejects(adapter.snapshot(), { code: 'ADAPTER_CLOSED' });
});

test('Plex hanging or late transport work is bounded by its request timeout', async t => {
  const gate = deferred(), entered = deferred(); let dispatched = 0;
  const { adapter } = await fixture(t, { timeoutMs: 100, request: async options => { entered.resolve(); await gate.promise; options.beforeDispatch(); dispatched++; return response(); } });
  const pending = adapter.snapshot(); await entered.promise; await assert.rejects(pending, { code: 'STATE_UNAVAILABLE' });
  gate.resolve(); await nextTurn(); assert.equal(dispatched, 0);
  assert.deepEqual((await adapter.snapshot({ refresh: false })).fields, {});
});
