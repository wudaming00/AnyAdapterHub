import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecretStore } from '../lib/security/secret-store.mjs';
import { OpenHABAdapter, projectOpenHABItem } from '../lib/adapters/openhab.mjs';
import { validateOpenHABConfig, protectOpenHABConfig, loadOpenHABConfig } from '../lib/adapters/openhab-config.mjs';

function certificate() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag, ...parts) => { const bytes = Buffer.concat(parts), lengths = []; let size = bytes.length;
    do { lengths.unshift(size & 255); size >>>= 8; } while (size);
    return Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | lengths.length, ...lengths])]), bytes]); };
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('openHAB offline fixture')))));
  const time = value => der(0x17, Buffer.from(new Date(value).toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const san = der(0xa3, der(0x30, der(0x30, Buffer.from('0603551d11', 'hex'), der(4, der(0x30, der(0x87, Buffer.from([127, 0, 0, 1])))))));
  const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    der(0x30, time(Date.now() - 86400000), time(Date.now() + 86400000)), name, keys.publicKey.export({ type: 'spki', format: 'der' }), san);
  const raw = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, keys.privateKey)));
  return { certificate: ['-----BEGIN CERTIFICATE-----', ...raw.toString('base64').match(/.{1,64}/g), '-----END CERTIFICATE-----', ''].join('\n'),
    certificatePin: createHash('sha256').update(raw).digest('hex'), key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const identity = certificate();
const config = (extra = {}) => ({ origin: 'https://127.0.0.1:18443', certificate: identity.certificate, certificatePin: identity.certificatePin,
  itemName: 'Fixture_Item', itemType: 'Switch', timeoutMs: 500, token: 'oh.synthetic_openhab_api_token', ...extra });
const item = (state, type = 'Switch', extra = {}) => ({ name: 'Fixture_Item', type, state, label: 'Untrusted private label',
  link: 'https://untrusted.example/private/item', tags: ['private'], metadata: { command: 'run code' }, ...extra });
const store = () => createSecretStore({ provider: 'portable-test', protect: async (bytes, entropy) => Buffer.concat([entropy, bytes]),
  unprotect: async (bytes, entropy) => { assert.deepEqual(bytes.subarray(0, 32), entropy); return bytes.subarray(32); } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };

test('openHAB config fixes HTTPS identity, exact item name/type and token; arbitrary routes and credential forms are denied', () => {
  assert.equal(validateOpenHABConfig(config()).itemName, 'Fixture_Item');
  for (const extra of [{ origin: 'http://127.0.0.1' }, { origin: config().origin + '/rest/items' }, { origin: config().origin + '/' },
    { origin: 'https://admin:secret@127.0.0.1' }, { origin: 'https://127.0.0.2:18443' }, { certificatePin: 'a'.repeat(64) },
    { certificate: identity.certificate + identity.certificate }, { itemName: '../items' }, { itemName: 'Fixture/Other' },
    { itemName: 'Fixture?fields=all' }, { itemName: '1Invalid' }, { itemName: '*' }, { itemName: '' }, { itemName: 'a'.repeat(129) },
    { itemType: 'Group' }, { itemType: 'String' }, { itemType: 'Image' }, { itemType: 'Number:Arbitrary' },
    { token: 'bad:password' }, { token: 'x\r\nsecret' }, { token: '' }, { timeoutMs: 0 }, { method: 'POST' }, { username: 'owner' }]) {
    assert.throws(() => validateOpenHABConfig(config(extra)), { code: 'INVALID_CONFIG' });
  }
});

test('executable descriptors and proxies cannot select configuration, features or state values', async () => {
  let reads = 0;
  const accessor = config(); Object.defineProperty(accessor, 'token', { enumerable: true, get() { reads++; return 'bad'; } });
  const proxy = new Proxy(config(), { getPrototypeOf() { reads++; throw new Error('do not inspect'); } });
  for (const value of [accessor, proxy, { ...config(), [Symbol('extra')]: true }]) assert.throws(() => validateOpenHABConfig(value), { code: 'INVALID_CONFIG' });
  assert.throws(() => new OpenHABAdapter({ deviceId: 'fixture', config: config(), features: ['control'] }), { code: 'INVALID_FEATURES' });
  const features = []; Object.defineProperty(features, 'extra', { get() { reads++; return true; } });
  assert.throws(() => new OpenHABAdapter({ deviceId: 'fixture', config: config(), features }), { code: 'INVALID_FEATURES' });
  const state = item('ON'); Object.defineProperty(state, 'state', { enumerable: true, get() { reads++; return 'OFF'; } });
  assert.throws(() => projectOpenHABItem(state, config().itemName, 'Switch'), { code: 'INVALID_ITEM_RESPONSE' });
  assert.equal(reads, 0);
});

test('token storage binds origin, certificate, selected item and type and never permits a plaintext saved token', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyadapter-openhab-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json'), secretStore = store(), saved = await protectOpenHABConfig(config(), { secretStore });
  assert.equal(Object.hasOwn(saved, 'token'), false); assert.equal(JSON.stringify(saved).includes(config().token), false);
  await writeFile(file, JSON.stringify(saved)); assert.deepEqual(await loadOpenHABConfig(file, { secretStore }), config());
  const other = certificate();
  for (const extra of [{ origin: 'https://127.0.0.1:18444' }, { itemName: 'Other_Item' }, { itemType: 'Dimmer' },
    { certificate: other.certificate, certificatePin: other.certificatePin }]) {
    await writeFile(file, JSON.stringify({ ...saved, ...extra }));
    await assert.rejects(loadOpenHABConfig(file, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
  await writeFile(file, JSON.stringify({ ...saved, token: config().token }));
  await assert.rejects(loadOpenHABConfig(file, { secretStore }), { code: 'INVALID_CONFIG' });
});

test('only matching item identity and supported type produce finite booleans or normalized numbers', () => {
  for (const [type, state, field, value] of [
    ['Switch', 'ON', 'power', true], ['Switch', 'OFF', 'power', false], ['Dimmer', '37.5', 'brightnessPercent', 37.5],
    ['Dimmer', '0', 'brightnessPercent', 0], ['Dimmer', '100', 'brightnessPercent', 100], ['Number', '-25.5', 'number', -25.5],
    ['Number:Temperature', '68 °F', 'temperatureC', 20], ['Number:Temperature', '293.15 K', 'temperatureC', 20],
    ['Number:Temperature', '20 °C', 'temperatureC', 20], ['Number:Power', '1.25 kW', 'powerWatts', 1250],
    ['Number:Energy', '1500 Wh', 'energyKwh', 1.5], ['Number:Energy', '3600000 J', 'energyKwh', 1],
    ['Number:ElectricPotential', '120000 mV', 'voltageV', 120], ['Number:ElectricCurrent', '100 mA', 'currentAmps', 0.1],
    ['Number:Illuminance', '250 lx', 'illuminanceLux', 250], ['Number:Frequency', '0.5 kHz', 'frequencyHz', 500],
    ['Number:Dimensionless', '50 %', 'ratio', 0.5], ['Number:Dimensionless', '400 ppm', 'ratio', 0.0004],
  ]) assert.deepEqual(projectOpenHABItem(item(state, type), config().itemName, type), { available: true, field, value });
  assert.deepEqual(projectOpenHABItem(item('UNDEF'), config().itemName, 'Switch'), { available: false, field: 'power' });
  assert.deepEqual(projectOpenHABItem(item('NULL', 'Number'), config().itemName, 'Number'), { available: false, field: 'number' });
  for (const [type, state] of [['Switch', 'true'], ['Switch', 'TOGGLE'], ['Dimmer', 'ON'], ['Dimmer', 'OFF'], ['Dimmer', '101'], ['Dimmer', '20 %'],
    ['Number', 'NaN'], ['Number', 'Infinity'], ['Number', '1e999'], ['Number', '1e13'], ['Number', '2 W'],
    ['Number:Temperature', '20'], ['Number:Temperature', '20 C'], ['Number:Temperature', '500 °C'],
    ['Number:Power', '12 var'], ['Number:Illuminance', '-1 lx'], ['Number:Dimensionless', '20 dB'], ['Number', '{}'], ['Number', '1\nprivate']]) {
    assert.throws(() => projectOpenHABItem(item(state, type), config().itemName, type));
  }
  assert.throws(() => projectOpenHABItem(item('ON', 'Switch', { name: 'Other_Item' }), config().itemName, 'Switch'), { code: 'INVALID_ITEM_RESPONSE' });
  assert.throws(() => projectOpenHABItem(item('ON', 'Group'), config().itemName, 'Switch'), { code: 'INVALID_ITEM_RESPONSE' });
});

test('construction/listeners stay inert; one exact GET uses token as Basic username and empty password with no actions', async () => {
  const requests = [], events = [];
  const adapter = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: config(), request: async request => {
    requests.push(request); request.beforeDispatch(); return item('ON');
  } });
  adapter.subscribe(event => events.push(event)); assert.equal(requests.length, 0); assert.deepEqual(adapter.supportedActions, []);
  await assert.rejects(adapter.execute({ action: 'switch.power.set', args: { on: false } }), { code: 'UNSUPPORTED_ACTION' });
  const state = await adapter.snapshot(); assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].path, '/rest/items/Fixture_Item'); assert.equal(requests[0].body, undefined);
  assert.equal(requests[0].headers.Accept, 'application/json');
  assert.equal(Buffer.from(requests[0].headers.Authorization.slice(6), 'base64').toString(), config().token + ':');
  assert.equal(state.fields.power.value, true); assert.equal(state.fields.available.value, true);
  assert.equal(state.fields.power.verification, 'hub-reported-selected-item'); assert.equal(state.fields.power.source, 'openhab-https');
  assert.equal(Date.parse(state.fields.power.expiresAt) - Date.parse(state.fields.power.observedAt), 15000);
  for (const output of [JSON.stringify(adapter), JSON.stringify(state), JSON.stringify(events)]) {
    for (const secret of [config().token, config().origin, config().itemName, 'Untrusted private label', 'untrusted.example', 'run code']) assert.equal(output.includes(secret), false);
  }
  await adapter.close();
});

test('NULL/UNDEF expires earlier measurement evidence; malformed or failed reads cannot refresh its age', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let state = item('15', 'Dimmer');
  const adapter = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: config({ itemType: 'Dimmer' }), request: async () => state });
  const initial = await adapter.snapshot(); const observedAt = initial.fields.brightnessPercent.observedAt;
  t.mock.timers.tick(1000); state = item('UNDEF', 'Dimmer'); const unknown = await adapter.snapshot();
  assert.equal(unknown.fields.available.value, false); assert.equal(unknown.fields.brightnessPercent.expiresAt, new Date(0).toISOString());
  assert.equal(unknown.fields.brightnessPercent.observedAt, observedAt);
  state = item('NaN', 'Dimmer'); await assert.rejects(adapter.snapshot(), { code: 'INVALID_ITEM_RESPONSE' });
  const after = await adapter.snapshot({ refresh: false }); assert.deepEqual(after.fields, unknown.fields); await adapter.close();
});

test('Dimmer ON or OFF cannot manufacture a brightness value or refresh an existing numeric percentage', async () => {
  let state = item('37', 'Dimmer');
  const adapter = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: config({ itemType: 'Dimmer' }), request: async () => state });
  const initial = await adapter.snapshot();
  for (const unsupported of ['ON', 'OFF']) {
    state = item(unsupported, 'Dimmer'); await assert.rejects(adapter.snapshot(), { code: 'INVALID_ITEM_RESPONSE' });
    assert.deepEqual((await adapter.snapshot({ refresh: false })).fields, initial.fields);
  }
  await adapter.close();
});

test('expired in-flight read cannot produce fresh state', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const gate = deferred();
  const adapter = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: config(), request: async request => {
    request.beforeDispatch(); await gate.promise; return item('ON');
  } });
  const pending = adapter.snapshot(); await flush(); t.mock.timers.tick(16000); gate.resolve();
  await assert.rejects(pending, { code: 'STALE_STATE' });
  const state = await adapter.snapshot({ refresh: false }); assert.deepEqual(state.fields, {}); await adapter.close();
});

test('polling never overlaps and close prevents late dispatch/events', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const gate = deferred(); let calls = 0, late;
  const adapter = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: config(), request: async request => {
    calls++; late = request; await gate.promise; request.beforeDispatch(); return item('ON');
  } });
  const events = []; adapter.subscribe(event => events.push(event)); const starting = adapter.start(); await flush();
  assert.equal(calls, 1); t.mock.timers.tick(400); await flush(); assert.equal(calls, 1);
  const closing = adapter.close(); await closing; await starting; const count = events.length;
  gate.resolve(); await flush(); t.mock.timers.tick(60000); await flush();
  assert.equal(late.signal.aborted, true); assert.equal(events.length, count); assert.equal(calls, 1);
  await assert.rejects(adapter.snapshot(), { code: 'ADAPTER_CLOSED' });
});

async function tlsFixture(t, serverIdentity = identity, { redirect = false } = {}) {
  const requests = [], sockets = new Set();
  const server = https.createServer({ cert: serverIdentity.certificate, key: serverIdentity.key }, (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (redirect) { response.writeHead(302, { Location: 'https://untrusted.invalid/rest/items/Other' }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(item('ON')));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { requests, config: config({ origin: `https://127.0.0.1:${server.address().port}`, timeoutMs: 1000 }) };
}

test('native pinned HTTPS sends Basic token only to the selected item route and never writes', { timeout: 5000 }, async t => {
  const f = await tlsFixture(t), adapter = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: f.config });
  t.after(() => adapter.close()); const state = await adapter.snapshot();
  assert.equal(state.fields.power.value, true); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
  assert.equal(f.requests[0].url, '/rest/items/Fixture_Item');
  assert.equal(Buffer.from(f.requests[0].authorization.slice(6), 'base64').toString(), config().token + ':');
  await adapter.close();
});

test('wrong TLS leaf gets zero HTTP/token bytes; redirects never expose another item or origin', { timeout: 5000 }, async t => {
  const wrong = await tlsFixture(t, certificate()), adapter = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: wrong.config });
  await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' }); assert.deepEqual(wrong.requests, []); await adapter.close();
  const redirect = await tlsFixture(t, identity, { redirect: true }), other = new OpenHABAdapter({ deviceId: 'fixture-openhab', config: redirect.config });
  await assert.rejects(other.snapshot(), { code: 'STATE_UNAVAILABLE' }); assert.equal(redirect.requests.length, 1); await other.close();
});
