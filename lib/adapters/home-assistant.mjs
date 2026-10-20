import { isIP } from 'node:net';
import { types } from 'node:util';
import { validateAction } from '../hub/policy.mjs';
import { createPinnedJsonClient } from '../security/pinned-json-https.mjs';
import { validateHomeAssistantConfig, homeAssistantDataRecord } from './home-assistant-config.mjs';

export const HOME_ASSISTANT_ACTIONS = Object.freeze(['light.power.set', 'light.brightness.set']);
const MODES = new Set(['onoff', 'brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white']);
const BRIGHTNESS_MODES = new Set(['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww']);
const COLOR_MODES = new Set(['hs', 'xy', 'rgb', 'rgbw', 'rgbww']);
const AUTHORIZATION_ERRORS = new Set(['ACCESS_DENIED', 'GRANT_EXPIRED', 'GRANT_REVOKED', 'HUB_CLOSING', 'DEADLINE_EXCEEDED']);
const TTL_MS = 15000;
const MAX_QUEUE = 16;
export class HomeAssistantAdapterError extends Error {
  constructor(code = 'DEVICE_OPERATION_FAILED') { super('The selected Home Assistant light operation could not be completed.'); this.name = 'HomeAssistantAdapterError'; this.code = code; }
}
const fail = code => { throw new HomeAssistantAdapterError(code); };
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function data(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('INVALID_DEVICE_RESPONSE');
  if (Reflect.ownKeys(value).length > 256) fail('INVALID_DEVICE_RESPONSE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(item => !Object.hasOwn(item, 'value') || !item.enumerable)) fail('INVALID_DEVICE_RESPONSE');
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}
function safeCode(error) {
  try { const value = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value; return AUTHORIZATION_ERRORS.has(value) ? value : 'DEVICE_OPERATION_FAILED'; }
  catch { return 'DEVICE_OPERATION_FAILED'; }
}

// Only selected-entity state can enter an event/result. Entity IDs, friendly
// names, attributes, HA context/user IDs and raw timestamps never leave here.
export function projectHomeAssistantLight(raw, entityId) {
  const state = data(raw);
  if (state.entity_id !== entityId || !['on', 'off', 'unavailable', 'unknown'].includes(state.state)) fail('INVALID_DEVICE_RESPONSE');
  const attributes = data(state.attributes);
  const modes = attributes.supported_color_modes;
  let supportsBrightness = false;
  if (modes !== undefined) {
    if (!Array.isArray(modes) || types.isProxy(modes) || Object.getPrototypeOf(modes) !== Array.prototype || modes.length > 16 || Object.getOwnPropertySymbols(modes).length) fail('INVALID_DEVICE_RESPONSE');
    const descriptors = Object.getOwnPropertyDescriptors(modes);
    const keys = Object.keys(descriptors).filter(key => key !== 'length');
    if (keys.length !== modes.length || keys.some((key, index) => key !== String(index) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable || !MODES.has(descriptors[key].value))) fail('INVALID_DEVICE_RESPONSE');
    const selected = keys.map(key => descriptors[key].value);
    if (new Set(selected).size !== selected.length || ((selected.includes('onoff') || selected.includes('brightness')) && selected.length !== 1) ||
        (selected.includes('white') && !selected.some(mode => COLOR_MODES.has(mode)))) fail('INVALID_DEVICE_RESPONSE');
    supportsBrightness = selected.some(mode => BRIGHTNESS_MODES.has(mode));
  }
  const brightness = attributes.brightness;
  return freeze({ available: state.state === 'on' || state.state === 'off',
    power: state.state === 'on' ? true : state.state === 'off' ? false : null,
    brightness: state.state === 'off' ? 0 : Number.isInteger(brightness) && brightness >= 0 && brightness <= 255 ? Math.round(brightness * 100 / 255) : null,
    supportsBrightness });
}

export class HomeAssistantAdapter {
  #config; #injectedRequest; #client; #listeners = new Set(); #tail = Promise.resolve();
  #queued = 0; #closing = false; #started = false; #startPromise; #timer; #active;
  #fields = {}; #phase = 'unknown'; #revision = 0; #closePromise;
  constructor(options = {}) {
    let checked;
    try { checked = homeAssistantDataRecord(options, ['deviceId', 'config', 'features', 'request']); }
    catch { fail('INVALID_CONFIG'); }
    const { deviceId, config, features = [], request } = checked;
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID');
    this.#config = validateHomeAssistantConfig(config);
    if (!Array.isArray(features) || types.isProxy(features) || Object.getPrototypeOf(features) !== Array.prototype || features.length > 2 || Object.getOwnPropertySymbols(features).length) fail('INVALID_FEATURES');
    const descriptors = Object.getOwnPropertyDescriptors(features), keys = Object.keys(descriptors).filter(key => key !== 'length');
    if (keys.length !== features.length || keys.some((key, index) => key !== String(index) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable || !['control', 'dimming'].includes(descriptors[key].value))) fail('INVALID_FEATURES');
    const selected = keys.map(key => descriptors[key].value);
    if (new Set(selected).size !== selected.length || (selected.includes('dimming') && !selected.includes('control'))) fail('INVALID_FEATURES');
    if (request !== undefined && typeof request !== 'function') fail('INVALID_CONFIG');
    this.#injectedRequest = request;
    const supportedActions = Object.freeze(selected.includes('control') ? selected.includes('dimming') ? [...HOME_ASSISTANT_ACTIONS] : ['light.power.set'] : []);
    Object.defineProperties(this, { deviceId: { value: deviceId, enumerable: true },
      adapterId: { value: 'home-assistant', enumerable: true }, supportedActions: { value: supportedActions, enumerable: true } });
  }
  #check(context = {}) {
    if (this.#closing) fail('ADAPTER_CLOSED');
    if (context.signal?.aborted) fail('ABORTED');
    if (context.deadlineAt !== undefined && (typeof context.deadlineAt !== 'string' || !Number.isFinite(Date.parse(context.deadlineAt)) || Date.parse(context.deadlineAt) <= Date.now())) fail('DEADLINE_EXCEEDED');
  }
  #snapshot() { return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields })); }
  #publish() {
    if (this.#closing) return;
    this.#revision += 1;
    const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.#snapshot() });
    for (const listener of this.#listeners) { try { listener(event); } catch {} }
  }
  #record(light, beganAt) {
    this.#check();
    this.#fields.light = { value: light, observedAt: new Date(beganAt).toISOString(), expiresAt: new Date(beganAt + TTL_MS).toISOString(), source: 'home-assistant-https', verification: 'hub-reported-selected-entity' };
    this.#phase = 'online'; this.#publish(); return light;
  }
  #failure() { if (!this.#closing) { this.#phase = 'offline'; this.#publish(); } }
  #enqueue(task) {
    if (this.#closing) return Promise.reject(new HomeAssistantAdapterError('ADAPTER_CLOSED'));
    if (this.#queued >= MAX_QUEUE) return Promise.reject(new HomeAssistantAdapterError('QUEUE_FULL'));
    this.#queued += 1;
    const operation = this.#tail.then(() => { this.#check(); return task(); });
    this.#tail = operation.catch(() => {}).finally(() => { this.#queued -= 1; });
    return operation;
  }
  async #request(method, route, context = {}, body, beforeDispatch) {
    this.#check(context);
    if (!this.#injectedRequest && !this.#client) this.#client = createPinnedJsonClient({ origin: this.#config.origin,
      certificate: this.#config.certificate, certificatePin: this.#config.certificatePin, timeoutMs: this.#config.timeoutMs, maxBytes: 65536 });
    const request = this.#injectedRequest ?? (options => this.#client.request(options));
    const abort = new AbortController(); this.#active = abort;
    const remaining = context.deadlineAt === undefined ? this.#config.timeoutMs : Math.min(this.#config.timeoutMs, Date.parse(context.deadlineAt) - Date.now());
    let timer, removeAbort = () => {};
    try {
      const boundary = new Promise((_, reject) => {
        const cancelled = () => reject(new HomeAssistantAdapterError(this.#closing ? 'ADAPTER_CLOSED' : 'ABORTED'));
        abort.signal.addEventListener('abort', cancelled, { once: true });
        const externalAbort = () => abort.abort();
        context.signal?.addEventListener('abort', externalAbort, { once: true });
        removeAbort = () => { abort.signal.removeEventListener('abort', cancelled); context.signal?.removeEventListener('abort', externalAbort); };
        timer = setTimeout(() => { reject(new HomeAssistantAdapterError('REQUEST_TIMEOUT')); abort.abort(); }, Math.max(1, remaining));
      });
      const pending = Promise.resolve().then(() => { this.#check(context); return request({ method, path: route,
        headers: { Authorization: `Bearer ${this.#config.token}` }, ...(body === undefined ? {} : { body }),
        deadlineAt: context.deadlineAt === undefined ? undefined : Date.parse(context.deadlineAt), signal: abort.signal,
        beforeDispatch: () => { this.#check(context); if (abort.signal.aborted) fail('ABORTED'); beforeDispatch?.(); } }); });
      const result = await Promise.race([pending, boundary]);
      this.#check(context); return result;
    } finally { clearTimeout(timer); removeAbort(); if (this.#active === abort) this.#active = undefined; }
  }
  async #read(context = {}) {
    const beganAt = Date.now();
    const raw = await this.#request('GET', `/api/states/${this.#config.entityId}`, context);
    return this.#record(projectHomeAssistantLight(raw, this.#config.entityId), beganAt);
  }
  snapshot({ refresh = true } = {}) {
    return this.#enqueue(async () => { if (refresh) { try { await this.#read(); } catch { this.#failure(); throw new HomeAssistantAdapterError('STATE_UNAVAILABLE'); } } return this.#snapshot(); });
  }
  subscribe(listener) {
    if (typeof listener !== 'function') fail('INVALID_LISTENER'); this.#check(); this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async start({ pollMs = 5000 } = {}) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60000) fail('INVALID_POLL_INTERVAL');
    this.#check(); if (this.#started) return this.#startPromise;
    this.#started = true;
    const poll = async () => {
      try { await this.snapshot(); } catch {}
      if (this.#started && !this.#closing) { this.#timer = setTimeout(poll, Math.max(5000, pollMs)); this.#timer.unref?.(); }
      return this.#snapshot();
    };
    this.#startPromise = poll(); return this.#startPromise;
  }
  execute(command = {}, context = {}) {
    let action, args;
    try {
      let checked;
      try { checked = homeAssistantDataRecord(command, ['action', 'args']); }
      catch { fail('INVALID_ARGUMENTS'); }
      action = checked.action;
      if (!this.supportedActions.includes(action)) fail('UNKNOWN_ACTION');
      args = validateAction(action, checked.args ?? {});
      try { context = homeAssistantDataRecord(context, ['deadlineAt', 'assertDispatch', 'signal']); }
      catch { fail('INVALID_CONTEXT'); }
      if (typeof context.assertDispatch !== 'function') fail('INVALID_CONTEXT');
      if (context.signal !== undefined && (types.isProxy(context.signal) || !(context.signal instanceof AbortSignal))) fail('INVALID_CONTEXT');
    } catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => {
      let dispatched = false, accepted = false;
      try {
        this.#check(context);
        const initial = await this.#read(context);
        if (!initial.available) fail('ENTITY_UNAVAILABLE');
        if (Date.parse(this.#fields.light.expiresAt) <= Date.now()) fail('STALE_STATE');
        if (action === 'light.brightness.set' && !initial.supportsBrightness) fail('BRIGHTNESS_UNSUPPORTED');
        const preflightField = this.#fields.light;
        const on = action === 'light.power.set' ? args.on : args.brightness > 0;
        const body = { entity_id: this.#config.entityId,
          ...(action === 'light.brightness.set' && on ? { brightness_pct: args.brightness } : {}) };
        await this.#request('POST', `/api/services/light/${on ? 'turn_on' : 'turn_off'}`, context, body, () => {
          this.#check(context);
          // TLS preparation can outlive the state observation. Recheck the
          // exact selected-entity preflight only at the last synchronous gate,
          // before authorizing or marking a possibly sent device effect.
          const current = this.#fields.light, now = Date.now();
          if (current !== preflightField || !Number.isFinite(Date.parse(current?.observedAt)) ||
              Date.parse(current.observedAt) > now || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= now) fail('STALE_STATE');
          if (current.value.available !== true) fail('ENTITY_UNAVAILABLE');
          if (action === 'light.brightness.set' && current.value.supportsBrightness !== true) fail('BRIGHTNESS_UNSUPPORTED');
          try { context.assertDispatch(); } catch (error) { throw new HomeAssistantAdapterError(safeCode(error)); }
          dispatched = true;
        });
        if (!dispatched) fail('REQUEST_PROTOCOL');
        accepted = true;
        const current = await this.#read(context);
        const confirmed = Date.parse(this.#fields.light.expiresAt) > Date.now() && current.available && current.power === on &&
          (action !== 'light.brightness.set' || !on || current.brightness === args.brightness);
        return freeze({ action, requestAccepted: true, confirmed, uncertain: false,
          verificationScope: 'home_assistant_reported_selected_entity_state', physicalEffectVerified: false });
      } catch (error) {
        this.#failure();
        if (dispatched) return freeze({ action, requestAccepted: accepted ? true : null, confirmed: false, uncertain: true,
          verificationScope: 'home_assistant_reported_selected_entity_state', physicalEffectVerified: false, error: { code: 'DEVICE_OPERATION_FAILED' } });
        if (error instanceof HomeAssistantAdapterError) throw error;
        throw new HomeAssistantAdapterError('DEVICE_OPERATION_FAILED');
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
