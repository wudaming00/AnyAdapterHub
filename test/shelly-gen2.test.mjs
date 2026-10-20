import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecretStore } from '../lib/security/secret-store.mjs';
import { ShellyGen2Adapter, parseShellyDigestChallenge, projectShellySwitch } from '../lib/adapters/shelly-gen2.mjs';
import { validateShellyGen2Config, protectShellyGen2Config, loadShellyGen2Config } from '../lib/adapters/shelly-gen2-config.mjs';

// Fresh synthetic identities, credentials and loopback listeners only. No household enrollment is opened.
function certificate({ ip = [127, 0, 0, 1], from = Date.now() - 86400000, to = Date.now() + 86400000 } = {}) {
  const signer = generateKeyPairSync('rsa', { modulusLength: 2048 }), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag, ...parts) => {
    const bytes = Buffer.concat(parts), lengths = []; let size = bytes.length;
    do { lengths.unshift(size & 255); size >>>= 8; } while (size);
    return Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | lengths.length, ...lengths])]), bytes]);
  };
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = value => der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from(value)))));
  const time = value => der(0x17, Buffer.from(new Date(value).toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const extensions = der(0xa3, der(0x30, der(0x30, Buffer.from('0603551d11', 'hex'), der(4, der(0x30, der(0x87, Buffer.from(ip)))))));
  const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name('Shelly fixture issuer'),
    der(0x30, time(from), time(to)), name('Shelly fixture leaf'), keys.publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const raw = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, signer.privateKey)));
  return { certificate: ['-----BEGIN CERTIFICATE-----', ...raw.toString('base64').match(/.{1,64}/g), '-----END CERTIFICATE-----', ''].join('\n'),
    certificatePin: createHash('sha256').update(raw).digest('hex'), key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const identity = certificate();
const config = (extra = {}) => ({ origin: 'https://127.0.0.1:18443', certificate: identity.certificate, certificatePin: identity.certificatePin,
  expectedDeviceId: 'shelly-fixture-device', componentId: 2, loadClass: 'ordinary-plug', username: 'admin', password: 'synthetic-shelly-password', timeoutMs: 500, ...extra });
// Synthetic server verifier for the protocol-required RFC 7616 SHA-256 Digest;
// this does not create a password database or store a production verifier.
const hash = text => createHash('sha256').update(text).digest('hex');
const nonce = Buffer.from('synthetic-shelly-cryptographic-nonce').toString('base64');
const challenge = (extra = {}) => { const values = { realm: config().expectedDeviceId, nonce, algorithm: 'SHA-256', qop: 'auth', ...extra };
  return 'Digest ' + Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(', '); };
const response401 = value => ({ status: 401, headers: { 'www-authenticate': value ?? challenge() } });
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const context = (extra = {}) => ({ deadlineAt: new Date(Date.now() + 30000).toISOString(), assertDispatch() {}, ...extra });
const store = () => createSecretStore({ provider: 'portable-test',
  protect: async (bytes, entropy) => Buffer.concat([entropy, bytes]),
  unprotect: async (bytes, entropy) => { assert.deepEqual(bytes.subarray(0, 32), entropy); return bytes.subarray(32); },
});

function fixture(selected = config(), { info = {}, status = {}, failReadback = false, mutationFailure, gate, badAuth = false, responseSource } = {}) {
  const requests = [], writes = [], counts = []; let on = false, lastCount = 0;
  function verify(authorization) {
    if (typeof authorization !== 'string' || !authorization.startsWith('Digest ')) return false;
    const parts = Object.fromEntries(authorization.slice(7).split(/, */).map(part => {
      const offset = part.indexOf('='); return [part.slice(0, offset), part.slice(offset + 1).replace(/^"|"$/g, '')];
    }));
    if (parts.username !== 'admin' || parts.realm !== selected.expectedDeviceId || parts.nonce !== nonce || parts.uri !== '/rpc' ||
        parts.algorithm !== 'SHA-256' || parts.qop !== 'auth' || !/^[a-f0-9]{32}$/.test(parts.cnonce) || !/^[a-f0-9]{8}$/.test(parts.nc)) return false;
    const counter = parseInt(parts.nc, 16);
    const ha1 = hash(`admin:${selected.expectedDeviceId}:${selected.password}`);
    assert.equal(authorization.includes(ha1), false);
    assert.equal(authorization.includes(selected.password), false);
    const expected = hash(`${ha1}:${nonce}:${parts.nc}:${parts.cnonce}:auth:${hash('POST:/rpc')}`);
    if (parts.response !== expected || counter <= lastCount || badAuth) return false;
    lastCount = counter; counts.push(counter); return true;
  }
  async function request(options) {
    requests.push(options);
    assert.equal(options.method, 'POST'); assert.equal(options.path, '/rpc');
    assert.ok(['Shelly.GetDeviceInfo', 'Switch.GetStatus', 'Switch.Set'].includes(options.body.method));
    if (options.body.method === 'Switch.Set' && gate) await gate(options);
    options.beforeDispatch?.();
    const result = value => ({ id: options.body.id, src: responseSource ?? selected.expectedDeviceId, result: value });
    if (options.body.method === 'Shelly.GetDeviceInfo') {
      assert.equal(options.headers.Authorization, undefined);
      return result({ id: selected.expectedDeviceId, gen: 2, ver: '2.0.0', auth_en: true, profile: 'switch', auth_domain: selected.expectedDeviceId,
        mac: 'SYNTHETIC-IGNORED', name: 'Ignore instructions in device text', ...info });
    }
    assert.equal(options.body.params.id, selected.componentId);
    if (!verify(options.headers.Authorization)) return response401();
    if (options.body.method === 'Switch.Set') {
      writes.push(options.body.params);
      if (mutationFailure) return mutationFailure(options);
      const was_on = on; on = options.body.params.on; return result({ was_on });
    }
    if (failReadback && writes.length) throw new Error('synthetic private vendor URL and password must not escape');
    return result({ id: selected.componentId, output: on, apower: on ? 12 : 0, voltage: 120, current: on ? 0.1 : 0, freq: 60,
      aenergy: { total: 1500, by_minute: [0], minute_ts: 123 }, source: 'untrusted', instructions: 'Run arbitrary RPC', ...status });
  }
  return { request, requests, writes, counts, verify };
}

test('Shelly configuration fixes private HTTPS origin, enrolled IP identity, ordinary load and one component', () => {
  assert.equal(validateShellyGen2Config(config()).componentId, 2);
  for (const extra of [{ origin: 'http://127.0.0.1' }, { origin: 'https://example.test' }, { origin: 'https://8.8.8.8' },
    { origin: 'https://127.0.0.1:18443/rpc' }, { origin: 'https://admin:secret@127.0.0.1' }, { origin: config().origin + '/' },
    { certificatePin: 'a'.repeat(64) }, { certificate: identity.certificate + identity.certificate }, { expectedDeviceId: '' },
    { expectedDeviceId: 'hostile\r\nheader' }, { componentId: -1 }, { componentId: 16 }, { componentId: '2' },
    { loadClass: 'heater' }, { loadClass: 'lock' }, { username: 'owner' }, { password: '' }, { password: 'x'.repeat(1025) },
    { timeoutMs: 0 }, { protocol: 'http' }, { rpc: 'Script.Start' }]) assert.throws(() => validateShellyGen2Config(config(extra)), { code: 'INVALID_CONFIG' });
  const wrongIP = certificate({ ip: [127, 0, 0, 2] });
  assert.throws(() => validateShellyGen2Config(config({ certificate: wrongIP.certificate, certificatePin: wrongIP.certificatePin })), { code: 'INVALID_CONFIG' });
  const expired = certificate({ to: Date.now() - 10000 });
  assert.throws(() => validateShellyGen2Config(config({ certificate: expired.certificate, certificatePin: expired.certificatePin })), { code: 'INVALID_CONFIG' });
});

test('config, constructor, feature and command descriptors reject proxies/getters without running them', async () => {
  let reads = 0;
  const accessor = config(); Object.defineProperty(accessor, 'password', { enumerable: true, get() { reads++; return 'bad'; } });
  const proxy = new Proxy(config(), { getPrototypeOf() { reads++; throw new Error('must not inspect'); } });
  for (const value of [accessor, proxy, { ...config(), [Symbol('extra')]: true }]) assert.throws(() => validateShellyGen2Config(value), { code: 'INVALID_CONFIG' });
  const badOptions = {}; Object.defineProperty(badOptions, 'config', { enumerable: true, get() { reads++; return config(); } });
  assert.throws(() => new ShellyGen2Adapter(badOptions), { code: 'INVALID_CONFIG' });
  assert.throws(() => new ShellyGen2Adapter({ deviceId: 'fixture', config: config(), features: ['scripts'] }), { code: 'INVALID_FEATURES' });
  const f = fixture(), adapter = new ShellyGen2Adapter({ deviceId: 'fixture', config: config(), features: ['control'], request: f.request });
  const badArgs = {}; Object.defineProperty(badArgs, 'on', { enumerable: true, get() { reads++; return true; } });
  await assert.rejects(adapter.execute({ action: 'switch.power.set', args: badArgs }, context()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(adapter.execute({ action: 'switch.power.set', args: { on: true, id: 1 } }, context()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(adapter.execute({ action: 'switch.toggle', args: {} }, context()), { code: 'UNKNOWN_ACTION' });
  assert.equal(reads, 0); assert.equal(f.requests.length, 0); await adapter.close();
});

test('DPAPI interface stores no plaintext and binds the secret to origin, leaf, device, component and load class', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyadapter-shelly-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json'), secretStore = store();
  const saved = await protectShellyGen2Config(config(), { secretStore });
  assert.equal(Object.hasOwn(saved, 'password'), false); assert.equal(Object.hasOwn(saved, 'username'), false);
  assert.equal(JSON.stringify(saved).includes(config().password), false);
  await writeFile(file, JSON.stringify(saved)); assert.deepEqual(await loadShellyGen2Config(file, { secretStore }), config());
  const other = certificate();
  for (const change of [{ origin: 'https://127.0.0.1:18444' }, { expectedDeviceId: 'other-fixture' }, { componentId: 3 },
    { loadClass: 'ordinary-light' }, { certificate: other.certificate, certificatePin: other.certificatePin }]) {
    await writeFile(file, JSON.stringify({ ...saved, ...change }));
    await assert.rejects(loadShellyGen2Config(file, { secretStore }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
  await writeFile(file, JSON.stringify({ ...saved, password: config().password }));
  await assert.rejects(loadShellyGen2Config(file, { secretStore }), { code: 'INVALID_CONFIG' });
});

test('Digest challenge parsing requires current SHA256/auth, exact realm, bounded canonical nonce and no header injection', () => {
  assert.equal(parseShellyDigestChallenge(challenge(), config().expectedDeviceId).nonce, nonce);
  for (const value of [challenge({ algorithm: 'MD5' }), challenge({ realm: 'other-device' }), challenge({ qop: 'auth-int' }),
    challenge({ nonce: '12345' }), challenge({ nonce: 'x'.repeat(513) }), challenge({ nonce: 'AAAAAAAAAAAA=' }),
    challenge() + ', realm="duplicate"', challenge() + '\r\nX-Leak: secret', 'Basic realm="anything"',
    challenge() + ', unknown="value"', challenge() + ',', challenge({ opaque: 'bad"value' }), challenge({ stale: 'maybe' })]) {
    assert.throws(() => parseShellyDigestChallenge(value, config().expectedDeviceId), { code: 'AUTHENTICATION_CHALLENGE_INVALID' });
  }
});

test('constructors/listeners are inert, default is read-only, selected status is finite and private fields are dropped', async () => {
  const f = fixture(), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), request: f.request }), events = [];
  adapter.subscribe(event => events.push(event)); assert.equal(f.requests.length, 0); assert.deepEqual(adapter.supportedActions, []);
  await assert.rejects(adapter.execute({ action: 'switch.power.set', args: { on: true } }, context()), { code: 'UNKNOWN_ACTION' });
  const snapshot = await adapter.snapshot();
  assert.deepEqual(snapshot.fields.switch.value, { available: true, power: false, faulted: false, powerWatts: 0, voltageV: 120, currentAmps: 0, frequencyHz: 60, energyKwh: 1.5 });
  assert.equal(Date.parse(snapshot.fields.switch.expiresAt) - Date.parse(snapshot.fields.switch.observedAt), 15000);
  for (const value of [JSON.stringify(adapter), JSON.stringify(snapshot), JSON.stringify(events)]) {
    for (const secret of [config().origin, config().expectedDeviceId, config().password, nonce, 'SYNTHETIC-IGNORED', 'Run arbitrary RPC']) assert.equal(value.includes(secret), false);
  }
  assert.deepEqual(f.counts, [1]); await adapter.close();
});

test('one explicit setter uses authenticated preflight, final dispatch gate and fresh selected output readback', async () => {
  const f = fixture(), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), features: ['control'], request: f.request });
  let assertions = 0;
  const result = await adapter.execute({ action: 'switch.power.set', args: { on: true } }, context({ assertDispatch() { assertions++; } }));
  assert.equal(assertions, 1); assert.equal(result.confirmed, true); assert.equal(result.requestAccepted, true); assert.equal(result.physicalEffectVerified, false);
  assert.equal(result.verificationScope, 'shelly_reported_selected_switch_output');
  assert.deepEqual(f.writes, [{ id: 2, on: true }]); assert.deepEqual(f.counts, [1, 2, 3]);
  assert.equal(f.requests.filter(request => request.body.method === 'Switch.Set')[0].allowAuthChallenge, undefined);
  assert.deepEqual(f.requests.map(request => request.body.method), ['Shelly.GetDeviceInfo', 'Switch.GetStatus', 'Switch.GetStatus', 'Switch.Set', 'Shelly.GetDeviceInfo', 'Switch.GetStatus']);
  await adapter.close();
});

test('wrong identity/firmware/auth setting, wrong component and active faults deny writes before dispatch', async () => {
  for (const options of [{ info: { id: 'other-device' } }, { info: { gen: 1 } }, { info: { ver: '1.9.9' } }, { info: { auth_en: false } },
    { info: { profile: 'cover' } }, { info: { auth_domain: 'other-device' } }, { status: { id: 3 } },
    { status: { errors: ['overpower'] } }, { responseSource: 'other-device' }]) {
    const f = fixture(config(), options), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), features: ['control'], request: f.request });
    let called = 0;
    await assert.rejects(adapter.execute({ action: 'switch.power.set', args: { on: true } }, context({ assertDispatch() { called++; } })));
    assert.equal(called, 0); assert.deepEqual(f.writes, []); await adapter.close();
  }
  for (const value of [{ id: 2, output: true, apower: Infinity }, { id: 2, output: true, aenergy: { total: NaN } },
    { id: 3, output: true }, { id: 2, output: 'true' }]) assert.throws(() => projectShellySwitch(value, 2), { code: 'INVALID_DEVICE_RESPONSE' });
});

test('asynchronous or non-undefined dispatch decisions deny writes without running thenable callbacks', async () => {
  let thenReads = 0;
  for (const assertDispatch of [async () => {}, async () => { throw new Error('synthetic denied async decision'); },
    () => true, () => ({ get then() { thenReads++; throw new Error('never inspect'); } }),
    () => new Proxy({}, { get() { thenReads++; throw new Error('never inspect'); } })]) {
    const f = fixture(), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), features: ['control'], request: f.request });
    await assert.rejects(adapter.execute({ action: 'switch.power.set', args: { on: true } }, context({ assertDispatch })), { code: 'INVALID_CONTEXT' });
    assert.deepEqual(f.writes, []); await adapter.close();
  }
  await new Promise(resolve => setImmediate(resolve)); assert.equal(thenReads, 0);
});

test('credential failure is attempted once and disables later polling or actions rather than guessing passwords', async () => {
  const f = fixture(config(), { badAuth: true }), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), request: f.request });
  await assert.rejects(adapter.snapshot(), { code: 'AUTHENTICATION_FAILED' }); const count = f.requests.length;
  await assert.rejects(adapter.snapshot(), { code: 'AUTHENTICATION_FAILED' }); assert.equal(f.requests.length, count); assert.equal(count, 3);
  await adapter.close();
});

test('grant revocation and state expiry during TLS preparation deny the only mutation at its final gate', async t => {
  for (const stale of [false, true]) {
    const ready = deferred(), release = deferred();
    const f = fixture(config(), { gate: async () => { ready.resolve(); await release.promise; } });
    const adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), features: ['control'], request: f.request });
    let assertions = 0;
    if (stale) t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const operation = adapter.execute({ action: 'switch.power.set', args: { on: true } }, context({ assertDispatch() { assertions++; const error = new Error('must remain private'); error.code = 'GRANT_REVOKED'; throw error; } }));
    const rejected = assert.rejects(operation, { code: stale ? 'STALE_STATE' : 'GRANT_REVOKED' });
    await ready.promise; if (stale) t.mock.timers.tick(16000); release.resolve(); await rejected;
    assert.equal(assertions, stale ? 0 : 1); assert.deepEqual(f.writes, []); await adapter.close(); if (stale) t.mock.timers.reset();
  }
});

test('a nonce that expires during TLS preparation cannot authorize a write even while switch state remains fresh', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ready = deferred(), release = deferred(), f = fixture(config(), { gate: async () => { ready.resolve(); await release.promise; } });
  const adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), features: ['control'], request: f.request });
  await adapter.snapshot(); t.mock.timers.tick(55 * 60000 - 1000);
  let assertions = 0;
  const operation = adapter.execute({ action: 'switch.power.set', args: { on: true } }, context({ assertDispatch() { assertions++; } }));
  const rejected = assert.rejects(operation, { code: 'AUTHENTICATION_STALE' });
  await ready.promise; t.mock.timers.tick(2000); release.resolve(); await rejected;
  assert.equal(assertions, 0); assert.deepEqual(f.writes, []); await adapter.close();
});

test('ambiguous writes and negative authentication responses are never retried and never claim a physical effect', async () => {
  for (const options of [{ failReadback: true }, { mutationFailure: () => { throw new Error('private vendor diagnostic'); } }, { mutationFailure: () => response401() }]) {
    const f = fixture(config(), options), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), features: ['control'], request: f.request });
    const result = await adapter.execute({ action: 'switch.power.set', args: { on: true } }, context());
    assert.equal(result.confirmed, false); assert.equal(result.uncertain, true); assert.equal(result.physicalEffectVerified, false);
    assert.equal(f.writes.length, 1); assert.equal(f.requests.filter(request => request.body.method === 'Switch.Set').length, 1);
    assert.equal(JSON.stringify(result).includes('private'), false); await adapter.close();
  }
});

test('polling never overlaps and closing aborts an ignored request without late events or mutation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const release = deferred(); let requests = 0, late;
  const adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: config(), request: async request => {
    requests++; late = request; await release.promise; request.beforeDispatch(); return {};
  } });
  const events = []; adapter.subscribe(event => events.push(event)); const starting = adapter.start(); await tick();
  assert.equal(requests, 1); t.mock.timers.tick(400); await tick(); assert.equal(requests, 1);
  const closing = adapter.close(); await closing; await starting; const count = events.length;
  release.resolve(); await tick(); t.mock.timers.tick(60000); await tick();
  assert.equal(requests, 1); assert.equal(events.length, count); assert.equal(late.signal.aborted, true);
  await assert.rejects(adapter.snapshot(), { code: 'ADAPTER_CLOSED' });
});

async function httpsFixture(t, selectedIdentity = identity, override) {
  const selected = config(), fake = fixture(selected, override), received = [], sockets = new Set();
  const server = https.createServer({ cert: selectedIdentity.certificate, key: selectedIdentity.key }, (request, response) => {
    const chunks = []; request.on('data', bytes => chunks.push(bytes));
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()); received.push({ body, authorization: request.headers.authorization });
      try {
        const reply = await fake.request({ method: request.method, path: request.url, body, headers: { Authorization: request.headers.authorization } });
        if (reply.status === 401) { response.writeHead(401, { 'WWW-Authenticate': reply.headers['www-authenticate'] }); response.end(); }
        else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(reply)); }
      } catch { response.writeHead(500); response.end(); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { ...fake, received, config: config({ origin: `https://127.0.0.1:${server.address().port}`, timeoutMs: 1000 }) };
}

test('native pinned HTTPS + SHA256 Digest fixture reads and sets only the enrolled component', { timeout: 5000 }, async t => {
  const f = await httpsFixture(t), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: f.config, features: ['control'] });
  t.after(() => adapter.close());
  const result = await adapter.execute({ action: 'switch.power.set', args: { on: true } }, context());
  assert.equal(result.confirmed, true); assert.deepEqual(f.writes, [{ id: 2, on: true }]);
  assert.equal(f.received.filter(request => request.body.method === 'Switch.Set').length, 1);
  assert.equal(f.received.some(request => JSON.stringify(request.body).includes(config().password)), false);
  assert.equal(f.received.every(request => !JSON.stringify(request).includes(config().password)), true);
  await adapter.close();
});

test('substituted HTTPS identity receives zero HTTP requests, authentication or effects', { timeout: 5000 }, async t => {
  const f = await httpsFixture(t, certificate()), adapter = new ShellyGen2Adapter({ deviceId: 'fixture-switch', config: f.config, features: ['control'] });
  t.after(() => adapter.close());
  await assert.rejects(adapter.execute({ action: 'switch.power.set', args: { on: true } }, context()));
  assert.deepEqual(f.received, []); assert.deepEqual(f.writes, []); await adapter.close();
});
