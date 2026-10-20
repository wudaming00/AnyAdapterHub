import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { assertPrivateOwner, assertPrivateRegularFile, protectDirectoryPermissions, protectFilePermissions } from '../lib/platform/private-storage.mjs';
import { resolvePowerShell } from '../lib/platform/system-tools.mjs';

const WINDOWS = process.platform === 'win32';
const ALLOWED_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PSMODULEPATH', 'DEVICE_HUB_ACL_PATH', 'DEVICE_HUB_ACL_KIND']);
const ordinary = overrides => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1,
  uid: process.getuid?.(), ...overrides });

function interceptProcess(t, implementation) {
  const mocked = t.mock.method(childProcess, 'execFileSync', implementation);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

test('private storage rejects symbolic, non-file and hard-linked entries before permissions change', () => {
  assert.doesNotThrow(() => assertPrivateRegularFile(ordinary()));
  for (const overrides of [{ isSymbolicLink: () => true }, { isFile: () => false }, { nlink: 2 }]) {
    assert.throws(() => assertPrivateRegularFile(ordinary(overrides)), { code: 'HUB_HOME_UNSAFE' });
  }
});

test('POSIX owner validation refuses a different owner', { skip: WINDOWS || !process.getuid }, () => {
  assert.doesNotThrow(() => assertPrivateOwner({ uid: process.getuid() }));
  assert.throws(() => assertPrivateOwner({ uid: process.getuid() + 1 }), { code: 'HUB_HOME_UNSAFE' });
});

test('Windows ACL operations use the fixed system executable, script, bounded pipes and minimal environment', { skip: !WINDOWS }, async t => {
  const unrelatedKey = 'ANYADAPTER_STORAGE_TEST_SECRET';
  const old = process.env[unrelatedKey];
  const oldModulePath = process.env.PSModulePath;
  process.env[unrelatedKey] = 'synthetic-fixture-must-not-reach-the-process';
  process.env.PSModulePath = 'C:\\synthetic-untrusted-user-modules';
  t.after(() => { if (old === undefined) delete process.env[unrelatedKey]; else process.env[unrelatedKey] = old; });
  t.after(() => { if (oldModulePath === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = oldModulePath; });
  const target = path.resolve("fixture path ' ; $([version]1.0)");
  const calls = [];
  interceptProcess(t, (file, args, options) => { calls.push({ file, args, options }); return 'ACL_OK\r\n'; });
  await protectDirectoryPermissions(target, []);
  await protectFilePermissions(target, null);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.file, resolvePowerShell());
    assert.equal(path.isAbsolute(call.file), true);
    assert.deepEqual(call.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    assert.equal(call.args.at(-1).includes(target), false);
    assert.equal(call.args.at(-1), calls[0].args.at(-1));
    assert.match(call.args.at(-1), /\$PSModuleAutoLoadingPreference = 'None'/);
    assert.doesNotMatch(call.args.at(-1), /\b(?:Get-Item|Get-ChildItem|Get-Acl|Set-Acl|ForEach-Object|Import-Module)\b/i);
    assert.equal(call.options.env.DEVICE_HUB_ACL_PATH, target);
    assert.equal(call.options.env.DEVICE_HUB_ACL_KIND, index === 0 ? 'directory' : 'file');
    assert.equal(Object.hasOwn(call.options.env, unrelatedKey), false);
    assert.ok(Object.keys(call.options.env).every(key => ALLOWED_ENV.has(key.toUpperCase())));
    assert.equal(Object.keys(call.options.env).some(key => key.toLowerCase() === 'path'), false);
    assert.equal(call.options.env.PSModulePath, path.join(path.dirname(call.file), 'Modules'));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 15000);
    assert.equal(call.options.maxBuffer, 64 * 1024);
    assert.equal(call.options.stdio, 'pipe');
  }
});

test('Windows ACL child failure or unrecognized output stays closed without reflecting diagnostics', { skip: !WINDOWS }, async t => {
  const diagnostic = 'synthetic-private-diagnostic';
  let call = 0;
  interceptProcess(t, () => { if (call++ === 0) return diagnostic; throw new Error(diagnostic); });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(protectFilePermissions(path.resolve('fixture-only'), null), error => {
      assert.equal(error.code, 'HUB_HOME_UNSAFE');
      assert.equal(error.message, 'Private Windows permissions could not be verified.');
      assert.equal(error.message.includes(diagnostic), false);
      return true;
    });
  }
  assert.equal(call, 2);
});
