import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecretStore } from '../lib/security/secret-store.mjs';
import { validateMQTTConfig, validateProtectedMQTTConfig, protectMQTTConfig, loadMQTTConfig } from '../lib/adapters/mqtt-config.mjs';

// Synthetic public certificate only. No household certificate or private enrollment is read.
function identity({ from = Date.now() - 86400000, to = Date.now() + 86400000, ip = [127, 0, 0, 1] } = {}) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag, ...parts) => {
    const bytes = Buffer.concat(parts), lengths = []; let size = bytes.length;
    do { lengths.unshift(size & 255); size >>>= 8; } while (size);
    return Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | lengths.length, ...lengths])]), bytes]);
  };
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('MQTT offline fixture')))));
  const time = value => der(0x17, Buffer.from(new Date(value).toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const san = der(0xa3, der(0x30, der(0x30, Buffer.from('0603551d11', 'hex'), der(4, der(0x30, der(0x87, Buffer.from(ip)))))));
  const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    der(0x30, time(from), time(to)), name, keys.publicKey.export({ type: 'spki', format: 'der' }), san);
  const raw = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, keys.privateKey)));
  return { certificatePem: ['-----BEGIN CERTIFICATE-----', ...raw.toString('base64').match(/.{1,64}/g), '-----END CERTIFICATE-----', ''].join('\n'),
    certificatePin: createHash('sha256').update(raw).digest('hex') };
}
const certificate = identity();
const config = (extra = {}) => ({ host: '127.0.0.1', port: 8883, ...certificate, topic: 'fixture/sensor/temperature',
  measurement: 'temperatureC', username: 'synthetic-user', password: 'synthetic-password', ...extra });
const store = () => createSecretStore({ provider: 'portable-test',
  protect: async (bytes, entropy) => Buffer.concat([entropy, bytes]),
  unprotect: async (bytes, entropy) => { assert.deepEqual(bytes.subarray(0, 32), entropy); return bytes.subarray(32); },
});

test('MQTT configuration binds one literal local broker, certificate and exact measurement topic', () => {
  assert.equal(validateMQTTConfig(config()).measurement, 'temperatureC');
  for (const change of [
    { host: 'example.test' }, { host: '8.8.8.8' }, { host: 'mqtts://127.0.0.1' }, { host: '127.0.0.1:8883' },
    { port: 0 }, { port: 65536 }, { port: '8883' }, { certificatePin: 'a'.repeat(64) },
    { certificatePem: certificate.certificatePem + certificate.certificatePem },
    { certificatePem: certificate.certificatePem + '\nPRIVATE KEY' },
    { topic: '#' }, { topic: 'fixture/+' }, { topic: '$share/group/topic' }, { topic: 'fixture/#/x' },
    { topic: 'a'.repeat(257) }, { topic: '' }, { topic: 'fixture\0sensor' }, { measurement: 'shell' },
    { measurement: {} }, { username: '' }, { password: '' }, { password: 'x'.repeat(4097) },
    { rejectUnauthorized: false }, { protocol: 'mqtt' }, { reconnectPeriod: 1 }, { publish: 'anything' },
  ]) assert.throws(() => validateMQTTConfig(config(change)), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateMQTTConfig(config(identity({ to: Date.now() - 10000, from: Date.now() - 86400000 }))), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateMQTTConfig(config(identity({ from: Date.now() + 10000, to: Date.now() + 86400000 }))), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateMQTTConfig(config(identity({ ip: [127, 0, 0, 2] }))), { code: 'INVALID_CONFIG' });
});

test('configuration rejects accessors, symbols and proxies without invoking user code', () => {
  let called = 0;
  const accessor = config(); Object.defineProperty(accessor, 'password', { enumerable: true, get() { called++; return 'bad'; } });
  const proxy = new Proxy(config(), { getPrototypeOf() { called++; throw new Error('must not inspect'); }, ownKeys() { called++; return []; } });
  for (const value of [accessor, proxy, { ...config(), [Symbol('unknown')]: true }, Object.create(config())]) {
    assert.throws(() => validateMQTTConfig(value), { code: 'INVALID_CONFIG' });
  }
  assert.equal(called, 0);
});

test('credential protection removes plaintext and binds ciphertext to origin, certificate, topic and measurement', async t => {
  const secretStore = store(), directory = await mkdtemp(path.join(os.tmpdir(), 'anyadapter-mqtt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json');
  const protectedValue = await protectMQTTConfig(config(), { secretStore });
  assert.equal(Object.hasOwn(protectedValue, 'password'), false);
  assert.equal(Object.hasOwn(protectedValue, 'username'), false);
  assert.equal(JSON.stringify(protectedValue).includes('synthetic-password'), false);
  assert.equal(validateProtectedMQTTConfig(protectedValue).topic, config().topic);
  await writeFile(file, JSON.stringify(protectedValue));
  assert.deepEqual(await loadMQTTConfig(file, { secretStore }), config());
  for (const change of [{ port: 8884 }, { topic: 'fixture/other' }, { measurement: 'co2Ppm' }, identity()]) {
    await writeFile(file, JSON.stringify({ ...protectedValue, ...change }));
    await assert.rejects(loadMQTTConfig(file, { secretStore }));
  }
  await writeFile(file, JSON.stringify(config()));
  await assert.rejects(loadMQTTConfig(file, { secretStore }), { code: 'INVALID_CONFIG' });
  await writeFile(file, JSON.stringify({ ...protectedValue, password: 'synthetic-password' }));
  await assert.rejects(loadMQTTConfig(file, { secretStore }), { code: 'INVALID_CONFIG' });
});

test('missing and invalid encrypted files fail with static messages and no path or secret reflection', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyadapter-mqtt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json');
  await writeFile(file, '{');
  for (const source of [file, path.join(directory, 'absent.json')]) {
    await assert.rejects(loadMQTTConfig(source, { secretStore: store() }), error => {
      assert.equal(error.code, 'INVALID_CONFIG'); assert.equal(error.message.includes(directory), false); return true;
    });
  }
});
