import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, X509Certificate, createHash } from 'node:crypto';
import https from 'node:https';
import { createSecretStore, isSecretStoreSupported } from '../lib/security/secret-store.mjs';
import { createHubIdentityManager, createHubIdentity, openHubIdentity, isHubIdentitySupported, classifyIdentityProcessFailure } from '../lib/security/hub-identity.mjs';

function fixture() {
  const key = randomBytes(32);
  const store = createSecretStore({ provider: 'test-aes-gcm',
    protect(clear, entropy) {
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(entropy);
      return Buffer.concat([nonce, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    },
    unprotect(bytes, entropy) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAAD(entropy); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  });
  return { store, manager: createHubIdentityManager(store) };
}

test('OpenSSL failure diagnostics produce only static categories and never copy private material', () => {
  assert.equal(classifyIdentityProcessFailure('req: Unknown option -noenc'), 'HUB_IDENTITY_OPTION_UNSUPPORTED');
  assert.equal(classifyIdentityProcessFailure('Could not open config file NUL'), 'HUB_IDENTITY_CONFIG_FAILED');
  assert.equal(classifyIdentityProcessFailure('Error on line 2 of config input'), 'HUB_IDENTITY_CONFIG_FAILED');
  for (const diagnostic of ['fixture-private-key-content', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----', 'X'.repeat(65537), null])
    assert.equal(classifyIdentityProcessFailure(diagnostic), 'HUB_IDENTITY_PROCESS_EXIT');
});

test('identity has a loopback SAN, self signature, server usage, bound key and SHA256 certificate pin', async () => {
  const { manager } = fixture(); const identity = await manager.createHubIdentity();
  assert.deepEqual(Object.keys(identity).sort(), ['certificate', 'certificatePin', 'purpose', 'secret']);
  assert.equal(identity.purpose, 'hub/tls-identity');
  assert.match(identity.certificatePin, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(identity).includes('BEGIN PRIVATE KEY'), false);
  const opened = await manager.openHubIdentity(identity);
  const cert = new X509Certificate(opened.cert);
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1'); assert.equal(cert.checkHost('localhost', { subject: 'never' }), 'localhost');
  assert.equal(cert.ca, false); assert.equal(cert.verify(cert.publicKey), true); assert.ok(cert.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
  assert.equal(createHash('sha256').update(cert.raw).digest('hex'), identity.certificatePin);
  assert.equal(opened.certificatePin, identity.certificatePin);
});

test('public certificate or pin replacement and encrypted identity tampering fail closed', async () => {
  const { manager } = fixture(); const one = await manager.createHubIdentity(); const two = await manager.createHubIdentity();
  await assert.rejects(manager.openHubIdentity({ ...one, certificatePin: '0'.repeat(64) }), { code: 'HUB_IDENTITY_FAILED' });
  await assert.rejects(manager.openHubIdentity({ ...one, certificate: two.certificate }), { code: 'HUB_IDENTITY_FAILED' });
  await assert.rejects(manager.openHubIdentity({ ...one, certificate: two.certificate, certificatePin: two.certificatePin }), { code: 'HUB_IDENTITY_FAILED' });
  const bytes = Buffer.from(one.secret.protected, 'base64'); bytes[16] ^= 1;
  await assert.rejects(manager.openHubIdentity({ ...one, secret: { ...one.secret, protected: bytes.toString('base64') } }), { code: 'HUB_IDENTITY_FAILED' });
});

test('custom purpose requires explicit matching code option rather than trusting record metadata', async () => {
  const { manager } = fixture();
  const custom = await manager.createHubIdentity({ purpose: 'hub/custom-identity' });
  await assert.rejects(manager.openHubIdentity(custom), { code: 'HUB_IDENTITY_FAILED' });
  assert.equal((await manager.openHubIdentity(custom, { purpose: 'hub/custom-identity' })).certificatePin, custom.certificatePin);
  await assert.rejects(manager.openHubIdentity({ ...custom, purpose: 'hub/tls-identity' }), { code: 'HUB_IDENTITY_FAILED' });
});

test('wrong private key, invalid material and extra record fields are rejected', async () => {
  const { manager, store } = fixture(); const one = await manager.createHubIdentity(); const two = await manager.createHubIdentity();
  const first = await manager.openHubIdentity(one); const second = await manager.openHubIdentity(two);
  const mismatched = await store.sealSecret({ key: first.key, cert: second.cert }, { purpose: 'hub/tls-identity' });
  await assert.rejects(manager.openHubIdentity({ ...one, secret: mismatched }), { code: 'HUB_IDENTITY_FAILED' });
  await assert.rejects(manager.openHubIdentity({ ...one, extra: true }), { code: 'HUB_IDENTITY_FAILED' });
  await assert.rejects(manager.openHubIdentity({ ...one, certificate: one.certificate + two.certificate }), { code: 'HUB_IDENTITY_FAILED' });
  const badGenerator = createHubIdentityManager({ ...store, generateIdentity() { return { key: 'private fixture', cert: 'invalid fixture' }; } });
  await assert.rejects(badGenerator.createHubIdentity(), error => error.code === 'HUB_IDENTITY_FAILED' && !error.message.includes('fixture'));
});

test('generated leaf identity supports strict HTTPS trust and default hostname checks on loopback', async t => {
  const { manager } = fixture(); const identity = await manager.createHubIdentity(); const opened = await manager.openHubIdentity(identity);
  const server = https.createServer({ key: opened.key, cert: opened.cert, minVersion: 'TLSv1.2' }, (_request, response) => response.end('ok'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = ca => new Promise((resolve, reject) => {
    const outgoing = https.get({ hostname: '127.0.0.1', port: server.address().port, path: '/', ca, rejectUnauthorized: true, agent: false }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    outgoing.on('error', reject);
  });
  assert.deepEqual(await request(identity.certificate), { status: 200, body: 'ok' });
  const unrelated = await manager.createHubIdentity();
  await assert.rejects(request(unrelated.certificate));
});

test('production TLS identity uses Windows DPAPI and opens without any plaintext key record', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(isSecretStoreSupported(), true); assert.equal(isHubIdentitySupported(), true);
  const identity = await createHubIdentity();
  assert.equal(identity.secret.provider, 'windows-dpapi');
  assert.equal(JSON.stringify(identity).includes('PRIVATE KEY'), false);
  const opened = await openHubIdentity(identity); assert.equal(opened.certificatePin, identity.certificatePin);
});

test('production identity fails closed when the secret-store provider is unsupported', { skip: process.platform === 'win32' }, async () => {
  assert.equal(isHubIdentitySupported(), false);
  await assert.rejects(createHubIdentity(), { code: 'HUB_IDENTITY_UNSUPPORTED' });
  await assert.rejects(openHubIdentity({}), { code: 'HUB_IDENTITY_UNSUPPORTED' });
});
