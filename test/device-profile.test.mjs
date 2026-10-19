import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateDeviceProfile, assertProfileCompatible, getProfileCapabilities,
  PROFILE_CAPABILITY_IDS, PROFILE_ADAPTER_IDS, PROFILE_MAX_BYTES,
  ProfileValidationError, ProfileCompatibilityError,
} from '../lib/device-profile.mjs';

const profileText = readFileSync(new URL('../profiles/lg-oled65b8pua-webos4.json', import.meta.url), 'utf8');
const schema = JSON.parse(readFileSync(new URL('../schema/device-profile.schema.json', import.meta.url), 'utf8'));
const profile = () => JSON.parse(profileText);
const actual = () => ({ vendor: 'LG', model: 'OLED65B8PUA', firmware: '05.50.70' });
const rejected = value => assert.throws(() => validateDeviceProfile(value), ProfileValidationError);

test('validated profile is an independent, deeply frozen JSON copy', () => {
  const input = profile();
  const result = validateDeviceProfile(input);
  assert.equal(result.id, 'lg-oled65b8pua-webos4');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.capabilityIds));
  assert.ok(Object.isFrozen(result.verification['temporary-observe'].evidence));
  input.firmware[0] = '00.00.00';
  assert.deepEqual(result.firmware, ['05.50.70']);
  assert.throws(() => { result.model = 'CHANGED'; }, TypeError);
  assert.deepEqual(validateDeviceProfile(result), result);
  assert.equal(PROFILE_CAPABILITY_IDS.length, 25);
});

test('identity matching requires the exact vendor, model and listed firmware', () => {
  assert.equal(assertProfileCompatible(profile(), actual()), true);
  for (const identity of [
    { ...actual(), vendor: 'lg' }, { ...actual(), model: 'OLED65B8PUA-OTHER' },
    { ...actual(), firmware: '05.50.71' }, { ...actual(), firmware: '05.50.70 ' },
    { ...actual(), firmware: null },
  ]) assert.throws(() => assertProfileCompatible(profile(), identity), ProfileCompatibilityError);
  assert.throws(() => assertProfileCompatible(profile(), { vendor: 'LG', model: 'OLED65B8PUA' }), ProfileValidationError);
  assert.throws(() => assertProfileCompatible(profile(), { ...actual(), credentials: 'not-read' }), ProfileValidationError);
});

test('privileged observation is absent by default and metadata does not grant access', () => {
  const ordinary = getProfileCapabilities(profile());
  assert.equal(ordinary.length, 24);
  assert.equal(ordinary.some(capability => capability.id === 'temporary-observe'), false);
  assert.equal(getProfileCapabilities(profile(), { allowPrivileged: false }).length, 24);
  const privileged = getProfileCapabilities(profile(), { allowPrivileged: true }).find(capability => capability.id === 'temporary-observe');
  assert.equal(privileged.optInRequired, true);
  assert.equal(privileged.privileged, true);
  assert.equal(Object.hasOwn(privileged, 'enabled'), false);
  assert.ok(Object.isFrozen(privileged));
  assert.equal(ordinary.find(capability => capability.id === 'tv_screenshot').status, 'unsupported');
  assert.throws(() => getProfileCapabilities(profile(), { allowPrivileged: 'true' }), ProfileValidationError);
  assert.throws(() => getProfileCapabilities(profile(), { execute: true }), ProfileValidationError);
});

test('profiles cannot disable opt-in or smuggle executable or credential fields', () => {
  for (const change of [
    p => { delete p.verification['temporary-observe'].optInRequired; },
    p => { p.verification['temporary-observe'].optInRequired = false; },
    p => { p.verification.tv_status.optInRequired = false; },
  ]) { const input = profile(); change(input); rejected(input); }
  for (const field of ['code', 'script', 'command', 'url', 'uri', 'path', 'permissions', 'credentials', 'clientKey', 'password']) {
    const top = profile(); top[field] = 'untrusted-data'; rejected(top);
    const nested = profile(); nested.verification.tv_status[field] = 'untrusted-data'; rejected(nested);
  }
});

test('adapters and capabilities only come from the reviewed code registry', () => {
  for (const adapter of ['../other.js', 'https://example.invalid/plugin.mjs', 'node:child_process', 'custom']) {
    const input = profile(); input.adapter = adapter; rejected(input);
  }
  for (const capability of ['luna://com.webos.service.acb/getForegroundAppInfo', 'tv_observe', 'eval', '__proto__']) {
    const input = profile(); input.capabilityIds.push(capability); rejected(input);
  }
  const duplicate = profile(); duplicate.capabilityIds.push('tv_status'); rejected(duplicate);
});

test('prototype pollution keys, custom prototypes, accessors and non-JSON values are rejected', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const input = JSON.parse(profileText); Object.defineProperty(input.verification.tv_status, key, { enumerable: true, value: { polluted: true } });
    rejected(input);
  }
  const inherited = Object.create({ permissions: 'all' }); Object.assign(inherited, profile()); rejected(inherited);
  let reads = 0;
  const getter = profile(); Object.defineProperty(getter, 'model', { enumerable: true, get() { reads += 1; return 'OLED65B8PUA'; } }); rejected(getter);
  assert.equal(reads, 0);
  for (const value of [() => {}, Symbol('x'), 1n, NaN, Infinity, new Date()]) {
    const input = profile(); input.extra = value; rejected(input);
  }
  assert.equal({}.polluted, undefined);
});

test('JSON duplicate keys cannot hide conflicting declarations, including escaped names', () => {
  rejected(profileText.replace('"vendor": "LG"', '"vendor":"OTHER","vendor":"LG"'));
  rejected(profileText.replace('"vendor": "LG"', '"\\u0076endor":"OTHER","vendor":"LG"'));
  rejected(profileText.replace('"optInRequired": true', '"optInRequired":false,"optInRequired":true'));
  assert.equal(validateDeviceProfile(profileText).vendor, 'LG');
});

test('size, depth, key-count, array-shape and cycle limits fail closed', () => {
  rejected(' '.repeat(PROFILE_MAX_BYTES) + profileText);
  const deep = profile(); let leaf = deep; for (let index = 0; index < 12; index += 1) { leaf.extra = {}; leaf = leaf.extra; } rejected(deep);
  const manyKeys = profile(); for (let index = 0; index < 129; index += 1) manyKeys[`field${index}`] = index; rejected(manyKeys);
  const manyItems = profile(); manyItems.firmware = new Array(129).fill('05.50.70'); rejected(manyItems);
  const sparse = profile(); delete sparse.capabilityIds[0]; rejected(sparse);
  const extraArrayProperty = profile(); extraArrayProperty.firmware.script = 'code'; rejected(extraArrayProperty);
  const cycle = profile(); cycle.extra = cycle; rejected(cycle);
});

test('evidence IDs can only address sanitized public evidence documents in this repository', () => {
  for (const evidence of [
    '/etc/passwd', 'C:\\Users\\private.txt', 'file:///private', 'https://example.invalid/proof',
    'reports/tv-audit.json', '../docs/evidence/proof.md#tv_status',
    'docs/evidence/../secret.md#tv_status', 'docs/evidence/%2e%2e.md#tv_status',
    'docs/evidence/proof.md?token=secret#tv_status', 'docs/evidence/proof.md#../../private',
    'docs/evidence/proof.md#tv_status\ncommand',
  ]) { const input = profile(); input.verification.tv_status.evidence = [evidence]; rejected(input); }
  const okay = profile(); okay.verification.tv_status.evidence = ['docs/evidence/reviewed-device.md#tv_status'];
  assert.equal(validateDeviceProfile(okay).verification.tv_status.evidence[0], 'docs/evidence/reviewed-device.md#tv_status');
});

test('every declared capability has exactly one valid verification entry', () => {
  const missing = profile(); delete missing.verification.tv_status; rejected(missing);
  const undeclared = profile(); undeclared.capabilityIds = undeclared.capabilityIds.filter(id => id !== 'tv_status'); rejected(undeclared);
  const noEvidence = profile(); noEvidence.verification.tv_status.evidence = []; rejected(noEvidence);
  const unknownStatus = profile(); unknownStatus.verification.tv_status.status = 'trusted'; rejected(unknownStatus);
  const unverified = profile(); unverified.verification.tv_status = { status: 'unverified', evidence: [] };
  assert.equal(validateDeviceProfile(unverified).verification.tv_status.status, 'unverified');
});

test('firmware is an exact bounded allowlist without patterns or commands', () => {
  for (const firmware of [[], ['*'], ['05.50.*'], ['latest'], ['>=05.50.70'], ['05.50.70; command'], ['05.50.70', '05.50.70']]) {
    const input = profile(); input.firmware = firmware; rejected(input);
  }
  const input = profile(); input.firmware = ['05.50.70', '05.50.71'];
  assert.equal(assertProfileCompatible(input, { ...actual(), firmware: '05.50.71' }), true);
});

test('published JSON Schema and reviewed runtime registries stay aligned', () => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.capabilityIds.items.enum, [...PROFILE_CAPABILITY_IDS]);
  assert.deepEqual(schema.properties.adapter.enum, [...PROFILE_ADAPTER_IDS]);
  assert.deepEqual(Object.keys(schema.properties.verification.properties), [...PROFILE_CAPABILITY_IDS]);
  assert.equal(schema.$defs.privilegedVerification.properties.optInRequired.const, true);
  assert.equal(schema.allOf.length, PROFILE_CAPABILITY_IDS.length);
  assert.ok(schema.allOf.every((rule, index) => rule.if.properties.capabilityIds.contains.const === PROFILE_CAPABILITY_IDS[index]));
});
