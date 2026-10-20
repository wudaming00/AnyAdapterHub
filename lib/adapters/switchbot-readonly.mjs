import { types } from 'node:util';
import { isIP } from 'node:net';

export class CloudSensorError extends Error {
  constructor(code = 'STATE_UNAVAILABLE') { super('The selected cloud sensor could not be read.'); this.name = 'CloudSensorError'; this.code = code; }
}
export const cloudFail = code => { throw new CloudSensorError(code); };
export function cloudRecord(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) cloudFail('INVALID_DATA');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(descriptors);
  if (keys.length > 256 || keys.some(key => (allowed && !allowed.includes(key)) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable || ['__proto__', 'prototype', 'constructor'].includes(key))) cloudFail('INVALID_DATA');
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
export const cloudFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(cloudFreeze); Object.freeze(value); } return value; };
export function cloudNumber(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) cloudFail('INVALID_DEVICE_RESPONSE');
  return value;
}
export function cloudString(value, maximum = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || !/^[\x21-\x7e]+$/.test(value)) cloudFail('INVALID_CONFIG');
  return value;
}
export const CLOUD_REFRESH_MS = 300000;
export const CLOUD_SAMPLE_MAX_MS = 600000;

// This lifecycle is trusted reviewed source, not an executable profile/plugin.
// Vendor adapters provide fixed request plans and finite projections below it.
export class ReviewedCloudSensor {
  #vendor; #timeout; #request; #read; #sampleTime; #client; #fields = {}; #phase = 'unknown'; #revision = 0;
  #listeners = new Set(); #tail = Promise.resolve(); #queued = 0; #closed = false; #closePromise;
  #lastAttempt = -Infinity; #active; #started = false; #startPromise; #timer;
  constructor({ deviceId, adapterId, vendor, timeoutMs, request, read, sampleTime }) {
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId) || isIP(deviceId) || (request !== undefined && typeof request !== 'function')) cloudFail('INVALID_CONFIG');
    if (sampleTime !== undefined && typeof sampleTime !== 'function') cloudFail('INVALID_CONFIG');
    this.#vendor = vendor; this.#timeout = timeoutMs; this.#request = request; this.#read = read; this.#sampleTime = sampleTime;
    Object.defineProperties(this, { deviceId: { value: deviceId, enumerable: true }, adapterId: { value: adapterId, enumerable: true }, supportedActions: { value: Object.freeze([]), enumerable: true } });
  }
  #check() { if (this.#closed) cloudFail('ADAPTER_CLOSED'); }
  #snapshot() { return cloudFreeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields })); }
  #publish() {
    if (this.#closed) return;
    this.#revision++; const event = cloudFreeze({ type: 'device.state', deviceId: this.deviceId, data: this.#snapshot() });
    for (const listener of this.#listeners) { try { listener(event); } catch {} }
  }
  async #fetch(options) {
    this.#check();
    if (!this.#request && !this.#client) {
      const { createVendorJsonClient } = await import('../security/vendor-json-https.mjs');
      this.#check(); this.#client = createVendorJsonClient(this.#vendor, { timeoutMs: this.#timeout, maxBytes: 65536 });
    }
    this.#check(); const abort = new AbortController(); this.#active = abort;
    let timer, cancelled;
    try {
      const boundary = new Promise((_, reject) => {
        cancelled = () => reject(new CloudSensorError(this.#closed ? 'ADAPTER_CLOSED' : 'REQUEST_ABORTED'));
        abort.signal.addEventListener('abort', cancelled, { once: true });
        timer = setTimeout(() => { reject(new CloudSensorError('REQUEST_TIMEOUT')); abort.abort(); }, this.#timeout);
      });
      const pending = Promise.resolve().then(() => {
        this.#check();
        return (this.#request ?? (value => this.#client.request(value)))({ ...options, method: 'GET', signal: abort.signal,
          beforeDispatch: () => { this.#check(); if (abort.signal.aborted) cloudFail('REQUEST_ABORTED'); } });
      });
      const response = await Promise.race([pending, boundary]); this.#check(); return response;
    } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); if (this.#active === abort) this.#active = undefined; }
  }
  snapshot(input = {}) {
    let refresh;
    try { ({ refresh = true } = cloudRecord(input, ['refresh'])); if (typeof refresh !== 'boolean') cloudFail('INVALID_ARGUMENTS'); this.#check(); }
    catch (error) { return Promise.reject(error); }
    if (this.#queued >= 16) return Promise.reject(new CloudSensorError('QUEUE_FULL'));
    this.#queued++;
    const operation = this.#tail.then(async () => {
      this.#check(); const beganAt = Date.now();
      if (refresh && (this.#lastAttempt === -Infinity || beganAt - this.#lastAttempt >= CLOUD_REFRESH_MS)) {
        this.#lastAttempt = beganAt;
        try {
          const values = await this.#read(options => this.#fetch(options)); this.#check();
          const reportedAt = this.#sampleTime?.();
          if (reportedAt !== undefined && (!Number.isSafeInteger(reportedAt) || reportedAt <= 0 || reportedAt > Date.now() || Date.now() - reportedAt >= CLOUD_SAMPLE_MAX_MS)) cloudFail('INVALID_DEVICE_RESPONSE');
          if (this.#sampleTime && reportedAt === undefined) cloudFail('INVALID_DEVICE_RESPONSE');
          const observedAt = reportedAt ?? beganAt, expiresAt = reportedAt === undefined ? beganAt + CLOUD_REFRESH_MS : Math.min(beganAt + CLOUD_REFRESH_MS, reportedAt + CLOUD_SAMPLE_MAX_MS);
          this.#fields = { environment: { value: values, observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), source: this.#vendor, verification: 'cloud-reported-selected-device' } };
          this.#phase = 'online'; this.#publish();
        } catch {
          if (!this.#closed) { this.#phase = 'offline'; for (const field of Object.values(this.#fields)) field.expiresAt = new Date(0).toISOString(); this.#publish(); }
          throw new CloudSensorError(this.#closed ? 'ADAPTER_CLOSED' : 'STATE_UNAVAILABLE');
        }
      }
      return this.#snapshot();
    });
    this.#tail = operation.catch(() => {}).finally(() => { this.#queued--; }); return operation;
  }
  subscribe(listener) {
    this.#check(); if (typeof listener !== 'function') cloudFail('INVALID_LISTENER'); this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }
  start(input = {}) {
    let pollMs;
    try { ({ pollMs = CLOUD_REFRESH_MS } = cloudRecord(input, ['pollMs'])); this.#check(); if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 3600000) cloudFail('INVALID_POLL_INTERVAL'); }
    catch (error) { return Promise.reject(error); }
    if (this.#started) return this.#startPromise; this.#started = true;
    const poll = async () => { try { await this.snapshot(); } catch {} if (!this.#closed) { this.#timer = setTimeout(poll, Math.max(CLOUD_REFRESH_MS, pollMs)); this.#timer.unref?.(); } return this.#snapshot(); };
    this.#startPromise = poll(); return this.#startPromise;
  }
  async execute() { cloudFail(this.#closed ? 'ADAPTER_CLOSED' : 'UNSUPPORTED_ACTION'); }
  close() {
    if (!this.#closePromise) {
      this.#closed = true; clearTimeout(this.#timer); this.#active?.abort(); this.#client?.close(); this.#listeners.clear();
      this.#closePromise = this.#tail.then(() => { for (const field of Object.values(this.#fields)) field.expiresAt = new Date(0).toISOString(); this.#phase = 'closed'; });
    }
    return this.#closePromise;
  }
}
