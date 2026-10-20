import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { types } from 'node:util';
import { readJson } from '../hub/config.mjs';
import { validatePinnedJsonIdentity } from '../security/pinned-json-https.mjs';
import * as productionStore from '../security/secret-store.mjs';

export const OPENHAB_ITEM_TYPES = Object.freeze(['Switch', 'Dimmer', 'Number', 'Number:Temperature', 'Number:Power', 'Number:Energy',
  'Number:ElectricPotential', 'Number:ElectricCurrent', 'Number:Illuminance', 'Number:Frequency', 'Number:Dimensionless']);
const BASE = ['origin', 'certificate', 'certificatePin', 'itemName', 'itemType', 'timeoutMs'];
export class OpenHABConfigError extends Error {
  constructor(code = 'INVALID_CONFIG') { super('An encrypted configuration for one enrolled openHAB Item is required.'); this.name = 'OpenHABConfigError'; this.code = code; }
}
const fail = () => { throw new OpenHABConfigError(); };
export function openHABDataRecord(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  if (keys.length > 128 || keys.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) ||
      (allowed && !allowed.includes(key)) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) fail();
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
function base(value, extra) {
  const record = openHABDataRecord(value, [...BASE, ...extra]); let identity;
  if (typeof record.origin !== 'string' || record.origin.length > 2048 || /[\u0000-\u0020\u007f]/.test(record.origin)) fail();
  try {
    const url = new URL(record.origin), host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.origin !== record.origin) fail();
    identity = validatePinnedJsonIdentity({ origin: record.origin, certificate: record.certificate, certificatePin: record.certificatePin });
    const cert = new X509Certificate(identity.certificate);
    if (!(isIP(host) ? cert.checkIP(host) : cert.checkHost(host))) fail();
  } catch { fail(); }
  if (typeof record.itemName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(record.itemName) ||
      typeof record.itemType !== 'string' || !OPENHAB_ITEM_TYPES.includes(record.itemType)) fail();
  const timeoutMs = record.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail();
  return { ...identity, itemName: record.itemName, itemType: record.itemType, timeoutMs, record };
}
function token(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{16,4096}$/.test(value)) fail(); return value; }
function publicBase(value) { return Object.fromEntries(BASE.map(key => [key, value[key]])); }
function purpose(value) { return `openhab/token:${createHash('sha256').update(JSON.stringify([value.origin, value.certificatePin, value.itemName, value.itemType])).digest('hex')}`; }
export function validateOpenHABConfig(value) { const checked = base(value, ['token']); return Object.freeze({ ...publicBase(checked), token: token(checked.record.token) }); }
export function validateProtectedOpenHABConfig(value, { secretStore = productionStore } = {}) {
  const checked = base(value, ['tokenSecret', 'tokenPurposeVersion']);
  openHABDataRecord(checked.record.tokenSecret, ['version', 'provider', 'protected']);
  if (checked.record.tokenPurposeVersion !== 1 || !secretStore.isSecretEnvelope(checked.record.tokenSecret)) fail();
  return Object.freeze({ ...publicBase(checked), tokenSecret: checked.record.tokenSecret, tokenPurposeVersion: 1 });
}
export async function protectOpenHABConfig(value, { secretStore = productionStore } = {}) {
  const checked = validateOpenHABConfig(value); let tokenSecret;
  try { tokenSecret = await secretStore.sealSecret(checked.token, { purpose: purpose(checked) }); }
  catch { throw new OpenHABConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validateProtectedOpenHABConfig({ ...publicBase(checked), tokenSecret, tokenPurposeVersion: 1 }, { secretStore });
}
export async function loadOpenHABConfig(file, { secretStore = productionStore } = {}) {
  let saved;
  try { saved = await readJson(file); } catch { fail(); }
  const checked = validateProtectedOpenHABConfig(saved, { secretStore }); let clear;
  try { clear = await secretStore.openSecret(checked.tokenSecret, { purpose: purpose(checked) }); }
  catch { throw new OpenHABConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validateOpenHABConfig({ ...publicBase(checked), token: clear });
}
