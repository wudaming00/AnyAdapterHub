import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createSecretStore, sealSecret, openSecret, isSecretEnvelope, isSecretStoreSupported, isSupportedSecretProvider, SecretStoreError } from '../lib/security/secret-store.mjs';
import { SecretStoreError as SharedSecretStoreError } from '../lib/security/secret-errors.mjs';

test('the public error export retains the platform provider error identity', () => {
  assert.equal(SecretStoreError, SharedSecretStoreError);
});

function fixture() {
  const key = randomBytes(32); const captured = [];
  const store = createSecretStore({ provider: 'test-aes-gcm',
    async protect(clear, entropy) {
      captured.push({ clear, entropy });
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(entropy);
      return Buffer.concat([nonce, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    },
    async unprotect(protectedBytes, entropy) {
      captured.push({ protectedBytes, entropy });
      const decipher = createDecipheriv('aes-256-gcm', key, protectedBytes.subarray(0, 12)); decipher.setAAD(entropy);
      decipher.setAuthTag(protectedBytes.subarray(-16));
      return Buffer.concat([decipher.update(protectedBytes.subarray(12, -16)), decipher.final()]);
    },
  });
  return { store, captured };
}

test('generic JSON secret round trips and ciphertext is randomized without recording purpose or plaintext', async () => {
  const { store } = fixture();
  const secret = { token: 'fixture-token-only', nested: ['中文', null, 12, true], empty: {}, zero: -0 };
  const one = await store.sealSecret(secret, { purpose: 'hub/owner-token' });
  const two = await store.sealSecret(secret, { purpose: 'hub/owner-token' });
  assert.deepEqual(Object.keys(one).sort(), ['protected', 'provider', 'version']);
  assert.notEqual(one.protected, two.protected);
  assert.deepEqual(await store.openSecret(one, { purpose: 'hub/owner-token' }), { ...secret, zero: 0 });
  assert.equal(JSON.stringify(one).includes(secret.token), false);
  assert.equal(JSON.stringify(one).includes('hub/owner-token'), false);
  assert.equal(store.isSecretEnvelope(one), true); assert.equal(Object.isFrozen(one), true);
  assert.equal(isSecretEnvelope(one), false); // Explicit test providers cannot become the production provider.
});

test('purpose is cryptographically bound and ciphertext modification fails without leaking provider errors', async () => {
  const { store } = fixture();
  const one = await store.sealSecret('fixture-private-value', { purpose: 'lg/client-key:device-1' });
  await assert.rejects(store.openSecret(one, { purpose: 'lg/client-key:device-2' }), error => error.code === 'SECRET_STORE_FAILED' && !error.message.includes('fixture'));
  const tampered = Buffer.from(one.protected, 'base64'); tampered[15] ^= 1;
  await assert.rejects(store.openSecret({ ...one, protected: tampered.toString('base64') }, { purpose: 'lg/client-key:device-1' }), { code: 'SECRET_STORE_FAILED' });
  await assert.rejects(store.openSecret({ ...one, provider: 'windows-dpapi' }, { purpose: 'lg/client-key:device-1' }), { code: 'INVALID_SECRET_ENVELOPE' });
});

test('entropy uses the exact AnyAdapterHub namespace and mutable secret buffers are cleared after use', async () => {
  const expected = createHash('sha256').update('AnyAdapterHub:hub/test').digest();
  let seenClear; let seenEntropy; let returnedProtected;
  const store = createSecretStore({ provider: 'test-provider',
    async protect(clear, entropy) { seenClear = clear; seenEntropy = entropy; assert.deepEqual(entropy, expected); returnedProtected = Buffer.from('encrypted-fixture'); return returnedProtected; },
    async unprotect() { return Buffer.from('null'); },
  });
  await store.sealSecret({ token: 'fixture' }, { purpose: 'hub/test' });
  assert.ok(seenClear.every(value => value === 0)); assert.ok(seenEntropy.every(value => value === 0)); assert.ok(returnedProtected.every(value => value === 0));
});

test('malformed envelopes, noncanonical base64, unsupported providers and accessors are rejected', async () => {
  const { store } = fixture(); const valid = await store.sealSecret(null, { purpose: 'test' });
  const invalid = [null, [], {}, { ...valid, version: 2 }, { ...valid, extra: true }, { ...valid, protected: '' },
    { ...valid, protected: '!!!!' }, { ...valid, protected: 'AB==' }, { ...valid, protected: valid.protected + '\n' }, { ...valid, provider: 'other' }];
  let invoked = false;
  invalid.push(Object.defineProperty({ version: 1, provider: valid.provider }, 'protected', { enumerable: true, get() { invoked = true; return valid.protected; } }));
  for (const value of invalid) { assert.equal(store.isSecretEnvelope(value), false); await assert.rejects(store.openSecret(value, { purpose: 'test' }), { code: 'INVALID_SECRET_ENVELOPE' }); }
  assert.equal(invoked, false);
});

test('non-JSON values, cycles, accessors, sparse arrays and oversized secrets fail before the provider', async () => {
  let calls = 0;
  const store = createSecretStore({ provider: 'test-provider', protect() { calls += 1; return Buffer.from('encrypted'); }, unprotect() { return Buffer.from('null'); } });
  const cycle = {}; cycle.self = cycle;
  let invoked = false; const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked = true; return 'fixture'; } });
  const sparse = []; sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cycle, accessor, sparse, new Proxy({}, {}), 'x'.repeat(256 * 1024 + 1)])
    await assert.rejects(store.sealSecret(value, { purpose: 'test' }), { code: 'INVALID_SECRET_VALUE' });
  assert.equal(calls, 0); assert.equal(invoked, false);
  for (const purpose of [undefined, '', 'bad purpose', '../bad?purpose', 'x'.repeat(129)]) await assert.rejects(store.sealSecret(null, { purpose }), { code: 'INVALID_SECRET_PURPOSE' });
});

test('provider failures and invalid decrypted JSON are generic, never plaintext fallbacks', async () => {
  const failure = createSecretStore({ provider: 'test-provider', protect() { throw new Error('fixture-private-provider-error'); }, unprotect() { throw new Error('fixture-private-provider-error'); } });
  await assert.rejects(failure.sealSecret('secret', { purpose: 'test' }), error => error.code === 'SECRET_STORE_FAILED' && !error.message.includes('fixture'));
  const invalid = createSecretStore({ provider: 'test-provider', protect() { return Buffer.from('encrypted'); }, unprotect() { return Buffer.from('not JSON'); } });
  await assert.rejects(invalid.openSecret({ version: 1, provider: 'test-provider', protected: Buffer.from('encrypted').toString('base64') }, { purpose: 'test' }), { code: 'SECRET_STORE_FAILED' });
});

test('the production provider fails closed outside Windows without selecting a test provider', { skip: process.platform === 'win32' }, async () => {
  assert.equal(isSecretStoreSupported(), false); assert.equal(isSupportedSecretProvider('windows-dpapi'), false);
  await assert.rejects(sealSecret('fixture', { purpose: 'test' }), { code: 'SECRET_STORE_UNSUPPORTED' });
  await assert.rejects(openSecret({ version: 1, provider: 'windows-dpapi', protected: 'AQ==' }, { purpose: 'test' }), { code: 'SECRET_STORE_UNSUPPORTED' });
});

test('Windows CurrentUser DPAPI round trip, wrong purpose and ciphertext tampering fail closed', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(isSecretStoreSupported(), true); assert.equal(isSupportedSecretProvider('windows-dpapi'), true);
  const value = { token: 'ephemeral-fixture-测试', commandText: '$(Write-Output fixture); `literal`' };
  const encrypted = await sealSecret(value, { purpose: 'test/current-user' });
  assert.equal(isSecretEnvelope(encrypted), true);
  assert.equal(encrypted.provider, 'windows-dpapi');
  assert.deepEqual(await openSecret(encrypted, { purpose: 'test/current-user' }), value);
  await assert.rejects(openSecret(encrypted, { purpose: 'test/wrong-purpose' }), { code: 'SECRET_STORE_FAILED' });
  const bytes = Buffer.from(encrypted.protected, 'base64'); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(openSecret({ ...encrypted, protected: bytes.toString('base64') }, { purpose: 'test/current-user' }), { code: 'SECRET_STORE_FAILED' });
});

test('Windows operation deadline reports only its fixed timeout code and kills its child', { skip: process.platform !== 'win32' }, async t => {
  const child = new EventEmitter(); let killed = 0;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.kill = () => { killed++; return true; };
  const mock = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); t.mock.timers.reset(); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completed = false;
  const pending = sealSecret('non-secret-deadline-fixture', { purpose: 'test/deadline' });
  const rejected = assert.rejects(pending, error => { completed = true; return error.code === 'SECRET_STORE_TIMEOUT' && error.message === 'The protected secret operation could not be completed.'; });
  t.mock.timers.tick(44999); await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1); await rejected;
  assert.equal(killed, 1);
});

test('Windows production protection uses fixed private pipes and an allowlisted process environment', { skip: process.platform !== 'win32' }, async t => {
  const child = new EventEmitter(); let request; let input;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end(wire) {
    input = wire;
    request = JSON.parse(wire.toString('utf8'));
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('AQ==\r\n')); child.emit('close', 0); });
  } });
  child.kill = () => true;
  const mock = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const value = 'ephemeral-protocol-fixture';
  const envelope = await sealSecret(value, { purpose: 'test/process-transport' });
  assert.equal(mock.mock.callCount(), 1);
  const [executable, args, options] = mock.mock.calls[0].arguments;
  assert.ok(executable.endsWith('powershell.exe'));
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(args.length, 5);
  assert.equal(args.join(' ').includes(value), false);
  assert.equal(args.join(' ').includes(request.bytes), false);
  assert.equal(args.join(' ').includes(request.entropy), false);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA']);
  assert.ok(Object.keys(options.env).every(key => allowed.has(key.toUpperCase())));
  assert.deepEqual(Object.keys(request).sort(), ['bytes', 'entropy', 'operation']);
  assert.equal(request.operation, 'protect');
  assert.equal(Buffer.from(request.bytes, 'base64').toString('utf8'), JSON.stringify(value));
  assert.deepEqual(Buffer.from(request.entropy, 'base64'), createHash('sha256').update('AnyAdapterHub:test/process-transport').digest());
  assert.equal(envelope.protected, 'AQ==');
  assert.ok(input.every(byte => byte === 0));
});

test('Windows spawn failure cannot forge the timeout code or leak its message', { skip: process.platform !== 'win32' }, async t => {
  const errors = [Object.assign(new Error('sensitive-provider-message'), { code: 'SECRET_STORE_TIMEOUT' }),
    new SecretStoreError('UNREVIEWED_PROVIDER_CODE')];
  const mock = t.mock.method(childProcess, 'spawn', () => { throw errors.shift(); });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(sealSecret('non-secret-spawn-fixture', { purpose: 'test/spawn-failure' }), error =>
      error.code === 'SECRET_STORE_FAILED' && error.message === 'The protected secret operation could not be completed.');
  }
  assert.equal(mock.mock.callCount(), 2);
});
