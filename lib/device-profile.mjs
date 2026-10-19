/**
 * Community profiles are descriptive JSON, never executable adapter definitions.
 * Adding an adapter or capability requires a reviewed code change to this module.
 * Callers must separately enforce user authorization and runtime safety policy.
 */
export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_MAX_BYTES = 64 * 1024;
export const PROFILE_MAX_DEPTH = 8;
export const PROFILE_ADAPTER_IDS = Object.freeze(['lg-webos']);
export const PROFILE_CAPABILITY_IDS = Object.freeze([
  'tv_status', 'tv_apps', 'tv_keyboard_state', 'tv_screenshot', 'tv_launch',
  'tv_launch_content', 'tv_open_url', 'tv_play_url', 'tv_dlna_play', 'tv_dlna_status',
  'tv_dlna_media', 'tv_cast_file', 'tv_type_text', 'tv_key', 'tv_pointer_move',
  'tv_pointer_click', 'tv_pointer_scroll', 'tv_media', 'tv_set_volume', 'tv_mute',
  'tv_set_input', 'tv_sound_output', 'tv_screen', 'tv_power', 'temporary-observe',
]);

const CAPABILITIES = new Set(PROFILE_CAPABILITY_IDS);
const PRIVILEGED = new Set(['temporary-observe']);
const STATUSES = new Set(['verified', 'unsupported', 'unverified']);
const FIELDS = ['schemaVersion', 'id', 'vendor', 'model', 'firmware', 'adapter', 'capabilityIds', 'verification'];
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const FIRMWARE = /^\d{1,3}(?:\.\d{1,3}){2}(?:-\d{1,3})?$/;
const EVIDENCE = /^docs\/evidence\/[a-z0-9]+(?:-[a-z0-9]+)*\.md#[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export class ProfileValidationError extends Error {
  constructor(message) { super(message); this.name = 'ProfileValidationError'; this.code = 'INVALID_DEVICE_PROFILE'; }
}

export class ProfileCompatibilityError extends Error {
  constructor(field) {
    super(`Device identity does not match the profile (${field})`);
    this.name = 'ProfileCompatibilityError'; this.code = 'PROFILE_IDENTITY_MISMATCH'; this.field = field;
  }
}

function invalid(message) { throw new ProfileValidationError(message); }

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must contain only JSON data`);
}

function inspectJSON(value) {
  const seen = new WeakSet();
  let keys = 0;
  function inspect(current, depth) {
    if (depth > PROFILE_MAX_DEPTH) invalid('Profile exceeds maximum nesting depth');
    if (typeof current === 'string') {
      if (current.length > 2048 || /[\u0000-\u001f\u007f]/.test(current)) invalid('Profile contains an invalid string');
      return;
    }
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') { if (!Number.isFinite(current)) invalid('Profile contains a non-JSON number'); return; }
    if (typeof current !== 'object') invalid('Profile contains a non-JSON value');
    if (seen.has(current)) invalid('Profile contains circular or shared object references');
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > 128) invalid('Profile array is too large');
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) invalid('Profile array has extra properties');
        if (!Object.hasOwn(descriptors[key], 'value')) invalid('Profile accessors are forbidden');
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(descriptors, String(index))) invalid('Sparse profile arrays are forbidden');
        inspect(descriptors[index].value, depth + 1);
      }
      return;
    }
    plainObject(current, 'Profile object');
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const names = Reflect.ownKeys(descriptors);
    keys += names.length;
    if (names.length > 128 || keys > 512) invalid('Profile contains too many keys');
    for (const key of names) {
      if (typeof key !== 'string' || key.length > 80 || BAD_KEYS.has(key) || /[\u0000-\u001f\u007f]/.test(key)) invalid('Profile contains a forbidden key');
      if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) invalid('Profile accessors and hidden fields are forbidden');
      inspect(descriptors[key].value, depth + 1);
    }
  }
  inspect(value, 0);
}

function fields(value, allowed, required, label) {
  plainObject(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${label} contains an unknown field`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${label} is missing ${key}`);
}

function strings(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string')) invalid(`${label} must be a bounded string array`);
  if (new Set(value).size !== value.length) invalid(`${label} contains duplicate values`);
}

function freezeJSON(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeJSON);
    Object.freeze(value);
  }
  return value;
}

function rejectDuplicateJSONKeys(text) {
  // JSON.parse has already checked syntax. Tokenize strings before punctuation so
  // escaped quotes/commas inside strings cannot disguise a duplicate object key.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
  const stack = [];
  for (const token of tokens) {
    if (token === '{') { stack.push({ keys: new Set(), expectingKey: true }); continue; }
    if (token === '[') { stack.push({ keys: null }); continue; }
    if (token === '}' || token === ']') { stack.pop(); continue; }
    const current = stack.at(-1);
    if (!current?.keys) continue;
    if (token === ',') { current.expectingKey = true; continue; }
    if (current.expectingKey && token.startsWith('"')) {
      const key = JSON.parse(token);
      if (current.keys.has(key)) invalid('Profile JSON contains duplicate object keys');
      current.keys.add(key);
      current.expectingKey = false;
    }
  }
}

/** Accept UTF-8 JSON text or a plain JSON-data object. Return an independent frozen copy. */
export function validateDeviceProfile(input) {
  let profile = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > PROFILE_MAX_BYTES) invalid('Profile exceeds maximum byte size');
    try { profile = JSON.parse(input); } catch { invalid('Profile is not valid JSON'); }
    rejectDuplicateJSONKeys(input);
  }
  inspectJSON(profile);
  let serialized;
  try { serialized = JSON.stringify(profile); } catch { invalid('Profile cannot be serialized as JSON'); }
  if (Buffer.byteLength(serialized, 'utf8') > PROFILE_MAX_BYTES) invalid('Profile exceeds maximum byte size');
  fields(profile, FIELDS, FIELDS, 'Profile');
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) invalid('Unsupported profile schema version');
  if (typeof profile.id !== 'string' || profile.id.length > 80 || !SLUG.test(profile.id)) invalid('Invalid profile ID');
  if (!PROFILE_ADAPTER_IDS.includes(profile.adapter)) invalid('Unknown reviewed adapter');
  if (profile.vendor !== 'LG') invalid('Vendor is incompatible with the reviewed adapter');
  if (typeof profile.model !== 'string' || !MODEL.test(profile.model)) invalid('Invalid model identifier');
  strings(profile.firmware, 16, 'Firmware');
  if (!profile.firmware.length || profile.firmware.some(version => !FIRMWARE.test(version))) invalid('Firmware must list exact numeric versions');
  strings(profile.capabilityIds, PROFILE_CAPABILITY_IDS.length, 'Capabilities');
  if (!profile.capabilityIds.length || profile.capabilityIds.some(id => !CAPABILITIES.has(id))) invalid('Unknown reviewed capability');
  fields(profile.verification, profile.capabilityIds, profile.capabilityIds, 'Verification');
  for (const id of profile.capabilityIds) {
    const verification = profile.verification[id];
    const privileged = PRIVILEGED.has(id);
    const allowed = privileged ? ['status', 'evidence', 'optInRequired'] : ['status', 'evidence'];
    fields(verification, allowed, allowed, `Verification for ${id}`);
    if (!STATUSES.has(verification.status)) invalid('Unknown verification status');
    strings(verification.evidence, 8, 'Evidence');
    if (verification.evidence.some(reference => reference.length > 200 || !EVIDENCE.test(reference))) invalid('Evidence must be a relative public repository evidence ID');
    if (verification.status !== 'unverified' && !verification.evidence.length) invalid('Verified or unsupported capabilities require reviewable evidence');
    if (privileged && verification.optInRequired !== true) invalid('Privileged observation requires explicit opt-in');
  }
  return freezeJSON(JSON.parse(serialized));
}

/** Exact identity matching only; missing identity never selects a best-effort profile. */
export function assertProfileCompatible(input, actual) {
  const profile = validateDeviceProfile(input);
  inspectJSON(actual);
  fields(actual, ['vendor', 'model', 'firmware'], ['vendor', 'model', 'firmware'], 'Device identity');
  if (actual.vendor !== profile.vendor) throw new ProfileCompatibilityError('vendor');
  if (actual.model !== profile.model) throw new ProfileCompatibilityError('model');
  if (typeof actual.firmware !== 'string' || !profile.firmware.includes(actual.firmware)) throw new ProfileCompatibilityError('firmware');
  return true;
}

/**
 * Return descriptive metadata, including verification limits; this grants no access.
 * Privileged metadata is hidden by default and still requires separate runtime consent.
 */
export function getProfileCapabilities(input, options = {}) {
  inspectJSON(options);
  fields(options, ['allowPrivileged'], [], 'Capability options');
  if (Object.hasOwn(options, 'allowPrivileged') && typeof options.allowPrivileged !== 'boolean') invalid('allowPrivileged must be a boolean');
  const profile = validateDeviceProfile(input);
  return Object.freeze(profile.capabilityIds.filter(id => !PRIVILEGED.has(id) || options.allowPrivileged === true)
    .map(id => Object.freeze({ id, status: profile.verification[id].status,
      evidence: profile.verification[id].evidence, privileged: PRIVILEGED.has(id),
      optInRequired: PRIVILEGED.has(id) })));
}
