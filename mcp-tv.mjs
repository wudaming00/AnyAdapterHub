import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { validateMediaRoots } from './lib/media-host.mjs';
import { resolveTVKey } from './lib/security/credentials.mjs';

// MCP stdio framing, lifecycle and tools are implemented against the pinned spec:
// https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
// https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
// https://modelcontextprotocol.io/specification/2025-06-18/server/tools
export const PROTOCOL_VERSION = '2025-06-18';
const VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '.lg-tv.local.json');
const MAX_MESSAGE_BYTES = 1024 * 1024;
const SECRET_FIELD = /^(?:clientkey|accesstoken|refreshtoken|token|password|passphrase|secret|authorization|cookie|setcookie|socketpath)$/i;
const IDENTIFIER = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const BOOLEAN = { type: 'boolean' };
const HTTP_URL = { type: 'string', minLength: 1, maxLength: 4096, format: 'uri' };
const DELTA = { type: 'integer', minimum: -10000, maximum: 10000 };
const SCROLL_DELTA = { type: 'integer', minimum: -1000, maximum: 1000 };
const MIME_TYPE = { type: 'string', minLength: 1, maxLength: 128 };
const DLNA_TOOLS = new Set(['tv_dlna_play', 'tv_dlna_status', 'tv_dlna_media', 'tv_cast_file']);
const UNSAFE_URL_ADDRESSES = { 4: new net.BlockList(), 6: new net.BlockList() };
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  UNSAFE_URL_ADDRESSES[4].addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 96], ['::ffff:0:0', 96], ['fe80::', 10], ['ff00::', 8]]) {
  UNSAFE_URL_ADDRESSES[6].addSubnet(address, prefix, 'ipv6');
}
const KEYS = ['HOME', 'BACK', 'ENTER', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'EXIT', 'MENU', 'QMENU',
  'INFO', 'GUIDE', 'RED', 'GREEN', 'YELLOW', 'BLUE', 'PLAY', 'PAUSE', 'STOP', 'REWIND',
  'FASTFORWARD', 'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE', 'CC',
  'LIST', 'SEARCH', 'MYAPPS', 'RECENT', 'NETFLIX', 'AMAZON', 'INPUT_HUB', 'TV',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function tool(name, description, properties, required = [], { readOnly = false, idempotent = false, openWorld = false } = {}) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld } };
}

export const TV_TOOLS = [
  tool('tv_status', 'Read the TV state and current app. A running app does not prove a particular title is playing.', {}, [], { readOnly: true, idempotent: true }),
  tool('tv_apps', 'List installed TV launch points and app IDs.', {}, [], { readOnly: true, idempotent: true }),
  tool('tv_keyboard_state', 'Read whether a TV text field has focus; no keyboard input is sent.', {}, [], { readOnly: true, idempotent: true }),
  tool('tv_screenshot', 'Capture the current TV display as an image. This may fail or omit protected video; a screenshot alone does not prove playback.', {}, [], { readOnly: true, idempotent: true }),
  tool('tv_observe', 'Temporarily open transparent TV diagnostics to read internal foreground and player state and capture the screen, then close the overlay and verify the original app. Requires compatible webOS. Player activity can be a homepage preview and does not verify a title.', {}),
  tool('tv_launch', 'Launch an installed ordinary TV app and verify its foreground ID. Agent-supplied launch params must be empty; HTTP(S) content IDs require a locally allowedUrlOrigins origin. Foreground confirmation does not verify content playback.',
    { id: IDENTIFIER, params: { type: 'object', properties: {}, maxProperties: 0, additionalProperties: false }, contentId: { type: 'string', minLength: 1, maxLength: 4096 } }, ['id']),
  tool('tv_launch_content', 'Launch content using an installed ordinary app\'s own $CONTENTID template, then verify foreground. Supply a known provider ID or an HTTP(S) URL whose origin is in local allowedUrlOrigins. Foreground confirmation does not verify the title is playing.',
    { id: IDENTIFIER, content: { type: 'string', minLength: 1, maxLength: 4096 } }, ['id', 'content']),
  tool('tv_open_url', 'Open an HTTP(S) URL whose exact origin is in locally configured allowedUrlOrigins. This does not guarantee media playback. Origin policy does not verify TV DNS results or redirects.',
    { url: HTTP_URL }, ['url'], { openWorld: true }),
  tool('tv_play_url', 'Ask the native TV media viewer to play a direct HTTP(S) media URL with an explicit MIME type. Media and icon origins require local allowedUrlOrigins. Provider web pages are unsuitable. The result reports acceptance only; playback is unverified.',
    { url: HTTP_URL, mimeType: MIME_TYPE,
      title: { type: 'string', maxLength: 512 }, description: { type: 'string', maxLength: 2048 }, iconSrc: HTTP_URL, loop: BOOLEAN }, ['url', 'mimeType'], { openWorld: true }),
  tool('tv_dlna_play', 'Send a direct, unprotected HTTP(S) media URL with an explicit MIME type to the TV DLNA renderer. The exact origin must be in local allowedUrlOrigins. Provider web pages are unsuitable. Confirmation checks renderer state, not the visible title.',
    { url: HTTP_URL, mimeType: MIME_TYPE, title: { type: 'string', maxLength: 512 } }, ['url', 'mimeType'], { openWorld: true }),
  tool('tv_dlna_status', 'Read the TV DLNA renderer transport state. This describes the DLNA session only and does not reveal playback inside Disney+ or other TV apps.', {}, [], { readOnly: true, idempotent: true }),
  tool('tv_dlna_media', 'Explicitly play, pause or stop the TV DLNA renderer and verify its transport state. This does not control playback inside Disney+ or other TV apps.',
    { action: { type: 'string', enum: ['play', 'pause', 'stop'] } }, ['action'], { idempotent: true }),
  tool('tv_cast_file', 'Cast one selected local audio/video file within explicitly configured mediaRoots to the TV for native DLNA decoding. A supported media extension is required and any MIME type must match it. The temporary file listener permits only this TV and stays available until replacement, confirmed DLNA stop or server exit. Network shares and streaming-provider pages are unsupported.',
    { filePath: { type: 'string', minLength: 1, maxLength: 32768 }, mimeType: MIME_TYPE, title: { type: 'string', maxLength: 512 } }, ['filePath']),
  tool('tv_type_text', 'Type text into the focused TV input. replace=true replaces the current field. Text is not echoed in results.',
    { text: { type: 'string', minLength: 1, maxLength: 4096 }, replace: BOOLEAN }, ['text']),
  tool('tv_key', 'Send one named remote key to the TV.', { key: { type: 'string', enum: KEYS } }, ['key']),
  tool('tv_pointer_move', 'Move the TV pointer by relative pixel offsets.', { dx: DELTA, dy: DELTA }, ['dx', 'dy']),
  tool('tv_pointer_click', 'Click once at the TV pointer location.', {}),
  tool('tv_pointer_scroll', 'Scroll at the TV pointer location using relative offsets.', { dx: SCROLL_DELTA, dy: SCROLL_DELTA }, ['dx', 'dy']),
  tool('tv_media', 'Send a media command to the active TV player. The active app determines which commands work.',
    { action: { type: 'string', enum: ['play', 'pause', 'stop', 'rewind', 'fastForward'] } }, ['action']),
  tool('tv_set_volume', 'Set TV volume from 0 through 100, then read back the value. An accepted request with missing or different readback is unconfirmed.', { volume: { type: 'integer', minimum: 0, maximum: 100 } }, ['volume'], { idempotent: true }),
  tool('tv_mute', 'Explicitly set TV mute on or off, then read back its mute state.', { muted: BOOLEAN }, ['muted'], { idempotent: true }),
  tool('tv_set_input', 'Switch to a TV-reported input ID and verify the appId declared for that input. No app ID is guessed when input metadata is missing.', { id: IDENTIFIER }, ['id'], { idempotent: true }),
  tool('tv_sound_output', 'Select a TV audio output ID, such as tv_speaker or external_arc.', { id: IDENTIFIER }, ['id'], { idempotent: true }),
  tool('tv_screen', 'Explicitly turn the picture on or off while leaving the TV powered.', { on: BOOLEAN }, ['on'], { idempotent: true }),
  tool('tv_power', 'Explicitly power off the TV or send Wake-on-LAN using its saved MAC. Wake transmission does not prove the TV woke.',
    { action: { type: 'string', enum: ['off', 'wake'] } }, ['action'], { idempotent: true }),
];
const TOOL_MAP = new Map(TV_TOOLS.map(t => [t.name, t]));

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = message => { throw new RpcError(-32602, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(schema, value, label) {
  if (schema.type === 'object') {
    if (!object(value)) invalid(`${label} must be an object`);
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) invalid(`${label} has too many properties`);
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) invalid(`${label}.${required} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) {
        if (schema.additionalProperties === false) invalid(`${label} has an unknown property`);
      } else validate(schema.properties[key], item, `${label}.${key}`);
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') invalid(`${label} must be a string`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) invalid(`${label} is empty`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) invalid(`${label} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid(`${label} contains unsupported characters`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) invalid(`${label} must be an integer`);
    if (value < schema.minimum || value > schema.maximum) invalid(`${label} is outside the allowed range`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') invalid(`${label} must be a boolean`);
  if (schema.enum && !schema.enum.includes(value)) invalid(`${label} is not an allowed value`);
}

function privateHost(host) {
  if (net.isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function safeUrlOrigin(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host ||
    host === 'localhost' || host.endsWith('.localhost') ||
    (family && (UNSAFE_URL_ADDRESSES[family].check(host, family === 4 ? 'ipv4' : 'ipv6') ||
      (family === 4 && host.endsWith('.255')))) ||
    (!family && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) {
    throw new Error('HTTP(S) URL origin is unsafe or contains credentials.');
  }
  return url.origin;
}
function allowedUrlOrigins(value = []) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('allowedUrlOrigins must be an array of at most 64 exact HTTP(S) origins.');
  return [...new Set(value.map(origin => {
    let url;
    try { if (typeof origin !== 'string' || origin.length > 4096) throw new Error(); url = new URL(origin); }
    catch { throw new Error('allowedUrlOrigins contains an invalid HTTP(S) origin.'); }
    const canonical = safeUrlOrigin(url);
    if (url.search || url.hash || url.pathname !== '/' || (origin !== canonical && origin !== canonical + '/')) {
      throw new Error('allowedUrlOrigins entries must be exact canonical origins without paths, queries or fragments.');
    }
    return canonical;
  }))];
}
function contentHttpUrl(value) {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url : undefined; }
  catch { return undefined; }
}

export async function loadPrivateConfig({ configPath = DEFAULT_CONFIG, host, env = process.env, readFile = fs.readFile, resolveKey = resolveTVKey } = {}) {
  let saved;
  try { saved = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') saved = {};
    else throw new Error('Unable to read the private TV configuration.');
  }
  if (!object(saved)) throw new Error('Private TV configuration must be a JSON object.');
  const devices = object(saved.devices) ? saved.devices : {};
  const candidates = Object.keys(devices);
  const selectedHost = host || env.LG_TV_HOST || saved.host || (candidates.length === 1 ? candidates[0] : undefined);
  if (!privateHost(selectedHost)) throw new Error('Select a private LAN IPv4 TV address with --host or LG_TV_HOST.');
  const profile = object(devices[selectedHost]) ? devices[selectedHost] : saved;
  // Copy only known connection fields. Loading never pairs, persists a key, or edits config.
  return { host: selectedHost, clientKey: await resolveKey(profile, selectedHost), permissions: profile.permissions,
    certificatePin: profile.certificatePin,
    port: profile.port, secure: profile.secure, timeoutMs: profile.timeoutMs, webOSMajor: profile.webOSMajor,
    registrationManifest: profile.registrationManifest,
    allowTemporaryObserver: profile.allowTemporaryObserver === true,
    mediaRoots: validateMediaRoots(profile.mediaRoots),
    allowedUrlOrigins: allowedUrlOrigins(profile.allowedUrlOrigins),
    mac: profile.mac ?? profile.wake?.mac,
    wake: object(profile.wake) ? profile.wake : {} };
}

function scrubText(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, match => {
    try {
      const url = new URL(match);
      if (url.username || url.password) { url.username = 'redacted'; url.password = ''; }
      for (const key of [...url.searchParams.keys()]) {
        if (/token|key|auth|password|secret|signature|credential/i.test(key)) url.searchParams.set(key, '[redacted]');
      }
      return url.href;
    } catch { return '[redacted URL]'; }
  });
}

export function redactOutput(value, secrets = [], depth = 0) {
  if (depth > 20) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 2000).map(v => redactOutput(v, secrets, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SECRET_FIELD.test(key.replace(/[-_]/g, '')) ? '[redacted]' : redactOutput(item, secrets, depth + 1)]));
  if (typeof value === 'string') return scrubText(value, secrets);
  if (typeof value === 'bigint') return value.toString();
  return value ?? null;
}

async function defaultFactory(config) {
  const { TVController } = await import('./lib/tv-controller.mjs');
  return new TVController(config);
}
async function defaultWake(mac, options) {
  const { TVController } = await import('./lib/tv-controller.mjs');
  return TVController.wake(mac, options);
}
async function defaultMediaHostFactory(options) {
  const { LocalMediaHost } = await import('./lib/media-host.mjs');
  return new LocalMediaHost(options);
}
async function defaultObserver(controller, options) {
  const { observeTV } = await import('./lib/tv-observer.mjs');
  return observeTV(controller, options);
}

function acceptedRequest(request) {
  return { requestAccepted: typeof request?.returnValue === 'boolean' ? request.returnValue : null,
    confirmed: false, request };
}
function statusPayload(snapshot, name) {
  return snapshot?.[name]?.status === 'ok' ? snapshot[name].payload : undefined;
}
function stateValue(snapshot, kind) {
  const volume = statusPayload(snapshot, 'volume');
  const audio = statusPayload(snapshot, 'audio');
  const candidates = kind === 'volume'
    ? [volume?.volumeStatus?.volume, volume?.volume, audio?.volumeStatus?.volume, audio?.volume]
    : [audio?.mute, audio?.muted, volume?.volumeStatus?.muted, volume?.volumeStatus?.mute,
      volume?.muted, volume?.mute, audio?.volumeStatus?.muted, audio?.volumeStatus?.mute];
  return candidates.find(value => kind === 'volume' ? Number.isFinite(value) : typeof value === 'boolean');
}

export class TVMcpServer {
  constructor({ loadConfig = loadPrivateConfig, controllerFactory = defaultFactory, wake = defaultWake,
    mediaHostFactory = defaultMediaHostFactory, observer = defaultObserver } = {}) {
    this.loadConfig = loadConfig;
    this.controllerFactory = controllerFactory;
    this.wake = wake;
    this.mediaHostFactory = mediaHostFactory;
    this.observer = observer;
    this.mediaHost = undefined;
    this.closed = false;
    this.initializing = false;
    this.ready = false;
    this.callQueue = Promise.resolve();
  }

  // Each complete command plus its verification finishes before another tool runs.
  // Config is still reloaded for each call so an explicitly replaced saved key is used.
  callTool(name, args) {
    if (this.closed) throw new RpcError(-32000, 'MCP server is closing');
    const result = this.callQueue.then(() => this.executeTool(name, args));
    this.callQueue = result.catch(() => {});
    return result;
  }

  async releaseMediaHost() {
    const host = this.mediaHost;
    this.mediaHost = undefined;
    if (host) await host.close();
  }

  close() {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.callQueue.then(() => this.releaseMediaHost());
    }
    return this.closePromise;
  }

  async confirmForeground(controller, request, expectedAppId, contentRequested = false) {
    const result = { ...acceptedRequest(request), verificationScope: 'foreground_app', expectedAppId,
      foregroundVerified: false, ...(contentRequested ? { contentPlaybackVerified: false } : {}) };
    if (result.requestAccepted === false) {
      result.error = { code: 'REQUEST_REJECTED', message: 'The TV rejected the app request.' };
      return result;
    }
    try {
      const observed = await controller.waitForApp(expectedAppId, { timeoutMs: 15000, pollMs: 250 });
      result.verification = observed;
      result.foregroundVerified = observed?.confirmed === true && observed.foreground?.appId === expectedAppId;
      result.confirmed = result.foregroundVerified;
      if (!result.confirmed) result.error = { code: 'STATE_NOT_CONFIRMED', message: 'Foreground evidence did not match the requested app.' };
    } catch (error) {
      result.lastObserved = error.payload?.lastObserved ?? null;
      result.lastObservedAppId = error.payload?.lastObservedAppId ?? null;
      result.error = { code: error.code ?? 'STATE_NOT_CONFIRMED', message: error.message ?? 'Foreground state could not be confirmed.' };
    }
    return result;
  }

  async confirmValue(controller, request, kind, expected) {
    const result = { ...acceptedRequest(request), verificationScope: kind, expected, observed: null };
    if (result.requestAccepted === false) {
      result.error = { code: 'REQUEST_REJECTED', message: 'The TV rejected the state request.' };
      return result;
    }
    try {
      const snapshot = await controller.status();
      result.observed = stateValue(snapshot, kind) ?? null;
      result.capturedAt = snapshot?.capturedAt;
      result.confirmed = result.observed === expected;
      if (!result.confirmed) result.error = { code: 'STATE_NOT_CONFIRMED', message: 'TV readback is missing or does not match the requested state.' };
    } catch (error) {
      result.error = { code: error.code ?? 'STATE_NOT_CONFIRMED', message: error.message ?? 'TV state could not be read back.' };
    }
    return result;
  }

  async executeTool(name, args) {
    const definition = TOOL_MAP.get(name);
    if (!definition) invalid('Unknown TV tool');
    validate(definition.inputSchema, args, 'arguments');
    for (const value of [args.url, args.iconSrc].filter(value => value !== undefined)) {
      let url;
      try { url = new URL(value); } catch { invalid('URL arguments must be absolute HTTP(S) URLs'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('URL arguments must be HTTP(S) URLs without credentials');
    }
    if (args.mimeType && !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(args.mimeType)) invalid('arguments.mimeType must be a media type such as video/mp4');
    if (name === 'tv_cast_file' && (!path.isAbsolute(args.filePath) || /^(?:\\\\|\/\/)/.test(args.filePath) || args.filePath.includes('\0'))) {
      invalid('arguments.filePath must be an absolute local file path; network shares are unsupported');
    }
    if (args.params && Buffer.byteLength(JSON.stringify(args.params)) > 16384) invalid('arguments.params is too large');
    if (['tv_launch', 'tv_launch_content'].includes(name)) {
      const content = name === 'tv_launch' ? args.contentId : args.content;
      const url = contentHttpUrl(content);
      if (content !== undefined && !url && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(content)) {
        invalid('Content must be a provider ID of at most 128 letters, digits, periods, underscores or hyphens, or an allowed HTTP(S) URL.');
      }
      if (url) args = { ...args, [name === 'tv_launch' ? 'contentId' : 'content']: url.href };
    }
    let controller;
    let config;
    let candidateHost;
    let hostedMedia;
    try {
      config = await this.loadConfig();
      if (!privateHost(config.host)) throw new Error('A private LAN IPv4 TV address is required.');
      if (name === 'tv_observe' && config.allowTemporaryObserver !== true) {
        throw new Error('Temporary privileged TV observation requires an explicit local allowTemporaryObserver=true setting.');
      }
      if (name === 'tv_cast_file' && !validateMediaRoots(config.mediaRoots).length) {
        throw new Error('Local file casting requires explicitly configured mediaRoots.');
      }
      const callerUrls = ['tv_open_url', 'tv_play_url', 'tv_dlna_play'].includes(name)
        ? [args.url, args.iconSrc].filter(value => value !== undefined).map(value => new URL(value))
        : ['tv_launch', 'tv_launch_content'].includes(name)
          ? [contentHttpUrl(name === 'tv_launch' ? args.contentId : args.content)].filter(Boolean) : [];
      if (callerUrls.length) {
        const allowed = allowedUrlOrigins(config.allowedUrlOrigins);
        for (const url of callerUrls) if (!allowed.includes(safeUrlOrigin(url))) {
          throw new Error('URL origin is not allowed by the locally configured allowedUrlOrigins.');
        }
      }
      let result;
      let checkedPostcondition = false;
      if (name === 'tv_power' && args.action === 'wake') {
        if (typeof config.mac !== 'string' || !/^(?:[\da-f]{2}[:-]?){5}[\da-f]{2}$/i.test(config.mac)) throw new Error('Wake-on-LAN requires an explicitly saved TV MAC address.');
        const options = config.wake ?? {};
        result = await this.wake(config.mac, { broadcast: options.broadcast, bindAddress: options.bindAddress, port: options.port ?? 9 });
      } else {
        if (!DLNA_TOOLS.has(name) && (typeof config.clientKey !== 'string' || !config.clientKey)) throw new Error('No saved pairing key for this TV. Pair explicitly using the TV CLI first; MCP never starts pairing.');
        controller = await this.controllerFactory(config);
        if (!DLNA_TOOLS.has(name)) await controller.connect({ allowPairing: false });
        switch (name) {
          case 'tv_status': result = await controller.status(); break;
          case 'tv_apps': result = await controller.apps(); break;
          case 'tv_keyboard_state': result = await controller.keyboardState(); break;
          case 'tv_screenshot': result = await controller.screenshot(); break;
          case 'tv_observe': result = await this.observer(controller, { timeoutMs: 25000 }); break;
          case 'tv_launch': {
            const request = await controller.launch(args.id, args.params ?? {}, args.contentId);
            result = await this.confirmForeground(controller, request, args.id, args.contentId !== undefined);
            checkedPostcondition = true;
            break;
          }
          case 'tv_launch_content': {
            const request = await controller.launchContent(args.id, args.content);
            result = await this.confirmForeground(controller, request, args.id, true);
            checkedPostcondition = true;
            break;
          }
          case 'tv_open_url': result = await controller.openUrl(args.url); break;
          case 'tv_play_url': {
            const { url, ...options } = args;
            result = await controller.playUrl(url, options);
            break;
          }
          case 'tv_dlna_status': result = await controller.dlnaStatus(); break;
          case 'tv_dlna_play': {
            const { url, ...options } = args;
            result = await controller.dlnaPlay(url, options);
            checkedPostcondition = true;
            break;
          }
          case 'tv_dlna_media': {
            result = await controller.dlnaMedia(args.action);
            checkedPostcondition = true;
            if (args.action === 'stop' && result?.confirmed === true && ['STOPPED', 'NO_MEDIA_PRESENT'].includes(result.transportState)) {
              try { await this.releaseMediaHost(); }
              catch { result = { ...result, cleanupWarning: 'The previous local media listener could not be closed.' }; }
            }
            break;
          }
          case 'tv_cast_file': {
            candidateHost = await this.mediaHostFactory({ tvHost: config.host, bindAddress: config.wake?.bindAddress, mediaRoots: config.mediaRoots });
            hostedMedia = await candidateHost.serve(args.filePath, { mimeType: args.mimeType });
            result = await controller.dlnaPlay(hostedMedia.url, { mimeType: hostedMedia.mimeType, title: args.title });
            result = { ...result, bytes: hostedMedia.bytes, mimeType: hostedMedia.mimeType };
            checkedPostcondition = true;
            if (result.confirmed === true) {
              const previousHost = this.mediaHost;
              this.mediaHost = candidateHost;
              candidateHost = undefined;
              if (previousHost) {
                try { await previousHost.close(); }
                catch { result.cleanupWarning = 'The previous local media listener could not be closed.'; }
              }
            }
            break;
          }
          case 'tv_type_text': result = await controller.typeText(args.text, { replace: args.replace ?? false }); break;
          case 'tv_key': result = await controller.key(args.key); break;
          case 'tv_pointer_move': result = await controller.move(args.dx, args.dy); break;
          case 'tv_pointer_click': result = await controller.click(); break;
          case 'tv_pointer_scroll': result = await controller.scroll(args.dx, args.dy); break;
          case 'tv_media': result = await controller.media(args.action); break;
          case 'tv_set_volume': {
            result = await this.confirmValue(controller, await controller.setVolume(args.volume), 'volume', args.volume);
            checkedPostcondition = true;
            break;
          }
          case 'tv_mute': {
            result = await this.confirmValue(controller, await controller.mute(args.muted), 'mute', args.muted);
            checkedPostcondition = true;
            break;
          }
          case 'tv_set_input': {
            let before;
            let metadataError;
            try { before = await controller.status(); } catch (error) { metadataError = error.message; }
            const devices = statusPayload(before, 'inputs')?.devices;
            const device = Array.isArray(devices) ? devices.find(device => device.id === args.id) : undefined;
            const request = await controller.setInput(args.id);
            if (typeof device?.appId === 'string' && device.appId) {
              result = await this.confirmForeground(controller, request, device.appId);
            } else {
              result = { ...acceptedRequest(request), foregroundVerified: false,
                error: { code: 'INPUT_METADATA_UNAVAILABLE', message: metadataError ?? 'The TV did not declare an appId for this input, so its foreground state cannot be verified.' } };
            }
            result.verificationScope = 'input_foreground';
            result.inputId = args.id;
            checkedPostcondition = true;
            break;
          }
          case 'tv_sound_output': result = await controller.soundOutput(args.id); break;
          case 'tv_screen': result = await controller.screen(args.on); break;
          case 'tv_power': result = await controller.powerOff(); break;
        }
      }
      if (name === 'tv_screenshot') {
        const mimeType = typeof result?.contentType === 'string' ? result.contentType.split(';')[0].trim().toLowerCase() : '';
        if (!Buffer.isBuffer(result?.data) || !result.data.length || result.data.length > 10 * 1024 * 1024
          || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
          throw new Error('The TV did not return a supported screenshot image.');
        }
        return { content: [{ type: 'image', data: result.data.toString('base64'), mimeType },
          { type: 'text', text: JSON.stringify({ bytes: result.data.length }) }], isError: false };
      }
      if (name === 'tv_observe') {
        if (!object(result?.metadata)) throw new Error('TV observation did not return diagnostic metadata.');
        const image = result.image;
        const hasImage = image !== undefined && image !== null;
        if (hasImage && (!Buffer.isBuffer(image) || image.length < 5 || image.length > 10 * 1024 * 1024
          || result.mimeType !== 'image/jpeg' || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff
          || image.at(-2) !== 0xff || image.at(-1) !== 0xd9)) {
          throw new Error('TV observation did not return a supported JPEG screenshot.');
        }
        const metadata = redactOutput({ ...result.metadata, screenshotVerified: hasImage,
          ...(hasImage ? { bytes: image.length, mimeType: 'image/jpeg' } : {}) }, [config.clientKey]);
        return { content: [...(hasImage ? [{ type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' }] : []),
          { type: 'text', text: JSON.stringify({ result: metadata }) }], isError: false };
      }
      if (!definition.annotations.readOnlyHint && !checkedPostcondition) {
        result = { ...acceptedRequest(result), ...(name === 'tv_play_url' ? { playbackVerified: false } : {}) };
      }
      const safe = redactOutput(result, [config.clientKey, args.text, args.filePath, hostedMedia?.url]);
      const isError = checkedPostcondition ? result.confirmed !== true : result?.requestAccepted === false;
      return { content: [{ type: 'text', text: JSON.stringify({ result: safe }) }], isError };
    } catch (error) {
      if (DLNA_TOOLS.has(name)) {
        const result = { ...(name === 'tv_dlna_status' ? {} : { requestAccepted: null, confirmed: false, playbackVerified: false }),
          ...(object(error.payload) ? error.payload : {}),
          ...(hostedMedia ? { bytes: hostedMedia.bytes, mimeType: hostedMedia.mimeType } : {}),
          error: { code: error.code ?? 'DLNA_FAILED', message: error.message ?? 'DLNA operation failed.',
            ...(error.upnpError !== undefined ? { upnpError: error.upnpError } : {}) } };
        return { content: [{ type: 'text', text: JSON.stringify({ result: redactOutput(result, [config?.clientKey, args.filePath, hostedMedia?.url]) }) }], isError: true };
      }
      return { content: [{ type: 'text', text: scrubText(error.message ?? 'TV operation failed.', [config?.clientKey, args.text]).slice(0, 800) }], isError: true };
    } finally {
      if (candidateHost) { try { await candidateHost.close(); } catch {} }
      if (controller) { try { await controller.close(); } catch {} }
    }
  }

  async handle(message) {
    const hasId = object(message) && Object.hasOwn(message, 'id');
    const validId = hasId && (typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)));
    const id = validId ? message.id : null;
    try {
      if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId && !validId)) throw new RpcError(-32600, 'Invalid JSON-RPC request');
      if (!hasId) {
        if (message.method === 'notifications/initialized' && this.initializing) this.ready = true;
        return null;
      }
      let result;
      switch (message.method) {
        case 'initialize': {
          if (this.initializing) throw new RpcError(-32600, 'Already initialized');
          const params = message.params;
          if (!object(params) || typeof params.protocolVersion !== 'string' || !object(params.capabilities)
            || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') invalid('Invalid initialize parameters');
          this.initializing = true;
          result = { protocolVersion: VERSIONS.has(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'lg-tv-local', version: '0.1.0' },
            instructions: 'Controls one configured LG TV. Remote controls require a saved pairing key; DLNA renderer controls use the local network without starting SSAP pairing. Pairing, factory settings, calibration, arbitrary endpoints and root exploits are unavailable. A successful acknowledgement does not prove a title is playing. DLNA state describes only its renderer session; app foreground confirmation does not confirm content playback.' };
          break;
        }
        case 'ping': result = {}; break;
        case 'tools/list':
          if (!this.ready) throw new RpcError(-32002, 'Server is not initialized');
          if (message.params !== undefined && (!object(message.params) || Object.keys(message.params).some(k => k !== '_meta'))) invalid('tools/list does not accept pagination parameters');
          result = { tools: structuredClone(TV_TOOLS) };
          break;
        case 'tools/call': {
          if (!this.ready) throw new RpcError(-32002, 'Server is not initialized');
          const params = message.params;
          if (!object(params) || typeof params.name !== 'string' || Object.keys(params).some(k => !['name', 'arguments', '_meta'].includes(k))) invalid('Invalid tools/call parameters');
          result = await this.callTool(params.name, Object.hasOwn(params, 'arguments') ? params.arguments : {});
          break;
        }
        default: throw new RpcError(-32601, 'Method not found');
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (!hasId && id === null && object(message) && message.jsonrpc === '2.0' && typeof message.method === 'string') return null;
      return { jsonrpc: '2.0', id, error: { code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof RpcError ? error.message : 'Internal MCP error' } };
    }
  }
}

export async function runStdio({ input = process.stdin, output = process.stdout, server = new TVMcpServer() } = {}) {
  input.setEncoding('utf8');
  let pending = '';
  const send = async message => {
    if (message && !output.write(`${JSON.stringify(message)}\n`)) await once(output, 'drain');
  };
  const line = async value => {
    if (!value.trim()) return;
    let message;
    try { message = JSON.parse(value); }
    catch { await send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    await send(await server.handle(message));
  };
  try {
    for await (const chunk of input) {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const value = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(value) > MAX_MESSAGE_BYTES) throw new Error('MCP input message exceeded the size limit.');
        await line(value);
      }
      if (Buffer.byteLength(pending) > MAX_MESSAGE_BYTES) throw new Error('MCP input message exceeded the size limit.');
    }
    // A closing stdin can deliver its final message without a trailing newline.
    if (pending.trim()) await line(pending);
  } finally {
    await server.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write('Usage: node mcp-tv.mjs [--host PRIVATE_TV_IP] [--config .lg-tv.local.json]\nMCP JSON-RPC uses stdin/stdout. Remote controls require saved pairing; DLNA uses the local renderer. No device is contacted until a tool is called.\n');
    return;
  }
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--host', '--config'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid arguments; use --help.');
    options[argv[i] === '--host' ? 'host' : 'configPath'] = argv[i + 1];
  }
  await runStdio({ server: new TVMcpServer({ loadConfig: () => loadPrivateConfig(options) }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('LG TV MCP stopped: check the local configuration and transport.\n'); process.exitCode = 1; });
}
