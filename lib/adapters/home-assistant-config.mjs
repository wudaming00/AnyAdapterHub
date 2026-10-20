import { createHash, X509Certificate } from 'node:crypto';
import { types } from 'node:util';
import { readJson } from '../hub/config.mjs';
import * as productionStore from '../security/secret-store.mjs';

export class HomeAssistantConfigError extends Error {
  constructor(code = 'INVALID_CONFIG') { super('A bound, encrypted Home Assistant light configuration is required.'); this.name = 'HomeAssistantConfigError'; this.code = code; }
}
const fail = () => { throw new HomeAssistantConfigError(); };
const BASE_FIELDS = ['origin', 'certificate', 'certificatePin', 'entityId', 'timeoutMs'];

// Inspect descriptors before reading values: executable properties and proxies
// must not become configuration or select a credential provider.
export function homeAssistantDataRecord(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function base(value, extra) {
  const fields = homeAssistantDataRecord(value, [...BASE_FIELDS, ...extra]);
  if (typeof fields.origin !== 'string' || fields.origin.length > 2048 || /[\u0000-\u0020\u007f]/.test(fields.origin)) fail();
  let url;
  try { url = new URL(fields.origin); } catch { fail(); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== fields.origin) fail();
  if (typeof fields.entityId !== 'string' || !/^light\.[a-z0-9_]{1,120}$/.test(fields.entityId)) fail();
  if (typeof fields.certificatePin !== 'string' || !/^[a-f0-9]{64}$/.test(fields.certificatePin) || typeof fields.certificate !== 'string' || fields.certificate.length > 16384) fail();
  const certs = fields.certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (certs?.length !== 1 || fields.certificate.replace(certs[0], '').trim()) fail();
  try {
    if (createHash('sha256').update(new X509Certificate(fields.certificate).raw).digest('hex') !== fields.certificatePin) fail();
  } catch { fail(); }
  const timeoutMs = fields.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail();
  return { origin: url.origin, certificate: fields.certificate, certificatePin: fields.certificatePin, entityId: fields.entityId, timeoutMs, fields };
}

function token(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(value)) fail();
  return value;
}
function purpose(config) {
  const digest = createHash('sha256').update(`${config.origin}\0${config.certificatePin}\0${config.entityId}`).digest('hex');
  return `home-assistant/token:${digest}`;
}
function publicBase(config) { const { origin, certificate, certificatePin, entityId, timeoutMs } = config; return { origin, certificate, certificatePin, entityId, timeoutMs }; }

export function validateHomeAssistantConfig(value) {
  const checked = base(value, ['token']);
  return Object.freeze({ ...publicBase(checked), token: token(checked.fields.token) });
}

export function validateProtectedHomeAssistantConfig(value, { secretStore = productionStore } = {}) {
  const checked = base(value, ['tokenSecret', 'tokenPurposeVersion']);
  // Envelope validation is provider-owned; still reject executable nested fields
  // before handing them to any explicitly injected fixture provider.
  homeAssistantDataRecord(checked.fields.tokenSecret, ['version', 'provider', 'protected']);
  if (checked.fields.tokenPurposeVersion !== 1 || !secretStore.isSecretEnvelope(checked.fields.tokenSecret)) fail();
  return Object.freeze({ ...publicBase(checked), tokenSecret: checked.fields.tokenSecret, tokenPurposeVersion: 1 });
}

export async function protectHomeAssistantConfig(value, { secretStore = productionStore } = {}) {
  const checked = validateHomeAssistantConfig(value);
  let tokenSecret;
  try { tokenSecret = await secretStore.sealSecret(checked.token, { purpose: purpose(checked) }); }
  catch { throw new HomeAssistantConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validateProtectedHomeAssistantConfig({ ...publicBase(checked), tokenSecret, tokenPurposeVersion: 1 }, { secretStore });
}

export async function loadHomeAssistantConfig(file, { secretStore = productionStore } = {}) {
  let saved;
  try { saved = await readJson(file); } catch { throw new HomeAssistantConfigError(); }
  const checked = validateProtectedHomeAssistantConfig(saved, { secretStore });
  let clear;
  try { clear = await secretStore.openSecret(checked.tokenSecret, { purpose: purpose(checked) }); }
  catch { throw new HomeAssistantConfigError('CREDENTIAL_UNAVAILABLE'); }
  return validateHomeAssistantConfig({ ...publicBase(checked), token: clear });
}
