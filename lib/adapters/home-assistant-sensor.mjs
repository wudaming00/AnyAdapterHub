import { isIP } from 'node:net';
import { types } from 'node:util';
import { createPinnedJsonClient } from '../security/pinned-json-https.mjs';
import { homeAssistantDataRecord } from './home-assistant-config.mjs';
import { HA_SENSOR_TYPES, HASensorError, validateHASensorConfig } from './home-assistant-sensor-config.mjs';

const fail = code => { throw new HASensorError(code); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function data(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_DEVICE_RESPONSE');
  const keys = Object.keys(Object.getOwnPropertyDescriptors(value));
  if (keys.length > 256) fail('INVALID_DEVICE_RESPONSE');
  try { return homeAssistantDataRecord(value, keys); } catch { fail('INVALID_DEVICE_RESPONSE'); }
}
export function projectHASensor(raw, config) {
  config = validateHASensorConfig(config);
  const row = data(raw), type = HA_SENSOR_TYPES[config.measurement];
  if (row.entity_id !== config.entityId || typeof row.state !== 'string' || row.state.length > 64) fail('INVALID_DEVICE_RESPONSE');
  if (['unavailable', 'unknown'].includes(row.state)) return { available: false };
  const attributes = data(row.attributes);
  if (!type.classes.includes(attributes.device_class)) fail('INVALID_DEVICE_RESPONSE');
  if (type.domain === 'binary_sensor') {
    if (!['on', 'off'].includes(row.state)) fail('INVALID_DEVICE_RESPONSE');
    return { available: true, value: row.state === 'on' };
  }
  if (attributes.unit_of_measurement !== type.unit || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(row.state)) fail('INVALID_DEVICE_RESPONSE');
  const value = Number(row.state);
  if (!Number.isFinite(value) || value < type.min || value > type.max) fail('INVALID_DEVICE_RESPONSE');
  return { available: true, value };
}

/** One enrolled sensor entity; no history, service, template or actuator tool. */
export class HomeAssistantSensorAdapter {
  #config; #request; #client; #fields = {}; #listeners = new Set(); #phase = 'unknown'; #revision = 0;
  #started = false; #closed = false; #timer; #pending; #abort; #pollMs = 5000;
  constructor(value = {}) {
    const { deviceId, config, request } = homeAssistantDataRecord(value, ['deviceId', 'config', 'request']);
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId) || isIP(deviceId) || (request !== undefined && typeof request !== 'function')) fail('INVALID_CONFIG');
    this.#config = validateHASensorConfig(config); this.#request = request;
    Object.defineProperties(this, { deviceId: { value: deviceId, enumerable: true }, adapterId: { value: 'home-assistant-sensor', enumerable: true }, supportedActions: { value: Object.freeze([]), enumerable: true } });
  }
  snapshot() { return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields })); }
  #publish() { if (!this.#closed) { this.#revision++; const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.snapshot() }); for (const listener of this.#listeners) { try { listener(event); } catch {} } } }
  subscribe(listener) { if (this.#closed) fail('ADAPTER_CLOSED'); if (typeof listener !== 'function') fail('INVALID_LISTENER'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  refresh() {
    if (this.#closed) return Promise.reject(new HASensorError('ADAPTER_CLOSED'));
    if (this.#pending) return this.#pending;
    const abort = new AbortController(); this.#abort = abort;
    const task = (async () => {
      let timer, onAbort;
      try {
        const beganAt = Date.now(), config = this.#config;
        if (!this.#request && !this.#client) this.#client = createPinnedJsonClient({ origin: config.origin, certificate: config.certificate, certificatePin: config.certificatePin, timeoutMs: config.timeoutMs });
        const request = this.#request ?? (input => this.#client.request(input));
        const raw = await Promise.race([
          Promise.resolve().then(() => {
            if (this.#closed || abort.signal.aborted) fail('ADAPTER_CLOSED');
            return request({ method: 'GET', path: `/api/states/${config.entityId}`, headers: { Authorization: `Bearer ${config.token}` }, signal: abort.signal,
              beforeDispatch: () => { if (this.#closed || abort.signal.aborted) fail('ADAPTER_CLOSED'); } });
          }),
          new Promise((_, reject) => {
            onAbort = () => reject(new HASensorError('ADAPTER_CLOSED'));
            abort.signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => { reject(new HASensorError('REQUEST_TIMEOUT')); abort.abort(); }, config.timeoutMs);
          }),
        ]);
        if (this.#closed || abort.signal.aborted) fail('ADAPTER_CLOSED');
        const projected = projectHASensor(raw, config), field = value => ({ value, observedAt: new Date(beganAt).toISOString(), expiresAt: new Date(beganAt + 15000).toISOString(), source: 'home-assistant-https', verification: 'hub-reported-selected-entity' });
        this.#fields.available = field(projected.available);
        if (projected.available) this.#fields[config.measurement] = field(projected.value);
        else if (this.#fields[config.measurement]) this.#fields[config.measurement].expiresAt = new Date(0).toISOString();
        this.#phase = 'online'; this.#publish(); return this.snapshot();
      } catch {
        if (!this.#closed) { this.#phase = 'offline'; for (const field of Object.values(this.#fields)) field.expiresAt = new Date(0).toISOString(); this.#publish(); }
        fail(this.#closed ? 'ADAPTER_CLOSED' : 'SENSOR_READ_FAILED');
      } finally { clearTimeout(timer); if (onAbort) abort.signal.removeEventListener('abort', onAbort); if (this.#abort === abort) this.#abort = undefined; }
    })();
    this.#pending = task;
    task.finally(() => { if (this.#pending === task) this.#pending = undefined; }).catch(() => {});
    return task;
  }
  start(input = {}) {
    const { pollMs = 5000 } = homeAssistantDataRecord(input, ['pollMs']);
    if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 300000) fail('INVALID_POLL_INTERVAL');
    if (this.#closed) return Promise.reject(new HASensorError('ADAPTER_CLOSED'));
    if (this.#started) return this.#pending ?? Promise.resolve();
    this.#started = true; this.#pollMs = Math.max(5000, pollMs);
    const loop = () => { const task = this.refresh(); task.catch(() => {}).finally(() => { if (!this.#closed) { this.#timer = setTimeout(loop, this.#pollMs); this.#timer.unref?.(); } }); return task; };
    return loop();
  }
  async execute() { fail(this.#closed ? 'ADAPTER_CLOSED' : 'UNSUPPORTED_ACTION'); }
  async close() { this.#closed = true; clearTimeout(this.#timer); this.#abort?.abort(); this.#client?.close(); this.#listeners.clear(); await this.#pending?.catch(() => {}); for (const field of Object.values(this.#fields)) field.expiresAt = new Date(0).toISOString(); this.#phase = 'closed'; }
}
