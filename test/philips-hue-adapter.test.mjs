import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
import { PhilipsHueAdapter, projectPhilipsHueLight } from '../lib/adapters/philips-hue.mjs';

const store = testSecretStore(), ID = '00000000-0000-4000-8000-000000000001';
function response(changes = {}) {
  return { errors: [], data: [{ id: ID, type: 'light', on: { on: false }, dimming: { brightness: 32.13, min_dim_level: 0.2 },
    metadata: { name: 'private room name', archetype: 'classic_bulb' }, mode: 'normal', owner: { rid: 'private owner UUID', rtype: 'device' }, ...changes }] };
}
const ack = () => ({ errors: [], data: [{ rid: ID, rtype: 'light' }] });
const authorization = () => ({ assertDispatch() {} });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, extra = {}) {
  const identity = await testIdentity(store), calls = []; let current = response();
  const config = { origin: 'https://127.0.0.1:8443',
    certificate: identity.certificate, certificatePin: identity.certificatePin, lightId: ID,
    applicationKey: 'synthetic_private_hue_application_key', timeoutMs: extra.timeoutMs ?? 8000 };
  const adapter = new PhilipsHueAdapter({ deviceId: 'fixture-hue', config, features: extra.features ?? ['control', 'dimming'],
    request: extra.request ?? (async options => {
      calls.push(options); options.beforeDispatch();
      if (options.method === 'PUT') { current.data[0].on.on = options.body.on.on; if (options.body.dimming) current.data[0].dimming.brightness = options.body.dimming.brightness; return ack(); }
      return structuredClone(current);
    }) });
  t?.after(() => adapter.close());
  return { adapter, config, calls, setState(value) { current = value; } };
}

test('Hue constructors/listeners remain inert and projection preserves stored off brightness without private fields', async t => {
  const { adapter, calls } = await fixture(t), events = []; adapter.subscribe(event => events.push(event));
  assert.equal(calls.length, 0); assert.equal(events.length, 0);
  const state = await adapter.snapshot();
  assert.equal(state.fields.light.value.power, false); assert.equal(state.fields.light.value.brightness, 32.13);
  assert.equal(state.fields.light.value.available, true); assert.equal(state.fields.light.verification, 'bridge-reported-selected-resource');
  assert.equal(Date.parse(state.fields.light.expiresAt) - Date.parse(state.fields.light.observedAt), 15000);
  for (const text of [ID, 'private room', 'private owner', '127.0.0.1', 'synthetic_private']) assert.equal(JSON.stringify([state, events]).includes(text), false);
});

test('Hue defaults to read-only and requires explicit control plus dimming without unrelated actions', async t => {
  const { adapter, calls } = await fixture(t, { features: [] });
  assert.deepEqual(adapter.supportedActions, []);
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization()), { code: 'UNKNOWN_ACTION' });
  const powerOnly = await fixture(t, { features: ['control'] });
  assert.deepEqual(powerOnly.adapter.supportedActions, ['light.power.set']);
  await assert.rejects(powerOnly.adapter.execute({ action: 'light.brightness.set', args: { brightness: 50 } }, authorization()), { code: 'UNKNOWN_ACTION' });
  assert.equal(calls.length, 0); assert.equal(powerOnly.calls.length, 0);
});

test('Hue constructor rejects executable or extra options and malformed feature arrays without evaluating them', async t => {
  const { config } = await fixture(t); let touched = 0;
  const base = { deviceId: 'fixture-hue', config }, getter = { ...base };
  Object.defineProperty(getter, 'request', { enumerable: true, get() { touched++; return () => {}; } });
  const features = ['control']; Object.defineProperty(features, '0', { enumerable: true, get() { touched++; return 'control'; } });
  for (const options of [getter, new Proxy(base, { ownKeys() { touched++; throw Error('private'); } }), { ...base, endpoint: '/groups' },
    { ...base, features }, { ...base, features: ['dimming'] }, { ...base, features: ['control', 'control'] }, { ...base, features: ['observer'] }]) {
    assert.throws(() => new PhilipsHueAdapter(options));
  }
  assert.equal(touched, 0);
});

test('Hue selected UUID uses only fixed GET/PUT and minimal explicit setters; zero turns off instead of dimming to minimum', async t => {
  const { adapter, calls } = await fixture(t);
  assert.equal((await adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization())).confirmed, true);
  assert.equal((await adapter.execute({ action: 'light.brightness.set', args: { brightness: 37 } }, authorization())).confirmed, true);
  assert.equal((await adapter.execute({ action: 'light.brightness.set', args: { brightness: 0 } }, authorization())).confirmed, true);
  assert.deepEqual(calls.filter(call => call.method === 'PUT').map(call => call.body), [{ on: { on: true } }, { on: { on: true }, dimming: { brightness: 37 } }, { on: { on: false } }]);
  assert.ok(calls.every(call => call.path === `/clip/v2/resource/light/${ID}` && ['GET', 'PUT'].includes(call.method)));
  assert.ok(calls.every(call => Object.keys(call.headers).join() === 'hue-application-key'));
});

test('Hue denies routes, foreign IDs, getters, proxies and malformed contexts before a request', async t => {
  const { adapter, calls } = await fixture(t); let touched = 0;
  const getter = {}; Object.defineProperty(getter, 'on', { enumerable: true, get() { touched++; return true; } });
  const proxy = new Proxy({ on: true }, { ownKeys() { touched++; throw Error('private'); } });
  for (const args of [{ on: true, lightId: 'other' }, { on: true, route: '/groups' }, { on: 1 }, getter, proxy]) await assert.rejects(adapter.execute({ action: 'light.power.set', args }, authorization()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true }, target: 'other' }, authorization()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }), { code: 'INVALID_CONTEXT' });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() {}, signal: { get aborted() { touched++; return false; } } }), { code: 'INVALID_CONTEXT' });
  await assert.rejects(adapter.start({ get pollMs() { touched++; return 5000; } }), { code: 'INVALID_POLL_INTERVAL' });
  await assert.rejects(adapter.snapshot({ get refresh() { touched++; return true; } }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(touched, 0); assert.equal(calls.length, 0);
});

test('Hue response identity, envelope errors and bounded scalar validation fail closed without reflecting device text', async t => {
  for (const raw of [response({ id: 'private foreign UUID' }), response({ type: 'grouped_light' }),
    { ...response(), errors: [{ description: 'private bridge error' }] }, { errors: [], data: [] }, { errors: [], data: [response().data[0], response().data[0]] },
    response({ on: { on: 'true' } }), response({ dimming: { brightness: NaN, min_dim_level: 0.2 } }), response({ dimming: { brightness: 40, min_dim_level: 101 } })]) {
    let writes = 0;
    const { adapter } = await fixture(t, { request: async options => { options.beforeDispatch(); if (options.method === 'PUT') writes++; return raw; } });
    await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization()), error => !String(error).includes('private'));
    assert.equal(writes, 0);
  }
  let touched = 0; const hostile = response(); Object.defineProperty(hostile.data[0], 'on', { enumerable: true, get() { touched++; return { on: true }; } });
  assert.throws(() => projectPhilipsHueLight(hostile, ID), { code: 'INVALID_DEVICE_RESPONSE' });
  const proxy = new Proxy(response().data, { ownKeys() { touched++; throw Error('private'); } });
  assert.throws(() => projectPhilipsHueLight({ errors: [], data: proxy }, ID), { code: 'INVALID_DEVICE_RESPONSE' });
  assert.equal(touched, 0);
});

test('Hue plugs, unknown/missing archetypes, streaming and unavailable dimming cannot gain light control', async t => {
  const { adapter, calls, setState } = await fixture(t);
  for (const changes of [{ metadata: { archetype: 'plug' } }, { metadata: { archetype: 'unknown_archetype' } }, { metadata: {} },
    { metadata: undefined }, { mode: 'streaming' }, { mode: undefined }]) {
    setState(response(changes));
    await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization()), { code: 'LIGHT_CONTROL_UNAVAILABLE' });
  }
  for (const dimming of [undefined, { brightness: 40 }, { brightness: 40, min_dim_level: 10 }]) {
    setState(response({ dimming }));
    await assert.rejects(adapter.execute({ action: 'light.brightness.set', args: { brightness: 5 } }, authorization()), { code: 'BRIGHTNESS_UNSUPPORTED' });
  }
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
});

test('Hue rechecks revocation after asynchronous TLS preparation immediately before PUT', async t => {
  const gate = deferred(), entered = deferred(); let revoked = false, writes = 0;
  const { adapter } = await fixture(t, { request: async options => {
    if (options.method === 'GET') { options.beforeDispatch(); return response(); }
    entered.resolve(); await gate.promise; options.beforeDispatch(); writes++; return ack();
  } });
  const pending = adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() { if (revoked) throw Object.assign(Error('private denial'), { code: 'GRANT_REVOKED' }); } });
  await entered.promise; revoked = true; gate.resolve();
  await assert.rejects(pending, error => error.code === 'GRANT_REVOKED' && !String(error).includes('private')); assert.equal(writes, 0);
});

test('Hue refuses asynchronous authorization callbacks without effects or unhandled promise rejection', async t => {
  let writes = 0;
  const { adapter } = await fixture(t, { request: async options => {
    options.beforeDispatch(); if (options.method === 'PUT') writes++; return response();
  } });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, {
    async assertDispatch() { throw Object.assign(Error('private async denial'), { code: 'GRANT_REVOKED' }); },
  }), error => !String(error).includes('private'));
  await nextTurn(); assert.equal(writes, 0);
});

test('Hue serializes polls and actions; queued writes cannot use revoked authorization', async t => {
  const gate = deferred(), entered = deferred(); let first = true, revoked = false, active = 0, maximum = 0, writes = 0;
  const { adapter } = await fixture(t, { request: async options => {
    active++; maximum = Math.max(maximum, active);
    try { if (first) { first = false; entered.resolve(); await gate.promise; } options.beforeDispatch(); if (options.method === 'PUT') writes++; return response(); }
    finally { active--; }
  } });
  const polling = adapter.start(); await entered.promise;
  const pending = adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() { if (revoked) throw Object.assign(Error('revoked'), { code: 'GRANT_REVOKED' }); } });
  revoked = true; gate.resolve(); await polling; await assert.rejects(pending, { code: 'GRANT_REVOKED' });
  assert.equal(maximum, 1); assert.equal(writes, 0);
});

test('Hue preflight expiry during PUT TLS wait denies both authorization and mutation', async t => {
  const { adapter } = await fixture(t, { timeoutMs: 15000, request: async options => {
    if (options.method === 'GET') { options.beforeDispatch(); now += 10000; return response(); }
    await nextTurn(); now += 6000; options.beforeDispatch(); effects++; return ack();
  } });
  let now = Date.now(), effects = 0, authorizations = 0; t.mock.method(Date, 'now', () => now);
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() { authorizations++; } }), { code: 'STALE_STATE' });
  assert.equal(effects, 0); assert.equal(authorizations, 0);
});

test('Hue missing, foreign or errored PUT acknowledgment stays unknown and never automatically retries', async t => {
  for (const result of [null, { errors: [], data: [{ rid: 'private foreign UUID', rtype: 'light' }] },
    { errors: [{ description: 'private vendor detail' }], data: [] }]) {
    let writes = 0;
    const { adapter } = await fixture(t, { request: async options => { options.beforeDispatch(); if (options.method === 'GET') return response(); writes++; if (result === null) throw Error('private lost response'); return result; } });
    const operation = await adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
    assert.equal(writes, 1); assert.equal(operation.requestAccepted, null); assert.equal(operation.uncertain, true); assert.equal(operation.confirmed, false);
    assert.equal(JSON.stringify(operation).includes('private'), false);
  }
});

test('Hue confirmation requires selected fresh readback; accepted ACK alone never proves the physical effect', async t => {
  let failReadback = false, reads = 0;
  const { adapter } = await fixture(t, { request: async options => {
    options.beforeDispatch(); if (options.method === 'PUT') return ack();
    reads++; if (failReadback && reads % 2 === 0) throw Error('private readback'); return response();
  } });
  const mismatch = await adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  assert.equal(mismatch.requestAccepted, true); assert.equal(mismatch.confirmed, false); assert.equal(mismatch.uncertain, false);
  assert.equal(mismatch.physicalEffectVerified, false); assert.equal(mismatch.verificationScope, 'philips_hue_bridge_reported_selected_light_state');
  failReadback = true;
  const unknown = await adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  assert.equal(unknown.requestAccepted, true); assert.equal(unknown.uncertain, true); assert.equal(unknown.confirmed, false);
});

test('Hue failed reads retain earlier expiry and close prevents late publication and queued effects', async t => {
  let failRead = false;
  const { adapter } = await fixture(t, { request: async options => { options.beforeDispatch(); if (failRead) throw Error('private'); return response(); } });
  const initial = await adapter.snapshot(); failRead = true; await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' });
  const cached = await adapter.snapshot({ refresh: false }); assert.deepEqual(cached.fields, initial.fields); assert.equal(cached.connection.phase, 'offline');
  const entered = deferred(), gate = deferred(); let effects = 0;
  const late = await fixture(null, { request: async options => { entered.resolve(); await gate.promise; options.beforeDispatch(); if (options.method === 'PUT') effects++; return response(); } });
  const events = []; late.adapter.subscribe(event => events.push(event));
  const pending = late.adapter.snapshot(); await entered.promise;
  const queued = late.adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  const assertions = [assert.rejects(pending), assert.rejects(queued, { code: 'ADAPTER_CLOSED' })];
  await late.adapter.close(); await Promise.all(assertions); gate.resolve(); await nextTurn();
  assert.equal(effects, 0); assert.equal(events.length, 0);
});

test('Hue local timeout and expired Hub deadline prevent a late PUT continuation from dispatching', async t => {
  const entered = deferred(), gate = deferred(); let effects = 0, reads = 0;
  const { adapter } = await fixture(t, { timeoutMs: 100, request: async options => {
    if (options.method === 'GET') { reads++; options.beforeDispatch(); return response(); }
    entered.resolve(); await gate.promise; options.beforeDispatch(); effects++; return ack();
  } });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, { deadlineAt: new Date(Date.now() - 1).toISOString(), assertDispatch() {} }), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(reads, 0);
  const pending = adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  await entered.promise; await assert.rejects(pending, { code: 'REQUEST_TIMEOUT' }); gate.resolve(); await nextTurn(); assert.equal(effects, 0);
});
