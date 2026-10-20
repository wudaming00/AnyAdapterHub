import { createHash } from 'node:crypto';
import { readJson } from '../hub/config.mjs';
import * as systemStore from '../security/secret-store.mjs';
import { cloudRecord, cloudString, cloudFail } from './switchbot-readonly.mjs';

export const LG_THINQ_COUNTRIES = Object.freeze({ US: 'aic', CA: 'aic', KR: 'kic', JP: 'kic', AU: 'kic', NZ: 'kic', SG: 'kic', GB: 'eic', DE: 'eic', FR: 'eic', IT: 'eic' });
export const LG_THINQ_DEVICE_TYPES = Object.freeze(['DEVICE_AIR_PURIFIER', 'DEVICE_DEHUMIDIFIER', 'DEVICE_AIR_CONDITIONER']);
const BASE = ['vendorDeviceId', 'deviceType', 'countryCode', 'clientId', 'timeoutMs'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CLIENT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function base(value, secretFields) {
  const record = cloudRecord(value, [...BASE, ...secretFields]);
  if (typeof record.vendorDeviceId !== 'string' || !UUID.test(record.vendorDeviceId) || !LG_THINQ_DEVICE_TYPES.includes(record.deviceType) ||
      typeof record.countryCode !== 'string' || !Object.hasOwn(LG_THINQ_COUNTRIES, record.countryCode) || typeof record.clientId !== 'string' || !CLIENT_UUID.test(record.clientId)) cloudFail('INVALID_CONFIG');
  const timeoutMs = record.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) cloudFail('INVALID_CONFIG');
  return { vendorDeviceId: record.vendorDeviceId, deviceType: record.deviceType, countryCode: record.countryCode, clientId: record.clientId, timeoutMs, record };
}
function metadata(value) { return Object.fromEntries(BASE.map(key => [key, value[key]])); }
export function lgThinQVendor(value) { return `lg-thinq-${LG_THINQ_COUNTRIES[value.countryCode]}`; }
export function lgThinQOrigin(value) { return `https://api-${LG_THINQ_COUNTRIES[value.countryCode]}.lgthinq.com`; }
function purpose(value) { return 'lg-thinq/credentials:' + createHash('sha256').update(JSON.stringify([lgThinQOrigin(value), value.countryCode, value.vendorDeviceId, value.deviceType, value.clientId])).digest('hex'); }
export function validateLGThinQConfig(value) {
  const checked = base(value, ['token', 'apiKey']);
  return Object.freeze({ ...metadata(checked), token: cloudString(checked.record.token), apiKey: cloudString(checked.record.apiKey) });
}
export function validateProtectedLGThinQConfig(value, { secretStore = systemStore } = {}) {
  const checked = base(value, ['credentialSecret']);
  cloudRecord(checked.record.credentialSecret, ['version', 'provider', 'protected']);
  if (!secretStore.isSecretEnvelope(checked.record.credentialSecret)) cloudFail('INVALID_CONFIG');
  return Object.freeze({ ...metadata(checked), credentialSecret: checked.record.credentialSecret });
}
export async function protectLGThinQConfig(value, { secretStore = systemStore } = {}) {
  const checked = validateLGThinQConfig(value);
  try { return validateProtectedLGThinQConfig({ ...metadata(checked), credentialSecret: await secretStore.sealSecret({ token: checked.token, apiKey: checked.apiKey }, { purpose: purpose(checked) }) }, { secretStore }); }
  catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
export async function loadLGThinQConfig(file, { secretStore = systemStore } = {}) {
  try {
    const checked = validateProtectedLGThinQConfig(await readJson(file), { secretStore });
    const clear = cloudRecord(await secretStore.openSecret(checked.credentialSecret, { purpose: purpose(checked) }), ['token', 'apiKey']);
    return validateLGThinQConfig({ ...metadata(checked), ...clear });
  } catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
