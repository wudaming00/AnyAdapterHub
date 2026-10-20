import { isIP } from 'node:net';
import { types } from 'node:util';
import { createPinnedJsonClient } from '../security/pinned-json-https.mjs';
import { validatePlexConfig, plexDataRecord } from './plex-config.mjs';

const TTL_MS = 30000, MAX_QUEUE = 16;
export class PlexAdapterError extends Error {
  constructor(code = 'STATE_UNAVAILABLE') { super('The selected Plex server identity could not be read.'); this.name = 'PlexAdapterError'; this.code = code; }
}
const fail = code => { throw new PlexAdapterError(code); };
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function data(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('INVALID_DEVICE_RESPONSE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 128 || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value') || !item.enumerable)) fail('INVALID_DEVICE_RESPONSE');
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}

export function projectPlexIdentity(raw, machineIdentifier) {
  const envelope = data(raw), identity = data(envelope.MediaContainer);
  if (identity.machineIdentifier !== machineIdentifier || identity.size !== 1 || typeof identity.claimed !== 'boolean') fail('INVALID_DEVICE_RESPONSE');
  const version = typeof identity.version === 'string' && /^\d{1,4}(?:\.\d{1,8}){3}(?:-[A-Za-z0-9]{1,64})?$/.test(identity.version) ? identity.version : null;
  return freeze({ available: true, claimed: identity.claimed, version });
}

export class PlexAdapter {
  #config; #injectedRequest; #client; #listeners = new Set(); #tail = Promise.resolve();
  #queued = 0; #closing = false; #started = false; #startPromise; #timer; #active;
  #fields = {}; #phase = 'unknown'; #revision = 0; #closePromise;
  constructor(options = {}) {
    let checked;
    try { checked = plexDataRecord(options, ['deviceId', 'config', 'features', 'request']); }
    catch { fail('INVALID_CONFIG'); }
    const { deviceId, config, features = [], request } = checked;
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID');
    if (!Array.isArray(features) || types.isProxy(features) || Object.getPrototypeOf(features) !== Array.prototype ||
        Object.getOwnPropertySymbols(features).length || Object.keys(Object.getOwnPropertyDescriptors(features)).join() !== 'length' || features.length !== 0) fail('INVALID_FEATURES');
    this.#config = validatePlexConfig(config);
    if (request !== undefined && typeof request !== 'function') fail('INVALID_CONFIG');
    this.#injectedRequest = request;
    Object.defineProperties(this, { deviceId: { value: deviceId, enumerable: true }, adapterId: { value: 'plex', enumerable: true },
      supportedActions: { value: Object.freeze([]), enumerable: true } });
  }
  #check() { if (this.#closing) fail('ADAPTER_CLOSED'); }
  #snapshot() { return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields })); }
  #publish() {
    if (this.#closing) return;
    this.#revision += 1;
    const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.#snapshot() });
    for (const listener of this.#listeners) { try { listener(event); } catch {} }
  }
  #enqueue(task) {
    if (this.#closing) return Promise.reject(new PlexAdapterError('ADAPTER_CLOSED'));
    if (this.#queued >= MAX_QUEUE) return Promise.reject(new PlexAdapterError('QUEUE_FULL'));
    this.#queued += 1;
    const operation = this.#tail.then(() => { this.#check(); return task(); });
    this.#tail = operation.catch(() => {}).finally(() => { this.#queued -= 1; });
    return operation;
  }
  async #read() {
    this.#check();
    if (!this.#injectedRequest && !this.#client) this.#client = createPinnedJsonClient({ policy: 'plex', origin: this.#config.origin,
      certificate: this.#config.certificate, certificatePin: this.#config.certificatePin, timeoutMs: this.#config.timeoutMs, maxBytes: 16384 });
    const request = this.#injectedRequest ?? (options => this.#client.request(options));
    const abort = new AbortController(); this.#active = abort; const beganAt = Date.now();
    let timer, onAbort;
    try {
      const boundary = new Promise((_, reject) => {
        onAbort = () => reject(new PlexAdapterError(this.#closing ? 'ADAPTER_CLOSED' : 'REQUEST_TIMEOUT'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => abort.abort(), this.#config.timeoutMs);
      });
      const pending = Promise.resolve().then(() => {
        this.#check();
        return request({ method: 'GET', path: '/identity', headers: { Accept: 'application/json' }, signal: abort.signal,
          beforeDispatch: () => { this.#check(); if (abort.signal.aborted) fail('REQUEST_TIMEOUT'); } });
      });
      const raw = await Promise.race([pending, boundary]); this.#check();
      const identity = projectPlexIdentity(raw, this.#config.machineIdentifier);
      this.#fields.server = { value: identity, observedAt: new Date(beganAt).toISOString(), expiresAt: new Date(beganAt + TTL_MS).toISOString(),
        source: 'plex-https', verification: 'server-reported-selected-identity' };
      this.#phase = 'online'; this.#publish();
    } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort); if (this.#active === abort) this.#active = undefined; }
  }
  snapshot(options = {}) {
    let refresh;
    try { const checked = plexDataRecord(options, ['refresh']); refresh = checked.refresh ?? true; if (typeof refresh !== 'boolean') fail('INVALID_ARGUMENTS'); }
    catch { return Promise.reject(new PlexAdapterError('INVALID_ARGUMENTS')); }
    return this.#enqueue(async () => {
      if (refresh) {
        try { await this.#read(); }
        catch {
          if (this.#closing) throw new PlexAdapterError('ADAPTER_CLOSED');
          this.#phase = 'offline'; this.#publish(); throw new PlexAdapterError('STATE_UNAVAILABLE');
        }
      }
      return this.#snapshot();
    });
  }
  subscribe(listener) { if (typeof listener !== 'function') fail('INVALID_LISTENER'); this.#check(); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async start(options = {}) {
    let pollMs;
    try { const checked = plexDataRecord(options, ['pollMs']); pollMs = checked.pollMs ?? 10000; }
    catch { fail('INVALID_POLL_INTERVAL'); }
    if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60000) fail('INVALID_POLL_INTERVAL');
    this.#check(); if (this.#started) return this.#startPromise; this.#started = true;
    const poll = async () => {
      try { await this.snapshot(); } catch {}
      if (this.#started && !this.#closing) { this.#timer = setTimeout(poll, Math.max(10000, pollMs)); this.#timer.unref?.(); }
      return this.#snapshot();
    };
    this.#startPromise = poll(); return this.#startPromise;
  }
  execute() { return Promise.reject(new PlexAdapterError('UNKNOWN_ACTION')); }
  close() {
    if (!this.#closePromise) {
      this.#closing = true; this.#started = false; clearTimeout(this.#timer); this.#active?.abort();
      this.#closePromise = (async () => { try { this.#client?.close(); await this.#tail; } finally { this.#listeners.clear(); } })();
    }
    return this.#closePromise;
  }
}
