import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ACTIONS, READ_CAPABILITIES, HubPolicyError, validateAction, validateGrant, authorize, redactHub } from '../lib/hub/policy.mjs';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const ROOT = path.resolve('test-approved-media');
const DEVICE = { allowedUrlOrigins: ['https://media.example', 'http://192.168.1.9:8096'], mediaRoots: [ROOT], allowTemporaryObserver: true };
const grant = overrides => ({ id: 'grant-1', label: 'Living room controls', deviceIds: ['living-room'],
  capabilities: ['state.read', 'audio.volume.set'], expiresAt: '2026-10-20T12:00:00Z', revokedAt: null, ...overrides });
const check = (name, args, deviceConfig = DEVICE) => validateAction(name, args, { deviceConfig });
const throws = (fn, code) => assert.throws(fn, error => error instanceof HubPolicyError && (!code || error.code === code));
const EXAMPLES = {
  'switch.power.set': { on: false },
  'light.power.set': { on: true }, 'light.brightness.set': { brightness: 50 },
  'audio.volume.set': { volume: 25 }, 'audio.mute.set': { muted: false },
  'app.list': {},
  'app.launch': { id: 'com.disney.disneyplus-prod' }, 'app.content.launch': { id: 'com.disney.disneyplus-prod', content: '70GoJHflgHH9' },
  'navigation.key': { key: 'ENTER' }, 'pointer.move': { dx: -2, dy: 3 }, 'pointer.click': {}, 'pointer.scroll': { dx: 0, dy: -1 },
  'media.control': { action: 'pause' }, 'input.select': { id: 'HDMI_1' }, 'audio.output.set': { id: 'tv_speaker' },
  'display.set': { on: true }, 'power.off': {}, 'power.wake': {}, 'text.focus.read': {}, 'text.insert': { text: 'private typed text' },
  'url.open': { url: 'https://media.example/watch' }, 'media.url.play': { url: 'https://media.example/clip.mp4', mimeType: 'video/mp4' },
  'dlna.play': { url: 'http://192.168.1.9:8096/clip.mp4', mimeType: 'video/mp4', title: 'Local movie' },
  'dlna.control': { action: 'stop' }, 'dlna.status': {}, 'media.host.release': {}, 'media.file.cast': { filePath: path.join(ROOT, 'clip.mp4') },
  'screen.observe': {},
  'vacuum.start': {}, 'vacuum.pause': {}, 'vacuum.resume': {}, 'vacuum.stop': {}, 'vacuum.dock': {}, 'vacuum.details.read': {},
};

test('registry contains only fixed reviewed actions and immutable strict JSON schemas', () => {
  assert.equal(Object.keys(ACTIONS).length, 34);
  assert.deepEqual(Object.keys(EXAMPLES).sort(), Object.keys(ACTIONS).sort());
  assert.deepEqual(READ_CAPABILITIES, ['state.read', 'events.read', 'screen.read']);
  for (const definition of Object.values(ACTIONS)) {
    assert.equal(definition.inputSchema.type, 'object');
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(Object.isFrozen(definition.inputSchema.properties), true);
  }
  assert.throws(() => { ACTIONS['owner.*'] = {}; }, TypeError);
});

test('valid actions normalize copied data and explicit defaults without a device call', () => {
  for (const [name, args] of Object.entries(EXAMPLES)) {
    const before = JSON.stringify(args);
    const result = check(name, args);
    assert.notEqual(result, args);
    assert.equal(JSON.stringify(args), before);
  }
  assert.deepEqual(check('text.insert', { text: 'hello' }), { text: 'hello', replace: false });
  assert.deepEqual(check('screen.observe', {}), { screenshot: true, timeoutMs: 25000 });
  assert.equal(check('media.file.cast', EXAMPLES['media.file.cast']).mimeType, 'video/mp4');
});

test('unknown actions, unexpected properties and missing arguments default to deny', () => {
  for (const name of ['ssap.request', 'luna.run', 'owner.*', 'grants.write', 'constructor', '__proto__', '*', 'screen.read']) throws(() => check(name, {}), 'UNKNOWN_ACTION');
  for (const [name, args] of Object.entries(EXAMPLES)) {
    throws(() => check(name, { ...args, arbitrary: true }), 'INVALID_ARGUMENTS');
    throws(() => check(name, null), 'INVALID_ARGUMENTS');
    for (const required of ACTIONS[name].inputSchema.required) {
      const missing = { ...args }; delete missing[required];
      throws(() => check(name, missing), 'INVALID_ARGUMENTS');
    }
  }
  throws(() => check('app.launch', { id: 'example.app', params: {} }), 'INVALID_ARGUMENTS');
  throws(() => check('app.launch', { id: 'example.app', uri: 'luna://service/run' }), 'INVALID_ARGUMENTS');
});

test('numeric, boolean, text, MIME and named controls enforce meaningful bounds', () => {
  for (const volume of [-1, 101, 0.5, NaN, Infinity, '20']) throws(() => check('audio.volume.set', { volume }), 'INVALID_ARGUMENTS');
  for (const [name, args] of [
    ['audio.mute.set', { muted: 'false' }], ['navigation.key', { key: 'POWER' }], ['navigation.key', { key: 'IN_START' }],
    ['pointer.move', { dx: 10001, dy: 0 }], ['pointer.scroll', { dx: 0, dy: -1001 }],
    ['media.control', { action: 'arbitrary' }], ['dlna.control', { action: 'fastForward' }],
    ['input.select', { id: 'input/../../method' }], ['text.insert', { text: '' }],
    ['text.insert', { text: 'x'.repeat(4097) }], ['text.insert', { text: 'secret\0value' }],
    ['media.url.play', { url: 'https://media.example/movie.mp4', mimeType: 'video/mp4\r\nInjected: yes' }],
    ['screen.observe', { timeoutMs: 4999 }], ['screen.observe', { timeoutMs: 25001 }], ['screen.observe', { screenshot: 1 }],
  ]) throws(() => check(name, args), 'INVALID_ARGUMENTS');
});

test('prototype values, proxies and accessors are rejected without invoking code', () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'volume', { enumerable: true, get() { invoked++; return 25; } });
  const proxy = new Proxy({}, { getPrototypeOf() { invoked++; return Object.prototype; } });
  for (const args of [accessor, proxy, Object.create({ volume: 25 }), Object.create(null),
    JSON.parse('{"__proto__":{"volume":25}}'), { volume: { valueOf() { invoked++; return 25; } } }, { volume: 25, [Symbol('hidden')]: true }]) {
    throws(() => check('audio.volume.set', args), 'INVALID_ARGUMENTS');
  }
  throws(() => validateAction('screen.observe', {}, Object.defineProperty({}, 'deviceConfig', { enumerable: true, get() { invoked++; return DEVICE; } })), 'INVALID_ARGUMENTS');
  assert.equal(invoked, 0);
});

test('URL origins are denied by default and compare scheme, host and port exactly', () => {
  for (const name of ['url.open', 'media.url.play', 'dlna.play']) {
    const args = { url: 'https://media.example/movie.mp4', ...(name === 'url.open' ? {} : { mimeType: 'video/mp4' }) };
    throws(() => check(name, args, {}), 'LOCAL_POLICY_DENIED');
    for (const origin of ['http://media.example', 'https://media.example.evil.test', 'https://media.example:444']) {
      throws(() => check(name, args, { allowedUrlOrigins: [origin] }), 'LOCAL_POLICY_DENIED');
    }
    assert.equal(check(name, args).url, args.url);
  }
  assert.equal(check('url.open', { url: ' ht\ntps://media.example/watch' }).url, 'https://media.example/watch');
  assert.equal(check('url.open', { url: 'http://192.168.1.9:8096/movie.mp4' }).url, 'http://192.168.1.9:8096/movie.mp4');
});

test('unsafe literal addresses, credentials and unreviewed schemes cannot become approved origins', () => {
  for (const origin of ['http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://169.254.169.254',
    'http://224.0.0.1', 'http://255.255.255.255', 'http://192.168.1.255', 'http://0.0.0.0', 'http://localhost',
    'http://tv.localhost', 'http://[::1]', 'http://[::]', 'http://[::ffff:127.0.0.1]', 'http://[fe80::1]', 'http://[ff02::1]',
    'https://user:private-password@media.example', 'file:///tmp/private', 'luna://system/run', 'javascript:alert(1)']) {
    throws(() => check('url.open', { url: origin }, { allowedUrlOrigins: [origin] }));
  }
  for (const allowedUrlOrigins of [null, '*', ['https://*.example'], ['https://media.example/private'],
    ['https://media.example?secret=1'], ['https://media.example#fragment']]) {
    throws(() => check('url.open', { url: 'https://media.example/watch' }, { allowedUrlOrigins }), 'INVALID_CONFIG');
  }
  const publicV6 = 'https://[2001:4860:4860::8888]';
  assert.equal(check('url.open', { url: publicV6 + '/fixture' }, { allowedUrlOrigins: [publicV6] }).url, publicV6 + '/fixture');
});

test('provider content IDs are narrow data and HTTP links still require local origin permission', () => {
  for (const content of ['70GoJHflgHH9', 'e8896bfa-1052-41f7-ae2e-00255d77cf05', 'provider_id.v2']) assert.equal(check('app.content.launch', { id: 'example.app', content }, {}).content, content);
  for (const content of ['java\nscript:alert(1)', 'luna://system/run', 'provider:command', '//evil.example/path', 'https%3A%2F%2Fevil.example', 'id with spaces', 'x'.repeat(129)]) throws(() => check('app.content.launch', { id: 'example.app', content }), 'INVALID_ARGUMENTS');
  throws(() => check('app.content.launch', { id: 'example.app', content: 'https://evil.example/watch' }), 'LOCAL_POLICY_DENIED');
  assert.equal(check('app.content.launch', { id: 'example.app', content: ' ht\ntps://media.example/watch' }).content, 'https://media.example/watch');
});

test('file casting needs local media roots and denies traversal, network shares and MIME disguises', () => {
  const filePath = path.join(ROOT, 'clip.mp4');
  throws(() => check('media.file.cast', { filePath }, {}), 'LOCAL_POLICY_DENIED');
  throws(() => check('media.file.cast', { filePath }, { mediaRoots: ['relative'] }), 'INVALID_CONFIG');
  for (const [selected, mimeType] of [['relative.mp4', undefined], ['\\\\server\\share\\clip.mp4', undefined],
    [path.join(ROOT, 'credentials.json'), 'video/mp4'], [filePath, 'audio/mpeg']]) {
    throws(() => check('media.file.cast', { filePath: selected, ...(mimeType ? { mimeType } : {}) }), 'INVALID_ARGUMENTS');
  }
  throws(() => check('media.file.cast', { filePath: path.join(ROOT, '..', 'outside.mp4') }), 'LOCAL_POLICY_DENIED');
  assert.equal(check('media.file.cast', { filePath }).mimeType, 'video/mp4');
});

test('temporary observation needs explicit local opt-in even when screenshot is disabled', () => {
  for (const allowTemporaryObserver of [undefined, false, 'true', 1]) {
    for (const screenshot of [true, false]) throws(() => check('screen.observe', { screenshot }, { allowTemporaryObserver }), 'LOCAL_POLICY_DENIED');
  }
  assert.deepEqual(check('screen.observe', { screenshot: false, timeoutMs: 5000 }), { screenshot: false, timeoutMs: 5000 });
});

test('grants normalize independent copies with exact device and capability lists', () => {
  const input = grant({ expiresAt: '2026-10-20T13:00:00+01:00' });
  const result = validateGrant(input);
  assert.equal(result.expiresAt, '2026-10-20T12:00:00.000Z');
  assert.notEqual(result.deviceIds, input.deviceIds);
  assert.notEqual(result.capabilities, input.capabilities);
  assert.equal(authorize(result, { deviceId: 'living-room', capability: 'audio.volume.set', now: NOW }), undefined);
  assert.equal(authorize(result, { deviceId: 'living-room', capability: 'state.read', now: NOW }), undefined);
});

test('every authorization independently checks exact expiry, revocation, device and capability', () => {
  const input = grant();
  const request = { deviceId: 'living-room', capability: 'audio.volume.set', now: NOW };
  authorize(input, request);
  throws(() => authorize(input, { ...request, deviceId: 'other-room' }), 'ACCESS_DENIED');
  throws(() => authorize(input, { ...request, capability: 'audio.mute.set' }), 'ACCESS_DENIED');
  throws(() => authorize(input, { ...request, now: Date.parse(input.expiresAt) }), 'GRANT_EXPIRED');
  throws(() => authorize(input, { ...request, now: Date.parse(input.expiresAt) + 1 }), 'GRANT_EXPIRED');
  input.revokedAt = '2026-10-19T12:00:01Z';
  throws(() => authorize(input, request), 'GRANT_REVOKED');
  throws(() => authorize(grant(), { ...request, now: Infinity }), 'ACCESS_DENIED');
});

test('state/image read grants never grant capture and capture alone never grants image access', () => {
  const reads = grant({ capabilities: ['state.read', 'events.read', 'screen.read'] });
  throws(() => authorize(reads, { deviceId: 'living-room', capability: 'screen.observe', now: NOW }), 'ACCESS_DENIED');
  const capture = grant({ capabilities: ['screen.observe'] });
  authorize(capture, { deviceId: 'living-room', capability: 'screen.observe', now: NOW });
  throws(() => authorize(capture, { deviceId: 'living-room', capability: 'screen.read', now: NOW }), 'ACCESS_DENIED');
  throws(() => check('screen.observe', {}, {}), 'LOCAL_POLICY_DENIED');
  throws(() => authorize(reads, { deviceId: 'living-room', capability: 'app.list', now: NOW }), 'ACCESS_DENIED');
  authorize(grant({ capabilities: ['app.list'] }), { deviceId: 'living-room', capability: 'app.list', now: NOW });
});

test('grants reject wildcards, owner/management scopes, malformed timestamps and hidden data', () => {
  for (const capabilities of [['*'], ['owner'], ['owner.*'], ['grants.write'], ['state.*'], ['state.read', 'state.read'], []]) throws(() => validateGrant(grant({ capabilities })), 'INVALID_GRANT');
  for (const deviceIds of [['*'], ['living-room', 'living-room'], [], ['other/device']]) throws(() => validateGrant(grant({ deviceIds })), 'INVALID_GRANT');
  for (const expiresAt of [null, 'tomorrow', '2026-02-30T12:00:00Z', '2026-10-20T12:00:00', '2026-10-20T24:00:00Z']) throws(() => validateGrant(grant({ expiresAt })), 'INVALID_GRANT');
  throws(() => validateGrant({ ...grant(), owner: true }), 'INVALID_GRANT');
  throws(() => validateGrant(grant({ revokedAt: false })), 'INVALID_GRANT');
  let invoked = 0;
  const input = grant(); Object.defineProperty(input, 'label', { enumerable: true, get() { invoked++; return 'bad'; } });
  throws(() => validateGrant(input), 'INVALID_GRANT');
  assert.equal(invoked, 0);
});

test('result redaction preserves ordinary state while suppressing credentials, URLs and sensitive input', () => {
  const value = { volume: 25, muted: false, title: 'Movie', args: { text: 'typed-private', filePath: 'C:\\private\\clip.mp4' },
    nested: { 'client-key': 'paired-secret', authorization: 'Bearer private-bearer', access_token: 'private-token',
      cookie: 'account=session', socketPath: 'ws://192.168.1.2/private', url: 'https://media.example?token=private-token' },
    message: 'paired-secret request https://media.example/private?secret=value failed at /home/user/private/file',
    image: Buffer.from('private-pixels') };
  const output = redactHub(value, ['paired-secret']);
  const serialized = JSON.stringify(output);
  for (const secret of ['typed-private', 'paired-secret', 'private-bearer', 'private-token', 'account=session', 'private-pixels', 'https://', 'ws://', 'C:\\private', '/home/user']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(output.volume, 25); assert.equal(output.muted, false); assert.equal(output.title, 'Movie');
  assert.equal(value.args.text, 'typed-private');
});

test('redaction does not execute getters or proxy traps and bounds cycles', () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'metadata', { enumerable: true, get() { invoked++; return 'secret'; } });
  const proxy = new Proxy({}, { getPrototypeOf() { invoked++; throw new Error('trap'); } });
  assert.equal(redactHub(accessor).metadata, '[redacted]');
  assert.equal(redactHub(proxy), '[omitted]');
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => JSON.stringify(redactHub(cyclic)));
  assert.equal(invoked, 0);
});
