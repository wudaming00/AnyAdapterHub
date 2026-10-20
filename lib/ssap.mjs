import WebSocket from 'ws';
import { isIP } from 'node:net';
import https from 'node:https';
import { createPinnedTVAgent, normalizeCertificatePin } from './security/tv-tls.mjs';

// Default profiles request this client's own unsigned grants. A public upstream
// compatibility manifest may be supplied explicitly; there is no automatic fallback.
export const AUDIT_PERMISSIONS = Object.freeze([
  'READ_INSTALLED_APPS', 'READ_RUNNING_APPS', 'READ_APP_STATUS',
  'READ_NETWORK_STATE', 'READ_INPUT_DEVICE_LIST', 'READ_POWER_STATE', 'READ_UPDATE_INFO',
]);
export const CONTROL_PERMISSIONS = Object.freeze([...AUDIT_PERMISSIONS,
  'LAUNCH', 'CONTROL_AUDIO', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD',
  'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER',
  'CONTROL_DISPLAY', 'CONTROL_TV_SCREEN',
]);
// Additional ordinary remote capabilities from Home Assistant's unsigned manifest:
// https://github.com/home-assistant-libs/aiowebostv/blob/main/aiowebostv/handshake.py
// Firmware update and TEST_* grants are deliberately absent.
export const EXTENDED_PERMISSIONS = Object.freeze([...new Set([...CONTROL_PERMISSIONS,
  'APP_TO_APP', 'CLOSE', 'LAUNCH_WEBAPP', 'READ_COUNTRY_INFO', 'READ_CURRENT_CHANNEL',
  'READ_LGE_SDX', 'READ_LGE_TV_INPUT_EVENTS', 'READ_NOTIFICATIONS', 'READ_SETTINGS',
  'READ_TV_CHANNEL_LIST', 'READ_TV_CURRENT_TIME', 'SEARCH', 'WRITE_NOTIFICATION_ALERT',
  'WRITE_NOTIFICATION_TOAST', 'WRITE_SETTINGS',
])]);

const endpointSource = 'https://github.com/chros73/bscpylgtv/blob/master/bscpylgtv/endpoints.py';
export const AUDIT_ENDPOINTS = Object.freeze([
  ['services', 'api/getServiceList'],
  ['system', 'system/getSystemInfo'],
  ['software', 'com.webos.service.update/getCurrentSWInformation'],
  ['apps', 'com.webos.applicationManager/listApps'],
  ['launchPoints', 'com.webos.applicationManager/listLaunchPoints'],
  ['foregroundApp', 'com.webos.applicationManager/getForegroundAppInfo'],
  ['audioStatus', 'audio/getStatus'],
  ['volume', 'audio/getVolume'],
  ['inputs', 'tv/getExternalInputList'],
  ['power', 'com.webos.service.tvpower/power/getPowerState'],
].map(([name, uri]) => Object.freeze({ name, uri: `ssap://${uri}`, source: endpointSource })));
export const POINTER_ENDPOINT = 'ssap://com.webos.service.networkinput/getPointerInputSocket';
export const SCREENSHOT_ENDPOINT = 'ssap://tv/executeOneShot';

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    return secrets.filter((s) => typeof s === 'string' && s.length > 0)
      .reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /client[-_]?key|password|authorization|cookie|access[-_]?token|refresh[-_]?token|^secret$/i.test(key)
        ? '[REDACTED]' : redact(item, secrets),
    ]));
  }
  return value;
}

export class SSAPError extends Error {
  constructor(message, code = 'SSAP_ERROR', payload) {
    super(message);
    this.name = 'SSAPError';
    this.code = code;
    if (payload !== undefined) this.payload = payload;
  }
}

export function validateLocalHost(host) {
  if (typeof host !== 'string' || !isIP(host)) {
    throw new SSAPError('Use the TV\'s literal local IP address, without a scheme or port.', 'INVALID_HOST');
  }
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254)) return host;
  } else if (/^(fc|fd|fe[89ab])/i.test(host) || host === '::1') return host;
  throw new SSAPError('Only a private/local TV address is accepted.', 'INVALID_HOST');
}

function checkTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new SSAPError('Timeout must be an integer from 1 to 120000 ms.', 'INVALID_TIMEOUT');
  }
  return value;
}

export class SSAPClient {
  #socket;
  #clientKey;
  #pending = new Map();
  #nextId = 0;
  #registered = false;
  #connecting = false;
  #registration;
  #connectTimer;
  #closed = false;
  #promptSeen = false;
  #finalizing = false;
  #registrationManifest;
  #injectedTransport;
  #tlsAgent;

  constructor({ host, port, secure, certificatePin, clientKey, permissions = AUDIT_PERMISSIONS,
    registrationManifest, interfaceAddress, wake,
    timeoutMs = 8_000, pairingTimeoutMs = 60_000, onPairing, onClientKey,
    webSocketFactory } = {}) {
    this.host = validateLocalHost(host);
    this.localAddress = interfaceAddress ?? wake?.bindAddress;
    this.#injectedTransport = typeof webSocketFactory === 'function';
    secure ??= !this.#injectedTransport;
    if (typeof secure !== 'boolean') throw new SSAPError('Secure transport must be a boolean.', 'TLS_REQUIRED');
    this.secure = secure;
    this.port = port ?? (secure ? 3001 : 3000);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new SSAPError('Invalid port.', 'INVALID_PORT');
    }
    if (this.port === 3001 && !secure) {
      throw new SSAPError('Port 3001 requires secure: true / --secure.', 'SECURE_REQUIRED');
    }
    this.certificatePin = certificatePin === undefined ? undefined : normalizeCertificatePin(certificatePin);
    if (!this.#injectedTransport) {
      if (!secure) throw new SSAPError('Real TV control requires pinned WSS; plaintext WS is disabled.', 'TLS_REQUIRED');
      this.certificatePin = normalizeCertificatePin(certificatePin);
    }
    if (clientKey !== undefined && (typeof clientKey !== 'string' || !clientKey.trim())) {
      throw new SSAPError('Stored client key is invalid.', 'INVALID_KEY');
    }
    this.#clientKey = clientKey;
    if (registrationManifest !== undefined) {
      try {
        this.#registrationManifest = JSON.parse(JSON.stringify(registrationManifest));
      } catch { throw new SSAPError('Registration manifest must be a JSON object.', 'INVALID_MANIFEST'); }
      const manifest = this.#registrationManifest;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.manifestVersion !== 1 ||
        !Array.isArray(manifest.permissions) || Object.hasOwn(manifest, 'client-key') ||
        (manifest.signed !== undefined && (!manifest.signed || typeof manifest.signed !== 'object' || Array.isArray(manifest.signed))) ||
        (manifest.signatures !== undefined && !Array.isArray(manifest.signatures))) {
        throw new SSAPError('Registration manifest has an unsupported shape.', 'INVALID_MANIFEST');
      }
      permissions = manifest.permissions;
    }
    this.permissions = Object.freeze([...new Set(permissions)]);
    if (!this.permissions.every((item) => typeof item === 'string' && /^[A-Z_]+$/.test(item))) {
      throw new SSAPError('Invalid permission list.', 'INVALID_PERMISSIONS');
    }
    this.timeoutMs = checkTimeout(timeoutMs);
    this.pairingTimeoutMs = checkTimeout(pairingTimeoutMs);
    this.onPairing = onPairing;
    this.onClientKey = onClientKey;
    this.webSocketFactory = webSocketFactory ?? ((url, options) => new WebSocket(url, options));
    const address = isIP(this.host) === 6 ? `[${this.host}]` : this.host;
    this.url = `${secure ? 'wss' : 'ws'}://${address}:${this.port}`;
  }

  get registered() { return this.#registered; }
  sanitize(value) { return redact(value, [this.#clientKey]); }

  connect({ allowPairing = false } = {}) {
    if (this.#registered) return Promise.resolve({ registered: true });
    if (this.#connecting || this.#closed) {
      return Promise.reject(new SSAPError('Create a new client for each connection attempt.', 'INVALID_STATE'));
    }
    if (!allowPairing && !this.#clientKey) {
      return Promise.reject(new SSAPError('No saved pairing key. Run the explicit pair command first.', 'PAIRING_REQUIRED'));
    }
    this.#connecting = true;
    const registerId = `register-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      this.#registration = { id: registerId, resolve, reject, allowPairing };
      this.#connectTimer = setTimeout(() => this.#fail(new SSAPError(
        allowPairing ? 'TV pairing/connection timed out.' : 'TV connection/registration timed out.', 'TIMEOUT',
      )), allowPairing ? this.pairingTimeoutMs : this.timeoutMs);
      try {
        const options = { handshakeTimeout: this.timeoutMs, maxPayload: 4 * 1024 * 1024, followRedirects: false };
        if (!this.#injectedTransport) {
          this.#tlsAgent = createPinnedTVAgent({ host: this.host, certificatePin: this.certificatePin,
            timeoutMs: this.timeoutMs, localAddress: this.localAddress });
          options.agent = this.#tlsAgent;
        }
        this.#socket = this.webSocketFactory(this.url, options);
        this.#socket.on('open', () => {
          if (this.#closed || !this.#registration) return;
          const payload = { forcePairing: false, manifest: this.#registrationManifest ??
            { manifestVersion: 1, appVersion: '1.0', permissions: this.permissions } };
          if (allowPairing) payload.pairingType = 'PROMPT';
          if (this.#clientKey) payload['client-key'] = this.#clientKey;
          this.#send({ id: registerId, type: 'register', payload });
        });
        this.#socket.on('message', (data) => { void this.#handleMessage(data).catch(() => {
          this.#fail(new SSAPError('Registration callback failed. Pairing key was not saved.', 'KEY_SAVE_FAILED'));
        }); });
        this.#socket.on('error', (error) => this.#fail(new SSAPError(
          this.sanitize(`TV transport error${error?.code ? ` (${error.code})` : ''}.`), /^(?:TLS_[A-Z_]+|INVALID_SOURCE_ADDRESS|SOURCE_ADDRESS_UNAVAILABLE)$/.test(error?.code ?? '') ? error.code : 'TRANSPORT_ERROR',
        )));
        this.#socket.on('close', () => this.#fail(new SSAPError('TV connection closed.', 'CONNECTION_CLOSED')));
      } catch (error) {
        this.#fail(new SSAPError('Unable to create TV connection.',
          /^(?:TLS_[A-Z_]+|INVALID_SOURCE_ADDRESS|SOURCE_ADDRESS_UNAVAILABLE)$/.test(error?.code ?? '') ? error.code : 'TRANSPORT_ERROR'));
      }
    });
  }

  #send(message) {
    try { this.#socket.send(JSON.stringify(message), (error) => {
      if (error) this.#fail(new SSAPError('Unable to send TV request.', 'TRANSPORT_ERROR'));
    }); } catch { this.#fail(new SSAPError('Unable to send TV request.', 'TRANSPORT_ERROR')); }
  }

  async #handleMessage(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch {
      this.#fail(new SSAPError('TV sent invalid JSON.', 'PROTOCOL_ERROR')); return;
    }
    if (!message || typeof message !== 'object') return;
    const error = message.type === 'error' || message.payload?.returnValue === false
      ? new SSAPError(this.sanitize(String(message.error ?? message.payload?.errorText ?? 'TV rejected the request.')),
        'TV_REJECTED', this.sanitize(message.payload)) : null;
    if (this.#registration && message.id === this.#registration.id) {
      if (error) { this.#fail(error); return; }
      if (message.type === 'registered') {
        if (this.#finalizing) return;
        this.#finalizing = true;
        const key = message.payload?.['client-key'];
        if (typeof key === 'string' && key.trim()) {
          this.#clientKey = key;
          if (this.onClientKey) await this.onClientKey(key);
        } else if (!this.#clientKey) {
          this.#fail(new SSAPError('TV registered without returning a pairing key.', 'PROTOCOL_ERROR')); return;
        }
        if (!this.#registration || this.#closed) return;
        clearTimeout(this.#connectTimer);
        this.#connecting = false;
        this.#registered = true;
        const { resolve } = this.#registration;
        this.#registration = undefined;
        resolve({ registered: true });
      } else if (message.type === 'response' && message.payload?.pairingType) {
        if (!this.#registration.allowPairing) {
          this.#fail(new SSAPError('Saved key was not accepted; audit stopped. Explicitly pair again.', 'PAIRING_REQUIRED')); return;
        }
        if (!this.#promptSeen) {
          this.#promptSeen = true;
          this.onPairing?.();
        }
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending || !(['response', 'error'].includes(message.type) ||
      (pending.type === 'subscribe' && message.type === 'event'))) return;
    if (pending.persistent) {
      if (error) {
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        if (pending.ready) { try { pending.onError?.(error); } catch {} }
        else pending.reject(error);
        return;
      }
      clearTimeout(pending.timer);
      try { pending.onUpdate(this.sanitize(message.payload ?? {})); }
      catch {
        this.#pending.delete(message.id);
        this.#unsubscribe(message.id);
        const callbackError = new SSAPError('Subscription update callback failed.', 'SUBSCRIPTION_CALLBACK_FAILED');
        if (pending.ready) { try { pending.onError?.(callbackError); } catch {} }
        else pending.reject(callbackError);
        return;
      }
      if (!pending.ready) {
        pending.ready = true;
        pending.resolve({ id: message.id, unsubscribe: () => {
          const active = this.#pending.get(message.id);
          if (!active) return;
          clearTimeout(active.timer);
          this.#pending.delete(message.id);
          this.#unsubscribe(message.id);
        } });
      }
      return;
    }
    if (!error && pending.type === 'subscribe' && pending.acceptPayload) {
      try {
        if (!pending.acceptPayload(message.payload ?? {})) return;
      } catch {
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        this.#unsubscribe(message.id);
        pending.reject(new SSAPError('Subscription payload predicate failed.', 'SUBSCRIPTION_PREDICATE_FAILED'));
        return;
      }
    }
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (error) pending.reject(error);
    else {
      if (pending.type === 'subscribe') this.#unsubscribe(message.id);
      pending.resolve(this.sanitize(message.payload ?? {}));
    }
  }

  request(uri, payload = {}, options = {}) {
    return this.#dispatch('request', uri, payload, options);
  }

  // Obtain one state snapshot from subscription-only APIs (for example IME focus),
  // then immediately cancel the subscription instead of leaving a listener active.
  subscribeOnce(uri, payload = {}, options = {}) {
    return this.#dispatch('subscribe', uri, payload, options);
  }

  // Resolve after the first acknowledgement, retain updates until unsubscribe/close.
  subscribe(uri, payload = {}, options = {}) {
    return this.#dispatch('subscribe', uri, payload, { ...options, persistent: true });
  }

  #unsubscribe(id) {
    if (this.#registered && !this.#closed) this.#send({ id, type: 'unsubscribe' });
  }

  #dispatch(type, uri, payload, { timeoutMs = this.timeoutMs, acceptPayload, persistent = false, onUpdate, onError } = {}) {
    if (!this.#registered || this.#closed) {
      return Promise.reject(new SSAPError('Register with the TV before sending requests.', 'NOT_REGISTERED'));
    }
    if (typeof uri !== 'string' || !/^ssap:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(uri)) {
      return Promise.reject(new SSAPError('Use a complete ssap://service/method URI.', 'INVALID_URI'));
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Promise.reject(new SSAPError('Request payload must be an object.', 'INVALID_PAYLOAD'));
    }
    if (acceptPayload !== undefined && (type !== 'subscribe' || typeof acceptPayload !== 'function')) {
      return Promise.reject(new SSAPError('acceptPayload must be a subscription predicate function.', 'INVALID_SUBSCRIPTION_PREDICATE'));
    }
    if (persistent && (type !== 'subscribe' || typeof onUpdate !== 'function' ||
      (onError !== undefined && typeof onError !== 'function'))) {
      return Promise.reject(new SSAPError('Persistent subscription requires onUpdate and an optional onError callback.', 'INVALID_SUBSCRIPTION_CALLBACK'));
    }
    checkTimeout(timeoutMs);
    const id = `${type}-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (type === 'subscribe') this.#unsubscribe(id);
        reject(new SSAPError('TV request timed out.', 'TIMEOUT'));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, type, acceptPayload, persistent, onUpdate, onError, ready: false });
      this.#send({ id, type, uri, payload });
    });
  }

  #fail(error) {
    clearTimeout(this.#connectTimer);
    this.#registered = false;
    this.#connecting = false;
    if (this.#registration) {
      this.#registration.reject(error);
      this.#registration = undefined;
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      if (pending.persistent && pending.ready) { try { pending.onError?.(error); } catch {} }
      else pending.reject(error);
    }
    this.#pending.clear();
    this.#tlsAgent?.destroy();
    if (!this.#closed) {
      this.#closed = true;
      this.#socket?.terminate();
    }
  }

  close() { this.#fail(new SSAPError('TV client closed.', 'CLIENT_CLOSED')); }
}

export async function auditTV(client, { includePointer = false } = {}) {
  if (!client.registered) throw new SSAPError('Audit requires an already registered client.', 'NOT_REGISTERED');
  const endpoints = includePointer
    ? [...AUDIT_ENDPOINTS, { name: 'pointerSocket', uri: POINTER_ENDPOINT, source: endpointSource }]
    : AUDIT_ENDPOINTS;
  const results = [];
  for (const endpoint of endpoints) {
    const start = performance.now();
    try {
      const payload = await client.request(endpoint.uri, {});
      results.push({ ...endpoint, status: 'ok', elapsedMs: Math.round(performance.now() - start), payload });
    } catch (error) {
      results.push({ ...endpoint, status: 'error', elapsedMs: Math.round(performance.now() - start),
        error: { code: error.code ?? 'ERROR', message: client.sanitize(error.message), payload: client.sanitize(error.payload) } });
    }
  }
  return client.sanitize({ schemaVersion: 1, capturedAt: new Date().toISOString(),
    target: { host: client.host, port: client.port, secure: client.secure },
    permissionsRequested: client.permissions,
    notes: [
      'Only the fixed read-query allowlist was sent; pointer URL retrieval is optional and no pointer socket is opened.',
      'api/getServiceList reports service namespaces/versions, not a complete list of callable methods.',
      'An endpoint error may mean insufficient permissions, an unsupported method, or a temporary TV state.',
      'No screenshots, app launches, input/volume/power changes, or control actions are part of this audit.',
    ], results,
  });
}

export function validateCaptureURL(value, tvHost) {
  validateLocalHost(tvHost);
  let url;
  try { url = new URL(value); } catch { throw new SSAPError('TV did not return a valid capture URL.', 'INVALID_CAPTURE_URL'); }
  const expected = new URL(`http://${isIP(tvHost) === 6 ? `[${tvHost}]` : tvHost}`).hostname;
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== expected ||
      url.username || url.password || url.hash) {
    throw new SSAPError('Refusing a capture URL outside the same local TV host.', 'INVALID_CAPTURE_URL');
  }
  return url;
}

export async function downloadCapture(value, tvHost, { timeoutMs = 8_000, maxBytes = 16 * 1024 * 1024,
  certificatePin, requestFactory, localAddress,
} = {}) {
  const url = validateCaptureURL(value, tvHost);
  checkTimeout(timeoutMs);
  const injected = typeof requestFactory === 'function';
  if (!injected && url.protocol !== 'https:') throw new SSAPError('Private captures require pinned HTTPS; plaintext image downloads are disabled.', 'TLS_REQUIRED');
  const agent = !injected ? createPinnedTVAgent({ host: tvHost, certificatePin, timeoutMs, localAddress }) : undefined;
  const requestImage = requestFactory ?? ((target, options, callback) => https.get(target, options, callback));
  return new Promise((resolve, reject) => {
    const req = requestImage(url, { ...(agent ? { agent } : {}), rejectUnauthorized: true }, (res) => {
      if (res.statusCode !== 200 || !/^image\/(png|jpeg|webp|gif|bmp)(?:;|$)/i.test(res.headers['content-type'] ?? '')) {
        res.destroy(); reject(new SSAPError('Capture download was not a direct image response (redirects are refused).', 'CAPTURE_DOWNLOAD_FAILED')); return;
      }
      const chunks = []; let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.destroy(); req.destroy(); reject(new SSAPError('Capture exceeds download size limit.', 'CAPTURE_TOO_LARGE'));
        } else chunks.push(chunk);
      });
      res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'], bytes }));
      res.on('error', () => reject(new SSAPError('Capture response interrupted.', 'CAPTURE_DOWNLOAD_FAILED')));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('close', () => { clearTimeout(timer); agent?.destroy(); });
    req.on('error', error => reject(new SSAPError('Capture download failed or timed out.', /^(?:TLS_[A-Z_]+|INVALID_SOURCE_ADDRESS|SOURCE_ADDRESS_UNAVAILABLE)$/.test(error?.code ?? '') ? error.code : 'CAPTURE_DOWNLOAD_FAILED')));
  });
}
