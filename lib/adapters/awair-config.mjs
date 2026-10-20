import { createHash } from 'node:crypto';
import { readJson } from '../hub/config.mjs';
import * as systemStore from '../security/secret-store.mjs';
import { cloudRecord, cloudString, cloudFail } from './switchbot-readonly.mjs';

export const AWAIR_ORIGIN = 'https://developer-apis.awair.is';
const FIELDS = ['vendorDeviceId', 'deviceType', 'timeoutMs'];
function base(value, secrets) {
  const record = cloudRecord(value, [...FIELDS, ...secrets]), timeoutMs = record.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(record.vendorDeviceId) || record.vendorDeviceId < 1 || record.vendorDeviceId > 999999999999 || !['awair-r2', 'awair-element'].includes(record.deviceType) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) cloudFail('INVALID_CONFIG');
  return { vendorDeviceId: record.vendorDeviceId, deviceType: record.deviceType, timeoutMs, record };
}
const metadata = value => Object.fromEntries(FIELDS.map(key => [key, value[key]]));
const purpose = value => 'awair/credentials:' + createHash('sha256').update(JSON.stringify([AWAIR_ORIGIN, 'global', value.deviceType, value.vendorDeviceId])).digest('hex');
export function validateAwairConfig(value) { const checked = base(value, ['token']); return Object.freeze({ ...metadata(checked), token: cloudString(checked.record.token) }); }
export function validateProtectedAwairConfig(value, { secretStore = systemStore } = {}) {
  const checked = base(value, ['credentialSecret']); cloudRecord(checked.record.credentialSecret, ['version', 'provider', 'protected']);
  if (!secretStore.isSecretEnvelope(checked.record.credentialSecret)) cloudFail('INVALID_CONFIG');
  return Object.freeze({ ...metadata(checked), credentialSecret: checked.record.credentialSecret });
}
export async function protectAwairConfig(value, { secretStore = systemStore } = {}) {
  const checked = validateAwairConfig(value);
  try { return validateProtectedAwairConfig({ ...metadata(checked), credentialSecret: await secretStore.sealSecret({ token: checked.token }, { purpose: purpose(checked) }) }, { secretStore }); }
  catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
export async function loadAwairConfig(file, { secretStore = systemStore } = {}) {
  try {
    const checked = validateProtectedAwairConfig(await readJson(file), { secretStore });
    return validateAwairConfig({ ...metadata(checked), ...cloudRecord(await secretStore.openSecret(checked.credentialSecret, { purpose: purpose(checked) }), ['token']) });
  } catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
