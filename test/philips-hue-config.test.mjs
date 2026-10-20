import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
import { validatePhilipsHueConfig, validateProtectedPhilipsHueConfig,
  protectPhilipsHueConfig, loadPhilipsHueConfig } from '../lib/adapters/philips-hue-config.mjs';

const store = testSecretStore();
async function fixture() {
  const identity = await testIdentity(store);
  return { origin: 'https://127.0.0.1:8443', certificate: identity.certificate,
    certificatePin: identity.certificatePin, lightId: '00000000-0000-4000-8000-000000000001',
    applicationKey: 'synthetic_hue_application_key_abcdefghijklmnopqrstuvwxyz' };
}
async function savedFile(t, value) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-hue-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json'); await writeFile(file, JSON.stringify(value)); return file;
}

test('Hue application key is purpose-encrypted; loading never accepts plaintext or changes production providers', async t => {
  const clear = { ...await fixture(), origin: 'https://127.0.0.1:8443' }, saved = await protectPhilipsHueConfig(clear, { secretStore: store });
  assert.equal(Object.hasOwn(saved, 'applicationKey'), false); assert.equal(saved.applicationKeyPurposeVersion, 1);
  assert.equal(JSON.stringify(saved).includes(clear.applicationKey), false);
  const file = await savedFile(t, saved), loaded = await loadPhilipsHueConfig(file, { secretStore: store });
  assert.equal(loaded.applicationKey, clear.applicationKey); assert.equal(loaded.timeoutMs, 8000); assert.equal(Object.isFrozen(loaded), true);
  await assert.rejects(loadPhilipsHueConfig(file), { code: 'INVALID_CONFIG' });
  await assert.rejects(loadPhilipsHueConfig(await savedFile(t, clear), { secretStore: store }), { code: 'INVALID_CONFIG' });
});

test('Hue ciphertext is bound to exact origin, leaf certificate pin and selected UUID', async t => {
  const clear = { ...await fixture(), origin: 'https://127.0.0.1:8443' }, saved = await protectPhilipsHueConfig(clear, { secretStore: store });
  const other = await testIdentity(testSecretStore());
  for (const changes of [{ origin: 'https://127.0.0.1:8444' }, { lightId: '00000000-0000-4000-8000-000000000002' },
    { certificate: other.certificate, certificatePin: other.certificatePin }]) {
    await assert.rejects(loadPhilipsHueConfig(await savedFile(t, { ...saved, ...changes }), { secretStore: store }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
});

test('Hue rejects downgrade, noncanonical origins, arbitrary routes, malformed keys, IDs and trust before enrollment', async () => {
  const clear = { ...await fixture(), origin: 'https://127.0.0.1:8443' };
  for (const changes of [{ origin: 'http://127.0.0.1' }, { origin: 'https://127.0.0.1:8443/' }, { origin: 'https://user:secret@host.invalid' },
    { origin: 'https://host.invalid/?key=secret' }, { origin: 'https://host.invalid/clip/v2' }, { origin: 'https://127.0.0.1:443' },
    { lightId: '1' }, { lightId: '00000000-0000-4000-8000-00000000000A' }, { lightId: '../grouped_light' },
    { bridgeId: '001788FFFE123456' }, { bridgeId: '001788fffe12345' }, { bridgeId: '../localhost' },
    { bridgeId: '001788fffe123456' }, { bridgeId: { toString() { throw Error('Must not coerce'); } } },
    { certificatePin: '0'.repeat(64) }, { certificate: clear.certificate + clear.certificate }, { certificate: '' },
    { applicationKey: 'secret\r\nHost: private' }, { applicationKey: '' }, { applicationKey: 'x'.repeat(4097) },
    { timeoutMs: 99 }, { timeoutMs: 15001 }, { route: '/clip/v2/resource/grouped_light' }, { policy: 'unrestricted' }, { rejectUnauthorized: false }]) {
    assert.throws(() => validatePhilipsHueConfig({ ...clear, ...changes }), { code: 'INVALID_CONFIG' });
  }
});

test('Hue configuration rejects accessors/proxies/symbols/inheritance without evaluating code or coercion', async () => {
  const clear = { ...await fixture(), origin: 'https://127.0.0.1:8443' }; let touched = 0;
  const getter = { ...clear }; Object.defineProperty(getter, 'applicationKey', { enumerable: true, get() { touched++; throw Error('private'); } });
  const proxy = new Proxy(clear, { ownKeys() { touched++; throw Error('private'); } });
  for (const value of [getter, proxy, Object.assign(Object.create({ route: 'private' }), clear), { ...clear, [Symbol('private')]: true },
    { ...clear, origin: { toString() { touched++; return clear.origin; } } }, { ...clear, lightId: { toString() { touched++; return clear.lightId; } } }]) {
    assert.throws(() => validatePhilipsHueConfig(value), { code: 'INVALID_CONFIG' });
  }
  const saved = await protectPhilipsHueConfig(clear, { secretStore: store }), envelope = { ...saved.applicationKeySecret };
  Object.defineProperty(envelope, 'protected', { enumerable: true, get() { touched++; return 'private'; } });
  assert.throws(() => validateProtectedPhilipsHueConfig({ ...saved, applicationKeySecret: envelope }, { secretStore: store }), { code: 'INVALID_CONFIG' });
  assert.equal(touched, 0);
});

test('Hue provider and file errors have static messages without private values', async t => {
  const saved = await protectPhilipsHueConfig({ ...await fixture(), origin: 'https://127.0.0.1:8443' }, { secretStore: store });
  const failing = { ...store, async openSecret() { throw Error('private-provider-secret'); } };
  await assert.rejects(loadPhilipsHueConfig(await savedFile(t, saved), { secretStore: failing }), error => error.code === 'CREDENTIAL_UNAVAILABLE' && !String(error).includes('private-provider'));
  const missingDirectory = await mkdtemp(path.join(tmpdir(), 'anyadapter-hue-missing-'));
  t.after(() => rm(missingDirectory, { recursive: true, force: true }));
  await assert.rejects(loadPhilipsHueConfig(path.join(missingDirectory, 'private-nonexistent-hue-file'), { secretStore: store }), error => error.code === 'INVALID_CONFIG' && !String(error).includes('private-nonexistent'));
});
