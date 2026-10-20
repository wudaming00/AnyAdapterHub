import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AwairAdapter, projectAwairSensor } from '../lib/adapters/awair.mjs';
import { validateAwairConfig, protectAwairConfig, loadAwairConfig } from '../lib/adapters/awair-config.mjs';
import { testSecretStore } from './helpers/secrets.mjs';

const now = 1700000000000;
const config = extra => ({ vendorDeviceId: 1234, deviceType: 'awair-element', token: 'synthetic-awair-personal-token', ...extra });
const response = extra => ({ data: [{ timestamp: new Date(now - 60000).toISOString(), score: 88, sensors: [{ comp: 'temp', value: 23.5 }, { comp: 'humid', value: 40 }, { comp: 'co2', value: 600 }, { comp: 'voc', value: 250 }, { comp: 'pm25', value: 4 }], ...extra }] });
async function file(t) { const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-awair-fixture-')); t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }); return path.join(directory, 'fixture.json'); }

test('Awair credentials encrypt and bind one fixed origin/device type/device number', async t => {
  const secretStore = testSecretStore(), clear = config(), saved = await protectAwairConfig(clear, { secretStore }), target = await file(t);
  assert.equal(JSON.stringify(saved).includes(clear.token), false); await writeFile(target, JSON.stringify(saved));
  assert.deepEqual(await loadAwairConfig(target, { secretStore }), validateAwairConfig(clear));
  for (const patch of [{ vendorDeviceId: 1235 }, { deviceType: 'awair-r2' }]) { await writeFile(target, JSON.stringify({ ...saved, ...patch })); await assert.rejects(loadAwairConfig(target, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' }); }
  await writeFile(target, JSON.stringify(clear)); await assert.rejects(loadAwairConfig(target, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
});

test('Awair enrollment denies arbitrary routing, unsupported device families, secret headers and executable configuration', () => {
  let accessed = 0; const bad = {}; Object.defineProperty(bad, 'vendorDeviceId', { enumerable: true, get() { accessed++; } });
  for (const value of [bad, new Proxy({}, { getPrototypeOf() { accessed++; } }), config({ vendorDeviceId: '1234' }), config({ vendorDeviceId: -1 }), config({ vendorDeviceId: 1.5 }), config({ deviceType: '../other' }), config({ origin: 'https://other.invalid' }), config({ token: 'bad\nheader' }), config({ query: 'fahrenheit=true' })]) assert.throws(() => validateAwairConfig(value));
  assert.equal(accessed, 0);
});

test('Awair projection maps only known finite numeric components and preserves validated reported sample time', () => {
  const projected = projectAwairSensor(response(), config(), now);
  assert.deepEqual(projected, { reportedAt: now - 60000, value: { temperatureC: 23.5, humidityPercent: 40, co2Ppm: 600, vocPpb: 250, pm25UgM3: 4 } });
  for (const [comp, value] of [['temp', '23'], ['humid', 101], ['co2', -1], ['pm25', Infinity], ['voc', NaN]]) assert.throws(() => projectAwairSensor(response({ sensors: [{ comp, value }] }), config(), now));
  assert.throws(() => projectAwairSensor(response({ sensors: [{ comp: 'temp', value: 20 }, { comp: 'temp', value: 21 }] }), config(), now));
  assert.throws(() => projectAwairSensor(response({ sensors: [{ comp: 'unknown', value: 'private' }] }), config(), now));
});

test('Awair empty/disconnected, stale, future, impossible and malformed timestamps fail closed', () => {
  assert.throws(() => projectAwairSensor({ data: [] }, config(), now));
  assert.throws(() => projectAwairSensor({ data: [response().data[0], response().data[0]] }, config(), now));
  for (const timestamp of [new Date(now - 600000).toISOString(), new Date(now + 1).toISOString(), '2023-02-30T12:00:00.000Z', '2023-11-14', now, '', null]) assert.throws(() => projectAwairSensor(response({ timestamp }), config(), now));
  let accessed = 0; const array = response().data; Object.defineProperty(array, '0', { enumerable: true, get() { accessed++; } });
  assert.throws(() => projectAwairSensor({ data: array }, config(), now)); assert.equal(accessed, 0);
});

test('Awair is inert, uses one fixed Celsius/latest GET and excludes private device/account text', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); const requests = [], events = [], clear = config();
  const adapter = new AwairAdapter({ deviceId: 'fixture-air', config: clear, request: async options => { requests.push(options); options.beforeDispatch(); return { ...response(), privateLocation: 'private home' }; } });
  adapter.subscribe(event => events.push(event)); assert.deepEqual(adapter.supportedActions, []); assert.equal(requests.length, 0);
  await assert.rejects(adapter.execute({ action: 'awair.display.set' }), { code: 'UNSUPPORTED_ACTION' }); assert.equal(requests.length, 0);
  const snapshot = await adapter.snapshot(), cell = snapshot.fields.environment;
  assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].path, '/v1/users/self/devices/awair-element/1234/air-data/latest?fahrenheit=false');
  assert.equal(requests[0].headers.Authorization, `Bearer ${clear.token}`);
  assert.equal(Date.parse(cell.observedAt), now - 60000); assert.equal(Date.parse(cell.expiresAt), now + 300000);
  for (const forbidden of [clear.token, 'private home', 'vendorDeviceId', '1234', 'score']) assert.equal(JSON.stringify([snapshot, events, adapter]).includes(forbidden), false);
  await adapter.snapshot(); assert.equal(requests.length, 1); await adapter.close();
});

test('Awair old-but-allowed samples expire at their source-age bound and stale refresh never freshens them', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); let calls = 0;
  const adapter = new AwairAdapter({ deviceId: 'fixture-air', config: config(), request: async options => { calls++; options.beforeDispatch(); return response({ timestamp: new Date(now - 540000).toISOString() }); } });
  const original = await adapter.snapshot(); assert.equal(Date.parse(original.fields.environment.expiresAt), now + 60000);
  t.mock.timers.tick(300000); await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' });
  const failed = await adapter.snapshot({ refresh: false }); assert.equal(failed.fields.environment.observedAt, original.fields.environment.observedAt); assert.equal(Date.parse(failed.fields.environment.expiresAt), 0); assert.equal(calls, 2); await adapter.close();
});
