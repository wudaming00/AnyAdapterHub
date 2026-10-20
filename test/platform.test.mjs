import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { describePlatform } from '../lib/platform/runtime.mjs';
import { resolvePowerShell, resolveOpenSSL, protectedProcessEnvironment, cryptoProcessEnvironment, PlatformToolError } from '../lib/platform/system-tools.mjs';
import { isSecretStoreSupported, sealSecret } from '../lib/security/secret-store.mjs';

function host(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', original));
}
function environment(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}
function filesystem(t, stat, realpath) {
  const mocks = [t.mock.method(fs, 'lstatSync', stat), t.mock.method(fs, 'realpathSync', realpath)];
  syncBuiltinESMExports();
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
}
const regular = { isFile: () => true, isSymbolicLink: () => false };

test('platform inventory is immutable and distinguishes implemented storage from planned distributions', () => {
  assert.deepEqual(describePlatform('win32'), {
    id: 'windows', nodePlatform: 'win32', secretProtection: { implemented: true, provider: 'windows-dpapi' },
    fileProtection: 'windows-dacl', nativeDistribution: 'planned',
  });
  for (const [platform, id] of [['linux', 'linux'], ['darwin', 'macos']]) {
    const item = describePlatform(platform);
    assert.equal(item.id, id); assert.equal(item.fileProtection, 'posix-mode');
    assert.deepEqual(item.secretProtection, { implemented: false, provider: null });
    assert.equal(item.nativeDistribution, 'planned');
  }
  const item = describePlatform('win32');
  assert.throws(() => { item.secretProtection.provider = 'test-provider'; }, TypeError);
  assert.throws(() => { item.id = 'linux'; }, TypeError);
  for (const value of ['freebsd', '__proto__', '', null, {}, new Proxy({}, {})]) {
    assert.equal(describePlatform(value).id, 'unsupported');
    assert.equal(describePlatform(value).secretProtection.implemented, false);
  }
});

test('describing Windows cannot enable production protection on Linux, macOS or an unknown host', async t => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      assert.equal(describePlatform('win32').secretProtection.implemented, true);
      assert.equal(isSecretStoreSupported(), false);
      await assert.rejects(sealSecret('non-secret-platform-fixture', { purpose: 'test/platform' }), { code: 'SECRET_STORE_UNSUPPORTED' });
      assert.throws(resolvePowerShell, { code: 'PLATFORM_TOOL_UNAVAILABLE' });
    } finally { Object.defineProperty(process, 'platform', original); }
  }
});

test('process environments exclude executable/module/config overrides and unrelated secrets', t => {
  for (const key of ['PATH', 'PSModulePath', 'OPENSSL_CONF', 'NODE_OPTIONS', 'ANYADAPTER_TEST_SECRET']) environment(t, key, 'non-secret-environment-fixture');
  environment(t, 'TEMP', 'non-secret-temp-fixture');
  environment(t, 'USERPROFILE', 'non-secret-profile-fixture');
  const protectedEnv = protectedProcessEnvironment(), cryptoEnv = cryptoProcessEnvironment();
  const protectedKeys = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA']);
  const cryptoKeys = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']);
  assert.ok(Object.keys(protectedEnv).every(key => protectedKeys.has(key.toUpperCase())));
  assert.ok(Object.keys(cryptoEnv).every(key => cryptoKeys.has(key.toUpperCase())));
  assert.equal(protectedEnv.TEMP, 'non-secret-temp-fixture'); assert.equal(cryptoEnv.TEMP, protectedEnv.TEMP);
  assert.equal(protectedEnv.USERPROFILE, 'non-secret-profile-fixture'); assert.equal(cryptoEnv.USERPROFILE, undefined);
  protectedEnv.TEMP = 'changed-copy'; assert.equal(process.env.TEMP, 'non-secret-temp-fixture');
});

test('PowerShell resolves only the canonical in-root Windows executable', t => {
  host(t, 'win32'); environment(t, 'SystemRoot', 'C:\\Windows');
  const root = path.resolve('non-secret-system-root-fixture');
  const executable = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const seen = [];
  filesystem(t, file => { seen.push(file); assert.equal(file, executable); return regular; }, file => {
    if (file === 'C:\\Windows') return root;
    assert.equal(file, executable); return executable;
  });
  assert.equal(resolvePowerShell(), executable); assert.deepEqual(seen, [executable]);
});

test('PowerShell rejects missing, relative, UNC, linked and escaping paths with static errors', t => {
  host(t, 'win32'); environment(t, 'SystemRoot', 'C:\\Windows');
  const root = path.resolve('non-secret-system-root-fixture');
  let linked = false, escape = false;
  filesystem(t, () => ({ isFile: () => true, isSymbolicLink: () => linked }), file => {
    if (file === 'C:\\Windows') return root;
    return escape ? path.resolve(root, '..', 'outside', 'powershell.exe') : file;
  });
  const reject = () => assert.throws(resolvePowerShell, error => error instanceof PlatformToolError &&
    error.code === 'PLATFORM_TOOL_UNAVAILABLE' && error.message === 'The fixed platform tool is unavailable.');
  for (const value of ['', 'Windows', '\\Windows', '\\\\server\\Windows', '//server/Windows', 'C:Windows']) {
    process.env.SystemRoot = value; reject();
  }
  delete process.env.SystemRoot; reject();
  process.env.SystemRoot = 'C:\\Windows'; linked = true; reject();
  linked = false; escape = true; reject();
});

test('OpenSSL uses only fixed per-platform candidates, skipping linked or missing files', t => {
  host(t, 'win32'); const seen = [];
  filesystem(t, file => { seen.push(file); return { isFile: () => true, isSymbolicLink: () => seen.length === 1 }; }, file => file);
  assert.equal(resolveOpenSSL(), 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
  assert.deepEqual(seen, ['C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']);
  for (const platform of ['linux', 'darwin']) {
    Object.defineProperty(process, 'platform', { value: platform }); seen.length = 0;
    assert.equal(resolveOpenSSL(), '/bin/openssl'); assert.deepEqual(seen, ['/usr/bin/openssl', '/bin/openssl']);
  }
  Object.defineProperty(process, 'platform', { value: 'unknown' }); seen.length = 0;
  assert.throws(resolveOpenSSL, { code: 'PLATFORM_TOOL_UNAVAILABLE' }); assert.deepEqual(seen, []);
});

test('missing fixed tools cannot fall back to PATH or disclose filesystem diagnostics', t => {
  host(t, 'linux'); const seen = [];
  filesystem(t, file => { seen.push(file); throw new Error('non-secret-private-path-fixture'); }, () => { throw new Error('unreachable'); });
  assert.throws(resolveOpenSSL, error => error instanceof PlatformToolError && !error.message.includes('fixture'));
  assert.deepEqual(seen, ['/usr/bin/openssl', '/bin/openssl']);
});
