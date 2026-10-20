import { isIP } from 'node:net';
import { types } from 'node:util';
import { createPinnedJsonClient } from '../security/pinned-json-https.mjs';
import { validateOpenHABConfig, OPENHAB_ITEM_TYPES, openHABDataRecord } from './openhab-config.mjs';

const TTL_MS = 15000;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const SPECS = Object.freeze({
  Number: { field: 'number', min: -1e12, max: 1e12, units: { '': value => value } },
  'Number:Temperature': { field: 'temperatureC', min: -100, max: 150, units: { '°C': value => value, '°F': value => (value - 32) * 5 / 9, K: value => value - 273.15 } },
  'Number:Power': { field: 'powerWatts', min: -1e7, max: 1e7, units: { W: value => value, kW: value => value * 1000, mW: value => value / 1000 } },
  'Number:Energy': { field: 'energyKwh', min: -1e12, max: 1e12, units: { kWh: value => value, Wh: value => value / 1000, J: value => value / 3600000 } },
  'Number:ElectricPotential': { field: 'voltageV', min: -1000, max: 1000, units: { V: value => value, mV: value => value / 1000, kV: value => value * 1000 } },
  'Number:ElectricCurrent': { field: 'currentAmps', min: -1000, max: 1000, units: { A: value => value, mA: value => value / 1000 } },
  'Number:Illuminance': { field: 'illuminanceLux', min: 0, max: 1e6, units: { lx: value => value } },
  'Number:Frequency': { field: 'frequencyHz', min: 0, max: 1e6, units: { Hz: value => value, kHz: value => value * 1000 } },
  'Number:Dimensionless': { field: 'ratio', min: -1e12, max: 1e12, units: { one: value => value, '%': value => value / 100, ppm: value => value / 1e6 } },
});
export class OpenHABAdapterError extends Error {
  constructor(code = 'STATE_UNAVAILABLE') { super('The selected openHAB Item state could not be read.'); this.name = 'OpenHABAdapterError'; this.code = code; }
}
const fail = code => { throw new OpenHABAdapterError(code); };
function data(value, allowed, code = 'INVALID_ITEM_RESPONSE') { try { return openHABDataRecord(value, allowed); } catch { fail(code); } }

/** Selected name/type must match; links, metadata, labels and arbitrary state text never escape. */
export function projectOpenHABItem(raw, itemName, itemType) {
  const item = data(raw);
  if (typeof itemName !== 'string' || typeof itemType !== 'string' || !OPENHAB_ITEM_TYPES.includes(itemType) || item.name !== itemName || item.type !== itemType ||
      typeof item.state !== 'string' || Buffer.byteLength(item.state) > 256) fail('INVALID_ITEM_RESPONSE');
  const field = itemType === 'Switch' ? 'power' : itemType === 'Dimmer' ? 'brightnessPercent' : SPECS[itemType].field;
  if (['NULL', 'UNDEF'].includes(item.state)) return freeze({ available: false, field });
  if (itemType === 'Switch') {
    if (!['ON', 'OFF'].includes(item.state)) fail('INVALID_ITEM_RESPONSE');
    return freeze({ available: true, field, value: item.state === 'ON' });
  }
  const match = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?: ([^\s]{1,12}))?$/.exec(item.state);
  if (!match || match[1].length > 64) fail('INVALID_ITEM_RESPONSE');
  const value = Number(match[1]), unit = match[2] ?? '';
  if (!Number.isFinite(value)) fail('INVALID_ITEM_RESPONSE');
  if (itemType === 'Dimmer') {
    if (unit || value < 0 || value > 100) fail('INVALID_ITEM_RESPONSE');
    return freeze({ available: true, field, value });
  }
  const spec = SPECS[itemType];
  if (!Object.hasOwn(spec.units, unit)) fail('UNSUPPORTED_ITEM_UNIT');
  const normalized = spec.units[unit](value);
  if (!Number.isFinite(normalized) || normalized < spec.min || normalized > spec.max) fail('INVALID_ITEM_RESPONSE');
  return freeze({ available: true, field, value: normalized });
}

export class OpenHABAdapter {
  #config; #requestFn; #client; #listeners = new Set(); #fields = {}; #phase = 'unknown'; #revision = 0;
  #tail = Promise.resolve(); #queued = 0; #closing = false; #closePromise; #started = false; #startPromise; #timer; #active;
  constructor(value = {}) {
    const { deviceId, config, features = [], request } = data(value, ['deviceId', 'config', 'features', 'request'], 'INVALID_CONFIG');
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID');
    this.#config = validateOpenHABConfig(config);
    if (!Array.isArray(features) || types.isProxy(features) || Object.getPrototypeOf(features) !== Array.prototype ||
        Reflect.ownKeys(features).length !== 1 || features.length !== 0) fail('INVALID_FEATURES');
    if (request !== undefined && typeof request !== 'function') fail('INVALID_CONFIG');
    this.#requestFn = request;
    Object.defineProperties(this, { deviceId: { value: deviceId, enumerable: true }, adapterId: { value: 'openhab', enumerable: true },
      supportedActions: { value: Object.freeze([]), enumerable: true } });
  }
  #check() { if (this.#closing) fail('ADAPTER_CLOSED'); }
  #snapshot() { return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields })); }
  #publish() { if (!this.#closing) { this.#revision++; const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.#snapshot() }); for (const listener of this.#listeners) { try { listener(event); } catch {} } } }
  #enqueue(task) {
    if (this.#closing) return Promise.reject(new OpenHABAdapterError('ADAPTER_CLOSED'));
    if (this.#queued >= 16) return Promise.reject(new OpenHABAdapterError('QUEUE_FULL'));
    this.#queued++; const operation = this.#tail.then(() => { this.#check(); return task(); });
    this.#tail = operation.catch(() => {}).finally(() => { this.#queued--; }); return operation;
  }
  async #read() {
    this.#check(); const beganAt = Date.now();
    if (!this.#requestFn && !this.#client) this.#client = createPinnedJsonClient({ origin: this.#config.origin, certificate: this.#config.certificate,
      certificatePin: this.#config.certificatePin, timeoutMs: this.#config.timeoutMs, maxBytes: 65536, policy: 'openhab' });
    const abort = new AbortController(); this.#active = abort; let timer;
    try {
      const boundary = new Promise((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(new OpenHABAdapterError(this.#closing ? 'ADAPTER_CLOSED' : 'REQUEST_ABORTED')), { once: true });
        timer = setTimeout(() => { reject(new OpenHABAdapterError('REQUEST_TIMEOUT')); abort.abort(); }, this.#config.timeoutMs);
      });
      const pending = Promise.resolve().then(() => {
        this.#check();
        // Official token contract: Basic username=API token, password empty.
        return (this.#requestFn ?? (input => this.#client.request(input)))({ method: 'GET', path: `/rest/items/${this.#config.itemName}`,
          headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(this.#config.token + ':', 'utf8').toString('base64')}` }, signal: abort.signal,
          beforeDispatch: () => { this.#check(); if (abort.signal.aborted) fail('REQUEST_ABORTED'); } });
      });
      const raw = await Promise.race([pending, boundary]); this.#check();
      const projected = projectOpenHABItem(raw, this.#config.itemName, this.#config.itemType);
      if (Date.now() < beganAt || Date.now() >= beganAt + TTL_MS) fail('STALE_STATE');
      const cell = value => ({ value, observedAt: new Date(beganAt).toISOString(), expiresAt: new Date(beganAt + TTL_MS).toISOString(), source: 'openhab-https', verification: 'hub-reported-selected-item' });
      this.#fields.available = cell(projected.available);
      if (projected.available) this.#fields[projected.field] = cell(projected.value);
      else if (this.#fields[projected.field]) this.#fields[projected.field].expiresAt = new Date(0).toISOString();
      this.#phase = 'online'; this.#publish();
    } finally { clearTimeout(timer); if (this.#active === abort) this.#active = undefined; }
  }
  snapshot(options = {}) {
    let refresh;
    try { ({ refresh = true } = data(options, ['refresh'], 'INVALID_ARGUMENTS')); if (typeof refresh !== 'boolean') fail('INVALID_ARGUMENTS'); }
    catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => {
      if (refresh) { try { await this.#read(); } catch (error) { if (!this.#closing) { this.#phase = 'offline'; this.#publish(); } throw error instanceof OpenHABAdapterError ? error : new OpenHABAdapterError(); } }
      return this.#snapshot();
    });
  }
  subscribe(listener) { this.#check(); if (typeof listener !== 'function') fail('INVALID_LISTENER'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  start(options = {}) {
    let pollMs;
    try { ({ pollMs = 5000 } = data(options, ['pollMs'], 'INVALID_POLL_INTERVAL')); this.#check(); if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) fail('INVALID_POLL_INTERVAL'); }
    catch (error) { return Promise.reject(error); }
    if (this.#started) return this.#startPromise; this.#started = true;
    const poll = async () => { try { await this.snapshot(); } catch {} if (this.#started && !this.#closing) { this.#timer = setTimeout(poll, Math.max(5000, pollMs)); this.#timer.unref?.(); } return this.#snapshot(); };
    this.#startPromise = poll(); return this.#startPromise;
  }
  async execute() { fail(this.#closing ? 'ADAPTER_CLOSED' : 'UNSUPPORTED_ACTION'); }
  close() {
    if (!this.#closePromise) {
      this.#closing = true; this.#started = false; clearTimeout(this.#timer); this.#active?.abort();
      this.#closePromise = (async () => { try { this.#client?.close(); await this.#tail; } finally { this.#listeners.clear(); } })();
    }
    return this.#closePromise;
  }
}
