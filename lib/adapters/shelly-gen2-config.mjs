import { createHash, X509Certificate } from 'node:crypto';
import { types } from 'node:util';
import { readJson } from '../hub/config.mjs';
import { validatePrivateHost } from '../hub/adapters.mjs';
import { validatePinnedJsonIdentity } from '../security/pinned-json-https.mjs';
import * as productionStore from '../security/secret-store.mjs';

const BASE = ['origin', 'certificate', 'certificatePin', 'expectedDeviceId', 'componentId', 'loadClass', 'timeoutMs'];
export class ShellyGen2ConfigError extends Error {
  constructor(code = 'INVALID_CONFIG') { super('An encrypted configuration for one enrolled Shelly switch is required.'); this.name = 'ShellyGen2ConfigError'; this.code = code; }
}
const fail = () => { throw new ShellyGen2ConfigError(); };
export function shellyGen2DataRecord(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  if (keys.length > 128 || keys.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) ||
      (allowed && !allowed.includes(key)) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) fail();
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
function base(value, extras) {
  const record = shellyGen2DataRecord(value, [...BASE, ...extras]);
  if (typeof record.origin !== 'string' || record.origin.length > 2048 || /[\u0000-\u0020\u007f]/.test(record.origin)) fail();
  let identity, host;
  try {
    const url = new URL(record.origin); host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.origin !== record.origin) fail();
    validatePrivateHost(host);
    identity = validatePinnedJsonIdentity({ origin: record.origin, certificate: record.certificate, certificatePin: record.certificatePin });
    if (new X509Certificate(identity.certificate).checkIP(host) !== host) fail();
  } catch { fail(); }
  if (typeof record.expectedDeviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.expectedDeviceId) ||
      !Number.isSafeInteger(record.componentId) || record.componentId < 0 || record.componentId > 15 ||
      !['ordinary-light', 'ordinary-plug'].includes(record.loadClass)) fail();
  const timeoutMs = record.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail();
  return { ...identity, expectedDeviceId: record.expectedDeviceId, componentId: record.componentId, loadClass: record.loadClass, timeoutMs, record };
}
function credentials(value) {
  const record = shellyGen2DataRecord(value, ['username', 'password']);
  if (record.username !== 'admin' || typeof record.password !== 'string' || !record.password.length || !record.password.isWellFormed() ||
      record.password.includes('\0') || Buffer.byteLength(record.password) > 1024) fail();
  return record;
}
function publicBase(value) { return Object.fromEntries(BASE.map(key => [key, value[key]])); }
function purpose(value) {
  const binding = JSON.stringify([value.origin, value.certificatePin, value.expectedDeviceId, value.componentId, value.loadClass]);
  return `shelly-gen2/credentials:${createHash('sha256').update(binding).digest('hex')}`;
}
export function validateShellyGen2Config(value) {
  const checked = base(value, ['username', 'password']);
  return Object.freeze({ ...publicBase(checked), ...credentials({ username: checked.record.username, password: checked.record.password }) });
}
export function validateProtectedShellyGen2Config(value, { secretStore = productionStore } = {}) {
  const checked = base(value, ['credentialSecret', 'credentialPurposeVersion']);
  shellyGen2DataRecord(checked.record.credentialSecret, ['version', 'provider', 'protected']);
  if (checked.record.credentialPurposeVersion !== 1 || !secretStore.isSecretEnvelope(checked.record.credentialSecret)) fail();
  return Object.freeze({ ...publicBase(checked), credentialSecret: checked.record.credentialSecret, credentialPurposeVersion: 1 });
}
export async function protectShellyGen2Config(value, { secretStore = productionStore } = {}) {
  const checked = validateShellyGen2Config(value); let credentialSecret;
  try { credentialSecret = await secretStore.sealSecret({ username: checked.username, password: checked.password }, { purpose: purpose(checked) }); }
  catch { throw new ShellyGen2ConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validateProtectedShellyGen2Config({ ...publicBase(checked), credentialSecret, credentialPurposeVersion: 1 }, { secretStore });
}
export async function loadShellyGen2Config(file, { secretStore = productionStore } = {}) {
  let saved;
  try { saved = await readJson(file); } catch { fail(); }
  const checked = validateProtectedShellyGen2Config(saved, { secretStore }); let clear;
  try { clear = credentials(await secretStore.openSecret(checked.credentialSecret, { purpose: purpose(checked) })); }
  catch { throw new ShellyGen2ConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validateShellyGen2Config({ ...publicBase(checked), ...clear });
}
