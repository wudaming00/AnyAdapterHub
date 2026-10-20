import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { validateLGThinQConfig, lgThinQVendor } from './lg-thinq-config.mjs';
import { ReviewedCloudSensor, cloudRecord, cloudFreeze, cloudNumber, cloudFail } from './switchbot-readonly.mjs';

export function lgThinQHeaders(config) {
  const checked = validateLGThinQConfig(config);
  return { Authorization: `Bearer ${checked.token}`, 'x-country': checked.countryCode, 'x-client-id': checked.clientId,
    'x-message-id': randomBytes(16).toString('base64url'), 'x-api-key': checked.apiKey, 'x-service-phase': 'OP' };
}
function selectedResponse(raw, checked) {
  const envelope = cloudRecord(raw);
  if (Object.hasOwn(envelope, 'error')) cloudFail('INVALID_DEVICE_RESPONSE');
  const response = cloudRecord(envelope.response);
  if ((response.deviceId !== undefined && response.deviceId !== checked.vendorDeviceId) || (response.deviceType !== undefined && response.deviceType !== checked.deviceType)) cloudFail('INVALID_DEVICE_RESPONSE');
  return response;
}
function readableRange(profile, resourceName, propertyName, outputName) {
  const property = cloudRecord(profile.property), resource = cloudRecord(property[resourceName]), descriptor = cloudRecord(resource[propertyName]);
  const mode = descriptor.mode;
  if (descriptor.type !== 'range' || !Array.isArray(mode) || types.isProxy(mode) || Object.getPrototypeOf(mode) !== Array.prototype || mode.length < 1 || mode.length > 2 || Object.getOwnPropertySymbols(mode).length) cloudFail('INVALID_DEVICE_RESPONSE');
  const descriptors = Object.getOwnPropertyDescriptors(mode), keys = Object.keys(descriptors).filter(key => key !== 'length');
  if (keys.length !== mode.length || keys.some((key, i) => key !== String(i) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable || !['r', 'w'].includes(descriptors[key].value))) cloudFail('INVALID_DEVICE_RESPONSE');
  const values = keys.map(key => descriptors[key].value);
  if (new Set(values).size !== values.length || !values.includes('r')) cloudFail('INVALID_DEVICE_RESPONSE');
  const unit = descriptor.unit ?? resource.unit;
  const units = outputName === 'temperatureC' ? ['C', '°C', 'CELSIUS', 'celsius'] : ['%', 'PERCENT', 'percent'];
  if (unit !== undefined && !units.includes(unit)) cloudFail('INVALID_DEVICE_RESPONSE');
  return true;
}

// Only explicit numeric resources in the official ThinQ Connect SDK are mapped.
// Profile data can confirm readability; it never supplies an endpoint or code.
export function projectLGThinQSensor(profileRaw, stateRaw, config) {
  const checked = validateLGThinQConfig(config), profile = selectedResponse(profileRaw, checked), state = selectedResponse(stateRaw, checked), value = {};
  const fields = checked.deviceType === 'DEVICE_AIR_PURIFIER'
    ? [['airQualitySensor', 'humidity', 'humidityPercent', 0, 100], ['filterInfo', 'filterRemainPercent', 'filterRemainingPercent', 0, 100]]
    : checked.deviceType === 'DEVICE_DEHUMIDIFIER'
      ? [['humidity', 'currentHumidity', 'humidityPercent', 0, 100]]
      : [['temperature', 'currentTemperatureC', 'temperatureC', -100, 150]];
  for (const [resourceName, propertyName, outputName, min, max] of fields) {
    if (!Object.hasOwn(state, resourceName)) continue;
    const resource = cloudRecord(state[resourceName]);
    if (!Object.hasOwn(resource, propertyName)) continue;
    readableRange(profile, resourceName, propertyName, outputName);
    value[outputName] = cloudNumber(resource[propertyName], min, max);
  }
  if (!Object.keys(value).length) cloudFail('INVALID_DEVICE_RESPONSE');
  return cloudFreeze(value);
}

export class LGThinQAdapter extends ReviewedCloudSensor {
  constructor(options = {}) {
    const { deviceId, config, request } = cloudRecord(options, ['deviceId', 'config', 'request']);
    const checked = validateLGThinQConfig(config);
    super({ deviceId, adapterId: 'lg-thinq', vendor: lgThinQVendor(checked), timeoutMs: checked.timeoutMs, request,
      read: async fetch => {
        const profile = await fetch({ path: `/devices/${checked.vendorDeviceId}/profile`, headers: lgThinQHeaders(checked) });
        // Reject unrelated/malformed profile envelopes before sending a second request.
        selectedResponse(profile, checked);
        const state = await fetch({ path: `/devices/${checked.vendorDeviceId}/state`, headers: lgThinQHeaders(checked) });
        return projectLGThinQSensor(profile, state, checked);
      } });
  }
}
