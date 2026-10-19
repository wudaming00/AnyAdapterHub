import test from 'node:test';
import assert from 'node:assert/strict';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
import { protectCredential, resolveCredential, protectTVKey, resolveTVKey, resolveTVKeyForMigration } from '../lib/security/credentials.mjs';

const token = 'fixture_owner_token_abcdefghijklmnopqrstuvwxyz';
const host = '192.168.77.80';
test('hub credential binds its token to the exact origin and valid public certificate pin', async () => {
  const secretStore = testSecretStore(), identity = await testIdentity(secretStore), options = { secretStore };
  const input = { token, url: 'https://127.0.0.1:8765', certificatePin: identity.certificatePin, certificate: identity.certificate };
  const encrypted = await protectCredential(input, options);
  assert.equal(Object.hasOwn(encrypted, 'token'), false); assert.equal((await resolveCredential(encrypted, options)).token, token);
  await assert.rejects(resolveCredential({ ...encrypted, url: 'https://127.0.0.1:8766' }, options));
  await assert.rejects(resolveCredential({ ...encrypted, certificatePin: 'a'.repeat(64) }, options));
  for (const changed of [{ token: [token] }, { certificate: 'invalid' }, { certificate: identity.certificate + identity.certificate }, { url: 'http://127.0.0.1:8765' }])
    await assert.rejects(protectCredential({ ...input, ...changed }, options));
});

test('TV key encryption binds the host and certificate pin and runtime refuses old purpose formats', async () => {
  const secretStore = testSecretStore(), options = { secretStore }, profile = { clientKey: 'fixture-key', certificatePin: 'a'.repeat(64) };
  const encrypted = await protectTVKey(profile, host, options);
  assert.equal(encrypted.clientKeyPurposeVersion, 2); assert.equal(Object.hasOwn(encrypted, 'clientKey'), false);
  assert.equal(await resolveTVKey(encrypted, host, options), profile.clientKey);
  await assert.rejects(resolveTVKey({ ...encrypted, certificatePin: 'b'.repeat(64) }, host, options));
  await assert.rejects(resolveTVKey(encrypted, '192.168.77.81', options));
  const old = { clientKeySecret: await secretStore.sealSecret('fixture-key', { purpose: `lg/client-key:${host}` }), certificatePin: 'a'.repeat(64) };
  await assert.rejects(resolveTVKey(old, host, options), { code: 'ENCRYPTED_CREDENTIAL_REQUIRED' });
  assert.equal(await resolveTVKeyForMigration(old, host, options), 'fixture-key');
  await assert.rejects(resolveTVKeyForMigration({ ...old, clientKeyPurposeVersion: 99 }, host, options));
});

test('pending TLS enrollment is a distinct cryptographic context and cannot become an active pin by editing metadata', async () => {
  const secretStore = testSecretStore(), options = { secretStore };
  const encrypted = await protectTVKey({ clientKey: 'fixture-key', certificateTrust: { method: 'pending-tv-tls-enrollment' } }, host, options);
  assert.equal(await resolveTVKey(encrypted, host, options), 'fixture-key');
  await assert.rejects(resolveTVKey({ ...encrypted, certificatePin: 'a'.repeat(64), certificateTrust: { method: 'tofu-existing-device' } }, host, options));
  await assert.rejects(protectTVKey({ clientKey: 'fixture-key' }, host, options));
  await assert.rejects(protectTVKey({ clientKey: 'fixture-key', certificatePin: 'a'.repeat(64) }, 'https://attacker', options));
});
