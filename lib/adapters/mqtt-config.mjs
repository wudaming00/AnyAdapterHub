import { createHash, X509Certificate } from 'node:crypto';
import { types } from 'node:util';
import { readJson } from '../hub/config.mjs';
import { validatePrivateHost } from '../hub/adapters.mjs';
import * as systemStore from '../security/secret-store.mjs';

export const MQTT_MEASUREMENTS = Object.freeze({
  temperatureC: Object.freeze([-100, 150]), humidityPercent: Object.freeze([0, 100]),
  co2Ppm: Object.freeze([0, 100000]), pm25UgM3: Object.freeze([0, 10000]),
  illuminanceLux: Object.freeze([0, 1000000]), powerWatts: Object.freeze([-10000000, 10000000]),
  energyKwh: Object.freeze([0, 1000000000000]),
});
const TARGET = ['host', 'port', 'certificatePem', 'certificatePin', 'topic', 'measurement'];
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const fail = () => { const error = new Error('MQTT requires one owner-selected TLS broker, pinned certificate, exact sensor topic and encrypted credentials.'); error.code = 'INVALID_CONFIG'; throw error; };

// Inspect descriptors only after rejecting proxies. Configuration cannot execute getters.
export function mqttDataObject(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) ||
      !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function target(value, secretKey) {
  const record = mqttDataObject(value, [...TARGET, ...secretKey]);
  try { validatePrivateHost(record.host); } catch { fail(); }
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.certificatePin !== 'string' || !/^[a-f0-9]{64}$/.test(record.certificatePin) ||
      typeof record.topic !== 'string' || Buffer.byteLength(record.topic) > 256 ||
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(record.topic) ||
      typeof record.measurement !== 'string' || !Object.hasOwn(MQTT_MEASUREMENTS, record.measurement) ||
      typeof record.certificatePem !== 'string' || record.certificatePem.length > 16384 ||
      record.certificatePem.match(PEM)?.length !== 1 || record.certificatePem.replace(PEM, '').trim()) fail();
  try {
    const cert = new X509Certificate(record.certificatePem);
    const now = Date.now();
    if (createHash('sha256').update(cert.raw).digest('hex') !== record.certificatePin ||
        cert.checkIP(record.host) !== record.host || !Number.isFinite(Date.parse(cert.validFrom)) ||
        !Number.isFinite(Date.parse(cert.validTo)) || Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) fail();
  } catch { fail(); }
  return record;
}

function credentials(value) {
  const record = mqttDataObject(value, ['username', 'password']);
  for (const key of ['username', 'password']) {
    if (typeof record[key] !== 'string' || !record[key].length || !record[key].isWellFormed() ||
        record[key].includes('\0') || Buffer.byteLength(record[key]) > (key === 'username' ? 256 : 4096)) fail();
  }
  return record;
}

/** Pure validation of the resolved, in-memory configuration. No SDK or network. */
export function validateMQTTConfig(value) {
  const record = target(value, ['username', 'password']);
  credentials({ username: record.username, password: record.password });
  return Object.freeze(record);
}

/** Pure validation of stored target metadata; envelope contents are checked by the secret store. */
export function validateProtectedMQTTConfig(value) {
  const record = target(value, ['credentialSecret']);
  mqttDataObject(record.credentialSecret, ['version', 'provider', 'protected']);
  return Object.freeze(record);
}

function purpose(record) {
  const host = record.host.includes(':') ? `[${record.host}]` : record.host;
  const binding = JSON.stringify([`mqtts://${host}:${record.port}`, record.certificatePin, record.topic, record.measurement]);
  return `mqtt/credentials:${createHash('sha256').update(binding).digest('hex')}`;
}

export async function protectMQTTConfig(value, { secretStore = systemStore } = {}) {
  const record = validateMQTTConfig(value);
  const credentialSecret = await secretStore.sealSecret({ username: record.username, password: record.password }, { purpose: purpose(record) });
  return Object.freeze({ ...Object.fromEntries(TARGET.map(key => [key, record[key]])), credentialSecret });
}

export async function loadMQTTConfig(file, { secretStore = systemStore } = {}) {
  let saved;
  try { saved = validateProtectedMQTTConfig(await readJson(file)); } catch { fail(); }
  if (!secretStore.isSecretEnvelope(saved.credentialSecret)) fail();
  const clear = credentials(await secretStore.openSecret(saved.credentialSecret, { purpose: purpose(saved) }));
  return validateMQTTConfig({ ...Object.fromEntries(TARGET.map(key => [key, saved[key]])), ...clear });
}
