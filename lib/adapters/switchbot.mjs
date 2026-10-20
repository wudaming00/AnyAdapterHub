import { createHmac, randomUUID } from 'node:crypto';
import { validateSwitchBotConfig } from './switchbot-config.mjs';
import { ReviewedCloudSensor, cloudRecord, cloudFreeze, cloudNumber, cloudFail } from './switchbot-readonly.mjs';

export function switchBotHeaders(config) {
  const checked = validateSwitchBotConfig(config), t = String(Date.now()), nonce = randomUUID();
  const sign = createHmac('sha256', checked.secret).update(checked.token + t + nonce).digest('base64');
  return { Authorization: checked.token, t, nonce, sign };
}
export function projectSwitchBotSensor(raw, config) {
  const checked = validateSwitchBotConfig(config), envelope = cloudRecord(raw);
  if (envelope.statusCode !== 100) cloudFail('INVALID_DEVICE_RESPONSE');
  const body = cloudRecord(envelope.body);
  if (body.deviceId !== checked.vendorDeviceId || body.deviceType !== checked.deviceType) cloudFail('INVALID_DEVICE_RESPONSE');
  const value = {};
  for (const [key, field, min, max, integer] of [['temperature', 'temperatureC', -100, 150, false], ['humidity', 'humidityPercent', 0, 100, true], ['battery', 'batteryPercent', 0, 100, true]]) {
    if (Object.hasOwn(body, key)) value[field] = cloudNumber(body[key], min, max, integer);
  }
  if (checked.deviceType === 'MeterPro(CO2)' && Object.hasOwn(body, 'CO2')) value.co2Ppm = cloudNumber(body.CO2, 0, 9999, true);
  if (!Object.keys(value).length) cloudFail('INVALID_DEVICE_RESPONSE');
  return cloudFreeze(value);
}

export class SwitchBotAdapter extends ReviewedCloudSensor {
  constructor(options = {}) {
    const { deviceId, config, request } = cloudRecord(options, ['deviceId', 'config', 'request']);
    const checked = validateSwitchBotConfig(config);
    super({ deviceId, adapterId: 'switchbot', vendor: 'switchbot', timeoutMs: checked.timeoutMs, request,
      read: async fetch => projectSwitchBotSensor(await fetch({ path: `/v1.1/devices/${checked.vendorDeviceId}/status`, headers: switchBotHeaders(checked) }), checked) });
  }
}
