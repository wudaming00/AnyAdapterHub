import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SwitchBotAdapter, switchBotHeaders, projectSwitchBotSensor } from '../lib/adapters/switchbot.mjs';
import { validateSwitchBotConfig, protectSwitchBotConfig, loadSwitchBotConfig } from '../lib/adapters/switchbot-config.mjs';
import { testSecretStore } from './helpers/secrets.mjs';

const config = extra => ({ vendorDeviceId: 'AABBCCDDEEFF', deviceType: 'Meter', token: 'synthetic-switchbot-token', secret: 'synthetic-switchbot-secret', ...extra });
const response = extra => ({ statusCode: 100, body: { deviceId: config().vendorDeviceId, deviceType: 'Meter', temperature: 20.5, humidity: 45, battery: 60, hubDeviceId: 'private-hub', ...extra }, message: 'private vendor message' });
async function files(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-switchbot-fixture-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return path.join(directory, 'synthetic.json');
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('SwitchBot HMAC follows the official token+epoch-ms+UUID base64 contract', () => {
  const selected = config(), headers = switchBotHeaders(selected);
  assert.equal(headers.Authorization, selected.token); assert.match(headers.t, /^\d{13}$/);
  assert.match(headers.nonce, /^[a-f0-9-]{36}$/);
  assert.equal(headers.sign, createHmac('sha256', selected.secret).update(selected.token + headers.t + headers.nonce).digest('base64'));
  assert.notEqual(headers.nonce, switchBotHeaders(selected).nonce);
  assert.equal(Object.values(headers).includes(selected.secret), false);
});

test('SwitchBot owner configuration encrypts both secrets and binds exact device and declared sensor type', async t => {
  const secretStore = testSecretStore(), selected = config(), saved = await protectSwitchBotConfig(selected, { secretStore }), file = await files(t);
  for (const secret of [selected.token, selected.secret]) assert.equal(JSON.stringify(saved).includes(secret), false);
  await writeFile(file, JSON.stringify(saved)); assert.deepEqual(await loadSwitchBotConfig(file, { secretStore }), validateSwitchBotConfig(selected));
  for (const patch of [{ vendorDeviceId: '001122334455' }, { deviceType: 'MeterPro' }]) {
    await writeFile(file, JSON.stringify({ ...saved, ...patch })); await assert.rejects(loadSwitchBotConfig(file, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
  await writeFile(file, JSON.stringify(selected)); await assert.rejects(loadSwitchBotConfig(file, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
});

test('SwitchBot configuration rejects URL routing, locks/IR/Bot, headers, plaintext envelope and executable fields', () => {
  let accessed = 0;
  const hostile = {}; Object.defineProperty(hostile, 'token', { enumerable: true, get() { accessed++; return 'bad'; } });
  for (const value of [hostile, new Proxy({}, { get() { accessed++; }, getPrototypeOf() { accessed++; } }),
    config({ origin: 'https://other.invalid' }), config({ vendorDeviceId: '../devices' }), config({ vendorDeviceId: 'aabbccddeeff' }),
    config({ deviceType: 'Lock' }), config({ deviceType: 'Bot' }), config({ token: 'bad\r\nheader' }), config({ secret: '' }), config({ endpoint: '/v1.1/devices' })]) assert.throws(() => validateSwitchBotConfig(value));
  assert.equal(accessed, 0);
});

test('SwitchBot projection exposes only finite selected-device environmental values', () => {
  assert.deepEqual(projectSwitchBotSensor(response(), config()), { temperatureC: 20.5, humidityPercent: 45, batteryPercent: 60 });
  const co2 = config({ deviceType: 'MeterPro(CO2)' });
  assert.equal(projectSwitchBotSensor(response({ deviceType: co2.deviceType, CO2: 9999 }), co2).co2Ppm, 9999);
  assert.equal(projectSwitchBotSensor(response({ CO2: 5000 }), config()).co2Ppm, undefined);
  for (const patch of [{ deviceId: '112233445566' }, { deviceType: 'Lock' }, { temperature: '20' }, { temperature: Infinity }, { humidity: 101 }, { humidity: 1.5 }, { battery: -1 }]) assert.throws(() => projectSwitchBotSensor(response(patch), config()));
  assert.throws(() => projectSwitchBotSensor({ statusCode: 190, body: response().body }, config()));
  assert.throws(() => projectSwitchBotSensor({ statusCode: 100, body: {} }, config()));
  let accessed = 0; const body = response().body; Object.defineProperty(body, 'temperature', { enumerable: true, get() { accessed++; } });
  assert.throws(() => projectSwitchBotSensor({ statusCode: 100, body }, config())); assert.equal(accessed, 0);
});

test('SwitchBot constructors and actions are inert; request uses one fixed GET and snapshots redact account/target strings', async () => {
  const seen = [], events = [], selected = config();
  const adapter = new SwitchBotAdapter({ deviceId: 'fixture-meter', config: selected, request: async options => { seen.push(options); options.beforeDispatch(); return response(); } });
  adapter.subscribe(event => events.push(event)); assert.deepEqual(adapter.supportedActions, []); assert.equal(seen.length, 0);
  await assert.rejects(adapter.execute({ action: 'switchbot.command' }), { code: 'UNSUPPORTED_ACTION' }); assert.equal(seen.length, 0);
  const state = await adapter.snapshot(); assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET'); assert.equal(seen[0].path, '/v1.1/devices/AABBCCDDEEFF/status');
  assert.equal(Date.parse(state.fields.environment.expiresAt) - Date.parse(state.fields.environment.observedAt), 300000);
  assert.equal(state.fields.environment.verification, 'cloud-reported-selected-device');
  const exposed = JSON.stringify([state, events, adapter]);
  for (const forbidden of [selected.token, selected.secret, selected.vendorDeviceId, 'private-hub', 'private vendor message', 'hubDeviceId']) assert.equal(exposed.includes(forbidden), false);
  await adapter.close(); await assert.rejects(adapter.snapshot(), { code: 'ADAPTER_CLOSED' });
});

test('SwitchBot manual refresh is bounded to one attempt per five minutes and failures do not freshen evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 }); let calls = 0, broken = false;
  const adapter = new SwitchBotAdapter({ deviceId: 'fixture-meter', config: config(), request: async options => { calls++; options.beforeDispatch(); if (broken) throw new Error('private-vendor-details'); return response(); } });
  await adapter.snapshot(); const original = (await adapter.snapshot()).fields.environment; assert.equal(calls, 1);
  t.mock.timers.tick(299999); await adapter.snapshot(); assert.equal(calls, 1);
  t.mock.timers.tick(1); broken = true; await assert.rejects(adapter.snapshot(), error => error.code === 'STATE_UNAVAILABLE' && !error.message.includes('private'));
  const failed = await adapter.snapshot({ refresh: false }); assert.equal(failed.fields.environment.observedAt, original.observedAt);
  assert.equal(failed.fields.environment.expiresAt, new Date(0).toISOString()); await adapter.snapshot(); assert.equal(calls, 2); await adapter.close();
});

test('SwitchBot close aborts an in-flight fixture and blocks late dispatch/publication without waiting for vendor completion', async () => {
  let pendingOptions, release; const events = [];
  const adapter = new SwitchBotAdapter({ deviceId: 'fixture-meter', config: config(), request: options => { pendingOptions = options; return new Promise(resolve => { release = resolve; }); } });
  adapter.subscribe(event => events.push(event)); const reading = adapter.snapshot(), rejected = assert.rejects(reading, { code: 'ADAPTER_CLOSED' });
  await flush(); assert.ok(pendingOptions); const closing = adapter.close(); await rejected; await closing;
  assert.equal(pendingOptions.signal.aborted, true); assert.throws(() => pendingOptions.beforeDispatch(), { code: 'ADAPTER_CLOSED' });
  release(response()); await flush(); assert.deepEqual(events, []);
});

test('SwitchBot timeout never retries a request or permits a late fixture continuation', async () => {
  let options, calls = 0;
  const adapter = new SwitchBotAdapter({ deviceId: 'fixture-meter', config: config({ timeoutMs: 100 }), request: value => { calls++; options = value; return new Promise(() => {}); } });
  await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' }); assert.equal(calls, 1); assert.equal(options.signal.aborted, true);
  assert.throws(() => options.beforeDispatch(), { code: 'REQUEST_ABORTED' }); await adapter.close();
});

test('SwitchBot runtime default poll interval is clamped to the five-minute attempt cadence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 }); let calls = 0;
  const adapter = new SwitchBotAdapter({ deviceId: 'fixture-meter', config: config(), request: async options => { calls++; options.beforeDispatch(); return response(); } });
  await adapter.start({ pollMs: 5000 }); assert.equal(calls, 1); t.mock.timers.tick(5000); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(295000); await flush(); assert.equal(calls, 2); await adapter.close();
});
