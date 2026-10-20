import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { types } from 'node:util';
import { createPinnedJsonClient } from '../security/pinned-json-https.mjs';
import { validateShellyGen2Config, shellyGen2DataRecord } from './shelly-gen2-config.mjs';

const TTL_MS = 15000, NONCE_MS = 55 * 60000;
const AUTH_CODES = new Set(['ACCESS_DENIED', 'GRANT_EXPIRED', 'GRANT_REVOKED', 'HUB_CLOSING', 'DEADLINE_EXCEEDED']);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const hash = value => createHash('sha256').update(value).digest('hex');
export class ShellyGen2AdapterError extends Error {
  constructor(code = 'DEVICE_OPERATION_FAILED') { super('The selected Shelly switch operation could not complete.'); this.name = 'ShellyGen2AdapterError'; this.code = code; }
}
const fail = code => { throw new ShellyGen2AdapterError(code); };
function data(value, allowed, code = 'INVALID_DEVICE_RESPONSE') { try { return shellyGen2DataRecord(value, allowed); } catch { fail(code); } }
function safeAuthorization(error) { try { const code = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value; return AUTH_CODES.has(code) ? code : 'ACCESS_DENIED'; } catch { return 'ACCESS_DENIED'; } }
function strings(value, max = 16) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) fail('INVALID_DEVICE_RESPONSE');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields).filter(key => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable || typeof fields[key].value !== 'string' || fields[key].value.length > 64)) fail('INVALID_DEVICE_RESPONSE');
  return keys.map(key => fields[key].value);
}

/** Only the documented SHA-256/auth challenge is supported; no Basic/MD5 fallback. */
export function parseShellyDigestChallenge(value, expectedDeviceId) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value) || !/^Digest +/i.test(value)) fail('AUTHENTICATION_CHALLENGE_INVALID');
  const text = value.replace(/^Digest +/i, ''), fields = {};
  const part = /([A-Za-z][A-Za-z0-9_-]*) *= *(?:"([^"\\]*)"|([A-Za-z0-9._~+/=-]+)) *(?:, *|$)/gy;
  let offset = 0;
  while (offset < text.length) {
    part.lastIndex = offset; const match = part.exec(text);
    if (!match || match.index !== offset) fail('AUTHENTICATION_CHALLENGE_INVALID');
    const key = match[1].toLowerCase();
    if (!['realm', 'nonce', 'algorithm', 'qop', 'stale', 'opaque', 'charset'].includes(key) || Object.hasOwn(fields, key)) fail('AUTHENTICATION_CHALLENGE_INVALID');
    fields[key] = match[2] ?? match[3]; offset = part.lastIndex;
  }
  if (!text || text.endsWith(',') || fields.realm !== expectedDeviceId || fields.algorithm?.toUpperCase() !== 'SHA-256' || fields.qop !== 'auth' ||
      typeof fields.nonce !== 'string' || fields.nonce.length < 12 || fields.nonce.length > 512 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fields.nonce) ||
      (fields.stale !== undefined && !['true', 'false'].includes(fields.stale)) ||
      (fields.charset !== undefined && fields.charset.toUpperCase() !== 'UTF-8') ||
      (fields.opaque !== undefined && !/^[A-Za-z0-9._~+/=-]{1,256}$/.test(fields.opaque))) fail('AUTHENTICATION_CHALLENGE_INVALID');
  const decoded = Buffer.from(fields.nonce, 'base64');
  if (decoded.length < 8 || decoded.toString('base64') !== fields.nonce) fail('AUTHENTICATION_CHALLENGE_INVALID');
  return Object.freeze(fields);
}

export function projectShellySwitch(raw, componentId) {
  const status = data(raw);
  if (status.id !== componentId || typeof status.output !== 'boolean') fail('INVALID_DEVICE_RESPONSE');
  const result = { available: true, power: status.output, faulted: status.errors === undefined ? false : strings(status.errors).length > 0 };
  for (const [source, destination, min, max] of [['apower', 'powerWatts', -10000000, 10000000], ['voltage', 'voltageV', 0, 1000],
    ['current', 'currentAmps', 0, 1000], ['freq', 'frequencyHz', 0, 1000]]) {
    if (status[source] !== undefined) {
      if (typeof status[source] !== 'number' || !Number.isFinite(status[source]) || status[source] < min || status[source] > max) fail('INVALID_DEVICE_RESPONSE');
      result[destination] = status[source];
    }
  }
  if (status.aenergy !== undefined) {
    const energy = data(status.aenergy);
    if (typeof energy.total !== 'number' || !Number.isFinite(energy.total) || energy.total < 0 || energy.total > 1e15) fail('INVALID_DEVICE_RESPONSE');
    result.energyKwh = energy.total / 1000;
  }
  return freeze(result);
}

export class ShellyGen2Adapter {
  #config; #requestFn; #client; #listeners = new Set(); #tail = Promise.resolve(); #queued = 0;
  #closing = false; #closePromise; #started = false; #startPromise; #timer; #active;
  #fields = {}; #revision = 0; #phase = 'unknown'; #nonce; #authFailed = false; #sequence = 0; #identity;
  constructor(value = {}) {
    const options = data(value, ['deviceId', 'config', 'features', 'request'], 'INVALID_CONFIG');
    const { deviceId, config, features = [], request } = options;
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID');
    this.#config = validateShellyGen2Config(config);
    let selected;
    try { selected = strings(features, 1); } catch { fail('INVALID_FEATURES'); }
    if (selected.some(feature => feature !== 'control') || new Set(selected).size !== selected.length) fail('INVALID_FEATURES');
    if (request !== undefined && typeof request !== 'function') fail('INVALID_CONFIG');
    this.#requestFn = request;
    Object.defineProperties(this, { deviceId: { value: deviceId, enumerable: true }, adapterId: { value: 'shelly-gen2', enumerable: true },
      supportedActions: { value: Object.freeze(selected.includes('control') ? ['switch.power.set'] : []), enumerable: true } });
  }
  #check(context = {}) {
    if (this.#closing) fail('ADAPTER_CLOSED');
    if (context.signal !== undefined && Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(context.signal)) fail('ABORTED');
    if (context.deadlineAt !== undefined && (typeof context.deadlineAt !== 'string' || !Number.isFinite(Date.parse(context.deadlineAt)) || Date.parse(context.deadlineAt) <= Date.now())) fail('DEADLINE_EXCEEDED');
  }
  #snapshot() { return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields })); }
  #publish() { if (!this.#closing) { this.#revision++; const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.#snapshot() }); for (const listener of this.#listeners) { try { listener(event); } catch {} } } }
  #failure() { if (!this.#closing) { this.#phase = 'offline'; this.#publish(); } }
  #enqueue(task) {
    if (this.#closing) return Promise.reject(new ShellyGen2AdapterError('ADAPTER_CLOSED'));
    if (this.#queued >= 16) return Promise.reject(new ShellyGen2AdapterError('QUEUE_FULL'));
    this.#queued++; const operation = this.#tail.then(() => { this.#check(); return task(); });
    this.#tail = operation.catch(() => {}).finally(() => { this.#queued--; }); return operation;
  }
  #nonceFresh(nonce = this.#nonce) { return nonce && nonce === this.#nonce && Date.now() >= nonce.observedAt && Date.now() < nonce.observedAt + NONCE_MS && nonce.count < 29000; }
  #authorization() {
    if (!this.#nonceFresh()) return undefined;
    const nonce = this.#nonce, nc = (++nonce.count).toString(16).padStart(8, '0'), cnonce = randomBytes(16).toString('hex');
    const response = hash(`${hash(`admin:${nonce.realm}:${this.#config.password}`)}:${nonce.nonce}:${nc}:${cnonce}:auth:${hash('POST:/rpc')}`);
    return { nonce, header: `Digest username="admin", realm="${nonce.realm}", nonce="${nonce.nonce}", uri="/rpc", algorithm=SHA-256, response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}"${nonce.opaque ? `, opaque="${nonce.opaque}"` : ''}` };
  }
  async #http(body, context, auth, allowAuthChallenge, beforeDispatch) {
    this.#check(context);
    if (!this.#requestFn && !this.#client) this.#client = createPinnedJsonClient({ origin: this.#config.origin, certificate: this.#config.certificate,
      certificatePin: this.#config.certificatePin, timeoutMs: this.#config.timeoutMs, maxBytes: 65536, policy: 'shelly-gen2' });
    const abort = new AbortController(); this.#active = abort;
    const remaining = context.deadlineAt === undefined ? this.#config.timeoutMs : Math.min(this.#config.timeoutMs, Date.parse(context.deadlineAt) - Date.now());
    let timer, removeAbort = () => {};
    try {
      const boundary = new Promise((_, reject) => {
        const cancelled = () => reject(new ShellyGen2AdapterError(this.#closing ? 'ADAPTER_CLOSED' : 'ABORTED'));
        const external = () => abort.abort(); abort.signal.addEventListener('abort', cancelled, { once: true });
        if (context.signal) EventTarget.prototype.addEventListener.call(context.signal, 'abort', external, { once: true });
        removeAbort = () => { abort.signal.removeEventListener('abort', cancelled); if (context.signal) EventTarget.prototype.removeEventListener.call(context.signal, 'abort', external); };
        timer = setTimeout(() => { reject(new ShellyGen2AdapterError('REQUEST_TIMEOUT')); abort.abort(); }, Math.max(1, remaining));
      });
      const pending = Promise.resolve().then(() => {
        this.#check(context);
        return (this.#requestFn ?? (value => this.#client.request(value)))({ method: 'POST', path: '/rpc', headers: auth ? { Authorization: auth.header } : {}, body,
          ...(allowAuthChallenge ? { allowAuthChallenge: true } : {}), signal: abort.signal,
          deadlineAt: context.deadlineAt === undefined ? undefined : Date.parse(context.deadlineAt),
          beforeDispatch: () => { this.#check(context); if (abort.signal.aborted) fail('ABORTED'); beforeDispatch?.(); } });
      });
      const raw = await Promise.race([pending, boundary]); this.#check(context); return raw;
    } finally { clearTimeout(timer); removeAbort(); if (this.#active === abort) this.#active = undefined; }
  }
  async #rpc(method, params, context = {}, { authenticate = true, mutation = false, beforeDispatch } = {}) {
    if (this.#authFailed) fail('AUTHENTICATION_FAILED');
    const id = this.#sequence = (this.#sequence % 2147483647) + 1;
    const body = { id, method, ...(params === undefined ? {} : { params }) };
    let auth = authenticate ? this.#authorization() : undefined;
    if (mutation && !auth) fail('AUTHENTICATION_REQUIRED');
    const request = async (ticket, allowChallenge, gate) => {
      try { return await this.#http(body, context, ticket, allowChallenge, gate); }
      catch (error) {
        if (['INTEGRATION_ACCESS_DENIED', 'INTEGRATION_RATE_LIMITED'].includes(Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value)) {
          this.#authFailed = true; this.#nonce = undefined; fail('AUTHENTICATION_FAILED');
        }
        throw error;
      }
    };
    let raw = await request(auth, authenticate && !mutation, () => {
      if (mutation && (!this.#nonceFresh(auth?.nonce) || this.#nonce !== auth.nonce)) fail('AUTHENTICATION_STALE');
      beforeDispatch?.();
    });
    if (raw && typeof raw === 'object' && !types.isProxy(raw) && Object.getOwnPropertyDescriptor(raw, 'status')?.value === 401) {
      if (!authenticate || mutation) fail('AUTHENTICATION_FAILED');
      const challenge = data(raw, ['status', 'headers']), headers = data(challenge.headers, ['www-authenticate']);
      let parsed;
      try { parsed = parseShellyDigestChallenge(headers['www-authenticate'], this.#config.expectedDeviceId); }
      catch (error) { this.#authFailed = true; this.#nonce = undefined; throw error; }
      this.#nonce = { ...parsed, observedAt: Date.now(), count: 0 }; auth = this.#authorization();
      raw = await request(auth, true);
      if (raw && typeof raw === 'object' && !types.isProxy(raw) && Object.getOwnPropertyDescriptor(raw, 'status')?.value === 401) { this.#authFailed = true; this.#nonce = undefined; fail('AUTHENTICATION_FAILED'); }
    }
    const response = data(raw);
    if (response.id !== id || response.src !== this.#config.expectedDeviceId || Object.hasOwn(response, 'error') || !Object.hasOwn(response, 'result')) fail('INVALID_DEVICE_RESPONSE');
    return response.result;
  }
  async #read(context = {}) {
    const beganAt = Date.now(), identity = data(await this.#rpc('Shelly.GetDeviceInfo', undefined, context, { authenticate: false }));
    if (identity.id !== this.#config.expectedDeviceId || !Number.isInteger(identity.gen) || identity.gen < 2 || identity.gen > 4 ||
        typeof identity.ver !== 'string' || !/^(?:[2-9]|[1-9]\d)\.\d{1,3}\.\d{1,3}(?:[-+][A-Za-z0-9.-]{1,64})?$/.test(identity.ver) ||
        identity.auth_en !== true || (identity.auth_domain !== undefined && identity.auth_domain !== this.#config.expectedDeviceId) ||
        (identity.profile !== undefined && identity.profile !== 'switch')) fail('DEVICE_IDENTITY_MISMATCH');
    this.#identity = { observedAt: beganAt };
    const value = projectShellySwitch(await this.#rpc('Switch.GetStatus', { id: this.#config.componentId }, context), this.#config.componentId);
    if (Date.now() < beganAt || Date.now() >= beganAt + TTL_MS) fail('STALE_STATE');
    this.#check(context);
    this.#fields.switch = { value, observedAt: new Date(beganAt).toISOString(), expiresAt: new Date(beganAt + TTL_MS).toISOString(),
      source: 'shelly-gen2-https', verification: 'device-reported-selected-switch' };
    this.#phase = 'online'; this.#publish(); return value;
  }
  snapshot(options = {}) {
    let refresh;
    try { ({ refresh = true } = data(options, ['refresh'], 'INVALID_ARGUMENTS')); if (typeof refresh !== 'boolean') fail('INVALID_ARGUMENTS'); }
    catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => { if (refresh) { try { await this.#read(); } catch (error) { this.#failure(); throw error instanceof ShellyGen2AdapterError ? error : new ShellyGen2AdapterError('STATE_UNAVAILABLE'); } } return this.#snapshot(); });
  }
  subscribe(listener) { this.#check(); if (typeof listener !== 'function') fail('INVALID_LISTENER'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  start(options = {}) {
    let pollMs;
    try { ({ pollMs = 5000 } = data(options, ['pollMs'], 'INVALID_POLL_INTERVAL')); this.#check(); if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) fail('INVALID_POLL_INTERVAL'); }
    catch (error) { return Promise.reject(error); }
    if (this.#started) return this.#startPromise; this.#started = true;
    const poll = async () => {
      try { await this.snapshot(); } catch {}
      if (this.#started && !this.#closing && !this.#authFailed) { this.#timer = setTimeout(poll, Math.max(5000, pollMs)); this.#timer.unref?.(); }
      return this.#snapshot();
    };
    this.#startPromise = poll(); return this.#startPromise;
  }
  execute(command, context = {}) {
    let args;
    try {
      command = data(command, ['action', 'args'], 'INVALID_ARGUMENTS');
      if (command.action !== 'switch.power.set' || !this.supportedActions.includes(command.action)) fail('UNKNOWN_ACTION');
      args = data(command.args, ['on'], 'INVALID_ARGUMENTS'); if (typeof args.on !== 'boolean') fail('INVALID_ARGUMENTS');
      context = data(context, ['deadlineAt', 'assertDispatch', 'signal'], 'INVALID_CONTEXT');
      if (typeof context.assertDispatch !== 'function') fail('INVALID_CONTEXT');
      if (context.signal !== undefined) { if (types.isProxy(context.signal)) fail('INVALID_CONTEXT'); try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(context.signal); } catch { fail('INVALID_CONTEXT'); } }
    } catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => {
      let dispatched = false, accepted = false;
      try {
        this.#check(context); const initial = await this.#read(context), field = this.#fields.switch, identity = this.#identity;
        if (!initial.available || initial.faulted) fail('SWITCH_UNAVAILABLE');
        const result = data(await this.#rpc('Switch.Set', { id: this.#config.componentId, on: args.on }, context, { mutation: true, beforeDispatch: () => {
          this.#check(context); const now = Date.now();
          if (this.#fields.switch !== field || this.#identity !== identity || !Number.isFinite(Date.parse(field.observedAt)) || Date.parse(field.observedAt) > now ||
              Date.parse(field.expiresAt) <= now || now < identity.observedAt || now >= identity.observedAt + TTL_MS) fail('STALE_STATE');
          if (field.value.available !== true || field.value.faulted) fail('SWITCH_UNAVAILABLE');
          let authorization;
          try { authorization = context.assertDispatch(); } catch (error) { throw new ShellyGen2AdapterError(safeAuthorization(error)); }
          if (authorization !== undefined) {
            // Authorization must finish synchronously; never invoke a returned
            // thenable or trust an async decision before sending the mutation.
            if (types.isPromise(authorization)) Promise.prototype.then.call(authorization, () => {}, () => {});
            fail('INVALID_CONTEXT');
          }
          dispatched = true;
        } }));
        if (!dispatched) fail('REQUEST_PROTOCOL');
        if (typeof result.was_on !== 'boolean') fail('INVALID_DEVICE_RESPONSE'); accepted = true;
        const current = await this.#read(context);
        return freeze({ action: command.action, requestAccepted: true, confirmed: Date.parse(this.#fields.switch.expiresAt) > Date.now() && current.available && !current.faulted && current.power === args.on,
          uncertain: false, verificationScope: 'shelly_reported_selected_switch_output', physicalEffectVerified: false });
      } catch (error) {
        this.#failure();
        if (dispatched) return freeze({ action: command.action, requestAccepted: accepted ? true : null, confirmed: false, uncertain: true,
          verificationScope: 'shelly_reported_selected_switch_output', physicalEffectVerified: false, error: { code: 'DEVICE_OPERATION_FAILED' } });
        if (error instanceof ShellyGen2AdapterError) throw error;
        throw new ShellyGen2AdapterError();
      }
    });
  }
  close() {
    if (!this.#closePromise) {
      this.#closing = true; this.#started = false; clearTimeout(this.#timer); this.#active?.abort();
      this.#closePromise = (async () => { try { this.#client?.close(); await this.#tail; } finally { this.#listeners.clear(); } })();
    }
    return this.#closePromise;
  }
}
