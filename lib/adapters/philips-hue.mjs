import { isIP } from 'node:net';
import { types } from 'node:util';
import { validateAction } from '../hub/policy.mjs';
import { createPinnedJsonClient } from '../security/pinned-json-https.mjs';
import { validatePhilipsHueConfig, philipsHueDataRecord } from './philips-hue-config.mjs';

export const PHILIPS_HUE_ACTIONS = Object.freeze(['light.power.set', 'light.brightness.set']);
const TTL_MS = 15000, MAX_QUEUE = 16;
const AUTHORIZATION_ERRORS = new Set(['ACCESS_DENIED', 'GRANT_EXPIRED', 'GRANT_REVOKED', 'HUB_CLOSING', 'DEADLINE_EXCEEDED']);
// A Hue `light` service may also represent a plug. Only explicit known lighting
// archetypes authorize these setters; absent, unknown and plug types stay read-only.
const LIGHTING_ARCHETYPES = new Set(['classic_bulb', 'sultan_bulb', 'flood_bulb', 'spot_bulb', 'candle_bulb', 'luster_bulb',
  'pendant_round', 'pendant_long', 'ceiling_round', 'ceiling_square', 'floor_shade', 'floor_lantern', 'table_shade',
  'recessed_ceiling', 'recessed_floor', 'single_spot', 'double_spot', 'table_wash', 'wall_lantern', 'wall_shade',
  'flexible_lamp', 'ground_spot', 'wall_spot', 'hue_go', 'hue_lightstrip', 'hue_iris', 'hue_bloom', 'bollard',
  'wall_washer', 'hue_play', 'vintage_bulb', 'vintage_candle_bulb', 'ellipse_bulb', 'triangle_bulb', 'small_globe_bulb',
  'large_globe_bulb', 'edison_bulb', 'christmas_tree', 'string_light', 'hue_centris', 'hue_lightstrip_tv',
  'hue_lightstrip_pc', 'hue_tube', 'hue_signe', 'pendant_spot', 'ceiling_horizontal', 'ceiling_tube']);
export class PhilipsHueAdapterError extends Error {
  constructor(code = 'DEVICE_OPERATION_FAILED') {
    super('The selected Philips Hue light operation could not be completed.');
    this.name = 'PhilipsHueAdapterError'; this.code = code;
  }
}
const fail = code => { throw new PhilipsHueAdapterError(code); };
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function data(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('INVALID_DEVICE_RESPONSE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 256 || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value') || !item.enumerable)) fail('INVALID_DEVICE_RESPONSE');
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}
function array(value, max) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail('INVALID_DEVICE_RESPONSE');
  const descriptors = Object.getOwnPropertyDescriptors(value), length = descriptors.length.value;
  if (length > max) fail('INVALID_DEVICE_RESPONSE');
  const keys = Object.keys(descriptors).filter(key => key !== 'length');
  if (keys.length !== length || keys.some((key, index) => key !== String(index) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail('INVALID_DEVICE_RESPONSE');
  return keys.map(key => descriptors[key].value);
}
function selectedEnvelope(raw) {
  const envelope = data(raw), errors = array(envelope.errors, 64), resources = array(envelope.data, 1);
  if (errors.length) fail('HUE_RESPONSE_REJECTED');
  if (resources.length !== 1) fail('INVALID_DEVICE_RESPONSE');
  return data(resources[0]);
}
function safeCode(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return 'DEVICE_OPERATION_FAILED';
  try { const code = Object.getOwnPropertyDescriptor(error, 'code')?.value; return AUTHORIZATION_ERRORS.has(code) ? code : 'DEVICE_OPERATION_FAILED'; }
  catch { return 'DEVICE_OPERATION_FAILED'; }
}
function signalAborted(signal) {
  if (signal === undefined) return false;
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)) fail('INVALID_CONTEXT');
  try { return Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal); }
  catch { fail('INVALID_CONTEXT'); }
}

// Freshness describes this bridge response, never physical sampling/reachability.
// No names, owner/device UUIDs, resource paths or vendor metadata leave projection.
export function projectPhilipsHueLight(raw, lightId) {
  const resource = selectedEnvelope(raw);
  if (resource.id !== lightId || resource.type !== 'light') fail('INVALID_DEVICE_RESPONSE');
  const on = data(resource.on);
  if (typeof on.on !== 'boolean') fail('INVALID_DEVICE_RESPONSE');
  const metadata = resource.metadata === undefined ? {} : data(resource.metadata);
  let brightness = null, minimumBrightness = null, supportsBrightness = false;
  if (resource.dimming !== undefined) {
    const dimming = data(resource.dimming);
    if (typeof dimming.brightness !== 'number' || !Number.isFinite(dimming.brightness) || dimming.brightness < 0 || dimming.brightness > 100) fail('INVALID_DEVICE_RESPONSE');
    brightness = dimming.brightness;
    if (dimming.min_dim_level !== undefined) {
      if (typeof dimming.min_dim_level !== 'number' || !Number.isFinite(dimming.min_dim_level) || dimming.min_dim_level < 0 || dimming.min_dim_level > 100) fail('INVALID_DEVICE_RESPONSE');
      minimumBrightness = dimming.min_dim_level; supportsBrightness = true;
    }
  }
  return freeze({ available: true, power: on.on, brightness, supportsBrightness, minimumBrightness,
    controlAvailable: LIGHTING_ARCHETYPES.has(metadata.archetype) && resource.mode === 'normal' });
}
function acceptPhilipsHueWrite(raw, lightId) {
  const selected = selectedEnvelope(raw);
  if (selected.rid !== lightId || selected.rtype !== 'light') fail('INVALID_DEVICE_RESPONSE');
}

export class PhilipsHueAdapter {
  #config; #injectedRequest; #client; #listeners = new Set(); #tail = Promise.resolve();
  #queued = 0; #closing = false; #started = false; #startPromise; #timer; #active;
  #fields = {}; #phase = 'unknown'; #revision = 0; #closePromise;
  constructor(options = {}) {
    let checked;
    try { checked = philipsHueDataRecord(options, ['deviceId', 'config', 'features', 'request']); }
    catch { fail('INVALID_CONFIG'); }
    const { deviceId, config, features = [], request } = checked;
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID');
    this.#config = validatePhilipsHueConfig(config);
    let selected;
    try { selected = array(features, 2); } catch { fail('INVALID_FEATURES'); }
    if (selected.some(feature => !['control', 'dimming'].includes(feature)) || new Set(selected).size !== selected.length || (selected.includes('dimming') && !selected.includes('control'))) fail('INVALID_FEATURES');
    if (request !== undefined && typeof request !== 'function') fail('INVALID_CONFIG');
    this.#injectedRequest = request;
    const supportedActions = Object.freeze(selected.includes('control') ? selected.includes('dimming') ? [...PHILIPS_HUE_ACTIONS] : ['light.power.set'] : []);
    Object.defineProperties(this, { deviceId: { value: deviceId, enumerable: true },
      adapterId: { value: 'philips-hue', enumerable: true }, supportedActions: { value: supportedActions, enumerable: true } });
  }
  #check(context = {}) {
    if (this.#closing) fail('ADAPTER_CLOSED');
    if (signalAborted(context.signal)) fail('ABORTED');
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
    this.#fields.light = { value: light, observedAt: new Date(beganAt).toISOString(), expiresAt: new Date(beganAt + TTL_MS).toISOString(), source: 'philips-hue-https', verification: 'bridge-reported-selected-resource' };
    this.#phase = 'online'; this.#publish(); return light;
  }
  #failure() { if (!this.#closing) { this.#phase = 'offline'; this.#publish(); } }
  #enqueue(task) {
    if (this.#closing) return Promise.reject(new PhilipsHueAdapterError('ADAPTER_CLOSED'));
    if (this.#queued >= MAX_QUEUE) return Promise.reject(new PhilipsHueAdapterError('QUEUE_FULL'));
    this.#queued += 1;
    const operation = this.#tail.then(() => { this.#check(); return task(); });
    this.#tail = operation.catch(() => {}).finally(() => { this.#queued -= 1; });
    return operation;
  }
  async #request(method, context = {}, body, beforeDispatch) {
    this.#check(context);
    if (!this.#injectedRequest && !this.#client) this.#client = createPinnedJsonClient({ policy: 'philips-hue', origin: this.#config.origin,
      ...(this.#config.bridgeId === undefined ? {} : { certificateName: this.#config.bridgeId }),
      certificate: this.#config.certificate, certificatePin: this.#config.certificatePin, timeoutMs: this.#config.timeoutMs, maxBytes: 65536 });
    const request = this.#injectedRequest ?? (options => this.#client.request(options));
    const abort = new AbortController(); this.#active = abort;
    const remaining = context.deadlineAt === undefined ? this.#config.timeoutMs : Math.min(this.#config.timeoutMs, Date.parse(context.deadlineAt) - Date.now());
    let timer, removeAbort = () => {};
    try {
      const boundary = new Promise((_, reject) => {
        const cancelled = () => reject(new PhilipsHueAdapterError(this.#closing ? 'ADAPTER_CLOSED' : 'ABORTED'));
        abort.signal.addEventListener('abort', cancelled, { once: true });
        const externalAbort = () => abort.abort();
        if (context.signal !== undefined) EventTarget.prototype.addEventListener.call(context.signal, 'abort', externalAbort, { once: true });
        removeAbort = () => { abort.signal.removeEventListener('abort', cancelled); if (context.signal !== undefined) EventTarget.prototype.removeEventListener.call(context.signal, 'abort', externalAbort); };
        timer = setTimeout(() => { reject(new PhilipsHueAdapterError('REQUEST_TIMEOUT')); abort.abort(); }, Math.max(1, remaining));
      });
      const pending = Promise.resolve().then(() => { this.#check(context); return request({ method, path: `/clip/v2/resource/light/${this.#config.lightId}`,
        headers: { 'hue-application-key': this.#config.applicationKey }, ...(body === undefined ? {} : { body }),
        deadlineAt: context.deadlineAt === undefined ? undefined : Date.parse(context.deadlineAt), signal: abort.signal,
        beforeDispatch: () => { this.#check(context); if (abort.signal.aborted) fail('ABORTED'); beforeDispatch?.(); } }); });
      const result = await Promise.race([pending, boundary]);
      this.#check(context); return result;
    } finally { clearTimeout(timer); removeAbort(); if (this.#active === abort) this.#active = undefined; }
  }
  async #read(context = {}) {
    const beganAt = Date.now(), raw = await this.#request('GET', context);
    return this.#record(projectPhilipsHueLight(raw, this.#config.lightId), beganAt);
  }
  snapshot(options = {}) {
    let refresh;
    try { const checked = philipsHueDataRecord(options, ['refresh']); refresh = checked.refresh ?? true; if (typeof refresh !== 'boolean') fail('INVALID_ARGUMENTS'); }
    catch { return Promise.reject(new PhilipsHueAdapterError('INVALID_ARGUMENTS')); }
    return this.#enqueue(async () => { if (refresh) { try { await this.#read(); } catch { this.#failure(); throw new PhilipsHueAdapterError('STATE_UNAVAILABLE'); } } return this.#snapshot(); });
  }
  subscribe(listener) {
    if (typeof listener !== 'function') fail('INVALID_LISTENER'); this.#check(); this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async start(options = {}) {
    let pollMs;
    try { const checked = philipsHueDataRecord(options, ['pollMs']); pollMs = checked.pollMs ?? 5000; }
    catch { fail('INVALID_POLL_INTERVAL'); }
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
      try { checked = philipsHueDataRecord(command, ['action', 'args']); }
      catch { fail('INVALID_ARGUMENTS'); }
      action = checked.action;
      if (!this.supportedActions.includes(action)) fail('UNKNOWN_ACTION');
      args = validateAction(action, checked.args ?? {});
      try { context = philipsHueDataRecord(context, ['deadlineAt', 'assertDispatch', 'signal']); }
      catch { fail('INVALID_CONTEXT'); }
      if (typeof context.assertDispatch !== 'function') fail('INVALID_CONTEXT');
      signalAborted(context.signal);
    } catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => {
      let dispatched = false, accepted = false;
      try {
        this.#check(context);
        await this.#read(context);
        const preflightField = this.#fields.light;
        const on = action === 'light.power.set' ? args.on : args.brightness > 0;
        const assertPreflight = () => {
          this.#check(context);
          const current = this.#fields.light, now = Date.now();
          if (current !== preflightField || !Number.isFinite(Date.parse(current?.observedAt)) || Date.parse(current.observedAt) > now ||
              !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= now) fail('STALE_STATE');
          if (!current.value.available || !current.value.controlAvailable) fail('LIGHT_CONTROL_UNAVAILABLE');
          if (action === 'light.brightness.set' && (!current.value.supportsBrightness ||
              (on && args.brightness < current.value.minimumBrightness))) fail('BRIGHTNESS_UNSUPPORTED');
        };
        assertPreflight();
        const body = { on: { on }, ...(action === 'light.brightness.set' && on ? { dimming: { brightness: args.brightness } } : {}) };
        const response = await this.#request('PUT', context, body, () => {
          assertPreflight();
          try {
            const result = context.assertDispatch();
            if (result !== undefined) {
              // Dispatch authorization must be synchronous. Observe a rejected
              // native Promise without trusting its .then property or sending.
              if (types.isPromise(result)) Promise.prototype.then.call(result, () => {}, () => {});
              fail('INVALID_CONTEXT');
            }
          }
          catch (error) { throw new PhilipsHueAdapterError(safeCode(error)); }
          dispatched = true;
        });
        if (!dispatched) fail('REQUEST_PROTOCOL');
        acceptPhilipsHueWrite(response, this.#config.lightId); accepted = true;
        const current = await this.#read(context);
        const confirmed = Date.parse(this.#fields.light.expiresAt) > Date.now() && current.available && current.controlAvailable && current.power === on &&
          (action !== 'light.brightness.set' || !on || (current.supportsBrightness && Math.abs(current.brightness - args.brightness) <= 0.5));
        return freeze({ action, requestAccepted: true, confirmed, uncertain: false,
          verificationScope: 'philips_hue_bridge_reported_selected_light_state', physicalEffectVerified: false });
      } catch (error) {
        this.#failure();
        if (dispatched) return freeze({ action, requestAccepted: accepted ? true : null, confirmed: false, uncertain: true,
          verificationScope: 'philips_hue_bridge_reported_selected_light_state', physicalEffectVerified: false, error: { code: 'DEVICE_OPERATION_FAILED' } });
        if (error instanceof PhilipsHueAdapterError) throw error;
        throw new PhilipsHueAdapterError('DEVICE_OPERATION_FAILED');
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
