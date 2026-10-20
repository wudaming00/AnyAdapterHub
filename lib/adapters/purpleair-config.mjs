import { createHash } from 'node:crypto';
import { readJson } from '../hub/config.mjs';
import * as systemStore from '../security/secret-store.mjs';
import { cloudRecord, cloudString, cloudFail } from './switchbot-readonly.mjs';

export const PURPLEAIR_ORIGIN = 'https://api.purpleair.com';
const metadata = value => ({ vendorDeviceId: value.vendorDeviceId, timeoutMs: value.timeoutMs });
function base(value, secrets) {
  const record = cloudRecord(value, ['vendorDeviceId', 'timeoutMs', ...secrets]), timeoutMs = record.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(record.vendorDeviceId) || record.vendorDeviceId < 1 || record.vendorDeviceId > 999999999999 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) cloudFail('INVALID_CONFIG');
  return { vendorDeviceId: record.vendorDeviceId, timeoutMs, record };
}
const purpose = value => 'purpleair/credentials:' + createHash('sha256').update(JSON.stringify([PURPLEAIR_ORIGIN, 'global', value.vendorDeviceId, 'public-only'])).digest('hex');
export function validatePurpleAirConfig(value) { const checked = base(value, ['apiKey']); return Object.freeze({ ...metadata(checked), apiKey: cloudString(checked.record.apiKey) }); }
export function validateProtectedPurpleAirConfig(value, { secretStore = systemStore } = {}) {
  const checked = base(value, ['credentialSecret']); cloudRecord(checked.record.credentialSecret, ['version', 'provider', 'protected']);
  if (!secretStore.isSecretEnvelope(checked.record.credentialSecret)) cloudFail('INVALID_CONFIG');
  return Object.freeze({ ...metadata(checked), credentialSecret: checked.record.credentialSecret });
}
export async function protectPurpleAirConfig(value, { secretStore = systemStore } = {}) {
  const checked = validatePurpleAirConfig(value);
  try { return validateProtectedPurpleAirConfig({ ...metadata(checked), credentialSecret: await secretStore.sealSecret({ apiKey: checked.apiKey }, { purpose: purpose(checked) }) }, { secretStore }); }
  catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
export async function loadPurpleAirConfig(file, { secretStore = systemStore } = {}) {
  try {
    const checked = validateProtectedPurpleAirConfig(await readJson(file), { secretStore });
    return validatePurpleAirConfig({ ...metadata(checked), ...cloudRecord(await secretStore.openSecret(checked.credentialSecret, { purpose: purpose(checked) }), ['apiKey']) });
  } catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
