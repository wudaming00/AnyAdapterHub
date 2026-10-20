import { validatePurpleAirConfig } from './purpleair-config.mjs';
import { ReviewedCloudSensor, cloudRecord, cloudFreeze, cloudNumber, cloudFail, CLOUD_SAMPLE_MAX_MS } from './switchbot-readonly.mjs';

function seconds(value, now) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(now / 1000) || now - value * 1000 >= CLOUD_SAMPLE_MAX_MS) cloudFail('INVALID_DEVICE_RESPONSE');
  return value * 1000;
}
export function projectPurpleAirSensor(raw, config, now = Date.now()) {
  const checked = validatePurpleAirConfig(config), envelope = cloudRecord(raw), sensor = cloudRecord(envelope.sensor);
  if (Object.hasOwn(envelope, 'error') || sensor.sensor_index !== checked.vendorDeviceId || (sensor.private !== undefined && sensor.private !== 0 && sensor.private !== false)) cloudFail('INVALID_DEVICE_RESPONSE');
  const generatedAt = seconds(envelope.time_stamp, now), loadedAt = seconds(envelope.data_time_stamp, now), reportedAt = seconds(sensor.last_seen, now);
  if (loadedAt > generatedAt || reportedAt > loadedAt || generatedAt - loadedAt > 30000) cloudFail('INVALID_DEVICE_RESPONSE');
  const value = {};
  if (sensor.temperature !== undefined && sensor.temperature !== null) value.sensorHousingTemperatureC = (cloudNumber(sensor.temperature, -148, 302) - 32) * 5 / 9;
  if (sensor.humidity !== undefined && sensor.humidity !== null) value.sensorHousingHumidityPercent = cloudNumber(sensor.humidity, 0, 100);
  if (sensor['pm2.5_atm'] !== undefined && sensor['pm2.5_atm'] !== null) value.pm25AtmosphericUgM3 = cloudNumber(sensor['pm2.5_atm'], 0, 10000);
  if (!Object.keys(value).length) cloudFail('INVALID_DEVICE_RESPONSE');
  return cloudFreeze({ value, reportedAt });
}
export class PurpleAirAdapter extends ReviewedCloudSensor {
  constructor(options = {}) {
    const { deviceId, config, request } = cloudRecord(options, ['deviceId', 'config', 'request']), checked = validatePurpleAirConfig(config);
    let reportedAt;
    super({ deviceId, adapterId: 'purpleair', vendor: 'purpleair', timeoutMs: checked.timeoutMs, request, sampleTime: () => reportedAt,
      read: async fetch => {
        const sample = projectPurpleAirSensor(await fetch({ path: `/v1/sensors/${checked.vendorDeviceId}?fields=last_seen,temperature,humidity,pm2.5_atm`, headers: { 'X-API-Key': checked.apiKey } }), checked);
        reportedAt = sample.reportedAt; return sample.value;
      } });
  }
}
