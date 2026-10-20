import { types } from 'node:util';
import { validateAwairConfig } from './awair-config.mjs';
import { ReviewedCloudSensor, cloudRecord, cloudFreeze, cloudNumber, cloudFail, CLOUD_SAMPLE_MAX_MS } from './switchbot-readonly.mjs';

function array(value, limit) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Object.getOwnPropertySymbols(value).length) cloudFail('INVALID_DEVICE_RESPONSE');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Object.keys(fields).filter(key => key !== 'length');
  if (keys.length !== value.length || keys.some((key, i) => key !== String(i) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) cloudFail('INVALID_DEVICE_RESPONSE');
  return keys.map(key => fields[key].value);
}
function timestamp(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) cloudFail('INVALID_DEVICE_RESPONSE');
  const time = Date.parse(value), normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isSafeInteger(time) || time <= 0 || new Date(time).toISOString() !== normalized || time > now || now - time >= CLOUD_SAMPLE_MAX_MS) cloudFail('INVALID_DEVICE_RESPONSE');
  return time;
}
export function projectAwairSensor(raw, config, now = Date.now()) {
  validateAwairConfig(config); const body = cloudRecord(raw), data = array(body.data, 1);
  if (data.length !== 1) cloudFail('INVALID_DEVICE_RESPONSE');
  const sample = cloudRecord(data[0]), reportedAt = timestamp(sample.timestamp, now), sensors = array(sample.sensors, 16), value = {}, seen = new Set();
  const schema = { temp: ['temperatureC', -40, 185], humid: ['humidityPercent', 0, 100], co2: ['co2Ppm', 0, 5000], voc: ['vocPpb', 0, 10000], pm25: ['pm25UgM3', 0, 1000] };
  for (const entry of sensors) {
    const sensor = cloudRecord(entry);
    if (typeof sensor.comp !== 'string' || seen.has(sensor.comp)) cloudFail('INVALID_DEVICE_RESPONSE'); seen.add(sensor.comp);
    if (!Object.hasOwn(schema, sensor.comp)) continue;
    const [field, min, max] = schema[sensor.comp]; value[field] = cloudNumber(sensor.value, min, max);
  }
  if (!Object.keys(value).length) cloudFail('INVALID_DEVICE_RESPONSE');
  return cloudFreeze({ value, reportedAt });
}
export class AwairAdapter extends ReviewedCloudSensor {
  constructor(options = {}) {
    const { deviceId, config, request } = cloudRecord(options, ['deviceId', 'config', 'request']), checked = validateAwairConfig(config);
    let reportedAt;
    super({ deviceId, adapterId: 'awair', vendor: 'awair', timeoutMs: checked.timeoutMs, request, sampleTime: () => reportedAt,
      read: async fetch => {
        const sample = projectAwairSensor(await fetch({ path: `/v1/users/self/devices/${checked.deviceType}/${checked.vendorDeviceId}/air-data/latest?fahrenheit=false`, headers: { Authorization: `Bearer ${checked.token}` } }), checked);
        reportedAt = sample.reportedAt; return sample.value;
      } });
  }
}
