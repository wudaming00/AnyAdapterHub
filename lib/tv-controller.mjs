import WebSocket from 'ws';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { createPinnedTVAgent, normalizeCertificatePin } from './security/tv-tls.mjs';
import { SSAPClient, SSAPError, POINTER_ENDPOINT, SCREENSHOT_ENDPOINT, downloadCapture, validateLocalHost } from './ssap.mjs';

export const CONTROL_SOURCES = Object.freeze({
  endpoints: 'https://github.com/chros73/bscpylgtv/blob/master/bscpylgtv/endpoints.py',
  payloads: 'https://github.com/chros73/bscpylgtv/blob/master/bscpylgtv/webos_client.py',
  buttons: 'https://github.com/chros73/bscpylgtv/blob/master/bscpylgtv/buttons.py',
  webOS4Screen: 'https://github.com/merdok/homebridge-webos-tv/blob/master/lib/LgTvController.js',
  mediaViewer: 'https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/master/src/com/connectsdk/service/WebOSTVService.java',
  screenshot: 'https://github.com/JPersson77/LGTVCompanion/blob/master/Docs/Commandline.md',
});
export const SCREENSHOT_OPTIONS = Object.freeze({
  path: '/tmp/capture.jpg', method: 'DISPLAY', format: 'JPG', width: 960, height: 540,
});
export const REMOTE_KEYS = Object.freeze([
  'LEFT', 'RIGHT', 'UP', 'DOWN', 'ENTER', 'BACK', 'EXIT', 'HOME', 'MENU', 'QMENU',
  'RED', 'GREEN', 'YELLOW', 'BLUE', 'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN',
  'PLAY', 'PAUSE', 'STOP', 'REWIND', 'FASTFORWARD', 'MUTE', 'INFO', 'GUIDE', 'LIST',
  'SEARCH', 'MYAPPS', 'RECENT', 'NETFLIX', 'AMAZON', 'CC', 'INPUT_HUB', 'TV', 'POWER',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);
const keySet = new Set(REMOTE_KEYS);
const URI = Object.freeze({
  foreground: 'ssap://com.webos.applicationManager/getForegroundAppInfo',
  audio: 'ssap://audio/getStatus', volume: 'ssap://audio/getVolume',
  inputs: 'ssap://tv/getExternalInputList',
  power: 'ssap://com.webos.service.tvpower/power/getPowerState',
  apps: 'ssap://com.webos.applicationManager/listApps',
  launchPoints: 'ssap://com.webos.applicationManager/listLaunchPoints',
  launch: 'ssap://system.launcher/launch', open: 'ssap://system.launcher/open',
  close: 'ssap://system.launcher/close',
  text: 'ssap://com.webos.service.ime/insertText',
  keyboard: 'ssap://com.webos.service.ime/registerRemoteKeyboard',
  enter: 'ssap://com.webos.service.ime/sendEnterKey',
  setVolume: 'ssap://audio/setVolume', mute: 'ssap://audio/setMute',
  input: 'ssap://tv/switchInput',
  sound: 'ssap://com.webos.service.apiadapter/audio/getSoundOutput',
  changeSound: 'ssap://com.webos.service.apiadapter/audio/changeSoundOutput',
  off: 'ssap://system/turnOff',
});
const mediaMethods = Object.freeze({ play: 'play', pause: 'pause', stop: 'stop', rewind: 'rewind', fastForward: 'fastForward' });
const READ_URIS = new Set([URI.foreground, URI.audio, URI.volume, URI.inputs, URI.power, URI.apps,
  URI.launchPoints, URI.sound, POINTER_ENDPOINT, 'ssap://system/getSystemInfo',
  'ssap://com.webos.service.update/getCurrentSWInformation']);
export const KEYBOARD_MAX_AGE_MS = 1500;
const FOCUS_CHANGING_URIS = new Set([URI.launch, URI.open, URI.close, URI.input, URI.off,
  'ssap://media.viewer/open', URI.enter]);

function keyboardOptions(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length) invalid('Keyboard options must be a plain data object.');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(fields).some(([key, descriptor]) => !allowed.includes(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)) {
    invalid('Keyboard options contain an unsupported field.');
  }
  return value;
}
function keyboardSignal(signal) {
  if (signal === undefined) return;
  if (!signal || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype) invalid('Use a native AbortSignal.');
  try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal); }
  catch { invalid('Use a native AbortSignal.'); }
  if (Object.getOwnPropertyNames(signal).some(key => ['aborted', 'addEventListener', 'removeEventListener'].includes(key))) invalid('Use an unmodified AbortSignal.');
}
function keyboardField(value, name) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function invalid(message, code = 'INVALID_ARGUMENT') { throw new SSAPError(message, code); }
function text(value, label, max = 8192, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) {
    invalid(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters without NUL.`);
  }
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') invalid(`${label} must be true or false.`);
  return value;
}
function normalId(value, label) {
  text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) invalid(`${label} contains unsupported characters.`);
  return value;
}
function ordinaryApp(id) {
  normalId(id, 'App ID');
  if (/(?:^|[._-])(?:factory\w*|service\w*|in_?start|ez_?adjust|remoteservice|calibration)(?:$|[._-])/i.test(id)) {
    invalid('Factory, service and calibration applications are outside ordinary TV control.', 'RESTRICTED_APP');
  }
  return id;
}
const SAFE_SYSTEM_APPS = new Set(['com.webos.app.browser', 'com.webos.app.livetv',
  'com.webos.app.hdmi1', 'com.webos.app.hdmi2', 'com.webos.app.hdmi3', 'com.webos.app.hdmi4',
  'com.webos.app.photovideo']);
function ordinaryLaunchApp(id, installed) {
  const app = installed?.apps?.find(item => item?.id === id);
  if (!app) invalid('App is not present in the installed-app metadata.', 'APP_NOT_FOUND');
  // App IDs and URL schemes do not describe the privileges of an LG system app.
  // In particular, some overlays execute their HTTP target with private Luna access.
  const unprivileged = app.privilegedJail === false && app.defaultWindowType === 'card' &&
    (app.requiredPermissions === undefined || (Array.isArray(app.requiredPermissions) && app.requiredPermissions.length === 0));
  if (!unprivileged || (app.systemApp !== false && !(app.systemApp === true && SAFE_SYSTEM_APPS.has(id)))) {
    invalid('Privileged, overlay, or unclassified applications cannot be launched by ordinary TV control.', 'RESTRICTED_APP');
  }
  return app;
}
export function canLaunchOrdinaryApp(app) {
  try { ordinaryApp(app?.id); ordinaryLaunchApp(app.id, { apps: [app] }); return true; }
  catch { return false; }
}
function observerURL(value, tvHost) {
  const url = new URL(webURL(value, 'Observer URL'));
  const octets = url.hostname.split('.').map(Number);
  const privateHost = isIP(url.hostname) === 4 && (octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (url.protocol !== 'http:' || !privateHost || url.hostname === tvHost || !url.port ||
    url.search || url.hash || !/^\/[a-f0-9]{48}\/assets\/loader\.html$/.test(url.pathname)) {
    invalid('Observer entry must be the private computer HTTP listener with its per-run token and fixed loader path.');
  }
  return url.href;
}
function webURL(value, label = 'URL') {
  text(value, label, 8192);
  let url;
  try { url = new URL(value); } catch { invalid(`${label} must be an absolute HTTP or HTTPS address.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid(`${label} must use HTTP(S) and contain no URL credentials.`);
  return url.href;
}
function launchParams(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid('Launch params must be a plain JSON object.');
  let serialized;
  try { serialized = JSON.stringify(value); } catch { invalid('Launch params must be serializable JSON.'); }
  if (serialized.length > 32768 || /(?:luna|ssap|javascript|file):/i.test(serialized)) {
    invalid('Launch params exceed the size limit or contain a restricted local/API scheme.');
  }
  return JSON.parse(serialized);
}
function launchContentId(value) {
  text(value, 'Content ID', 8192);
  if (/(?:luna|ssap|javascript|file):/i.test(value)) invalid('Content ID contains a restricted local/API scheme.');
  return value;
}

export function validatePointerURL(value, tvHost) {
  validateLocalHost(tvHost);
  let url;
  try { url = new URL(value); } catch { invalid('TV returned an invalid pointer URL.', 'INVALID_POINTER_URL'); }
  const expected = new URL(`http://${isIP(tvHost) === 6 ? `[${tvHost}]` : tvHost}`).hostname;
  if (!['ws:', 'wss:'].includes(url.protocol) || url.hostname !== expected || url.username || url.password || url.hash) {
    invalid('Pointer connection must remain on the same literal local TV host.', 'INVALID_POINTER_URL');
  }
  return url;
}

export class TVController {
  #client;
  #pointer;
  #pointerConnecting;
  #closed = false;
  #pointerFactory;
  #keyboardSubscription;
  #keyboardStarting;
  #keyboardSnapshot;
  #keyboardObservedAt;
  #keyboardObservedTime;
  #keyboardGeneration = 0;
  #keyboardEpoch = 0;
  #keyboardForeground;
  #keyboardAppId;
  #keyboardNow;
  #keyboardWaiters = new Set();
  #dlna;
  #dlnaConnecting;
  #dlnaReady = false;
  #dlnaOptions;
  #dispatchScope = new AsyncLocalStorage();
  #injectedTransport;
  #pointerAgent;
  #localAddress;

  constructor({ host, webOSMajor = 4, ssapClient, dlnaClient,
    pointerWebSocketFactory, keyboardNowFn = () => performance.now(), ...options } = {}) {
    this.host = validateLocalHost(host);
    this.webOSMajor = integer(webOSMajor, 'webOS major version', 1, 100);
    this.#client = ssapClient ?? new SSAPClient({ host, ...options });
    this.#localAddress = options.interfaceAddress ?? options.wake?.bindAddress ?? this.#client.localAddress;
    this.secure = options.secure ?? this.#client.secure ?? true;
    this.certificatePin = options.certificatePin ?? this.#client.certificatePin;
    if (this.certificatePin !== undefined) this.certificatePin = normalizeCertificatePin(this.certificatePin);
    this.#injectedTransport = (ssapClient !== undefined && !(ssapClient instanceof SSAPClient)) || typeof pointerWebSocketFactory === 'function';
    this.timeoutMs = options.timeoutMs ?? this.#client.timeoutMs ?? 8000;
    integer(this.timeoutMs, 'Timeout', 1, 120000);
    this.#pointerFactory = pointerWebSocketFactory ?? ((url, options) => new WebSocket(url, options));
    if (typeof keyboardNowFn !== 'function') invalid('Keyboard clock must be a function.');
    this.#keyboardNow = keyboardNowFn;
    this.#dlna = dlnaClient;
    this.#dlnaOptions = { host, interfaceAddress: options.interfaceAddress ?? options.wake?.bindAddress,
      timeoutMs: options.dlnaTimeoutMs ?? 15000 };
  }

  get registered() { return this.#client.registered && !this.#closed; }
  // A guard belongs to one trusted host operation and follows its async work.
  // It is never installed as mutable connection state or accepted from JSON.
  withDispatchGuard(assertDispatch, task) {
    if (typeof assertDispatch !== 'function' || typeof task !== 'function') invalid('A dispatch guard and operation are required.');
    const synchronousGuard = () => {
      const result = assertDispatch();
      if (result !== undefined) {
        if (types.isPromise(result)) { try { Promise.prototype.then.call(result, () => {}, () => {}); } catch {} }
        invalid('The dispatch guard must finish synchronously without a return value.', 'INVALID_DISPATCH_CALLBACK');
      }
    };
    return this.#dispatchScope.run(synchronousGuard, task);
  }
  sanitize(value) { return this.#client.sanitize(value); }
  connect() {
    if (this.#closed) return Promise.reject(new SSAPError('Create a new controller after closing it.', 'INVALID_STATE'));
    return this.#client.connect({ allowPairing: false });
  }
  close() {
    this.#closed = true;
    this.#stopKeyboard('CLIENT_CLOSED');
    this.#pointer?.terminate();
    this.#pointer = undefined;
    this.#pointerAgent?.destroy();
    this.#client.close();
    this.#dlnaReady = false;
    this.#dlna?.close?.();
  }

  async #call(uri, payload = {}, options, assertReady) {
    if (!READ_URIS.has(uri)) this.#dispatchScope.getStore()?.();
    assertReady?.();
    const focusChanging = FOCUS_CHANGING_URIS.has(uri) || /\/turn(?:On|Off)Screen$/.test(uri);
    const watching = focusChanging && this.#watchingKeyboard();
    if (focusChanging) this.invalidateKeyboardFocus();
    try {
      const result = this.sanitize(await this.#client.request(uri, payload, options));
      if (uri === URI.foreground && typeof result?.appId === 'string') this.#observeForeground(result.appId);
      return result;
    } catch (error) {
      if (!this.registered || ['NOT_REGISTERED', 'CLIENT_CLOSED'].includes(error.code)) this.#stopKeyboard('NOT_REGISTERED');
      throw new SSAPError(this.sanitize(error.message), error.code ?? 'TV_CONTROL_FAILED', this.sanitize(error.payload));
    } finally {
      if (watching && this.registered) this.startKeyboard().catch(() => {});
    }
  }

  async status() {
    const queries = ['foreground', 'audio', 'volume', 'power', 'inputs', 'sound'];
    const results = await Promise.allSettled(queries.map((name) => this.#call(URI[name])));
    return { capturedAt: new Date().toISOString(), host: this.host,
      ...Object.fromEntries(results.map((result, index) => [queries[index], result.status === 'fulfilled'
        ? { status: 'ok', payload: result.value }
        : { status: 'error', error: { code: result.reason.code, message: this.sanitize(result.reason.message) } }])),
    };
  }

  apps() { return this.#call(URI.apps); }
  async identity() {
    const [system, software] = await Promise.all([
      this.#call('ssap://system/getSystemInfo'),
      this.#call('ssap://com.webos.service.update/getCurrentSWInformation'),
    ]);
    if (system.returnValue !== true || software.returnValue !== true || typeof system.modelName !== 'string' ||
      typeof software.major_ver !== 'string' || typeof software.minor_ver !== 'string') {
      invalid('Cannot verify the TV model and firmware.', 'IDENTITY_UNVERIFIED');
    }
    return { vendor: 'LG', model: system.modelName, firmware: `${software.major_ver}.${software.minor_ver}` };
  }
  launchPoints() { return this.#call(URI.launchPoints); }
  launch(id, params = {}, contentId) {
    const payload = { id: ordinaryApp(id), params: launchParams(params) };
    if (contentId !== undefined) payload.contentId = launchContentId(contentId);
    return this.#launchOrdinary(payload);
  }
  async #launchOrdinary(payload, installed) {
    ordinaryLaunchApp(payload.id, installed ?? await this.apps());
    return this.#call(URI.launch, payload);
  }
  // Internal fixed diagnostic entry. It is deliberately absent from the MCP tool
  // schema; callers cannot choose an app ID, launch parameters or a different path.
  launchObserver(value) {
    return this.#call(URI.launch, { id: 'com.webos.app.dangbei-overlay', params: { target: observerURL(value, this.host) } });
  }
  closeApp(id) { return this.#call(URI.close, { id: ordinaryApp(id) }); }
  async waitForApp(id, { timeoutMs = 15000, pollMs = 250 } = {}) {
    normalId(id, 'Expected app ID');
    integer(timeoutMs, 'App confirmation timeout', 1, 120000);
    integer(pollMs, 'App confirmation poll interval', 1, 5000);
    const started = performance.now();
    const deadline = started + timeoutMs;
    let lastObserved;
    let lastError;
    while (performance.now() < deadline) {
      if (this.#closed) invalid('TV controller closed while waiting for app.', 'CLIENT_CLOSED');
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      try {
        lastObserved = await this.#call(URI.foreground, {}, { timeoutMs: Math.min(this.timeoutMs, remaining) });
        if (lastObserved.appId === id) {
          return { confirmed: true, appId: id, elapsedMs: Math.round(performance.now() - started), foreground: lastObserved };
        }
      } catch (error) {
        if (['NOT_REGISTERED', 'CLIENT_CLOSED', 'INVALID_STATE'].includes(error.code)) throw error;
        lastError = { code: error.code, message: this.sanitize(error.message) };
      }
      const delay = Math.min(pollMs, deadline - performance.now());
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new SSAPError('Foreground app did not reach the expected app before timeout.', 'TIMEOUT', this.sanitize({
      expectedAppId: id, lastObservedAppId: lastObserved?.appId ?? null, lastObserved,
      lastError, elapsedMs: Math.round(performance.now() - started),
    }));
  }
  async launchContent(id, content) {
    ordinaryApp(id); launchContentId(content);
    const installed = await this.apps();
    const app = installed.apps?.find((item) => item.id === id);
    if (!app) invalid('App is not present in the installed-app metadata.', 'APP_NOT_FOUND');
    ordinaryLaunchApp(id, installed);
    let template = app.deeplinkingParams ?? app.params;
    if (typeof template === 'string') {
      try { template = JSON.parse(template); } catch { invalid('App deep-link metadata is not valid JSON.', 'INVALID_CONTENT_TEMPLATE'); }
    }
    const checked = launchParams(template);
    if (!JSON.stringify(checked).includes('$CONTENTID')) invalid('App has no declared $CONTENTID deep-link template.', 'NO_CONTENT_TEMPLATE');
    const expand = (value) => {
      if (typeof value === 'string') return value.replaceAll('$CONTENTID', content);
      if (Array.isArray(value)) return value.map(expand);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
      return value;
    };
    return this.#launchOrdinary({ id, params: launchParams(expand(checked)), contentId: content }, installed);
  }
  openUrl(value) {
    return this.#call(URI.open, { target: webURL(value) });
  }
  playUrl(value, { mimeType, title = '', description = '', iconSrc = '', loop = false } = {}) {
    if (typeof mimeType !== 'string' || mimeType.length > 128 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
      invalid('mimeType must be an explicit MIME type such as video/mp4.');
    }
    return this.#call('ssap://media.viewer/open', {
      target: webURL(value), title: text(title, 'Title', 512, { empty: true }),
      description: text(description, 'Description', 2048, { empty: true }), mimeType,
      iconSrc: iconSrc === '' ? '' : webURL(iconSrc, 'Icon URL'), loop: boolean(loop, 'Loop'),
    });
  }
  async screenshot() {
    const capture = await this.#call(SCREENSHOT_ENDPOINT, { ...SCREENSHOT_OPTIONS });
    return downloadCapture(capture.imageUri, this.host, { timeoutMs: this.timeoutMs, certificatePin: this.certificatePin, localAddress: this.#localAddress,
      ...(this.#injectedTransport ? { requestFactory: (url, options, callback) => (url.protocol === 'https:' ? https : http).get(url, options, callback) } : {}) });
  }
  async #getDLNA() {
    if (this.#closed) invalid('TV controller closed.', 'CLIENT_CLOSED');
    if (this.#dlnaReady) return this.#dlna;
    if (!this.#dlnaConnecting) {
      this.#dlnaConnecting = (async () => {
        if (!this.#dlna) {
          const { DLNAClient } = await import('./dlna.mjs');
          if (this.#closed) invalid('TV controller closed before DLNA connection.', 'CLIENT_CLOSED');
          this.#dlna = new DLNAClient(this.#dlnaOptions);
        }
        await this.#dlna.connect();
        if (this.#closed) {
          this.#dlna.close?.();
          invalid('TV controller closed during DLNA connection.', 'CLIENT_CLOSED');
        }
        this.#dlnaReady = true;
        return this.#dlna;
      })();
    }
    try { return await this.#dlnaConnecting; }
    finally { this.#dlnaConnecting = undefined; }
  }
  async #dlnaCall(method, ...args) {
    let watching = false;
    try {
      const client = await this.#getDLNA();
      const assertDispatch = this.#dispatchScope.getStore();
      if (method !== 'status' && assertDispatch) {
        assertDispatch();
        args[1] = { ...(args[1] ?? {}), assertDispatch };
      }
      if (method !== 'status') { watching = this.#watchingKeyboard(); this.invalidateKeyboardFocus(); }
      return this.sanitize(await client[method](...args));
    } catch (error) {
      const wrapped = new SSAPError(this.sanitize(error.message), error.code ?? 'DLNA_FAILED', this.sanitize(error.payload));
      if (Object.hasOwn(error, 'uncertain')) wrapped.uncertain = error.uncertain;
      if (Object.hasOwn(error, 'upnpError')) wrapped.upnpError = this.sanitize(error.upnpError);
      throw wrapped;
    } finally {
      if (watching && this.registered) this.startKeyboard().catch(() => {});
    }
  }
  dlnaStatus() { return this.#dlnaCall('status'); }
  dlnaPlay(value, { mimeType, title = '' } = {}) {
    if (typeof mimeType !== 'string' || mimeType.length > 128 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
      invalid('mimeType must be an explicit MIME type such as video/mp4.');
    }
    return this.#dlnaCall('play', webURL(value), { mimeType, title: text(title, 'Title', 512, { empty: true }) });
  }
  dlnaMedia(action) {
    if (!['play', 'pause', 'stop'].includes(action)) invalid('DLNA media action must be play, pause or stop.');
    return this.#dlnaCall('media', action);
  }
  // Focus telemetry is a short-lived observation, never proof of inserted text.
  #clearKeyboardEvidence() {
    this.#keyboardGeneration++;
    this.#keyboardSnapshot = undefined;
    this.#keyboardObservedAt = undefined;
    this.#keyboardObservedTime = undefined;
  }
  #watchingKeyboard() { return Boolean(this.#keyboardStarting || this.#keyboardSubscription || this.#keyboardForeground || this.#keyboardWaiters.size); }
  invalidateKeyboardFocus() {
    this.#keyboardEpoch++;
    this.#clearKeyboardEvidence();
    this.#keyboardAppId = undefined;
    this.#keyboardStarting = undefined;
    for (const subscription of [this.#keyboardSubscription, this.#keyboardForeground]) {
      try { subscription?.unsubscribe(); } catch {}
    }
    this.#keyboardSubscription = undefined; this.#keyboardForeground = undefined;
  }
  #stopKeyboard(code = 'IME_SUBSCRIPTION_FAILED') {
    this.invalidateKeyboardFocus();
    for (const waiter of [...this.#keyboardWaiters]) waiter.finish(new SSAPError('Keyboard observation is unavailable.', code));
  }
  #observeForeground(appId) {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(appId)) { this.#stopKeyboard(); return; }
    if (this.#keyboardAppId === undefined) { this.#keyboardAppId = appId; this.#clearKeyboardEvidence(); }
    else if (appId !== this.#keyboardAppId) {
      const watching = this.#watchingKeyboard(); this.invalidateKeyboardFocus();
      if (watching && this.registered) this.startKeyboard().catch(() => {});
    }
  }
  #keyboardView(maxAgeMs) {
    const age = this.#keyboardObservedTime === undefined ? undefined : this.#keyboardNow() - this.#keyboardObservedTime;
    const fresh = this.registered && Number.isFinite(age) && age >= 0 && age <= maxAgeMs && this.#keyboardSnapshot !== undefined;
    return { subscribed: Boolean(this.#keyboardSubscription && this.#keyboardForeground), pending: Boolean(this.#keyboardStarting),
      focusKnown: fresh, focused: fresh ? (this.#keyboardSnapshot.currentWidget?.focus ?? this.#keyboardSnapshot.focus) : null,
      fresh, generation: this.#keyboardGeneration, observedAt: this.#keyboardObservedAt ?? null,
      ageMs: Number.isFinite(age) && age >= 0 ? Math.floor(age) : null };
  }
  #notifyKeyboardWaiters() {
    for (const waiter of [...this.#keyboardWaiters]) {
      if (this.#keyboardView(waiter.maxAgeMs).focusKnown) waiter.finish();
    }
  }
  typeText(value, options = {}) {
    const { replace = false, timeoutMs = this.timeoutMs, maxAgeMs = KEYBOARD_MAX_AGE_MS } = keyboardOptions(options, ['replace', 'timeoutMs', 'maxAgeMs']);
    const payload = { text: text(value, 'Text', 8192, { empty: true }), replace: boolean(replace, 'replace') };
    integer(timeoutMs, 'Text request timeout', 1, 120000); integer(maxAgeMs, 'Keyboard maximum age', 1, KEYBOARD_MAX_AGE_MS);
    if (this.#closed) return Promise.reject(new SSAPError('TV controller closed.', 'CLIENT_CLOSED'));
    const evidence = this.#keyboardView(maxAgeMs);
    // No delayed insertion: a caller must obtain fresh focus before asking to type.
    if (!evidence.focusKnown || evidence.focused !== true) {
      return Promise.reject(new SSAPError('No fresh confirmed TV text focus; text was not sent.', 'IME_FOCUS_UNVERIFIED'));
    }
    return Promise.resolve().then(async () => {
      const current = this.#keyboardView(maxAgeMs);
      if (!current.focusKnown || current.focused !== true || current.generation !== evidence.generation) {
        invalid('TV text focus changed before insertion; text was not sent.', 'IME_NOT_FOCUSED');
      }
      try {
        const result = await this.#call(URI.text, payload, { timeoutMs }, () => {
          const dispatch = this.#keyboardView(maxAgeMs);
          if (!dispatch.focusKnown || dispatch.focused !== true || dispatch.generation !== evidence.generation) invalid('TV text focus changed before insertion.', 'IME_NOT_FOCUSED');
        });
        return { returnValue: result.returnValue === true, focusConfirmed: true, insertionConfirmed: false };
      } catch (error) {
        throw new SSAPError('TV rejected the text insertion request; do not blindly repeat it.', error.code ?? 'TEXT_INSERT_FAILED');
      }
    });
  }
  async startKeyboard(options = {}) {
    const { timeoutMs = this.timeoutMs } = keyboardOptions(options, ['timeoutMs']);
    integer(timeoutMs, 'Keyboard registration timeout', 1, 120000);
    if (this.#closed) invalid('TV controller closed.', 'CLIENT_CLOSED');
    if (!this.registered) { this.#stopKeyboard('NOT_REGISTERED'); invalid('Connect before observing keyboard focus.', 'NOT_REGISTERED'); }
    if (this.#keyboardSubscription && this.#keyboardForeground) return { subscribed: true };
    if (!this.#keyboardStarting) {
      const epoch = ++this.#keyboardEpoch;
      this.#clearKeyboardEvidence();
      const active = () => !this.#closed && this.registered && epoch === this.#keyboardEpoch;
      const failed = () => { if (epoch === this.#keyboardEpoch) this.#stopKeyboard('IME_SUBSCRIPTION_FAILED'); };
      // LG ConnectSDK subscribes to getForegroundAppInfo and registerRemoteKeyboard.
      // https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/master/src/com/connectsdk/service/WebOSTVService.java
      const starting = (async () => {
        const foreground = await this.#client.subscribe(URI.foreground, {}, { timeoutMs,
          onUpdate: payload => {
            if (active() && payload && typeof payload === 'object' && !types.isProxy(payload) && Object.hasOwn(payload, 'appId')) this.#observeForeground(keyboardField(payload, 'appId'));
          }, onError: failed });
        if (!active()) { foreground.unsubscribe(); invalid('Keyboard context changed.', this.#closed ? 'CLIENT_CLOSED' : 'IME_CONTEXT_CHANGED'); }
        this.#keyboardForeground = foreground;
        const keyboard = await this.#client.subscribe(URI.keyboard, {}, { timeoutMs,
          onUpdate: payload => {
            if (!active() || !payload || typeof payload !== 'object' || types.isProxy(payload) ||
                !(Object.hasOwn(payload, 'currentWidget') || Object.hasOwn(payload, 'focus'))) return;
            const focus = Object.hasOwn(payload, 'currentWidget') ? keyboardField(keyboardField(payload, 'currentWidget'), 'focus') : keyboardField(payload, 'focus');
            if (typeof focus !== 'boolean' || this.#keyboardAppId === undefined) { this.#clearKeyboardEvidence(); return; }
            this.#keyboardGeneration++;
            this.#keyboardSnapshot = Object.hasOwn(payload, 'currentWidget')
              ? Object.freeze({ currentWidget: Object.freeze({ focus }) }) : Object.freeze({ focus });
            this.#keyboardObservedTime = this.#keyboardNow(); this.#keyboardObservedAt = new Date().toISOString();
            this.#notifyKeyboardWaiters();
          }, onError: failed });
        if (!active()) { keyboard.unsubscribe(); invalid('Keyboard context changed.', this.#closed ? 'CLIENT_CLOSED' : 'IME_CONTEXT_CHANGED'); }
        this.#keyboardSubscription = keyboard;
        return { subscribed: true };
      })().catch(() => { throw new SSAPError('Keyboard subscription is unavailable.', this.#closed ? 'CLIENT_CLOSED' : 'IME_SUBSCRIPTION_FAILED'); });
      this.#keyboardStarting = starting;
      starting.then(() => { if (this.#keyboardStarting === starting) this.#keyboardStarting = undefined; }, () => {
        if (epoch === this.#keyboardEpoch) failed();
        if (this.#keyboardStarting === starting) this.#keyboardStarting = undefined;
      });
    }
    return this.#keyboardStarting;
  }
  observeKeyboard(options = {}) {
    const { waitMs = 0, maxAgeMs = KEYBOARD_MAX_AGE_MS, signal } = keyboardOptions(options, ['waitMs', 'maxAgeMs', 'signal']);
    integer(waitMs, 'Keyboard wait', 0, 30000); integer(maxAgeMs, 'Keyboard maximum age', 1, KEYBOARD_MAX_AGE_MS); keyboardSignal(signal);
    if (this.#closed) return Promise.reject(new SSAPError('TV controller closed.', 'CLIENT_CLOSED'));
    if (signal?.aborted) return Promise.reject(new SSAPError('Keyboard observation cancelled.', 'ABORT_ERR'));
    if (waitMs > 0 && this.#keyboardWaiters.size >= 32) return Promise.reject(new SSAPError('Too many keyboard observations are pending.', 'IME_WAIT_LIMIT'));
    if (this.#keyboardSnapshot !== undefined && !this.#keyboardView(maxAgeMs).focusKnown && this.#keyboardSubscription && !this.#keyboardStarting) this.invalidateKeyboardFocus();
    const ready = this.startKeyboard({ timeoutMs: Math.min(waitMs || this.timeoutMs, this.timeoutMs) });
    if (waitMs === 0) { ready.catch(() => {}); return Promise.resolve(this.#keyboardView(maxAgeMs)); }
    return new Promise((resolve, reject) => {
      const waiter = { maxAgeMs, finish: error => {
        if (!this.#keyboardWaiters.delete(waiter)) return;
        clearTimeout(waiter.timer); signal?.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve(this.#keyboardView(maxAgeMs));
      } };
      const cancelled = () => waiter.finish(new SSAPError('Keyboard observation cancelled.', 'ABORT_ERR'));
      waiter.timer = setTimeout(() => waiter.finish(new SSAPError('No fresh keyboard focus event arrived; acknowledgement is not focus.', 'TIMEOUT')), waitMs);
      this.#keyboardWaiters.add(waiter); signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) { cancelled(); return; }
      ready.then(() => this.#notifyKeyboardWaiters(), () => waiter.finish(new SSAPError('Keyboard observation is unavailable.', this.#closed ? 'CLIENT_CLOSED' : 'IME_SUBSCRIPTION_FAILED')));
      this.#notifyKeyboardWaiters();
    });
  }
  async keyboardState(options = {}) {
    const { timeoutMs = this.timeoutMs, maxAgeMs = KEYBOARD_MAX_AGE_MS, signal } = keyboardOptions(options, ['timeoutMs', 'maxAgeMs', 'signal']);
    integer(timeoutMs, 'Keyboard state timeout', 1, 30000);
    await this.observeKeyboard({ waitMs: timeoutMs, maxAgeMs, ...(signal === undefined ? {} : { signal }) });
    if (!this.#keyboardView(maxAgeMs).focusKnown) invalid('Keyboard context changed.', 'IME_CONTEXT_CHANGED');
    return this.#keyboardSnapshot;
  }
  // Explicit Enter is kept independent of text insertion's focus gate.
  sendEnter() { return this.startKeyboard().then(() => this.#call(URI.enter)); }
  media(action) {
    if (!Object.hasOwn(mediaMethods, action)) invalid('Media action must be play, pause, stop, rewind or fastForward.');
    return this.#call(`ssap://media.controls/${mediaMethods[action]}`);
  }
  setVolume(value) { return this.#call(URI.setVolume, { volume: integer(value, 'Volume', 0, 100) }); }
  mute(value) { return this.#call(URI.mute, { mute: boolean(value, 'Mute') }); }
  setInput(id) { return this.#call(URI.input, { inputId: normalId(id, 'Input ID') }); }
  soundOutput(id) { return this.#call(URI.changeSound, { output: normalId(id, 'Sound output ID') }); }
  screen(on) {
    boolean(on, 'Screen state');
    const service = this.webOSMajor < 5 ? 'com.webos.service.tv.power' : 'com.webos.service.tvpower/power';
    return this.#call(`ssap://${service}/${on ? 'turnOnScreen' : 'turnOffScreen'}`, { standbyMode: 'active' });
  }
  powerOff() { return this.#call(URI.off); }

  async #getPointer() {
    if (this.#closed || !this.#client.registered) invalid('Connect the controller before sending remote input.', 'NOT_REGISTERED');
    if (this.#pointer?.readyState === 1) return this.#pointer;
    if (this.#pointerConnecting) return this.#pointerConnecting;
    this.#pointerConnecting = (async () => {
      const response = await this.#call(POINTER_ENDPOINT);
      const url = validatePointerURL(response.socketPath, this.host);
      if (!this.#injectedTransport && url.protocol !== 'wss:') invalid('Pointer transport must use pinned WSS; plaintext downgrade refused.', 'TLS_REQUIRED');
      if (this.#closed) invalid('Controller closed before pointer connection.', 'CLIENT_CLOSED');
      return new Promise((resolve, reject) => {
        let completed = false;
        const finish = (error) => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          if (error) { socket?.terminate(); reject(error); }
          else resolve(socket);
        };
        let socket;
        const timer = setTimeout(() => finish(new SSAPError('Pointer connection timed out.', 'TIMEOUT')), this.timeoutMs);
        try {
          const options = { handshakeTimeout: this.timeoutMs, followRedirects: false, maxPayload: 65536 };
          if (!this.#injectedTransport) {
            this.#pointerAgent?.destroy();
            this.#pointerAgent = createPinnedTVAgent({ host: this.host, certificatePin: this.certificatePin,
              timeoutMs: this.timeoutMs, localAddress: this.#localAddress });
            options.agent = this.#pointerAgent;
          }
          socket = this.#pointerFactory(url.href, options);
          this.#pointer = socket;
          socket.on('open', () => finish());
          socket.on('error', error => finish(new SSAPError('Pointer transport error.', /^(?:TLS_[A-Z_]+|INVALID_SOURCE_ADDRESS|SOURCE_ADDRESS_UNAVAILABLE)$/.test(error?.code ?? '') ? error.code : 'POINTER_ERROR')));
          socket.on('close', () => {
            if (this.#pointer === socket) this.#pointer = undefined;
            finish(new SSAPError('Pointer connection closed.', 'POINTER_CLOSED'));
          });
        } catch (error) { finish(new SSAPError('Cannot open TV pointer connection.', /^(?:TLS_[A-Z_]+|INVALID_SOURCE_ADDRESS|SOURCE_ADDRESS_UNAVAILABLE)$/.test(error?.code ?? '') ? error.code : 'POINTER_ERROR')); }
      });
    })();
    try { return await this.#pointerConnecting; }
    finally { this.#pointerConnecting = undefined; }
  }

  async #sendPointer(type, fields = {}) {
    const socket = await this.#getPointer();
    const message = [`type:${type}`, ...Object.entries(fields).map(([key, value]) => `${key}:${value}`)].join('\n') + '\n\n';
    this.#dispatchScope.getStore()?.();
    const watching = this.#watchingKeyboard();
    this.invalidateKeyboardFocus();
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        socket.off('error', fail);
        socket.off('close', closed);
        if (error) {
          // A timed-out send can leave a half-open pointer channel even while
          // SSAP reads work. Drop it without replaying the ambiguous input.
          if (this.#pointer === socket) {
            this.#pointer = undefined; this.#pointerAgent?.destroy();
            this.#pointerAgent = undefined;
          }
          socket.terminate(); reject(error);
        }
        else resolve({ sent: true, transport: 'pointer', acknowledged: false });
        if (watching && this.registered) this.startKeyboard().catch(() => {});
      };
      const fail = () => finish(new SSAPError('Pointer input transport failed.', 'POINTER_ERROR'));
      const closed = () => finish(new SSAPError('Pointer input connection closed.', 'POINTER_CLOSED'));
      const timer = setTimeout(() => finish(new SSAPError('Pointer send timed out.', 'TIMEOUT')), this.timeoutMs);
      socket.once('error', fail); socket.once('close', closed);
      try { socket.send(message, (error) => finish(error ? new SSAPError('Unable to send pointer input.', 'POINTER_ERROR') : undefined)); }
      catch { fail(); }
    });
  }
  key(name) {
    if (typeof name !== 'string' || !keySet.has(name.toUpperCase())) invalid('Remote key is not in the ordinary remote-button allowlist.', 'INVALID_KEY');
    return this.#sendPointer('button', { name: name.toUpperCase() });
  }
  move(dx, dy) {
    return this.#sendPointer('move', { dx: integer(dx, 'dx', -10000, 10000), dy: integer(dy, 'dy', -10000, 10000), down: 0 });
  }
  click() { return this.#sendPointer('click'); }
  scroll(dx, dy) {
    return this.#sendPointer('scroll', { dx: integer(dx, 'dx', -1000, 1000), dy: integer(dy, 'dy', -1000, 1000) });
  }
  wake(mac, broadcastOrOptions, bindAddress) {
    const options = typeof broadcastOrOptions === 'string' ? { broadcast: broadcastOrOptions, bindAddress } : (broadcastOrOptions ?? {});
    return wakeTV(mac, { ...options, assertDispatch: this.#dispatchScope.getStore() });
  }
  static wake(mac, options) { return wakeTV(mac, options); }
}

export function createMagicPacket(mac) {
  if (typeof mac !== 'string' || !/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2})$/i.test(mac)) {
    invalid('MAC must contain six hexadecimal bytes.', 'INVALID_MAC');
  }
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  if ((bytes[0] & 1) || bytes.every((byte) => byte === 0)) invalid('Use the TV\'s unicast MAC address.', 'INVALID_MAC');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

export async function wakeTV(mac, { broadcast = '255.255.255.255', bindAddress, port = 9,
  timeoutMs = 5000, socketFactory = () => dgram.createSocket('udp4'), assertDispatch } = {}) {
  const packet = createMagicPacket(mac);
  if (isIP(broadcast) !== 4) invalid('Wake address must be a literal IPv4 address.');
  if (broadcast !== '255.255.255.255') validateLocalHost(broadcast);
  if (bindAddress !== undefined) {
    if (isIP(bindAddress) !== 4) invalid('Wake bind address must be a local IPv4 address.');
    validateLocalHost(bindAddress);
  }
  integer(port, 'UDP port', 1, 65535); integer(timeoutMs, 'Wake timeout', 1, 120000);
  return new Promise((resolve, reject) => {
    let socket; let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket?.close(); } catch {}
      if (error) reject(error);
      else resolve({ sent: true, transport: 'udp', address: broadcast, port, acknowledged: false });
    };
    const timer = setTimeout(() => finish(new SSAPError('Wake packet timed out.', 'TIMEOUT')), timeoutMs);
    try {
      socket = socketFactory();
      socket.once('error', () => finish(new SSAPError('Cannot send wake packet.', 'WAKE_FAILED')));
      socket.bind(0, bindAddress, () => {
        if (settled) return;
        try { assertDispatch?.(); } catch (error) { finish(error); return; }
        try {
          socket.setBroadcast(true);
          socket.send(packet, port, broadcast, (error) => finish(error ? new SSAPError('Cannot send wake packet.', 'WAKE_FAILED') : undefined));
        } catch { finish(new SSAPError('Cannot send wake packet.', 'WAKE_FAILED')); }
      });
    } catch { finish(new SSAPError('Cannot create wake socket.', 'WAKE_FAILED')); }
  });
}
