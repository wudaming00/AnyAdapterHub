import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LGThinQAdapter, lgThinQHeaders, projectLGThinQSensor } from '../lib/adapters/lg-thinq.mjs';
import { validateLGThinQConfig, protectLGThinQConfig, loadLGThinQConfig, lgThinQVendor } from '../lib/adapters/lg-thinq-config.mjs';
import { testSecretStore } from './helpers/secrets.mjs';

const config = extra => ({ vendorDeviceId: '00000000-1111-2222-3333-444444444444', deviceType: 'DEVICE_AIR_PURIFIER', countryCode: 'US', clientId: '12345678-1234-4123-8123-123456789abc', token: 'synthetic-thinq-personal-access-token', apiKey: 'synthetic-thinq-application-api-key', ...extra });
const range = extra => ({ type: 'range', mode: ['r'], ...extra });
const profile = () => ({ response: { property: { airQualitySensor: { humidity: range() }, filterInfo: { filterRemainPercent: range() } } } });
const state = () => ({ messageId: 'private-message-id', response: { airQualitySensor: { humidity: 42 }, filterInfo: { filterRemainPercent: 65 }, notifications: 'private activity' } });
async function file(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-thinq-fixture-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return path.join(directory, 'synthetic.json');
}

test('ThinQ header contract uses one persistent client identity, random message IDs and fixed production phase', () => {
  const selected = config(), first = lgThinQHeaders(selected), second = lgThinQHeaders(selected);
  assert.equal(first.Authorization, `Bearer ${selected.token}`); assert.equal(first['x-api-key'], selected.apiKey);
  assert.equal(first['x-country'], 'US'); assert.equal(first['x-client-id'], selected.clientId); assert.equal(second['x-client-id'], selected.clientId);
  assert.match(first['x-message-id'], /^[A-Za-z0-9_-]{22}$/); assert.notEqual(first['x-message-id'], second['x-message-id']); assert.equal(first['x-service-phase'], 'OP');
  for (const [countryCode, vendor] of [['US', 'aic'], ['CA', 'aic'], ['KR', 'kic'], ['JP', 'kic'], ['GB', 'eic'], ['DE', 'eic']]) assert.equal(lgThinQVendor(validateLGThinQConfig(config({ countryCode }))), `lg-thinq-${vendor}`);
});

test('ThinQ credentials encrypt and bind exact fixed region/country/device/type/client identity', async t => {
  const secretStore = testSecretStore(), selected = config(), saved = await protectLGThinQConfig(selected, { secretStore }), target = await file(t);
  for (const secret of [selected.token, selected.apiKey]) assert.equal(JSON.stringify(saved).includes(secret), false);
  await writeFile(target, JSON.stringify(saved)); assert.deepEqual(await loadLGThinQConfig(target, { secretStore }), validateLGThinQConfig(selected));
  for (const patch of [{ countryCode: 'CA' }, { countryCode: 'KR' }, { vendorDeviceId: '11111111-1111-2222-3333-444444444444' }, { clientId: '12345678-1234-4123-8123-123456789abd' }, { deviceType: 'DEVICE_DEHUMIDIFIER' }]) {
    await writeFile(target, JSON.stringify({ ...saved, ...patch })); await assert.rejects(loadLGThinQConfig(target, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
  await writeFile(target, JSON.stringify(selected)); await assert.rejects(loadLGThinQConfig(target, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
});

test('ThinQ config rejects arbitrary origin, control/cooking devices, malformed identifiers and executable inputs', () => {
  let accessed = 0; const getter = {}; Object.defineProperty(getter, 'token', { enumerable: true, get() { accessed++; } });
  for (const value of [getter, new Proxy({}, { getPrototypeOf() { accessed++; } }), config({ origin: 'https://malicious.invalid' }), config({ countryCode: 'ZZ' }), config({ deviceType: 'DEVICE_OVEN' }), config({ vendorDeviceId: '../other' }), config({ clientId: '12345678-1234-1123-8123-123456789abc' }), config({ token: 'bad\nheader' }), config({ apiKey: '' })]) assert.throws(() => validateLGThinQConfig(value));
  assert.equal(accessed, 0);
});

test('ThinQ maps only explicit readable numeric resources and rejects write-only, malformed or wrong-device responses', () => {
  assert.deepEqual(projectLGThinQSensor(profile(), state(), config()), { humidityPercent: 42, filterRemainingPercent: 65 });
  for (const change of [p => { p.response.property.airQualitySensor.humidity.mode = ['w']; }, p => { p.response.property.airQualitySensor.humidity.type = 'string'; }, p => { p.response.property.airQualitySensor.humidity.unit = 'F'; }, p => { p.response.property = {}; }]) { const p = profile(); change(p); assert.throws(() => projectLGThinQSensor(p, state(), config())); }
  for (const value of [-1, 101, '42', Infinity]) { const s = state(); s.response.airQualitySensor.humidity = value; assert.throws(() => projectLGThinQSensor(profile(), s, config())); }
  assert.throws(() => projectLGThinQSensor(profile(), { response: { deviceId: 'other', airQualitySensor: { humidity: 42 } } }, config()));
  assert.throws(() => projectLGThinQSensor(profile(), { error: { message: 'private auth error' } }, config()));
  assert.throws(() => projectLGThinQSensor(profile(), { response: [{ airQualitySensor: { humidity: 42 } }] }, config()));
  let accessed = 0; const p = profile(); Object.defineProperty(p.response.property.airQualitySensor.humidity.mode, '0', { enumerable: true, get() { accessed++; } });
  assert.throws(() => projectLGThinQSensor(p, state(), config())); assert.equal(accessed, 0);
});

test('ThinQ dehumidifier humidity and explicit AC Celsius use reviewed fixed resource maps only', () => {
  for (const [deviceType, resource, property, value, output] of [['DEVICE_DEHUMIDIFIER', 'humidity', 'currentHumidity', 55, 'humidityPercent'], ['DEVICE_AIR_CONDITIONER', 'temperature', 'currentTemperatureC', 22.5, 'temperatureC']]) {
    const p = { response: { property: { [resource]: { [property]: range({ mode: ['r', 'w'] }) } } } }, s = { response: { [resource]: { [property]: value } } };
    assert.deepEqual(projectLGThinQSensor(p, s, config({ deviceType })), { [output]: value });
  }
  assert.throws(() => projectLGThinQSensor({ response: { property: {} } }, { response: { temperature: { currentTemperatureF: 72 } } }, config({ deviceType: 'DEVICE_AIR_CONDITIONER' })));
});

test('ThinQ rejects wrong temperature units and accepts canonical percentage/Celsius metadata', () => {
  const selected = config({ deviceType: 'DEVICE_AIR_CONDITIONER' }), s = { response: { temperature: { currentTemperatureC: 22 } } };
  for (const unit of ['F', 'FAHRENHEIT', 'kelvin', 1, {}]) assert.throws(() => projectLGThinQSensor({ response: { property: { temperature: { currentTemperatureC: range({ unit }) } } } }, s, selected));
  assert.equal(projectLGThinQSensor({ response: { property: { temperature: { currentTemperatureC: range({ unit: 'C' }) } } } }, s, selected).temperatureC, 22);
  const p = profile(); p.response.property.airQualitySensor.humidity.unit = '%'; assert.equal(projectLGThinQSensor(p, state(), config()).humidityPercent, 42);
});

test('ThinQ is inert until reading and uses only exact selected profile/state GETs with no raw metadata leaks', async () => {
  const selected = config(), seen = [], events = [], adapter = new LGThinQAdapter({ deviceId: 'fixture-purifier', config: selected, request: async options => { seen.push(options); options.beforeDispatch(); return options.path.endsWith('/profile') ? profile() : state(); } });
  adapter.subscribe(event => events.push(event)); assert.equal(seen.length, 0); assert.deepEqual(adapter.supportedActions, []);
  await assert.rejects(adapter.execute({ action: 'thinq.control' }), { code: 'UNSUPPORTED_ACTION' }); assert.equal(seen.length, 0);
  const snapshot = await adapter.snapshot(); assert.deepEqual(seen.map(value => [value.method, value.path]), [['GET', `/devices/${selected.vendorDeviceId}/profile`], ['GET', `/devices/${selected.vendorDeviceId}/state`]]);
  const exposed = JSON.stringify([snapshot, events, adapter]);
  for (const forbidden of [selected.vendorDeviceId, selected.token, selected.apiKey, selected.clientId, 'private-message-id', 'private activity']) assert.equal(exposed.includes(forbidden), false);
  await adapter.snapshot(); assert.equal(seen.length, 2); await adapter.close();
});

test('ThinQ malformed or foreign profile is rejected before the selected state request', async () => {
  let requests = 0; const adapter = new LGThinQAdapter({ deviceId: 'fixture-purifier', config: config(), request: async () => { requests++; return { response: { deviceId: 'foreign-device' } }; } });
  await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' }); assert.equal(requests, 1); await adapter.close();
});
