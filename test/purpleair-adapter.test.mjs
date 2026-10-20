import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PurpleAirAdapter, projectPurpleAirSensor } from '../lib/adapters/purpleair.mjs';
import { validatePurpleAirConfig, protectPurpleAirConfig, loadPurpleAirConfig } from '../lib/adapters/purpleair-config.mjs';
import { testSecretStore } from './helpers/secrets.mjs';

const now = 1700000000000, seconds = now / 1000;
const config = extra => ({ vendorDeviceId: 23456, apiKey: 'synthetic-purpleair-read-api-key', ...extra });
const response = extra => ({ time_stamp: seconds, data_time_stamp: seconds - 10, sensor: { sensor_index: 23456, last_seen: seconds - 60, temperature: 77, humidity: 40, 'pm2.5_atm': 5.5, name: 'private sensor label', latitude: 1.234, longitude: 2.345, ...extra } });
async function file(t) { const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-purpleair-fixture-')); t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); }); return path.join(directory, 'fixture.json'); }

test('PurpleAir READ key encrypts and binds exact public selected sensor and fixed origin', async t => {
  const secretStore = testSecretStore(), clear = config(), saved = await protectPurpleAirConfig(clear, { secretStore }), target = await file(t);
  assert.equal(JSON.stringify(saved).includes(clear.apiKey), false); await writeFile(target, JSON.stringify(saved)); assert.deepEqual(await loadPurpleAirConfig(target, { secretStore }), validatePurpleAirConfig(clear));
  await writeFile(target, JSON.stringify({ ...saved, vendorDeviceId: 23457 })); await assert.rejects(loadPurpleAirConfig(target, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
  await writeFile(target, JSON.stringify(clear)); await assert.rejects(loadPurpleAirConfig(target, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
});

test('PurpleAir private read keys, arbitrary fields/origins, URL secrets and executable config are rejected', () => {
  let accessed = 0; const bad = {}; Object.defineProperty(bad, 'apiKey', { enumerable: true, get() { accessed++; } });
  for (const value of [bad, new Proxy({}, { getPrototypeOf() { accessed++; } }), config({ vendorDeviceId: '23456' }), config({ vendorDeviceId: 0 }), config({ vendorDeviceId: Infinity }), config({ read_key: 'private-secret' }), config({ readKey: 'private-secret' }), config({ origin: 'https://other.invalid' }), config({ fields: 'latitude,longitude' }), config({ apiKey: 'bad\rheader' })]) assert.throws(() => validatePurpleAirConfig(value));
  assert.equal(accessed, 0);
});

test('PurpleAir projection identifies housing temperature/humidity and ATM PM values without ambient/AQI guesses', () => {
  const projected = projectPurpleAirSensor(response(), config(), now);
  assert.deepEqual(projected, { reportedAt: now - 60000, value: { sensorHousingTemperatureC: 25, sensorHousingHumidityPercent: 40, pm25AtmosphericUgM3: 5.5 } });
  assert.deepEqual(projectPurpleAirSensor(response({ temperature: null, humidity: null }), config(), now).value, { pm25AtmosphericUgM3: 5.5 });
  for (const patch of [{ sensor_index: 23457 }, { private: 1 }, { temperature: '77' }, { temperature: Infinity }, { humidity: 101 }, { 'pm2.5_atm': -1 }, { 'pm2.5_atm': NaN }, { temperature: null, humidity: null, 'pm2.5_atm': null }]) assert.throws(() => projectPurpleAirSensor(response(patch), config(), now));
});

test('PurpleAir source/server timestamps must be finite integer seconds, current and consistently ordered', () => {
  for (const last_seen of [seconds - 600, seconds + 1, now, 0, '1700000000', NaN, Infinity]) assert.throws(() => projectPurpleAirSensor(response({ last_seen }), config(), now));
  assert.throws(() => projectPurpleAirSensor(response({ last_seen: seconds - 1 }), config(), now));
  for (const patch of [{ time_stamp: seconds + 1 }, { data_time_stamp: seconds - 31 }, { data_time_stamp: seconds + 1 }, { time_stamp: seconds - 601 }, { time_stamp: null }, { error: 'private-error' }]) assert.throws(() => projectPurpleAirSensor({ ...response(), ...patch }, config(), now));
  let accessed = 0; const s = response(); Object.defineProperty(s.sensor, 'last_seen', { enumerable: true, get() { accessed++; } });
  assert.throws(() => projectPurpleAirSensor(s, config(), now)); assert.equal(accessed, 0);
});

test('PurpleAir read is inert until requested and uses only exact selected fields and authentication header', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); const requests = [], events = [], clear = config();
  const adapter = new PurpleAirAdapter({ deviceId: 'fixture-air', config: clear, request: async options => { requests.push(options); options.beforeDispatch(); return response(); } });
  adapter.subscribe(event => events.push(event)); assert.deepEqual(adapter.supportedActions, []); assert.equal(requests.length, 0);
  await assert.rejects(adapter.execute({ action: 'purpleair.history' }), { code: 'UNSUPPORTED_ACTION' }); assert.equal(requests.length, 0);
  const snapshot = await adapter.snapshot(); assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].path, '/v1/sensors/23456?fields=last_seen,temperature,humidity,pm2.5_atm'); assert.deepEqual(requests[0].headers, { 'X-API-Key': clear.apiKey });
  assert.equal(Date.parse(snapshot.fields.environment.observedAt), now - 60000);
  for (const forbidden of [clear.apiKey, '23456', 'private sensor label', 'latitude', 'longitude']) assert.equal(JSON.stringify([snapshot, events, adapter]).includes(forbidden), false);
  await adapter.snapshot(); assert.equal(requests.length, 1); await adapter.close();
});

test('PurpleAir cached source evidence expires within ten minutes of last_seen and never refreshes on stale errors', async t => {
  t.mock.timers.enable({ apis: ['Date'], now }); let calls = 0;
  const adapter = new PurpleAirAdapter({ deviceId: 'fixture-air', config: config(), request: async options => { calls++; options.beforeDispatch(); return response({ last_seen: seconds - 590 }); } });
  const original = await adapter.snapshot(); assert.equal(Date.parse(original.fields.environment.expiresAt), now + 10000);
  t.mock.timers.tick(300000); await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' });
  const failed = await adapter.snapshot({ refresh: false }); assert.equal(failed.fields.environment.observedAt, original.fields.environment.observedAt); assert.equal(Date.parse(failed.fields.environment.expiresAt), 0); assert.equal(calls, 2); await adapter.close();
});
