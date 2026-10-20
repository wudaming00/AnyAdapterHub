import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
import { validateHomeAssistantConfig, validateProtectedHomeAssistantConfig,
  protectHomeAssistantConfig, loadHomeAssistantConfig } from '../lib/adapters/home-assistant-config.mjs';

const store = testSecretStore();
const identity = testIdentity(store);
async function fixture() {
  const certificate = await identity;
  return { origin: 'https://127.0.0.1:8123', certificate: certificate.certificate,
    certificatePin: certificate.certificatePin, entityId: 'light.fixture', token: 'fixture_ha_token_abcdefghijklmnopqrstuvwxyz' };
}
async function fileFixture(t, value) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-ha-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json'); await writeFile(file, JSON.stringify(value)); return file;
}

test('HA owner configuration encrypts its token and restores only through the scoped provider', async t => {
  const clear = await fixture();
  const saved = await protectHomeAssistantConfig(clear, { secretStore: store });
  assert.equal(Object.hasOwn(saved, 'token'), false);
  assert.equal(saved.tokenPurposeVersion, 1);
  assert.equal(JSON.stringify(saved).includes(clear.token), false);
  const file = await fileFixture(t, saved);
  const loaded = await loadHomeAssistantConfig(file, { secretStore: store });
  assert.equal(loaded.token, clear.token); assert.equal(loaded.timeoutMs, 8000); assert.equal(Object.isFrozen(loaded), true);
  await assert.rejects(loadHomeAssistantConfig(file), { code: 'INVALID_CONFIG' });
});

test('HA token purpose binds exact canonical origin, certificate pin and selected light', async t => {
  const clear = await fixture(), saved = await protectHomeAssistantConfig(clear, { secretStore: store });
  const secondStore = testSecretStore(), second = await testIdentity(secondStore);
  for (const changes of [{ origin: 'https://127.0.0.1:8124' }, { entityId: 'light.other' },
    { certificate: second.certificate, certificatePin: second.certificatePin }]) {
    const file = await fileFixture(t, { ...saved, ...changes });
    await assert.rejects(loadHomeAssistantConfig(file, { secretStore: store }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
});

test('HA configuration rejects plaintext loaded records, non-light targets, arbitrary routes and insecure origins', async t => {
  const clear = await fixture();
  for (const change of [{ origin: 'http://127.0.0.1:8123' }, { origin: 'https://user:password@ha.example' },
    { origin: 'https://ha.example/api' }, { origin: 'https://ha.example/?token=private' }, { origin: 'https://ha.example/' },
    { entityId: 'switch.heater' }, { entityId: 'light.fixture/../../services' }, { entityId: 'light.UPPER' },
    { certificatePin: 'a'.repeat(64) }, { certificate: clear.certificate + clear.certificate },
    { token: 'token\r\nOther: value' }, { token: '' }, { token: 'x'.repeat(4097) }, { timeoutMs: 0 }, { timeoutMs: 15001 },
    { service: 'script.execute' }, { url: 'https://unselected.example' }, { secretStore: 'plaintext' }]) {
    assert.throws(() => validateHomeAssistantConfig({ ...clear, ...change }), { code: 'INVALID_CONFIG' });
  }
  const file = await fileFixture(t, clear);
  await assert.rejects(loadHomeAssistantConfig(file, { secretStore: store }), { code: 'INVALID_CONFIG' });
});

test('HA configuration rejects accessors, proxies, inherited and symbolic fields without evaluating them', async () => {
  const clear = await fixture(); let touched = false;
  const getter = { ...clear }; Object.defineProperty(getter, 'token', { enumerable: true, get() { touched = true; throw new Error('private fixture'); } });
  const proxy = new Proxy(clear, { ownKeys() { touched = true; throw new Error('private fixture'); } });
  for (const value of [getter, proxy, Object.assign(Object.create({ service: 'script.run' }), clear), { ...clear, [Symbol('private')]: 'private' }]) {
    assert.throws(() => validateHomeAssistantConfig(value), { code: 'INVALID_CONFIG' });
  }
  assert.equal(touched, false);
  const saved = await protectHomeAssistantConfig(clear, { secretStore: store });
  const envelope = { ...saved.tokenSecret };
  Object.defineProperty(envelope, 'protected', { enumerable: true, get() { touched = true; return 'private'; } });
  assert.throws(() => validateProtectedHomeAssistantConfig({ ...saved, tokenSecret: envelope }, { secretStore: store }), { code: 'INVALID_CONFIG' });
  assert.equal(touched, false);
});

test('HA loaded credential failures never reflect provider text or private fields', async t => {
  const clear = await fixture(), saved = await protectHomeAssistantConfig(clear, { secretStore: store });
  const file = await fileFixture(t, saved);
  const failing = { ...store, async openSecret() { throw new Error('private-provider-error'); } };
  await assert.rejects(loadHomeAssistantConfig(file, { secretStore: failing }), error => error.code === 'CREDENTIAL_UNAVAILABLE' && !String(error).includes('private-provider-error'));
});
