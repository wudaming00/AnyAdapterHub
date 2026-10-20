import { createHash } from 'node:crypto';
import { readJson } from '../hub/config.mjs';
import * as systemStore from '../security/secret-store.mjs';
import { cloudRecord, cloudString, cloudFail } from './switchbot-readonly.mjs';

export const SWITCHBOT_ORIGIN = 'https://api.switch-bot.com';
export const SWITCHBOT_SENSOR_TYPES = Object.freeze(['Meter', 'MeterPlus', 'MeterPro', 'MeterPro(CO2)', 'WoIOSensor']);
const BASE = ['vendorDeviceId', 'deviceType', 'timeoutMs'];
function base(value, secretFields) {
  const record = cloudRecord(value, [...BASE, ...secretFields]);
  if (typeof record.vendorDeviceId !== 'string' || !/^[A-F0-9]{12}$/.test(record.vendorDeviceId) || !SWITCHBOT_SENSOR_TYPES.includes(record.deviceType)) cloudFail('INVALID_CONFIG');
  const timeoutMs = record.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) cloudFail('INVALID_CONFIG');
  return { vendorDeviceId: record.vendorDeviceId, deviceType: record.deviceType, timeoutMs, record };
}
function metadata(value) { return { vendorDeviceId: value.vendorDeviceId, deviceType: value.deviceType, timeoutMs: value.timeoutMs }; }
function purpose(value) { return 'switchbot/credentials:' + createHash('sha256').update(JSON.stringify([SWITCHBOT_ORIGIN, 'global', value.vendorDeviceId, value.deviceType])).digest('hex'); }
export function validateSwitchBotConfig(value) {
  const checked = base(value, ['token', 'secret']);
  return Object.freeze({ ...metadata(checked), token: cloudString(checked.record.token), secret: cloudString(checked.record.secret) });
}
export function validateProtectedSwitchBotConfig(value, { secretStore = systemStore } = {}) {
  const checked = base(value, ['credentialSecret']);
  cloudRecord(checked.record.credentialSecret, ['version', 'provider', 'protected']);
  if (!secretStore.isSecretEnvelope(checked.record.credentialSecret)) cloudFail('INVALID_CONFIG');
  return Object.freeze({ ...metadata(checked), credentialSecret: checked.record.credentialSecret });
}
export async function protectSwitchBotConfig(value, { secretStore = systemStore } = {}) {
  const checked = validateSwitchBotConfig(value);
  try { return validateProtectedSwitchBotConfig({ ...metadata(checked), credentialSecret: await secretStore.sealSecret({ token: checked.token, secret: checked.secret }, { purpose: purpose(checked) }) }, { secretStore }); }
  catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
export async function loadSwitchBotConfig(file, { secretStore = systemStore } = {}) {
  try {
    const checked = validateProtectedSwitchBotConfig(await readJson(file), { secretStore });
    const clear = cloudRecord(await secretStore.openSecret(checked.credentialSecret, { purpose: purpose(checked) }), ['token', 'secret']);
    return validateSwitchBotConfig({ ...metadata(checked), ...clear });
  } catch { cloudFail('CREDENTIAL_UNAVAILABLE'); }
}
