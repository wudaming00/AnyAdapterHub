import net from 'node:net';
import path from 'node:path';
import { types } from 'node:util';

export class HubPolicyError extends Error {
  constructor(code, message) { super(message); this.name = 'HubPolicyError'; this.code = code; }
}
const fail = (code, message) => { throw new HubPolicyError(code, message); };
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const BOOL = { type: 'boolean' };
const URL = { type: 'string', minLength: 1, maxLength: 4096 };
const MIME = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$' };
const TITLE = { type: 'string', maxLength: 512 };
const KEYS = ['HOME', 'BACK', 'ENTER', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'EXIT', 'MENU', 'QMENU',
  'INFO', 'GUIDE', 'RED', 'GREEN', 'YELLOW', 'BLUE', 'PLAY', 'PAUSE', 'STOP', 'REWIND',
  'FASTFORWARD', 'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE', 'CC',
  'LIST', 'SEARCH', 'MYAPPS', 'RECENT', 'NETFLIX', 'AMAZON', 'INPUT_HUB', 'TV',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const MEDIA_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav' };
const integer = (minimum, maximum, defaultValue) => ({ type: 'integer', minimum, maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }) });
function action(description, properties = {}, required = Object.keys(properties)) {
  return { description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
export const ACTIONS = freeze({
  'switch.power.set': action('Set one explicitly enrolled ordinary-load switch.', { on: BOOL }),
  'light.power.set': action('Set one enrolled light power explicitly.', { on: BOOL }),
  'light.brightness.set': action('Set one enrolled dimmable light brightness.', { brightness: integer(0, 100) }),
  'audio.volume.set': action('Set volume.', { volume: integer(0, 100) }),
  'audio.mute.set': action('Set mute explicitly.', { muted: BOOL }),
  'app.list': action('List a privacy-filtered installed application inventory.'),
  'app.launch': action('Launch one ordinary application without arbitrary parameters.', { id: ID }),
  'app.content.launch': action('Launch a provider ID or a locally approved HTTP(S) URL.', { id: ID, content: URL }),
  'navigation.key': action('Send an ordinary remote key.', { key: { type: 'string', enum: KEYS } }),
  'pointer.move': action('Move the pointer relatively.', { dx: integer(-10000, 10000), dy: integer(-10000, 10000) }),
  'pointer.click': action('Click the pointer.'),
  'pointer.scroll': action('Scroll relatively.', { dx: integer(-1000, 1000), dy: integer(-1000, 1000) }),
  'media.control': action('Send a supported active-player command.', { action: { type: 'string', enum: ['play', 'pause', 'stop', 'rewind', 'fastForward'] } }),
  'input.select': action('Select a reported input ID.', { id: ID }),
  'audio.output.set': action('Select a reported audio output ID.', { id: ID }),
  'display.set': action('Set the picture on or off.', { on: BOOL }),
  'power.off': action('Power off the device.'),
  'power.wake': action('Send configured Wake-on-LAN.'),
  'text.insert': action('Insert sensitive text into a focused field.', { text: { type: 'string', minLength: 1, maxLength: 4096 }, replace: { ...BOOL, default: false } }, ['text']),
  'url.open': action('Open an HTTP(S) URL with a locally allowed origin.', { url: URL }),
  'media.url.play': action('Request native playback of an approved direct media URL.', { url: URL, mimeType: MIME, title: TITLE }, ['url', 'mimeType']),
  'dlna.play': action('Request DLNA playback of an approved direct media URL.', { url: URL, mimeType: MIME, title: TITLE }, ['url', 'mimeType']),
  'dlna.control': action('Control the DLNA renderer.', { action: { type: 'string', enum: ['play', 'pause', 'stop'] } }),
  'dlna.status': action('Read the DLNA renderer state.'),
  'media.file.cast': action('Cast an approved local media file; the media host additionally checks real paths.', {
    filePath: { type: 'string', minLength: 1, maxLength: 32768 }, mimeType: MIME, title: TITLE }, ['filePath']),
  'screen.observe': action('Run temporary privileged observation; capturing and reading images require separate grants.', {
    screenshot: { ...BOOL, default: true }, timeoutMs: integer(5000, 25000, 25000) }, []),
  'vacuum.start': action('Start cleaning on the explicitly enrolled vacuum.'),
  'vacuum.pause': action('Pause the enrolled vacuum.'),
  'vacuum.resume': action('Resume cleaning on the enrolled vacuum.'),
  'vacuum.stop': action('Stop the enrolled vacuum.'),
  'vacuum.dock': action('Request the enrolled vacuum to return to its dock.'),
  'vacuum.details.read': action('Read normalized settings and service counters without maps or account data.'),
});
export const READ_CAPABILITIES = freeze(['state.read', 'events.read', 'screen.read']);
const CAPABILITIES = new Set([...READ_CAPABILITIES, ...Object.keys(ACTIONS)]);

function record(value, code = 'INVALID_ARGUMENTS') {
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail(code, 'Expected a plain data object.');
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Object.values(entries).some(item => !Object.hasOwn(item, 'value') || !item.enumerable) ||
    Object.keys(entries).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail(code, 'Accessors and prototype properties are not allowed.');
  return entries;
}
function array(value, code, maximum) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum || Object.getOwnPropertySymbols(value).length) fail(code, 'Expected a bounded data array.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter(key => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index) ||
    !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail(code, 'Array accessors and extra properties are not allowed.');
  return keys.map(key => descriptors[key].value);
}
function string(value, schema, code = 'INVALID_ARGUMENTS') {
  if (typeof value !== 'string' || value.includes('\0') || [...value].length < (schema.minLength ?? 0) ||
    [...value].length > schema.maxLength || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail(code, 'String value is outside the allowed format.');
  return value;
}
function schemaArgs(schema, args) {
  const descriptors = record(args);
  const result = {};
  if (Object.keys(descriptors).some(key => !Object.hasOwn(schema.properties, key))) fail('INVALID_ARGUMENTS', 'Unknown action argument.');
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(descriptors, key)) {
      if (schema.required.includes(key)) fail('INVALID_ARGUMENTS', 'A required action argument is missing.');
      if (Object.hasOwn(spec, 'default')) result[key] = spec.default;
      continue;
    }
    const value = descriptors[key].value;
    if (spec.type === 'string') string(value, spec);
    else if (spec.type === 'boolean' && typeof value !== 'boolean') fail('INVALID_ARGUMENTS', 'Expected a boolean action argument.');
    else if (spec.type === 'integer' && (!Number.isSafeInteger(value) || value < spec.minimum || value > spec.maximum)) fail('INVALID_ARGUMENTS', 'Integer action argument is outside its allowed range.');
    if (spec.enum && !spec.enum.includes(value)) fail('INVALID_ARGUMENTS', 'Action argument is outside the fixed allowlist.');
    result[key] = value;
  }
  return result;
}
function localField(config, name) {
  const descriptors = record(config ?? {}, 'INVALID_CONFIG');
  return descriptors[name]?.value;
}
const DENIED_IPS = { 4: new net.BlockList(), 6: new net.BlockList() };
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) DENIED_IPS[4].addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['::ffff:0:0', 96], ['fe80::', 10], ['ff00::', 8]]) DENIED_IPS[6].addSubnet(address, prefix, 'ipv6');
function checkedUrl(value, code = 'INVALID_ARGUMENTS') {
  let url;
  try { url = new globalThis.URL(value); } catch { fail(code, 'Expected an absolute HTTP(S) URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host ||
    host === 'localhost' || host.endsWith('.localhost') ||
    (family && (DENIED_IPS[family].check(host, family === 4 ? 'ipv4' : 'ipv6') || (family === 4 && host.endsWith('.255')))) ||
    (!family && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) fail(code, 'URL contains an unsafe origin or credentials.');
  return url;
}
function origins(config) {
  const field = localField(config, 'allowedUrlOrigins');
  const value = field === undefined ? [] : field;
  return array(value, 'INVALID_CONFIG', 64).map(item => {
    string(item, { minLength: 1, maxLength: 4096 }, 'INVALID_CONFIG');
    const url = checkedUrl(item, 'INVALID_CONFIG');
    if (url.search || url.hash || url.pathname !== '/' || (item !== url.origin && item !== url.origin + '/')) fail('INVALID_CONFIG', 'allowedUrlOrigins requires exact canonical origins without paths, queries or fragments.');
    return url.origin;
  });
}
function approvedUrl(value, config) {
  const url = checkedUrl(value);
  if (!origins(config).includes(url.origin)) fail('LOCAL_POLICY_DENIED', 'URL origin is not in local allowedUrlOrigins.');
  return url.href;
}
function localPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 && path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value) && !value.includes('\0');
}
function mediaRoots(config) {
  const field = localField(config, 'mediaRoots');
  const roots = array(field === undefined ? [] : field, 'INVALID_CONFIG', 32);
  if (roots.some(root => !localPath(root))) fail('INVALID_CONFIG', 'mediaRoots requires absolute local directory paths.');
  if (!roots.length) fail('LOCAL_POLICY_DENIED', 'Local file casting requires configured mediaRoots.');
  return roots.map(root => path.resolve(root));
}

export function validateAction(name, args, options = {}) {
  const optionFields = record(options);
  if (Object.keys(optionFields).some(key => key !== 'deviceConfig')) fail('INVALID_ARGUMENTS', 'Unknown validation option.');
  const deviceConfig = optionFields.deviceConfig?.value;
  if (typeof name !== 'string' || !Object.hasOwn(ACTIONS, name)) fail('UNKNOWN_ACTION', 'Action is outside the reviewed capability registry.');
  const result = schemaArgs(ACTIONS[name].inputSchema, args);
  if (['url.open', 'media.url.play', 'dlna.play'].includes(name)) result.url = approvedUrl(result.url, deviceConfig);
  if (name === 'app.content.launch') {
    let url;
    try { url = new globalThis.URL(result.content); } catch {}
    if (url && ['http:', 'https:'].includes(url.protocol)) result.content = approvedUrl(result.content, deviceConfig);
    else string(result.content, ID);
  }
  if (name === 'media.file.cast') {
    const roots = mediaRoots(deviceConfig);
    if (!localPath(result.filePath)) fail('INVALID_ARGUMENTS', 'File must be an absolute local path without network shares.');
    result.filePath = path.resolve(result.filePath);
    if (!roots.some(root => { const relative = path.relative(root, result.filePath); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); })) fail('LOCAL_POLICY_DENIED', 'File is outside configured mediaRoots.');
    const mimeType = MEDIA_TYPES[path.extname(result.filePath).toLowerCase()];
    if (!mimeType || (result.mimeType !== undefined && result.mimeType !== mimeType)) fail('INVALID_ARGUMENTS', 'Media MIME type must match a supported media extension.');
    result.mimeType = mimeType;
  }
  if (name === 'screen.observe' && localField(deviceConfig, 'allowTemporaryObserver') !== true) fail('LOCAL_POLICY_DENIED', 'Temporary privileged observation requires explicit local opt-in.');
  return result;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(code, 'Expected an ISO timestamp with an explicit timezone.');
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const [, year, month, day, hour, minute, second, zone, , offsetHour, offsetMinute] = parts;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59 ||
    (zone !== 'Z' && (+offsetHour > 23 || +offsetMinute > 59)) || !Number.isFinite(Date.parse(value))) fail(code, 'Invalid ISO timestamp.');
  return new Date(value).toISOString();
}
export function validateGrant(metadata) {
  const fields = record(metadata, 'INVALID_GRANT');
  const expected = ['id', 'label', 'deviceIds', 'capabilities', 'expiresAt', 'revokedAt'];
  if (Object.keys(fields).some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(fields, key))) fail('INVALID_GRANT', 'Grant metadata requires exactly the reviewed grant fields.');
  const id = string(fields.id.value, ID, 'INVALID_GRANT');
  const label = string(fields.label.value, { minLength: 1, maxLength: 128 }, 'INVALID_GRANT').trim();
  if (!label || /[\u0000-\u001f\u007f]/.test(label)) fail('INVALID_GRANT', 'Grant label must be nonempty printable text.');
  const deviceIds = array(fields.deviceIds.value, 'INVALID_GRANT', 64).map(item => string(item, ID, 'INVALID_GRANT'));
  const capabilities = array(fields.capabilities.value, 'INVALID_GRANT', CAPABILITIES.size).map(item => {
    if (typeof item !== 'string' || !CAPABILITIES.has(item)) fail('INVALID_GRANT', 'Grant capability is outside the fixed registry.');
    return item;
  });
  if (!deviceIds.length || !capabilities.length || new Set(deviceIds).size !== deviceIds.length || new Set(capabilities).size !== capabilities.length) fail('INVALID_GRANT', 'Grant devices and capabilities must be nonempty exact unique allowlists.');
  return { id, label, deviceIds, capabilities, expiresAt: timestamp(fields.expiresAt.value, 'INVALID_GRANT'),
    revokedAt: fields.revokedAt.value === null ? null : timestamp(fields.revokedAt.value, 'INVALID_GRANT') };
}
export function authorize(grant, options = {}) {
  const fields = record(options, 'ACCESS_DENIED');
  if (Object.keys(fields).some(key => !['deviceId', 'capability', 'now'].includes(key))) fail('ACCESS_DENIED', 'Unknown authorization option.');
  const deviceId = fields.deviceId?.value;
  const capability = fields.capability?.value;
  const now = fields.now?.value ?? Date.now();
  const checked = validateGrant(grant);
  string(deviceId, ID, 'ACCESS_DENIED');
  if (typeof capability !== 'string' || !CAPABILITIES.has(capability) || !Number.isSafeInteger(now) || now < 0) fail('ACCESS_DENIED', 'Invalid authorization target or clock.');
  if (checked.revokedAt !== null) fail('GRANT_REVOKED', 'Grant has been revoked.');
  if (now >= Date.parse(checked.expiresAt)) fail('GRANT_EXPIRED', 'Grant has expired.');
  if (!checked.deviceIds.includes(deviceId) || !checked.capabilities.includes(capability)) fail('ACCESS_DENIED', 'Grant does not cover this exact device and capability.');
}

const PRIVATE_FIELD = /(?:authorization|clientkey|token|cookie|password|passphrase|secret|socketpath|privatekey|credential)|^(?:text|filepath|url|uri|sourcefile|mediaroots)$/i;
export function redactHub(value, secrets = []) {
  const known = Array.isArray(secrets) ? secrets.filter(item => typeof item === 'string' && item) : [];
  function visit(item, depth) {
    if (depth > 12) return '[omitted]';
    if (typeof item === 'string') {
      let result = item;
      for (const secret of known) result = result.split(secret).join('[redacted]');
      return result.replace(/\b(?:https?|wss?|luna|ssap|file):[^\s"'<>]+/gi, '[redacted-url]')
        .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[redacted-path]')
        .replace(/(^|[\s(])\/[^\s"'<>]+/g, '$1[redacted-path]').slice(0, 4096);
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item !== 'object' || types.isProxy(item)) return '[omitted]';
    if (Buffer.isBuffer(item) || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return '[binary omitted]';
    if (Array.isArray(item)) {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      return Array.from({ length: Math.min(item.length, 256) }, (_, index) => Object.hasOwn(descriptors[index] ?? {}, 'value') ? visit(descriptors[index].value, depth + 1) : '[omitted]');
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return '[omitted]';
    return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(item)).slice(0, 100).map(([key, descriptor]) => [key,
      PRIVATE_FIELD.test(key.replace(/[-_]/g, '')) || !Object.hasOwn(descriptor, 'value') ? '[redacted]' : visit(descriptor.value, depth + 1)]));
  }
  return visit(value, 0);
}
