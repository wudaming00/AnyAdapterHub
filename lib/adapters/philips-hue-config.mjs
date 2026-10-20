import { createHash, X509Certificate } from 'node:crypto';
import { types } from 'node:util';
import { readJson } from '../hub/config.mjs';
import { validatePrivateHost } from '../hub/adapters.mjs';
import { validatePinnedJsonIdentity } from '../security/pinned-json-https.mjs';
import * as productionStore from '../security/secret-store.mjs';

export class PhilipsHueConfigError extends Error {
  constructor(code = 'INVALID_CONFIG') {
    super('A bound, encrypted Philips Hue light configuration is required.');
    this.name = 'PhilipsHueConfigError'; this.code = code;
  }
}
const fail = () => { throw new PhilipsHueConfigError(); };
const BASE_FIELDS = ['origin', 'certificate', 'certificatePin', 'lightId', 'timeoutMs', 'bridgeId'];
export const PHILIPS_HUE_LIGHT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function philipsHueDataRecord(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function base(value, extra) {
  const fields = philipsHueDataRecord(value, [...BASE_FIELDS, ...extra]);
  if (typeof fields.origin !== 'string' || fields.origin.length > 2048 || /[\u0000-\u0020\u007f]/.test(fields.origin)) fail();
  let identity;
  try {
    identity = validatePinnedJsonIdentity({ origin: fields.origin, certificate: fields.certificate, certificatePin: fields.certificatePin });
    if (identity.origin !== fields.origin) fail();
  } catch { fail(); }
  if (fields.bridgeId !== undefined) {
    if (typeof fields.bridgeId !== 'string' || !/^[a-f0-9]{16}$/.test(fields.bridgeId)) fail();
    try {
      validatePrivateHost(new URL(identity.origin).hostname.replace(/^\[|\]$/g, ''));
      const matched = new X509Certificate(identity.certificate).checkHost(fields.bridgeId, { wildcards: false });
      if (typeof matched !== 'string' || matched.toLowerCase() !== fields.bridgeId) fail();
    } catch { fail(); }
  }
  if (typeof fields.lightId !== 'string' || !PHILIPS_HUE_LIGHT_ID.test(fields.lightId)) fail();
  const timeoutMs = fields.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail();
  return { ...identity, lightId: fields.lightId, timeoutMs, ...(fields.bridgeId === undefined ? {} : { bridgeId: fields.bridgeId }), fields };
}
function applicationKey(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(value)) fail();
  return value;
}
function publicBase(config) {
  const { origin, certificate, certificatePin, lightId, timeoutMs, bridgeId } = config;
  return { origin, certificate, certificatePin, lightId, timeoutMs, ...(bridgeId === undefined ? {} : { bridgeId }) };
}
function purpose(config) {
  const digest = createHash('sha256').update(`${config.origin}\0${config.certificatePin}\0${config.lightId}${config.bridgeId === undefined ? '' : '\0' + config.bridgeId}`).digest('hex');
  return `philips-hue/application-key:${digest}`;
}
export function validatePhilipsHueConfig(value) {
  const checked = base(value, ['applicationKey']);
  return Object.freeze({ ...publicBase(checked), applicationKey: applicationKey(checked.fields.applicationKey) });
}
export function validateProtectedPhilipsHueConfig(value, { secretStore = productionStore } = {}) {
  const checked = base(value, ['applicationKeySecret', 'applicationKeyPurposeVersion']);
  philipsHueDataRecord(checked.fields.applicationKeySecret, ['version', 'provider', 'protected']);
  if (checked.fields.applicationKeyPurposeVersion !== 1 || !secretStore.isSecretEnvelope(checked.fields.applicationKeySecret)) fail();
  return Object.freeze({ ...publicBase(checked), applicationKeySecret: checked.fields.applicationKeySecret, applicationKeyPurposeVersion: 1 });
}
export async function protectPhilipsHueConfig(value, { secretStore = productionStore } = {}) {
  const checked = validatePhilipsHueConfig(value);
  let applicationKeySecret;
  try { applicationKeySecret = await secretStore.sealSecret(checked.applicationKey, { purpose: purpose(checked) }); }
  catch { throw new PhilipsHueConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validateProtectedPhilipsHueConfig({ ...publicBase(checked), applicationKeySecret, applicationKeyPurposeVersion: 1 }, { secretStore });
}
export async function loadPhilipsHueConfig(file, { secretStore = productionStore } = {}) {
  let saved;
  try { saved = await readJson(file); } catch { throw new PhilipsHueConfigError(); }
  const checked = validateProtectedPhilipsHueConfig(saved, { secretStore });
  let clear;
  try { clear = await secretStore.openSecret(checked.applicationKeySecret, { purpose: purpose(checked) }); }
  catch { throw new PhilipsHueConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validatePhilipsHueConfig({ ...publicBase(checked), applicationKey: clear });
}
