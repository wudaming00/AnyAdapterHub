import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
import { HomeAssistantAdapter, projectHomeAssistantLight } from '../lib/adapters/home-assistant.mjs';

const store = testSecretStore(), identity = testIdentity(store);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const authorization = () => ({ assertDispatch() {} });
function state(overrides = {}) {
  return { entity_id: 'light.fixture', state: 'off', attributes: { supported_color_modes: ['brightness'], brightness: 0,
    friendly_name: 'private household fixture', token: 'private-raw-token', entity_picture: 'https://private.invalid/picture' }, ...overrides };
}
async function fixture(t, { request, features = ['control', 'dimming'], timeoutMs = 8000 } = {}) {
  const cert = await identity;
  const config = { origin: 'https://127.0.0.1:8123', certificate: cert.certificate, certificatePin: cert.certificatePin,
    entityId: 'light.fixture', token: 'fixture_ha_token_abcdefghijklmnopqrstuvwxyz', timeoutMs };
  const calls = []; let current = state();
  const defaultRequest = async options => {
    options.beforeDispatch(); calls.push({ method: options.method, path: options.path, body: options.body });
    if (options.method === 'GET') return structuredClone(current);
    const on = options.path.endsWith('/turn_on');
    current = state({ state: on ? 'on' : 'off', attributes: { supported_color_modes: ['brightness'],
      brightness: on ? Math.round((options.body.brightness_pct ?? 100) * 255 / 100) : 0 } });
    return [];
  };
  const adapter = new HomeAssistantAdapter({ deviceId: 'fixture-light', config, features, request: request ?? defaultRequest });
  t?.after(() => adapter.close());
  return { adapter, config, calls, setState(value) { current = value; } };
}

test('HA constructor/listeners are inert and projected state excludes entity, names, credentials and raw attributes', async t => {
  const { adapter, config, calls } = await fixture(t);
  const events = []; const cancel = adapter.subscribe(event => events.push(event));
  assert.equal(calls.length, 0);
  const snapshot = await adapter.snapshot();
  assert.deepEqual(snapshot.fields.light.value, { available: true, power: false, brightness: 0, supportsBrightness: true });
  assert.equal(snapshot.fields.light.source, 'home-assistant-https');
  assert.equal(snapshot.fields.light.verification, 'hub-reported-selected-entity');
  assert.equal(Date.parse(snapshot.fields.light.expiresAt) - Date.parse(snapshot.fields.light.observedAt), 15000);
  const encoded = JSON.stringify([snapshot, events]);
  for (const privateValue of [config.entityId, config.origin, config.certificatePin, config.token, 'private household fixture', 'private-raw-token', 'https://private.invalid/picture']) assert.equal(encoded.includes(privateValue), false);
  assert.equal(Object.isFrozen(snapshot.fields.light.value), true); cancel();
});

test('HA refuses asynchronous or non-void dispatch authorization before writes without executing then getters', async t => {
  let touched=0;
  for(const assertDispatch of [async()=>{},async()=>{throw new Error('private denial');},()=>true,()=>({get then(){touched++;return()=>{};}}),()=>new Proxy({},{get(){touched++;}})]){
    const f=await fixture(t);
    await assert.rejects(f.adapter.execute({action:'light.power.set',args:{on:true}},{assertDispatch}),{code:'INVALID_CONTEXT'});
    assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  }
  await nextTurn();assert.equal(touched,0);
});

test('HA constructor rejects executable, inherited and unknown outer options without evaluating accessors or proxy traps', async t => {
  const { config } = await fixture(t); let touched = false;
  const valid = { deviceId: 'fixture-light', config, request: async () => state() };
  const getter = { ...valid };
  Object.defineProperty(getter, 'request', { enumerable: true, get() { touched = true; throw Error('private constructor text'); } });
  const configGetter = { ...valid };
  Object.defineProperty(configGetter, 'config', { enumerable: true, get() { touched = true; throw Error('private constructor text'); } });
  const proxy = new Proxy(valid, { get() { touched = true; throw Error('private proxy text'); },
    ownKeys() { touched = true; throw Error('private proxy text'); }, getPrototypeOf() { touched = true; throw Error('private proxy text'); } });
  const hidden = { ...valid }; Object.defineProperty(hidden, 'request', { value: valid.request, enumerable: false });
  for (const options of [getter, configGetter, proxy, hidden, Object.assign(Object.create({ endpoint: 'private' }), valid),
    { ...valid, host: '127.0.0.2' }, { ...valid, [Symbol('private')]: true }]) {
    assert.throws(() => new HomeAssistantAdapter(options), error => error.code === 'INVALID_CONFIG' && !String(error).includes('private'));
  }
  assert.equal(touched, false);
});

test('HA defaults to read-only and separates power from dimming features', async t => {
  const readonly = await fixture(t, { features: [] });
  assert.deepEqual(readonly.adapter.supportedActions, []);
  await assert.rejects(readonly.adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization()), { code: 'UNKNOWN_ACTION' });
  assert.equal(readonly.calls.length, 0);
  const power = await fixture(t, { features: ['control'] });
  assert.deepEqual(power.adapter.supportedActions, ['light.power.set']);
  assert.throws(() => { power.adapter.supportedActions = ['light.brightness.set']; }, TypeError);
  assert.throws(() => { power.adapter.deviceId = 'other-device'; }, TypeError);
  await assert.rejects(power.adapter.execute({ action: 'light.brightness.set', args: { brightness: 50 } }, authorization()), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => new HomeAssistantAdapter({ deviceId: 'fixture-light', config: power.config, features: ['dimming'], request() {} }), { code: 'INVALID_FEATURES' });
  assert.throws(() => new HomeAssistantAdapter({ deviceId: 'fixture-light', config: power.config, features: ['control', 'control'], request() {} }), { code: 'INVALID_FEATURES' });
});

test('HA setters use only the selected entity, fixed services and fresh post-dispatch readback', async t => {
  const { adapter, calls } = await fixture(t); let checks = 0;
  const result = await adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() { checks += 1; assert.equal(calls.length, 1); } });
  assert.equal(checks, 1);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/states/light.fixture', body: undefined },
    { method: 'POST', path: '/api/services/light/turn_on', body: { entity_id: 'light.fixture' } },
    { method: 'GET', path: '/api/states/light.fixture', body: undefined }]);
  assert.equal(result.requestAccepted, true); assert.equal(result.confirmed, true);
  assert.equal(result.verificationScope, 'home_assistant_reported_selected_entity_state'); assert.equal(result.physicalEffectVerified, false);
});

test('HA brightness preflight denies on/off-only lights and zero uses fixed turn_off', async t => {
  const { adapter, calls, setState } = await fixture(t);
  setState(state({ attributes: { supported_color_modes: ['onoff'] } }));
  await assert.rejects(adapter.execute({ action: 'light.brightness.set', args: { brightness: 50 } }, authorization()), { code: 'BRIGHTNESS_UNSUPPORTED' });
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  setState(state());
  assert.equal((await adapter.execute({ action: 'light.brightness.set', args: { brightness: 37 } }, authorization())).confirmed, true);
  assert.deepEqual(calls.find(call => call.method === 'POST').body, { entity_id: 'light.fixture', brightness_pct: 37 });
  assert.equal((await adapter.execute({ action: 'light.brightness.set', args: { brightness: 0 } }, authorization())).confirmed, true);
  assert.equal(calls.filter(call => call.method === 'POST').at(-1).path, '/api/services/light/turn_off');
  assert.deepEqual(calls.filter(call => call.method === 'POST').at(-1).body, { entity_id: 'light.fixture' });
});

test('HA rejects arbitrary routing/service arguments, accessors, proxies and malformed contexts before networking', async t => {
  const { adapter, calls } = await fixture(t); let touched = false;
  const getter = {}; Object.defineProperty(getter, 'on', { enumerable: true, get() { touched = true; return true; } });
  const proxy = new Proxy({ on: true }, { ownKeys() { touched = true; throw Error('private'); } });
  for (const args of [{ on: true, entity_id: 'light.other' }, { on: true, service: 'script.run' }, { on: 1 }, getter, proxy, Object.assign(Object.create({ entityId: 'other' }), { on: true })]) {
    await assert.rejects(adapter.execute({ action: 'light.power.set', args }, authorization()), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(adapter.execute({ action: 'light.brightness.set', args: { brightness: 101 } }, authorization()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true }, target: 'other' }, authorization()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }), { code: 'INVALID_CONTEXT' });
  const context = {}; Object.defineProperty(context, 'assertDispatch', { enumerable: true, get() { touched = true; return () => {}; } });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, context), { code: 'INVALID_CONTEXT' });
  assert.equal(calls.length, 0); assert.equal(touched, false);
});

test('HA foreign/unavailable entity response cannot authorize a write or leak private strings', async t => {
  let posts = 0;
  const { adapter } = await fixture(t, { request: async options => { options.beforeDispatch(); if (options.method === 'POST') posts += 1; return state({ entity_id: 'light.private_foreign' }); } });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization()), error => error.code === 'INVALID_DEVICE_RESPONSE' && !String(error).includes('private_foreign'));
  assert.equal(posts, 0);
  assert.throws(() => projectHomeAssistantLight(state({ state: 'private state' }), 'light.fixture'), { code: 'INVALID_DEVICE_RESPONSE' });
});

test('HA rechecks revocation after awaited TLS/preflight and immediately before POST', async t => {
  const gate = deferred(), entered = deferred(); let revoked = false, posts = 0;
  const { adapter } = await fixture(t, { request: async options => {
    if (options.method === 'GET') { options.beforeDispatch(); return state(); }
    entered.resolve(); await gate.promise; options.beforeDispatch(); posts += 1; return [];
  } });
  const pending = adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() { if (revoked) throw Object.assign(new Error('private revocation'), { code: 'GRANT_REVOKED' }); } });
  await entered.promise; revoked = true; gate.resolve();
  await assert.rejects(pending, error => error.code === 'GRANT_REVOKED' && !String(error).includes('private revocation'));
  assert.equal(posts, 0);
});

test('HA poll and actions serialize; queued revocation is checked after the earlier read completes', async t => {
  const gate = deferred(), entered = deferred(); let first = true, active = 0, maximum = 0, posts = 0, revoked = false;
  const { adapter } = await fixture(t, { request: async options => {
    active += 1; maximum = Math.max(maximum, active);
    try { if (first) { first = false; entered.resolve(); await gate.promise; } options.beforeDispatch(); if (options.method === 'POST') posts += 1; return state(); }
    finally { active -= 1; }
  } });
  const start = adapter.start(); await entered.promise;
  const queued = adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() { if (revoked) throw Object.assign(new Error('revoked'), { code: 'GRANT_REVOKED' }); } });
  revoked = true; gate.resolve(); await start; await assert.rejects(queued, { code: 'GRANT_REVOKED' });
  assert.equal(maximum, 1); assert.equal(posts, 0);
});

test('HA lost write response is unknown and is never automatically retried', async t => {
  let posts = 0;
  const { adapter } = await fixture(t, { request: async options => {
    options.beforeDispatch(); if (options.method === 'GET') return state();
    posts += 1; throw Object.assign(new Error('private vendor token and URL'), { code: 'VENDOR_PRIVATE' });
  } });
  const result = await adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  assert.equal(posts, 1); assert.equal(result.requestAccepted, null); assert.equal(result.uncertain, true); assert.equal(result.confirmed, false);
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(result.error.code, 'DEVICE_OPERATION_FAILED');
});

test('HA acceptance with mismatching state stays unconfirmed; failed readback stays unknown', async t => {
  let reads = 0, failReadback = false;
  const { adapter } = await fixture(t, { request: async options => {
    options.beforeDispatch(); if (options.method === 'POST') return [];
    reads += 1; if (failReadback && reads % 2 === 0) throw Error('private readback'); return state();
  } });
  const unmatched = await adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  assert.equal(unmatched.requestAccepted, true); assert.equal(unmatched.confirmed, false); assert.equal(unmatched.uncertain, false);
  failReadback = true;
  const unknown = await adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  assert.equal(unknown.requestAccepted, true); assert.equal(unknown.confirmed, false); assert.equal(unknown.uncertain, true);
});

test('HA failed refresh retains prior evidence expiry and never refreshes stale fields', async t => {
  let failed = false;
  const { adapter } = await fixture(t, { request: async options => { options.beforeDispatch(); if (failed) throw Error('private failure'); return state(); } });
  const initial = await adapter.snapshot(); failed = true;
  await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' });
  const cached = await adapter.snapshot({ refresh: false });
  assert.equal(cached.connection.phase, 'offline');
  assert.deepEqual(cached.fields.light, initial.fields.light);
});

test('HA close aborts active reads, rejects queued writes and prevents late state publication', async () => {
  const gate = deferred(), entered = deferred(); let posts = 0;
  const { adapter } = await fixture(null, { request: async options => { entered.resolve(); await gate.promise; options.beforeDispatch(); if (options.method === 'POST') posts += 1; return state(); } });
  const events = []; adapter.subscribe(event => events.push(event));
  const reading = adapter.snapshot(); await entered.promise;
  const queued = adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  const assertions = [assert.rejects(reading), assert.rejects(queued, { code: 'ADAPTER_CLOSED' })];
  await adapter.close(); await Promise.all(assertions);
  gate.resolve(); await nextTurn(); assert.equal(posts, 0); assert.equal(events.length, 0);
  await assert.rejects(adapter.snapshot(), { code: 'ADAPTER_CLOSED' });
});

test('HA local request deadline prevents a late injected TLS continuation from writing', async t => {
  const gate = deferred(), entered = deferred(); let effects = 0;
  const { adapter } = await fixture(t, { timeoutMs: 100, request: async options => {
    if (options.method === 'GET') { options.beforeDispatch(); return state(); }
    entered.resolve(); await gate.promise; options.beforeDispatch(); effects += 1; return [];
  } });
  const command = adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization());
  await entered.promise; await assert.rejects(command, { code: 'REQUEST_TIMEOUT' });
  gate.resolve(); await nextTurn(); assert.equal(effects, 0);
});

test('HA converts the Hub ISO deadline to the transport epoch deadline and denies expired work without reads', async t => {
  const deadlineAt = new Date(Date.now() + 10000).toISOString(); let requests = 0;
  const { adapter } = await fixture(t, { request: async options => {
    requests += 1; assert.equal(options.deadlineAt, Date.parse(deadlineAt));
    options.beforeDispatch(); return options.method === 'POST' ? [] : state();
  } });
  const result = await adapter.execute({ action: 'light.power.set', args: { on: false } }, { deadlineAt, assertDispatch() {} });
  assert.equal(result.confirmed, true); assert.equal(requests, 3);
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: false } }, {
    deadlineAt: new Date(Date.now() - 1).toISOString(), assertDispatch() {},
  }), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(requests, 3);
});

test('HA stale preflight cannot confirm or dispatch a fresh write', async t => {
  let now = Date.now(), posts = 0;
  t.mock.method(Date, 'now', () => now);
  const { adapter } = await fixture(t, { request: async options => {
    options.beforeDispatch(); if (options.method === 'POST') posts += 1;
    now += 16000; return state();
  } });
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization()), { code: 'STALE_STATE' });
  assert.equal(posts, 0);
});

test('HA checks preflight expiry again after POST TLS preparation before authorization and device effects', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (const command of [{ action: 'light.power.set', args: { on: true } },
    { action: 'light.brightness.set', args: { brightness: 50 } }]) {
    let effects = 0, authorizations = 0, postPreparations = 0;
    const { adapter } = await fixture(t, { timeoutMs: 15000, request: async options => {
      if (options.method === 'GET') { options.beforeDispatch(); now += 10000; return state(); }
      postPreparations += 1; await nextTurn(); now += 6000;
      options.beforeDispatch(); effects += 1; return [];
    } });
    await assert.rejects(adapter.execute(command, { assertDispatch() { authorizations += 1; } }), { code: 'STALE_STATE' });
    assert.equal(postPreparations, 1); assert.equal(authorizations, 0); assert.equal(effects, 0);
  }
});

test('HA missing response capabilities and unavailable states fail closed before changing brightness', async t => {
  const { adapter, calls, setState } = await fixture(t);
  setState(state({ attributes: {} }));
  await assert.rejects(adapter.execute({ action: 'light.brightness.set', args: { brightness: 50 } }, authorization()), { code: 'BRIGHTNESS_UNSUPPORTED' });
  setState(state({ state: 'unavailable' }));
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, authorization()), { code: 'ENTITY_UNAVAILABLE' });
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  for (const supported_color_modes of [['white'], ['onoff', 'brightness'], ['brightness', 'brightness']]) {
    assert.throws(() => projectHomeAssistantLight(state({ attributes: { supported_color_modes } }), 'light.fixture'), { code: 'INVALID_DEVICE_RESPONSE' });
  }
});
