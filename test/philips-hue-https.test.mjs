import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHubIdentityManager } from '../lib/security/hub-identity.mjs';
import { resolveOpenSSL, cryptoProcessEnvironment } from '../lib/platform/system-tools.mjs';
import { testSecretStore } from './helpers/secrets.mjs';
import { PhilipsHueAdapter } from '../lib/adapters/philips-hue.mjs';
import { validatePhilipsHueConfig, protectPhilipsHueConfig, loadPhilipsHueConfig } from '../lib/adapters/philips-hue-config.mjs';

const ID = '00000000-0000-4000-8000-000000000001';
const BRIDGE_ID = '001788fffe123456', OTHER_BRIDGE_ID = '001788fffe123457';
async function namedCertificate({ commonNameOnly = false, uppercaseName = false } = {}) {
  const certificateName = uppercaseName ? BRIDGE_ID.toUpperCase() : BRIDGE_ID;
  const args = ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-', '-config', '-',
    '-subj', `/CN=${certificateName}`, '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth', '-sha256', '-days', '2', '-batch'];
  if (!commonNameOnly) args.push('-addext', `subjectAltName=DNS:${certificateName},DNS:${uppercaseName ? OTHER_BRIDGE_ID.toUpperCase() : OTHER_BRIDGE_ID}`);
  const output = await new Promise((resolve, reject) => {
    const child = execFile(resolveOpenSSL(), args, { env: cryptoProcessEnvironment(), windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      (error, stdout) => error ? reject(Error('Synthetic Hue certificate generation failed.')) : resolve(stdout));
    child.stdin.on('error', () => {}); child.stdin.end('[req]\ndistinguished_name=dn\n[dn]\n');
  });
  const cert = output.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  const key = output.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)?.[0];
  assert.ok(cert && key);
  return { cert, key, certificatePin: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex') };
}
async function fixture(t, { substituteCertificate = false, bridgeId, commonNameOnly = false, uppercaseName = false } = {}) {
  const manager = createHubIdentityManager(testSecretStore());
  const served = bridgeId ? await namedCertificate({ commonNameOnly, uppercaseName }) : await manager.createHubIdentity();
  const enrolled = substituteCertificate ? bridgeId ? await namedCertificate({ commonNameOnly, uppercaseName }) : await manager.createHubIdentity() : served;
  const keys = bridgeId ? served : await manager.openHubIdentity(served), seen = []; let on = false, brightness = 50;
  const server = https.createServer(keys, (req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ errors: [], data: [{ id: ID, type: 'light', mode: 'normal',
      metadata: { archetype: 'classic_bulb', name: 'private fixture name' }, on: { on }, dimming: { brightness, min_dim_level: 0.2 } }] }));
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      on = body.on.on; if (body.dimming) brightness = body.dimming.brightness;
      res.end(JSON.stringify({ errors: [], data: [{ rid: ID, rtype: 'light' }] }));
    });
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { origin: `https://127.0.0.1:${server.address().port}`, certificate: bridgeId ? enrolled.cert : enrolled.certificate,
    certificatePin: enrolled.certificatePin, ...(bridgeId ? { bridgeId } : {}), lightId: ID, applicationKey: 'synthetic_hue_key_never_logged' };
  const adapter = new PhilipsHueAdapter({ deviceId: 'fixture-hue', features: ['control', 'dimming'], config });
  t.after(() => adapter.close());
  return { adapter, seen, config };
}

test('Hue real HTTPS authenticates selected GET/PUT only and confirms selected bridge readback', async t => {
  const { adapter, seen } = await fixture(t); let authorized = 0;
  const result = await adapter.execute({ action: 'light.brightness.set', args: { brightness: 42 } }, { assertDispatch() { authorized++; } });
  assert.equal(authorized, 1); assert.equal(result.confirmed, true); assert.equal(result.physicalEffectVerified, false);
  assert.deepEqual(seen.map(request => request.method), ['GET', 'PUT', 'GET']);
  assert.ok(seen.every(request => request.path === `/clip/v2/resource/light/${ID}` && request.headers['hue-application-key'] === 'synthetic_hue_key_never_logged'));
  assert.equal(JSON.stringify(result).includes('synthetic_hue'), false);
});

test('Hue grant denial at the real post-TLS gate sends zero PUT HTTP bytes', async t => {
  const { adapter, seen } = await fixture(t);
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, {
    assertDispatch() { throw Object.assign(Error('private grant detail'), { code: 'GRANT_REVOKED' }); },
  }), error => error.code === 'GRANT_REVOKED' && !String(error).includes('private'));
  assert.deepEqual(seen.map(request => request.method), ['GET']);
});

test('Hue substituted TLS identity receives no HTTP request or application-key header', async t => {
  const { adapter, seen } = await fixture(t, { substituteCertificate: true }); let authorized = 0;
  await assert.rejects(adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() { authorized++; } }), { code: 'DEVICE_OPERATION_FAILED' });
  assert.equal(authorized, 0); assert.equal(seen.length, 0);
});

test('Hue explicit bridge ID verifies DNS-only and CN-only certificates while connecting to the fixed loopback IP', async t => {
  for (const commonNameOnly of [false, true]) {
    const { adapter, seen, config } = await fixture(t, { bridgeId: BRIDGE_ID, commonNameOnly });
    assert.equal(new X509Certificate(config.certificate).checkIP('127.0.0.1'), undefined);
    const result = await adapter.execute({ action: 'light.power.set', args: { on: true } }, { assertDispatch() {} });
    assert.equal(result.confirmed, true); assert.equal(seen.length, 3);
    assert.ok(seen.every(request => request.headers['hue-application-key'] === 'synthetic_hue_key_never_logged'));
  }
});

test('Hue lowercase owner bridge ID accepts uppercase certificate DNS and CN names while keeping the exact pin', async t => {
  for (const commonNameOnly of [false, true]) {
    const { adapter, config, seen } = await fixture(t, { bridgeId: BRIDGE_ID, commonNameOnly, uppercaseName: true });
    assert.ok(new X509Certificate(config.certificate).subject.includes(BRIDGE_ID.toUpperCase()));
    const state = await adapter.snapshot(); assert.equal(state.fields.light.value.available, true); assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['hue-application-key'], 'synthetic_hue_key_never_logged');
    assert.throws(() => validatePhilipsHueConfig({ ...config, bridgeId: '001788fffe999999' }), { code: 'INVALID_CONFIG' });
    assert.equal(seen.length, 1);
  }
});

test('Hue wrong bridge name or a missing explicit name fails before any authenticated HTTP request', async t => {
  const { adapter, config, seen } = await fixture(t, { bridgeId: BRIDGE_ID, commonNameOnly: true });
  assert.throws(() => validatePhilipsHueConfig({ ...config, bridgeId: '001788fffe999999' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validatePhilipsHueConfig({ ...config, origin: 'https://bridge.invalid' }), { code: 'INVALID_CONFIG' });
  const { bridgeId: _name, ...unnamed } = config;
  const withoutName = new PhilipsHueAdapter({ deviceId: 'fixture-hue-no-name', config: unnamed }); t.after(() => withoutName.close());
  await assert.rejects(withoutName.snapshot(), { code: 'STATE_UNAVAILABLE' });
  assert.equal(seen.length, 0); await adapter.close();
});

test('Hue a different pinned certificate with the same bridge DNS identity still receives zero authentication bytes', async t => {
  const { adapter, seen } = await fixture(t, { bridgeId: BRIDGE_ID, substituteCertificate: true });
  await assert.rejects(adapter.snapshot(), { code: 'STATE_UNAVAILABLE' }); assert.equal(seen.length, 0);
});

test('Hue ciphertext purpose binds the explicit bridge ID and cannot be downgraded by removing it', async t => {
  const { config } = await fixture(t, { bridgeId: BRIDGE_ID }), store = testSecretStore();
  const saved = await protectPhilipsHueConfig(config, { secretStore: store }); assert.equal(saved.bridgeId, BRIDGE_ID);
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-hue-bridge-name-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json'); await writeFile(file, JSON.stringify(saved));
  assert.equal((await loadPhilipsHueConfig(file, { secretStore: store })).bridgeId, BRIDGE_ID);
  for (const changed of [{ ...saved, bridgeId: OTHER_BRIDGE_ID }, (({ bridgeId: _name, ...remaining }) => remaining)(saved)]) {
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(loadPhilipsHueConfig(file, { secretStore: store }), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
});
