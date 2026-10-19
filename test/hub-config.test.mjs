import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, chmod, open, symlink, link, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { initializeHub, addHubDevice, loadHubConfig, loadTVConfig, privateDirectory, protectHubHome, readJson,
  writePrivateJson, setAdapterEnabled, setDeviceFeatures } from '../lib/hub/config.mjs';
import { protectTVKey, resolveCredential, resolveTVKey } from '../lib/security/credentials.mjs';
import { testSecretStore, testIdentity } from './helpers/secrets.mjs';

const WINDOWS = process.platform === 'win32';
const HOST = '192.168.50.25';
const TOKEN = 'fixture_owner_credential_abcdefghijklmnopqrstuvwxyz';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'device-hub-config-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const tvConfigPath = path.join(root, 'paired-tv.json');
  const secretStore = testSecretStore();
  await writeFile(tvConfigPath, JSON.stringify(await protectTVKey({ host: HOST, clientKey: 'offline-fixture-pairing-key',
    secure: true, certificatePin: 'b'.repeat(64) }, HOST, { secretStore })), { mode: 0o600 });
  return { root, home: path.join(root, 'hub'), tvConfigPath, secretStore, identity: await testIdentity(secretStore) };
}

async function markers(home, tvConfigPath) {
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'hub.json'), JSON.stringify({
    version: 1, port: 8765, devices: [{ id: 'tv', label: 'Fixture TV', adapter: 'lg-webos', configPath: tvConfigPath, host: HOST }],
  }), { mode: 0o600 });
  await writeFile(path.join(home, 'owner.json'), JSON.stringify({ url: 'http://127.0.0.1:8765', token: TOKEN }), { mode: 0o600 });
}

function powershell(script, target) {
  const env = { ...process.env, DEVICE_HUB_TEST_PATH: target };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return childProcess.execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000,
    env,
  }).trim();
}

const ACL_INFO = String.raw`
$ErrorActionPreference = 'Stop'
$root = Get-Item -LiteralPath $env:DEVICE_HUB_TEST_PATH -Force
$items = @($root)
if ($root.PSIsContainer) { $items += @(Get-ChildItem -LiteralPath $root.FullName -Force) }
$result = @($items | ForEach-Object {
  $acl = Get-Acl -LiteralPath $_.FullName
  [PSCustomObject]@{ name = $_.Name; directory = [bool]$_.PSIsContainer;
    currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    protected = $acl.AreAccessRulesProtected;
    rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [PSCustomObject]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited;
        allow = $_.AccessControlType.ToString(); rights = [int]$_.FileSystemRights;
        inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
    }) }
})
ConvertTo-Json -InputObject $result -Depth 6 -Compress
`;
const ADD_EVERYONE = String.raw`
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:DEVICE_HUB_TEST_PATH -Force
$acl = Get-Acl -LiteralPath $item.FullName
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
if ($item.PSIsContainer) { $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
  $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $item.FullName -AclObject $acl
`;

async function assertPrivate(home) {
  if (WINDOWS) {
    const rows = JSON.parse(powershell(ACL_INFO, home));
    for (const row of rows) {
      assert.equal(row.protected, true);
      assert.equal(row.owner, row.currentSid);
      assert.deepEqual(row.rules.map(rule => rule.sid).sort(), [...new Set([row.currentSid, 'S-1-5-18'])].sort());
      for (const rule of row.rules) {
        assert.equal(rule.inherited, false);
        assert.equal(rule.allow, 'Allow');
        assert.equal(rule.rights, 2032127);
        assert.equal(rule.inheritance, row.directory ? 3 : 0);
        assert.equal(rule.propagation, 0);
      }
    }
  } else {
    assert.equal((await lstat(home)).mode & 0o777, 0o700);
    for (const name of await readdir(home)) assert.equal((await lstat(path.join(home, name))).mode & 0o777, 0o600);
  }
}

test('initialization, serve loading and credential writes enforce private home and file permissions', async t => {
  const f = await fixture(t);
  const initialized = await initializeHub({ ...f, host: HOST });
  assert.equal(initialized.home, f.home);
  const loaded = await loadHubConfig(f.home, { secretStore: f.secretStore });
  assert.equal(loaded.devices[0].config.host, HOST);
  assert.equal(loaded.devices[0].id, 'living-room-tv');
  assert.equal(loaded.devices[0].config.certificatePin, 'b'.repeat(64));
  const owner = await readJson(path.join(f.home, 'owner.json'));
  assert.equal(Object.hasOwn(owner, 'token'), false);
  assert.match((await resolveCredential(owner, { secretStore: f.secretStore })).token, /^[A-Za-z0-9_-]{43}$/);
  await writePrivateJson(path.join(f.home, 'client.json'), { url: 'https://127.0.0.1:8765', certificatePin: f.identity.certificatePin,
    certificate: f.identity.certificate, token: TOKEN }, { secretStore: f.secretStore });
  await writePrivateJson(path.join(f.home, 'process.json'), { pid: 1 }, { exclusive: false, secretStore: f.secretStore });
  await writePrivateJson(path.join(f.home, 'process.json'), { pid: 2 }, { exclusive: false, secretStore: f.secretStore });
  assert.deepEqual(await readJson(path.join(f.home, 'process.json')), { pid: 2 });
  await assertPrivate(f.home);
  const ownerBytes = await readFile(path.join(f.home, 'owner.json'), 'utf8');
  await assert.rejects(initializeHub({ ...f, host: HOST }), /new or empty/);
  assert.equal(await readFile(path.join(f.home, 'owner.json'), 'utf8'), ownerBytes);
});

test('empty core has no enabled adapter and disabled enrollments never open their configuration', async t => {
  const f = await fixture(t);
  await initializeHub({ home: f.home, secretStore: f.secretStore, identity: f.identity });
  const record = await readJson(path.join(f.home, 'hub.json'));
  assert.deepEqual(record, { version: 2, port: 8765, adapters: [], devices: [] });
  assert.deepEqual((await loadHubConfig(f.home, { secretStore: f.secretStore })).devices, []);
  record.devices.push({ id: 'disabled-tv', label: 'Offline TV', adapter: 'lg-webos',
    configPath: path.join(f.root, 'never-open-this-file.json'), features: [] });
  await writePrivateJson(path.join(f.home, 'hub.json'), record, { exclusive: false, secretStore: f.secretStore });
  assert.deepEqual((await loadHubConfig(f.home, { secretStore: f.secretStore })).devices, []);
  await assert.rejects(lstat(record.devices[0].configPath), { code: 'ENOENT' });
});

test('LG enrollment requires the exact encrypted key binding and never falls back to plaintext', async t => {
  const f = await fixture(t);
  const options = { configPath: f.tvConfigPath, secretStore: f.secretStore };
  assert.equal((await loadTVConfig(options)).clientKey, 'offline-fixture-pairing-key');
  await assert.rejects(loadTVConfig({ ...options, host: '192.168.50.26' }), { code: 'SECRET_STORE_FAILED' });
  const sealed = await readJson(f.tvConfigPath);
  await writeFile(f.tvConfigPath, JSON.stringify({ ...sealed, clientKey: 'plaintext-fallback-must-fail' }));
  await assert.rejects(loadTVConfig(options), { code: 'ENCRYPTED_CREDENTIAL_REQUIRED' });
  await writeFile(f.tvConfigPath, JSON.stringify({ host: HOST, clientKey: 'plaintext-only-must-fail' }));
  await assert.rejects(loadTVConfig(options), { code: 'ENCRYPTED_CREDENTIAL_REQUIRED' });
  assert.equal((await readdir(f.root)).includes('hub'), false);
});

test('owner feature selection and adapter switches persist independently without changing credentials', async t => {
  const f = await fixture(t);
  await initializeHub({ ...f, host: HOST });
  const options = { secretStore: f.secretStore };
  const configPath = path.join(f.home, 'hub.json');
  const ownerPath = path.join(f.home, 'owner.json');
  const ownerBefore = await readFile(ownerPath, 'utf8');
  const tvBefore = await readFile(f.tvConfigPath, 'utf8');
  assert.deepEqual((await loadHubConfig(f.home, options)).devices[0].features, []);
  assert.deepEqual(await setDeviceFeatures(f.home, 'living-room-tv', ['observer', 'media'], options), {
    deviceId: 'living-room-tv', features: ['observer', 'media'], restartRequired: true,
  });
  assert.deepEqual((await loadHubConfig(f.home, options)).devices[0].features, ['observer', 'media']);
  let before = await readFile(configPath, 'utf8');
  await assert.rejects(setDeviceFeatures(f.home, 'living-room-tv', ['shell'], options), { code: 'INVALID_FEATURES' });
  await assert.rejects(setDeviceFeatures(f.home, 'living-room-tv', ['media', 'media'], options), { code: 'INVALID_FEATURES' });
  await assert.rejects(setDeviceFeatures(f.home, 'not-enrolled', ['media'], options), /enrolled v2 device/);
  assert.equal(await readFile(configPath, 'utf8'), before);
  assert.deepEqual(await setAdapterEnabled(f.home, 'lg-webos', false, options), {
    adapter: 'lg-webos', enabled: false, restartRequired: true,
  });
  assert.deepEqual((await loadHubConfig(f.home, options)).devices, []);
  assert.deepEqual((await readJson(configPath)).devices[0].features, ['observer', 'media']);
  await setDeviceFeatures(f.home, 'living-room-tv', [], options);
  assert.deepEqual((await readJson(configPath)).adapters, []);
  await setAdapterEnabled(f.home, 'lg-webos', true, options);
  await setAdapterEnabled(f.home, 'lg-webos', true, options);
  assert.deepEqual((await readJson(configPath)).adapters, ['lg-webos']);
  assert.deepEqual((await loadHubConfig(f.home, options)).devices[0].features, []);
  before = await readFile(configPath, 'utf8');
  await assert.rejects(setAdapterEnabled(f.home, '../unreviewed-plugin.mjs', true, options), { code: 'UNKNOWN_ADAPTER' });
  assert.equal(await readFile(configPath, 'utf8'), before);
  assert.equal(await readFile(ownerPath, 'utf8'), ownerBefore);
  assert.equal(await readFile(f.tvConfigPath, 'utf8'), tvBefore);
  await assertPrivate(f.home);
});

test('unrelated populated directories and incomplete markers are rejected before permission changes', async t => {
  const f = await fixture(t);
  await mkdir(f.home, { mode: 0o755 });
  await writeFile(path.join(f.home, 'unrelated.txt'), 'preserve this file', { mode: 0o644 });
  const before = WINDOWS ? powershell(ACL_INFO, f.home) : (await lstat(f.home)).mode;
  await assert.rejects(initializeHub({ ...f, host: HOST }), /new or empty/);
  await assert.rejects(protectHubHome(f.home), /valid hub and owner markers/);
  await assert.rejects(writePrivateJson(path.join(f.home, 'client.json'), { token: TOKEN }), /valid hub and owner markers/);
  assert.equal(await readFile(path.join(f.home, 'unrelated.txt'), 'utf8'), 'preserve this file');
  assert.deepEqual(await readdir(f.home), ['unrelated.txt']);
  const after = WINDOWS ? powershell(ACL_INFO, f.home) : (await lstat(f.home)).mode;
  assert.equal(after, before);
});

test('home junctions or symlinks and immediate child junctions are rejected without touching targets', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'keep.txt'), 'unrelated');
  await symlink(external, f.home, WINDOWS ? 'junction' : 'dir');
  await assert.rejects(privateDirectory(f.home), { code: 'HUB_HOME_UNSAFE' });
  assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), 'unrelated');
  const realHome = path.join(f.root, 'real-hub');
  await markers(realHome, f.tvConfigPath);
  await symlink(external, path.join(realHome, 'linked-child'), WINDOWS ? 'junction' : 'dir');
  await assert.rejects(protectHubHome(realHome), { code: 'HUB_HOME_UNSAFE' });
});

test('hard-linked immediate files are rejected rather than changing an external file ACL', async t => {
  const f = await fixture(t);
  await markers(f.home, f.tvConfigPath);
  const external = path.join(f.root, 'external.txt');
  await writeFile(external, 'outside home');
  await link(external, path.join(f.home, 'linked.txt'));
  await assert.rejects(protectHubHome(f.home), { code: 'HUB_HOME_UNSAFE' });
  assert.equal(await readFile(external, 'utf8'), 'outside home');
});

test('failed owner write rolls back only configuration files created by that initialization', async t => {
  const f = await fixture(t);
  const handle = await open(f.tvConfigPath, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const original = prototype.writeFile;
  const mocked = t.mock.method(prototype, 'writeFile', async function (data, ...options) {
    if (typeof data === 'string' && Object.hasOwn(JSON.parse(data), 'tokenSecret')) {
      const error = new Error('Fixture disk write failure.'); error.code = 'ENOSPC'; throw error;
    }
    return original.call(this, data, ...options);
  });
  try { await assert.rejects(initializeHub({ ...f, host: HOST }), { code: 'ENOSPC' }); }
  finally { mocked.mock.restore(); }
  assert.deepEqual(await readdir(f.home), []);
  const paired = await readJson(f.tvConfigPath);
  assert.equal(Object.hasOwn(paired, 'clientKey'), false);
  assert.equal(await resolveTVKey(paired, HOST, { secretStore: f.secretStore }), 'offline-fixture-pairing-key');
  await initializeHub({ ...f, host: HOST });
  await assertPrivate(f.home);
});

test('malformed private JSON is bounded and does not reflect credential contents', async t => {
  const f = await fixture(t);
  const malformed = path.join(f.root, 'malformed.json');
  await writeFile(malformed, '{"token":"private-fixture-secret" broken}');
  await assert.rejects(readJson(malformed), error => !error.message.includes('private-fixture-secret') && /invalid JSON/.test(error.message));
  const large = path.join(f.root, 'large.json');
  await writeFile(large, Buffer.alloc(1024 * 1024 + 1, 0x20));
  await assert.rejects(readJson(large), /size limit/);
});

test('Windows replaces explicit Everyone ACEs and handles metacharacters strictly as a path', { skip: !WINDOWS }, async t => {
  const f = await fixture(t);
  const home = path.join(f.root, "hub ' ; $([version]1.0)");
  await mkdir(home);
  powershell(ADD_EVERYONE, home);
  assert.ok(JSON.parse(powershell(ACL_INFO, home))[0].rules.some(rule => rule.sid === 'S-1-1-0'));
  await privateDirectory(home);
  await assertPrivate(home);
  await writeFile(path.join(home, 'hub.json'), JSON.stringify({ version: 1, port: 8765, devices: [{ id: 'tv', label: 'Fixture', adapter: 'lg-webos', configPath: f.tvConfigPath, host: HOST }] }));
  await writeFile(path.join(home, 'owner.json'), JSON.stringify({ url: 'http://127.0.0.1:8765', token: TOKEN }));
  powershell(ADD_EVERYONE, path.join(home, 'owner.json'));
  await protectHubHome(home);
  await assertPrivate(home);
});

test('Windows ACL failure is closed and initialization removes both newly reserved files', { skip: !WINDOWS }, async t => {
  const f = await fixture(t);
  const original = childProcess.execFileSync;
  let calls = 0;
  const mocked = t.mock.method(childProcess, 'execFileSync', (...args) => {
    calls += 1;
    if (calls === 3) throw new Error('Fixture ACL verification failure.');
    return original(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(initializeHub({ ...f, host: HOST }), { code: 'HUB_HOME_UNSAFE' }); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(calls, 3);
  assert.deepEqual(await readdir(f.home), []);
});

test('POSIX protection restores modes and rejects files owned by another user', { skip: WINDOWS }, async t => {
  const f = await fixture(t);
  await markers(f.home, f.tvConfigPath);
  await chmod(f.home, 0o755);
  await chmod(path.join(f.home, 'owner.json'), 0o644);
  await protectHubHome(f.home);
  await assertPrivate(f.home);
  if (process.getuid() === 0) {
    const owner = path.join(f.home, 'owner.json');
    await chown(owner, 65534, 65534);
    try { await assert.rejects(protectHubHome(f.home), /different owner/); }
    finally { await chown(owner, process.getuid(), process.getgid()); }
  }
});

test('owner enrollment adds one pinned cloud device without changing TV credentials or owner token', async t => {
  const f = await fixture(t);
  await initializeHub({ ...f, host: HOST });
  const ownerBefore = await readFile(path.join(f.home, 'owner.json'), 'utf8');
  const originalTV = await readFile(f.tvConfigPath, 'utf8');
  const credentialFile = path.join(f.root, 'encrypted-fixture.bin');
  const ecovacsConfigPath = path.join(f.root, 'ecovacs.local.json');
  await writeFile(credentialFile, Buffer.from('encrypted-offline-fixture'));
  await writeFile(ecovacsConfigPath, JSON.stringify({ pythonPath: process.execPath, credentialFile, selectedDeviceSha256: 'a'.repeat(64) }));
  const added = await addHubDevice({ home: f.home, ecovacsConfigPath, secretStore: f.secretStore });
  assert.deepEqual(added, { deviceId: 'vacuum', adapter: 'ecovacs-x11', restartRequired: true });
  const loaded = await loadHubConfig(f.home, { secretStore: f.secretStore });
  assert.equal(loaded.devices.length, 2);
  assert.equal(loaded.devices[0].adapterName, 'lg-webos');
  assert.equal(loaded.devices[1].adapterName, 'ecovacs-x11');
  assert.equal(loaded.devices[1].config.selectedDeviceSha256, 'a'.repeat(64));
  assert.equal(await readFile(path.join(f.home, 'owner.json'), 'utf8'), ownerBefore);
  assert.equal(await readFile(f.tvConfigPath, 'utf8'), originalTV);
  const before = await readFile(path.join(f.home, 'hub.json'), 'utf8');
  await assert.rejects(addHubDevice({ home: f.home, ecovacsConfigPath, secretStore: f.secretStore }), /already enrolled/);
  await assert.rejects(addHubDevice({ home: f.home, ecovacsConfigPath, id: 'other-vacuum', host: HOST, secretStore: f.secretStore }), /not a host/);
  await assert.rejects(addHubDevice({ home: f.home, ecovacsConfigPath, tvConfigPath: f.tvConfigPath, secretStore: f.secretStore }), /exactly one/);
  assert.equal(await readFile(path.join(f.home, 'hub.json'), 'utf8'), before);
  assert.equal((await readdir(f.home)).some(name => name.startsWith('enrollment-')), false);
  await assertPrivate(f.home);
});

test('invalid cloud enrollment fails before creating a hub or touching encrypted credentials', async t => {
  const f = await fixture(t);
  const credentialFile = path.join(f.root, 'encrypted-fixture.bin');
  const ecovacsConfigPath = path.join(f.root, 'ecovacs.local.json');
  await writeFile(credentialFile, 'preserve-encrypted-fixture');
  const config = { pythonPath: process.execPath, credentialFile, selectedDeviceSha256: 'b'.repeat(64) };
  for (const candidate of [{ ...config, selectedDeviceSha256: '*' }, { ...config, host: HOST }, { ...config, pythonPath: 'python --anything' }, { ...config, credentialFile: '//network/share/credentials.bin' }]) {
    await writeFile(ecovacsConfigPath, JSON.stringify(candidate));
    await assert.rejects(initializeHub({ home: f.home, ecovacsConfigPath }));
    await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  }
  assert.equal(await readFile(credentialFile, 'utf8'), 'preserve-encrypted-fixture');
});
