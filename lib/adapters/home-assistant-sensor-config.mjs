import { createHash } from 'node:crypto';
import { readJson } from '../hub/config.mjs';
import * as systemStore from '../security/secret-store.mjs';
import { validatePinnedJsonIdentity } from '../security/pinned-json-https.mjs';
import { homeAssistantDataRecord } from './home-assistant-config.mjs';

const numeric = (deviceClass, unit, min, max) => Object.freeze({ domain: 'sensor', classes: Object.freeze([deviceClass]), unit, min, max });
const binary = (...classes) => Object.freeze({ domain: 'binary_sensor', classes: Object.freeze(classes) });
export const HA_SENSOR_TYPES = Object.freeze({
  temperatureC: numeric('temperature', '°C', -100, 150), humidityPercent: numeric('humidity', '%', 0, 100),
  co2Ppm: numeric('carbon_dioxide', 'ppm', 0, 100000), illuminanceLux: numeric('illuminance', 'lx', 0, 1000000),
  powerWatts: numeric('power', 'W', -10000000, 10000000), energyKwh: numeric('energy', 'kWh', 0, 1e12),
  batteryPercent: numeric('battery', '%', 0, 100), contactOpen: binary('door', 'window', 'opening'),
  motionDetected: binary('motion'), occupied: binary('occupancy'), moistureDetected: binary('moisture'),
});
export class HASensorError extends Error {
  constructor(code = 'INVALID_CONFIG') { super('The selected Home Assistant sensor request could not complete.'); this.name = 'HASensorError'; this.code = code; }
}
const fail = code => { throw new HASensorError(code); };
const BASE = ['origin', 'certificate', 'certificatePin', 'entityId', 'measurement', 'timeoutMs'];
function base(value, extra) {
  const input = homeAssistantDataRecord(value, [...BASE, ...extra]);
  if (typeof input.origin !== 'string' || input.origin.endsWith('/') || typeof input.measurement !== 'string' || !Object.hasOwn(HA_SENSOR_TYPES, input.measurement)) fail();
  const identity = validatePinnedJsonIdentity({ origin: input.origin, certificate: input.certificate, certificatePin: input.certificatePin });
  const type = HA_SENSOR_TYPES[input.measurement];
  if (typeof input.entityId !== 'string' || !new RegExp(`^${type.domain}\\.[a-z0-9_]{1,120}$`).test(input.entityId)) fail();
  const timeoutMs = input.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail();
  return { input, public: { ...identity, entityId: input.entityId, measurement: input.measurement, timeoutMs } };
}
const purpose = c => 'ha-sensor/token:' + createHash('sha256').update(JSON.stringify([c.origin, c.certificatePin, c.entityId, c.measurement])).digest('hex');
export function validateHASensorConfig(value) {
  const c = base(value, ['token']);
  if (typeof c.input.token !== 'string' || !/^[A-Za-z0-9._~-]{16,4096}$/.test(c.input.token)) fail();
  return Object.freeze({ ...c.public, token: c.input.token });
}
export async function protectHASensorConfig(value, { secretStore = systemStore } = {}) {
  const c = validateHASensorConfig(value), { token, ...metadata } = c;
  try { return Object.freeze({ ...metadata, tokenSecret: await secretStore.sealSecret(token, { purpose: purpose(c) }), tokenPurposeVersion: 1 }); }
  catch { fail('CREDENTIAL_UNAVAILABLE'); }
}
export async function loadHASensorConfig(file, { secretStore = systemStore } = {}) {
  let c;
  try { c = base(await readJson(file), ['tokenSecret', 'tokenPurposeVersion']); } catch { fail(); }
  if (c.input.tokenPurposeVersion !== 1 || !secretStore.isSecretEnvelope(c.input.tokenSecret)) fail();
  let token;
  try { token = await secretStore.openSecret(c.input.tokenSecret, { purpose: purpose(c.public) }); }
  catch { fail('CREDENTIAL_UNAVAILABLE'); }
  return validateHASensorConfig({ ...c.public, token });
}
