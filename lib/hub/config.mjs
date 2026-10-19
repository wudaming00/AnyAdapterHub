import { open, mkdir, readdir, lstat, unlink, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateLocalHost } from '../ssap.mjs';
import { loadECOVACSConfig } from '../adapters/ecovacs-config.mjs';

const ownObject = value => value && Object.getPrototypeOf(value) === Object.prototype;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const JSON_LIMIT = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const POSIX = process.platform !== 'win32';
const unsafe = message => { const error = new Error(message); error.code = 'HUB_HOME_UNSAFE'; throw error; };

// Fixed script; paths enter only through the environment, never source interpolation.
// A fresh descriptor removes all previous ACEs, including explicit Everyone entries.
const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = $env:DEVICE_HUB_ACL_PATH
$kind = $env:DEVICE_HUB_ACL_KIND
if ([string]::IsNullOrEmpty($target) -or @('directory', 'file') -notcontains $kind) { throw 'Invalid protection target' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$principals = @($current)
if ($current.Value -ne $system.Value) { $principals += $system }
function Checked-Item($file, $directory) {
  $item = Get-Item -LiteralPath $file -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory) { throw 'Linked or unexpected protection target' }
  return $item
}
$root = Checked-Item $target ($kind -eq 'directory')
$items = @($root)
if ($kind -eq 'directory') {
  foreach ($child in @(Get-ChildItem -LiteralPath $target -Force)) { $items += Checked-Item $child.FullName $false }
}
foreach ($item in $items) {
  $directory = [bool]$item.PSIsContainer
  if ($directory) {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($current)
  foreach ($principal in $principals) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal,
      [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    [void]$security.AddAccessRule($rule)
  }
  # Persist only the descriptor sections we changed. Set-Acl may also request
  # SACL privileges when reapplying a protected descriptor as a standard user.
  if ($directory) { [System.IO.Directory]::SetAccessControl($item.FullName, $security) }
  else { [System.IO.File]::SetAccessControl($item.FullName, $security) }
  [void](Checked-Item $item.FullName $directory)
  $actual = Get-Acl -LiteralPath $item.FullName
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value -or $rules.Count -ne $principals.Count) { throw 'Private DACL verification failed' }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if (@($principals | ForEach-Object { $_.Value }) -notcontains $sid -or $seen.ContainsKey($sid) -or
      $rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'Private DACL verification failed' }
    $seen[$sid] = $true
  }
}
[Console]::WriteLine('ACL_OK')
`;

function windowsProtection(target, kind) {
  try {
    const env = { ...process.env, DEVICE_HUB_ACL_PATH: target, DEVICE_HUB_ACL_KIND: kind };
    // PowerShell 7's module directory cannot be autoloaded by Windows PowerShell 5.
    // Let the fixed legacy executable construct its own standard module search path.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    const result = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_ACL_SCRIPT], {
      env,
      encoding: 'utf8', stdio: 'pipe', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 64 * 1024,
    });
    if (result.trim() !== 'ACL_OK') unsafe('Private Windows permissions could not be verified.');
  } catch { unsafe('Private Windows permissions could not be verified.'); }
}

function checkOwner(info) {
  if (POSIX && typeof process.getuid === 'function' && info.uid !== process.getuid()) unsafe('Private storage has a different owner.');
}

function checkRegular(info) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) unsafe('Private storage contains a linked or unexpected file.');
  checkOwner(info);
}

async function inspectHome(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) unsafe('Hub home must be an ordinary dedicated directory.');
  checkOwner(info);
  const names = await readdir(directory);
  for (const name of names) checkRegular(await lstat(path.join(directory, name)));
  return names;
}

async function posixProtect(target, directory = false) {
  const handle = await open(target, constants.O_RDONLY | NOFOLLOW | (directory ? (constants.O_DIRECTORY ?? 0) : 0));
  try {
    const info = await handle.stat();
    if (directory) {
      if (!info.isDirectory()) unsafe('Hub home must be an ordinary dedicated directory.');
      checkOwner(info);
    } else checkRegular(info);
    await handle.chmod(directory ? 0o700 : 0o600);
    if (((await handle.stat()).mode & 0o777) !== (directory ? 0o700 : 0o600)) unsafe('Private POSIX permissions could not be verified.');
  } finally { await handle.close(); }
}

async function protectInspected(directory, names) {
  if (POSIX) {
    await posixProtect(directory, true);
    for (const name of names) await posixProtect(path.join(directory, name));
  } else windowsProtection(directory, 'directory');
  await inspectHome(directory);
}

export async function readJson(file) {
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) unsafe('Configuration must be an ordinary file.');
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > JSON_LIMIT) throw new Error('Private configuration exceeds size limit.');
    const buffer = Buffer.alloc(JSON_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > JSON_LIMIT) throw new Error('Private configuration exceeds size limit.');
    let value;
    try { value = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { throw new Error('Private configuration is invalid JSON.'); }
    if (!ownObject(value)) throw new Error('Private configuration must be an object.');
    return value;
  } finally { await handle.close(); }
}

function hubRecord(config) {
  if (!ownObject(config) || Object.keys(config).some(key => !['version', 'port', 'devices'].includes(key)) ||
    config.version !== 1 || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
    !Array.isArray(config.devices) || !config.devices.length || config.devices.length > 64) throw new Error('Invalid hub configuration.');
  const ids = new Set();
  for (const item of config.devices) {
    if (!ownObject(item) || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id) || typeof item.label !== 'string' || !item.label || item.label.length > 128 ||
      !['lg-webos', 'ecovacs-x11'].includes(item.adapter) || typeof item.configPath !== 'string' || !path.isAbsolute(item.configPath) ||
      Object.keys(item).some(key => !['id', 'label', 'adapter', 'configPath', 'host'].includes(key))) throw new Error('Unsupported device configuration.');
    ids.add(item.id);
    if (item.adapter === 'ecovacs-x11' && item.host !== undefined) throw new Error('Cloud device targets cannot use a caller-selected host.');
    if (item.host !== undefined) validateLocalHost(item.host);
  }
  return config;
}

async function validHubMarker(directory, names) {
  if (!names.includes('hub.json') || !names.includes('owner.json')) unsafe('Populated hub home requires valid hub and owner markers.');
  try {
    const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
    const owner = await readJson(path.join(directory, 'owner.json'));
    if (Object.keys(owner).some(key => !['url', 'token'].includes(key)) || owner.url !== `http://127.0.0.1:${config.port}` ||
      typeof owner.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(owner.token)) throw new Error();
  } catch { unsafe('Populated hub home requires valid hub and owner markers.'); }
}

/** Initialization only: never change the ACL of an existing populated directory. */
export async function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  try { await mkdir(absolute, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const names = await inspectHome(absolute);
  if (names.length) unsafe('Hub initialization requires a new or empty dedicated directory.');
  await protectInspected(absolute, names);
  return absolute;
}

/** Serve/grant entry point: recognize a dedicated hub before changing permissions. */
export async function protectHubHome(home) {
  const directory = path.resolve(home);
  const names = await inspectHome(directory);
  await validHubMarker(directory, names);
  await protectInspected(directory, names);
  return directory;
}

async function removeCreated(file, identity) {
  try {
    const info = await lstat(file);
    if (info.isFile() && !info.isSymbolicLink() && info.dev === identity.dev && info.ino === identity.ino) await unlink(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function writeSecureJson(file, value, { exclusive = true, onCreated } = {}) {
  const encoded = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > JSON_LIMIT) throw new Error('Private configuration exceeds size limit.');
  let handle, identity, created = false, succeeded = false;
  try {
    if (!exclusive) {
      try { handle = await open(file, constants.O_RDWR | NOFOLLOW); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!handle) {
      handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      created = true;
    }
    identity = await handle.stat();
    checkRegular(identity);
    if (created) onCreated?.(file, identity);
    if (POSIX) {
      await handle.chmod(0o600);
      if (((await handle.stat()).mode & 0o777) !== 0o600) unsafe('Private POSIX permissions could not be verified.');
    } else windowsProtection(file, 'file');
    const current = await lstat(file);
    checkRegular(current);
    if (current.dev !== identity.dev || current.ino !== identity.ino) unsafe('Private file changed during initialization.');
    if (!exclusive) await handle.truncate(0);
    await handle.writeFile(encoded);
    await handle.sync();
    succeeded = true;
  } finally {
    await handle?.close();
    if (created && !succeeded && identity) await removeCreated(file, identity);
  }
}

export async function writePrivateJson(file, value, { exclusive = true } = {}) {
  const absolute = path.resolve(file);
  await protectHubHome(path.dirname(absolute));
  await writeSecureJson(absolute, value, { exclusive });
}

async function enrolledDevice({ tvConfigPath, ecovacsConfigPath, host, id, label }) {
  if (Boolean(tvConfigPath) === Boolean(ecovacsConfigPath)) throw new Error('Select exactly one local device configuration.');
  const adapter = tvConfigPath ? 'lg-webos' : 'ecovacs-x11';
  id ??= tvConfigPath ? 'living-room-tv' : 'vacuum';
  label ??= tvConfigPath ? 'Living room LG' : 'ECOVACS X11';
  if (typeof id !== 'string' || !ID.test(id) || typeof label !== 'string' || !label || label.length > 128) throw new Error('Invalid local device identity.');
  if (tvConfigPath) { await loadTVConfig({ configPath: tvConfigPath, host }); return { id, label, adapter, configPath: path.resolve(tvConfigPath), ...(host === undefined ? {} : { host }) }; }
  if (host !== undefined) throw new Error('A cloud target is bound by its local configuration, not a host argument.');
  await loadECOVACSConfig(ecovacsConfigPath);
  return { id, label, adapter, configPath: path.resolve(ecovacsConfigPath) };
}

export async function initializeHub({ home, tvConfigPath, ecovacsConfigPath, host, id, label, port = 8765 }) {
  const device = await enrolledDevice({ tvConfigPath, ecovacsConfigPath, host, id, label });
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid hub configuration.');
  const directory = await privateDirectory(home);
  const created = [];
  const onCreated = (file, identity) => created.push({ file, identity });
  try {
    await writeSecureJson(path.join(directory, 'hub.json'), { version: 1, port, devices: [device] }, { onCreated });
    await writeSecureJson(path.join(directory, 'owner.json'), { url: `http://127.0.0.1:${port}`, token: randomBytes(32).toString('base64url') }, { onCreated });
    await protectHubHome(directory);
    return { home: directory, deviceId: device.id, port };
  } catch (error) {
    for (const item of created.reverse()) await removeCreated(item.file, item.identity);
    throw error;
  }
}

/** Owner-local enrollment only. Running processes reload the registry on restart. */
export async function addHubDevice({ home, ...options }) {
  const directory = await protectHubHome(home);
  const device = await enrolledDevice(options);
  const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
  if (config.devices.length >= 64 || config.devices.some(item => item.id === device.id)) throw new Error('Device limit reached or device ID already enrolled.');
  config.devices.push(device);
  hubRecord(config);
  const temp = path.join(directory, `enrollment-${randomBytes(16).toString('hex')}.json`);
  let created;
  try {
    await writeSecureJson(temp, config, { onCreated: (_file, identity) => { created = identity; } });
    await rename(temp, path.join(directory, 'hub.json'));
  } catch (error) { if (created) await removeCreated(temp, created); throw error; }
  return { deviceId: device.id, adapter: device.adapter, restartRequired: true };
}

export async function loadTVConfig({ configPath, host }) {
  const saved = await readJson(configPath);
  const devices = ownObject(saved.devices) ? saved.devices : {};
  const selectedHost = host ?? saved.host ?? (Object.keys(devices).length === 1 ? Object.keys(devices)[0] : null);
  validateLocalHost(selectedHost);
  const device = ownObject(devices[selectedHost]) ? devices[selectedHost] : saved;
  if (typeof device.clientKey !== 'string' || !device.clientKey || device.clientKey.length > 4096) throw new Error('Explicit TV pairing is required before hub setup.');
  return { host: selectedHost, ...Object.fromEntries(['clientKey', 'permissions', 'port', 'secure', 'timeoutMs', 'webOSMajor',
    'registrationManifest', 'allowTemporaryObserver', 'mediaRoots', 'allowedUrlOrigins', 'mac', 'wake'].filter(key => Object.hasOwn(device, key)).map(key => [key, device[key]])) };
}

export async function loadHubConfig(home) {
  const directory = await protectHubHome(home);
  const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
  const devices = [];
  for (const item of config.devices) devices.push({ id: item.id, label: item.label, adapterName: item.adapter,
    config: item.adapter === 'lg-webos' ? await loadTVConfig(item) : await loadECOVACSConfig(item.configPath) });
  return { home: directory, port: config.port, devices };
}
