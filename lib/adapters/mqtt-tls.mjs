import tls from 'node:tls';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { types } from 'node:util';
import { MQTT_MEASUREMENTS, validateMQTTConfig } from './mqtt-config.mjs';
import { createMQTTWireTransport } from './mqtt-wire.mjs';

const TTL_MS = 60000;
const CONNECT_MS = 5000;
const CLEANUP_MS = 500;
const BACKOFF = Object.freeze([1000, 2000, 4000, 8000, 16000]);
const NOOP = () => {};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export class MQTTAdapterError extends Error {
  constructor(code, message = 'The selected MQTT sensor connection could not be completed.') { super(message); this.name = 'MQTTAdapterError'; this.code = code; }
}
const fail = code => { throw new MQTTAdapterError(code); };
function assertNoDebugLogging() {
  if (['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].some(key => typeof process.env[key] === 'string' && process.env[key].length > 0)) {
    throw new MQTTAdapterError('MQTT_DEBUG_ENABLED', 'Disable DEBUG, NODE_DEBUG and NODE_DEBUG_NATIVE before starting the MQTT adapter.');
  }
}
function ownOptions(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_CONFIG');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  if (keys.some(key => !allowed.includes(key) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable) ||
      required.some(key => !Object.hasOwn(fields, key))) fail('INVALID_CONFIG');
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}

/** Fixed native TLS settings, with a pre-parser frame boundary on broker input. */
export function createMQTTTLSStream(config) {
  assertNoDebugLogging();
  const checked = validateMQTTConfig(config);
  return createMQTTWireTransport(tls.connect({ host: checked.host, port: checked.port, ca: checked.certificatePem,
    rejectUnauthorized: true, allowPartialTrustChain: true, minVersion: 'TLSv1.2', checkServerIdentity: createMQTTTLSChecker(checked) }));
}

/** Node runs this during TLS authentication, before buffered MQTT CONNECT bytes may leave. */
export function createMQTTTLSChecker(config) {
  const { host: selectedHost, certificatePin } = validateMQTTConfig(config);
  return (host, peer) => {
    try {
      if (host !== selectedHost || !peer || typeof peer !== 'object' || types.isProxy(peer)) return new MQTTAdapterError('TLS_CERTIFICATE_INVALID');
      const raw = Object.getOwnPropertyDescriptor(peer, 'raw');
      if (!raw || !Object.hasOwn(raw, 'value') || !Buffer.isBuffer(raw.value)) return new MQTTAdapterError('TLS_CERTIFICATE_INVALID');
      if (createHash('sha256').update(raw.value).digest('hex') !== certificatePin) return new MQTTAdapterError('TLS_PIN_MISMATCH');
      const cert = new X509Certificate(raw.value), now = Date.now();
      if (cert.checkIP(selectedHost) !== selectedHost || Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) return new MQTTAdapterError('TLS_CERTIFICATE_INVALID');
      if (tls.checkServerIdentity(selectedHost, cert.toLegacyObject())) return new MQTTAdapterError('TLS_CERTIFICATE_INVALID');
      return undefined;
    } catch { return new MQTTAdapterError('TLS_CERTIFICATE_INVALID'); }
  };
}

function options(config) {
  return {
    protocol: 'mqtts', host: config.host, port: config.port,
    ca: config.certificatePem, rejectUnauthorized: true, allowPartialTrustChain: true, minVersion: 'TLSv1.2',
    checkServerIdentity: createMQTTTLSChecker(config),
    username: config.username, password: config.password,
    clientId: `anyadapter_${randomBytes(16).toString('hex')}`,
    protocolVersion: 5, clean: true, keepalive: 30, connectTimeout: CONNECT_MS,
    reconnectPeriod: 0, reconnectOnConnackError: false, resubscribe: false,
    queueQoSZero: false, autoUseTopicAlias: false, autoAssignTopicAlias: false,
    properties: { maximumPacketSize: 1024, receiveMaximum: 1, topicAliasMaximum: 0, sessionExpiryInterval: 0 },
    log: NOOP,
  };
}

function reading(payload, packet, measurement) {
  if (!Buffer.isBuffer(payload) || payload.length < 1 || payload.length > 256 || !packet ||
      typeof packet !== 'object' || types.isProxy(packet)) return undefined;
  const retain = Object.getOwnPropertyDescriptor(packet, 'retain');
  // Missing metadata is not evidence that a sample was delivered live.
  if (!retain || !Object.hasOwn(retain, 'value') || retain.value !== false) return undefined;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload).trim(); } catch { return undefined; }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
  const value = Number(text), [min, max] = MQTT_MEASUREMENTS[measurement];
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** A fixed subscription, never an MQTT publish/passthrough capability. */
export class MQTTTLSAdapter {
  #config; #factory; #listeners = new Set(); #fields = {}; #revision = 0; #phase = 'unknown';
  #closed = false; #started = false; #startPromise; #attemptPromise; #token; #timer; #retries = 0; #pollMs = 1000;
  #cleanups = new Set(); #closePromise; #cleanupIncomplete = false;
  constructor(value = {}) {
    const { deviceId, config, connectFactory } = ownOptions(value, ['deviceId', 'config', 'connectFactory'], ['deviceId', 'config']);
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID');
    if (connectFactory !== undefined && typeof connectFactory !== 'function') fail('INVALID_CONFIG');
    this.#config = validateMQTTConfig(config);
    this.#factory = connectFactory;
    Object.defineProperties(this, {
      deviceId: { value: deviceId, enumerable: true }, adapterId: { value: 'mqtt-tls', enumerable: true },
      supportedActions: { value: Object.freeze([]), enumerable: true },
    });
  }
  snapshot() {
    return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(),
      connection: { phase: this.#phase }, fields: this.#fields }));
  }
  #publish() {
    if (this.#closed) return;
    this.#revision++;
    const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.snapshot() });
    for (const listener of this.#listeners) { try { listener(event); } catch {} }
  }
  subscribe(listener) {
    if (this.#closed) fail('ADAPTER_CLOSED');
    if (typeof listener !== 'function') fail('INVALID_LISTENER');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #dispose(token) {
    if (token.disposal) return token.disposal;
    token.active = false; clearTimeout(token.timeout);
    for (const [event, handler] of Object.entries(token.handlers ?? {})) token.client.removeListener(event, handler);
    token.client.on('error', NOOP); // SDK cleanup may emit a late error; never expose vendor text.
    const task = new Promise(resolve => {
      let done = false;
      const finish = completed => { if (done) return; done = true; clearTimeout(timer); if (!completed) this.#cleanupIncomplete = true; resolve(completed); };
      const timer = setTimeout(() => { try { token.client.stream?.destroy(); } catch {} finish(false); }, CLEANUP_MS);
      try { token.client.end(true, {}, error => finish(!error)); } catch { try { token.client.stream?.destroy(); } catch {} finish(false); }
    });
    token.disposal = task;
    this.#cleanups.add(task); task.finally(() => this.#cleanups.delete(task));
    return task;
  }
  #retry() {
    if (this.#closed || this.#cleanupIncomplete || !this.#started || this.#timer || this.#retries >= BACKOFF.length) return;
    const wait = Math.max(this.#pollMs, BACKOFF[this.#retries++]);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#closed) void this.#connect().catch(NOOP);
    }, wait);
    this.#timer.unref?.();
  }
  #failure(token, code, retry = true) {
    if (!token.active) return;
    token.active = false;
    token.settle(new MQTTAdapterError(code));
    if (this.#token === token) this.#token = undefined;
    void this.#dispose(token).then(completed => {
      if (!this.#closed && completed && retry) this.#retry();
      else if (!this.#closed && !completed) { this.#phase = 'cleanup-incomplete'; this.#publish(); }
    });
    if (this.#closed) return;
    this.#phase = 'offline';
    for (const field of Object.values(this.#fields)) field.expiresAt = new Date(0).toISOString();
    this.#publish();
  }
  #connect() {
    if (this.#closed) return Promise.reject(new MQTTAdapterError('ADAPTER_CLOSED'));
    if (this.#attemptPromise) return this.#attemptPromise;
    const task = (async () => {
      assertNoDebugLogging();
      if (!this.#factory) {
        try {
          const mqtt = await import('mqtt');
          this.#factory = settings => new mqtt.MqttClient(() => createMQTTTLSStream(this.#config), settings);
        }
        catch { throw new MQTTAdapterError('ADAPTER_DEPENDENCY_MISSING', 'MQTT is optional. Run npm run adapter:mqtt:install (mqtt@5.16.1) before enabling it.'); }
      }
      if (this.#closed) fail('ADAPTER_CLOSED');
      assertNoDebugLogging();
      this.#phase = 'connecting'; this.#publish();
      await new Promise((resolve, reject) => {
        let client;
        try { client = this.#factory(options(this.#config)); }
        catch { this.#phase = 'offline'; this.#publish(); this.#retry(); return reject(new MQTTAdapterError('MQTT_CONNECTION_FAILED')); }
        if (!client || typeof client.on !== 'function' || typeof client.removeListener !== 'function' ||
            typeof client.subscribe !== 'function' || typeof client.end !== 'function') return reject(new MQTTAdapterError('MQTT_CONNECTION_FAILED'));
        let settled = false;
        const token = { client, active: true, ready: false, settle: error => {
          if (settled) return; settled = true; clearTimeout(token.timeout); error ? reject(error) : resolve();
        } };
        this.#token = token;
        token.handlers = {
          connect: () => {
            if (this.#closed || !token.active || token.subscribing) return;
            token.subscribing = true;
            try {
              client.subscribe(this.#config.topic, { qos: 0, nl: true, rap: true, rh: 2 }, (error, grants) => {
                if (this.#closed || !token.active) return;
                if (error || !Array.isArray(grants) || grants.length !== 1 || grants[0]?.topic !== this.#config.topic || grants[0]?.qos !== 0) return this.#failure(token, 'MQTT_SUBSCRIPTION_FAILED');
                token.ready = true; this.#retries = 0; this.#phase = 'online'; this.#publish(); token.settle();
              });
            } catch { this.#failure(token, 'MQTT_SUBSCRIPTION_FAILED'); }
          },
          message: (topic, payload, packet) => {
            if (this.#closed || !token.active || !token.ready || topic !== this.#config.topic) return;
            const value = reading(payload, packet, this.#config.measurement);
            if (value === undefined) return;
            const receivedAt = Date.now();
            // Receipt freshness says nothing about the publisher/device sampling age.
            this.#fields[this.#config.measurement] = { value, observedAt: new Date(receivedAt).toISOString(),
              expiresAt: new Date(receivedAt + TTL_MS).toISOString(), source: 'mqtt-tls', verification: 'broker-reported' };
            this.#publish();
          },
          error: error => {
            const code = typeof error?.code === 'string' ? error.code : '';
            const trustFailure = /^(?:TLS_|ERR_TLS_|CERT_|DEPTH_ZERO_|UNABLE_TO_VERIFY_|SELF_SIGNED_)/.test(code);
            this.#failure(token, trustFailure ? (code === 'TLS_PIN_MISMATCH' ? code : 'TLS_CERTIFICATE_INVALID') : 'MQTT_CONNECTION_FAILED', !trustFailure);
          },
          close: () => this.#failure(token, 'MQTT_CONNECTION_CLOSED'),
          offline: () => this.#failure(token, 'MQTT_CONNECTION_CLOSED'),
        };
        for (const [event, handler] of Object.entries(token.handlers)) client.on(event, handler);
        token.timeout = setTimeout(() => this.#failure(token, 'MQTT_CONNECTION_TIMEOUT'), CONNECT_MS);
      });
    })();
    this.#attemptPromise = task;
    task.finally(() => { if (this.#attemptPromise === task) this.#attemptPromise = undefined; }).catch(NOOP);
    return task;
  }
  start(value = {}) {
    let pollMs;
    try { ({ pollMs = 1000 } = ownOptions(value, ['pollMs'])); } catch (error) { return Promise.reject(error); }
    if (this.#closed) return Promise.reject(new MQTTAdapterError('ADAPTER_CLOSED'));
    if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 300000) return Promise.reject(new MQTTAdapterError('INVALID_POLL_INTERVAL'));
    if (this.#started) return this.#startPromise;
    this.#started = true; this.#pollMs = pollMs;
    this.#startPromise = this.#connect();
    return this.#startPromise;
  }
  async execute() { fail(this.#closed ? 'ADAPTER_CLOSED' : 'UNSUPPORTED_ACTION'); }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true; clearTimeout(this.#timer); this.#timer = undefined; this.#listeners.clear();
    const token = this.#token;
    this.#closePromise = (async () => {
      if (token) { token.settle(new MQTTAdapterError('ADAPTER_CLOSED')); await this.#dispose(token); }
      await this.#attemptPromise?.catch(NOOP);
      await Promise.all([...this.#cleanups]);
      for (const field of Object.values(this.#fields)) field.expiresAt = new Date(0).toISOString();
      if (this.#cleanupIncomplete) { this.#phase = 'cleanup-incomplete'; fail('MQTT_CLEANUP_INCOMPLETE'); }
      this.#phase = 'closed';
    })();
    return this.#closePromise;
  }
}
