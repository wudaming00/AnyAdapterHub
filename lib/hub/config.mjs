import { open, mkdir, readdir, lstat, unlink, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validatePrivateHost as validateLocalHost, validateAdapterName, validateAdapterFeatures, loadAdapterConfig } from './adapters.mjs';
import { protectCredential } from '../security/credentials.mjs';
import * as systemStore from '../security/secret-store.mjs';
import { assertPrivateOwner, assertPrivateRegularFile, protectDirectoryPermissions, protectFilePermissions } from '../platform/private-storage.mjs';
export { loadTVConfig } from '../adapters/lg-config.mjs';

const ownObject = value => value && Object.getPrototypeOf(value) === Object.prototype;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const JSON_LIMIT = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const unsafe = message => { const error = new Error(message); error.code = 'HUB_HOME_UNSAFE'; throw error; };

async function inspectHome(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) unsafe('Hub home must be an ordinary dedicated directory.');
  assertPrivateOwner(info);
  const names = await readdir(directory);
  for (const name of names) assertPrivateRegularFile(await lstat(path.join(directory, name)));
  return names;
}

async function protectInspected(directory, names) {
  await protectDirectoryPermissions(directory, names);
  await inspectHome(directory);
}

export async function readJson(file) {
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) unsafe('Configuration must be an ordinary file.');
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > JSON_LIMIT) throw new Error('Private configuration exceeds size limit.');
    // Bind the pre-open name and its current directory entry to this exact
    // handle before reading. Windows does not expose O_NOFOLLOW through Node.
    // Ancestor-directory integrity still belongs to the trusted local filesystem.
    const current = await lstat(file);
    if (current.isSymbolicLink() || !current.isFile() || before.dev !== info.dev || before.ino !== info.ino ||
      current.dev !== info.dev || current.ino !== info.ino) unsafe('Configuration changed while opening it.');
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
  if (!ownObject(config) || Object.keys(config).some(key => !['version', 'port', 'devices', 'adapters'].includes(key)) ||
    ![1, 2].includes(config.version) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
    !Array.isArray(config.devices) || config.devices.length > 64) throw new Error('Invalid hub configuration.');
  if (config.version === 2 && (!Array.isArray(config.adapters) || config.adapters.length > 16 || new Set(config.adapters).size !== config.adapters.length)) throw new Error('Invalid enabled adapters.');
  for (const adapter of config.adapters ?? []) validateAdapterName(adapter);
  const ids = new Set();
  for (const item of config.devices) {
    if (!ownObject(item) || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id) || typeof item.label !== 'string' || !item.label || item.label.length > 128 ||
      !['lg-webos', 'ecovacs-x11', 'home-assistant', 'mqtt-tls'].includes(item.adapter) || typeof item.configPath !== 'string' || !path.isAbsolute(item.configPath) ||
      Object.keys(item).some(key => !['id', 'label', 'adapter', 'configPath', 'host', 'features'].includes(key))) throw new Error('Unsupported device configuration.');
    validateAdapterFeatures(item.adapter, item.features ?? []);
    ids.add(item.id);
    if (item.adapter !== 'lg-webos' && item.host !== undefined) throw new Error('This integration target is bound by its owner-enrolled configuration.');
    if (item.host !== undefined) validateLocalHost(item.host);
  }
  return config;
}

async function validHubMarker(directory, names, secretStore = systemStore) {
  if (!names.includes('hub.json') || !names.includes('owner.json')) unsafe('Populated hub home requires valid hub and owner markers.');
  try {
    const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
    const owner = await readJson(path.join(directory, 'owner.json'));
    if (Object.keys(owner).some(key => !['url', 'token', 'tokenSecret', 'certificatePin', 'certificate'].includes(key)) ||
      ![`http://127.0.0.1:${config.port}`, `https://127.0.0.1:${config.port}`].includes(owner.url) ||
      !(typeof owner.token === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(owner.token) || secretStore.isSecretEnvelope(owner.tokenSecret))) throw new Error();
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
export async function protectHubHome(home, { secretStore } = {}) {
  const directory = path.resolve(home);
  const names = await inspectHome(directory);
  await validHubMarker(directory, names, secretStore);
  await protectInspected(directory, names);
  return directory;
}

async function removeCreated(file, identity) {
  try {
    const info = await lstat(file);
    if (info.isFile() && !info.isSymbolicLink() && info.dev === identity.dev && info.ino === identity.ino) await unlink(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function writeSecureJson(file, value, { exclusive = true, onCreated } = {}) {
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
    assertPrivateRegularFile(identity);
    if (created) onCreated?.(file, identity);
    await protectFilePermissions(file, handle);
    const current = await lstat(file);
    assertPrivateRegularFile(current);
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

export async function writePrivateJson(file, value, { exclusive = true, secretStore } = {}) {
  const absolute = path.resolve(file);
  await protectHubHome(path.dirname(absolute), { secretStore });
  await writeSecureJson(absolute, typeof value.token === 'string' ? await protectCredential(value, { secretStore }) : value, { exclusive });
}

async function enrolledDevice({ tvConfigPath, ecovacsConfigPath, adapterName, configPath, host, id, label, features = [], secretStore }) {
  if ([tvConfigPath, ecovacsConfigPath, configPath].filter(Boolean).length !== 1 || Boolean(configPath) !== Boolean(adapterName) || ((tvConfigPath || ecovacsConfigPath) && adapterName !== undefined)) throw new Error('Select exactly one owner-enrolled configuration and its reviewed adapter.');
  const adapter = tvConfigPath ? 'lg-webos' : ecovacsConfigPath ? 'ecovacs-x11' : validateAdapterName(adapterName);
  features = [...validateAdapterFeatures(adapter, features)];
  id ??= adapter === 'lg-webos' ? 'living-room-tv' : adapter === 'ecovacs-x11' ? 'vacuum' : adapter + '-device';
  label ??= adapter === 'lg-webos' ? 'Living room LG' : adapter === 'ecovacs-x11' ? 'ECOVACS X11' : adapter;
  if (typeof id !== 'string' || !ID.test(id) || typeof label !== 'string' || !label || label.length > 128) throw new Error('Invalid local device identity.');
  const selectedPath = tvConfigPath || ecovacsConfigPath || configPath;
  if (adapter !== 'lg-webos' && host !== undefined) throw new Error('This target is bound by its local configuration, not a host argument.');
  await loadAdapterConfig(adapter, { configPath: selectedPath, host, secretStore });
  return { id, label, adapter, configPath: path.resolve(selectedPath), features, ...(host === undefined ? {} : { host }) };
}

export async function initializeHub({ home, tvConfigPath, ecovacsConfigPath, adapterName, configPath, host, id, label, port = 8765, features = [], secretStore, identity }) {
  const device = tvConfigPath || ecovacsConfigPath || configPath || adapterName ? await enrolledDevice({ tvConfigPath, ecovacsConfigPath, adapterName, configPath, host, id, label, features, secretStore }) : null;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid hub configuration.');
  const directory = await privateDirectory(home);
  const created = [];
  const onCreated = (file, identity) => created.push({ file, identity });
  try {
    const tlsIdentity = identity ?? await (await import('../security/hub-identity.mjs')).createHubIdentity();
    await writeSecureJson(path.join(directory, 'hub.json'), { version: 2, port, adapters: device ? [device.adapter] : [], devices: device ? [device] : [] }, { onCreated });
    await writeSecureJson(path.join(directory, 'identity.json'), tlsIdentity, { onCreated });
    await writeSecureJson(path.join(directory, 'owner.json'), await protectCredential({ url: `https://127.0.0.1:${port}`, certificatePin: tlsIdentity.certificatePin, certificate: tlsIdentity.certificate, token: randomBytes(32).toString('base64url') }, { secretStore }), { onCreated });
    await protectHubHome(directory, { secretStore });
    return { home: directory, ...(device ? { deviceId: device.id } : {}), port };
  } catch (error) {
    for (const item of created.reverse()) await removeCreated(item.file, item.identity);
    throw error;
  }
}

/** Owner-local enrollment only. Running processes reload the registry on restart. */
export async function addHubDevice({ home, ...options }) {
  const directory = await protectHubHome(home, { secretStore: options.secretStore });
  const device = await enrolledDevice(options);
  const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
  if (config.devices.length >= 64 || config.devices.some(item => item.id === device.id)) throw new Error('Device limit reached or device ID already enrolled.');
  config.devices.push(device);
  config.version = 2;
  config.adapters = [...new Set([...(config.adapters ?? config.devices.map(item => item.adapter)), device.adapter])];
  hubRecord(config);
  const temp = path.join(directory, `enrollment-${randomBytes(16).toString('hex')}.json`);
  let created;
  try {
    await writeSecureJson(temp, config, { onCreated: (_file, identity) => { created = identity; } });
    await rename(temp, path.join(directory, 'hub.json'));
  } catch (error) { if (created) await removeCreated(temp, created); throw error; }
  return { deviceId: device.id, adapter: device.adapter, restartRequired: true };
}

export async function loadHubConfig(home, { secretStore } = {}) {
  const directory = await protectHubHome(home, { secretStore });
  const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
  const devices = [];
  if (config.version !== 2) throw new Error('Run the explicit local security migration before serving this legacy hub.');
  for (const item of config.devices.filter(item => config.adapters.includes(item.adapter))) devices.push({ id: item.id, label: item.label, adapterName: item.adapter, features: item.features ?? [],
    config: await loadAdapterConfig(item.adapter, { configPath: item.configPath, host: item.host, secretStore }) });
  return { home: directory, port: config.port, devices };
}

export async function setAdapterEnabled(home, adapter, enabled, { secretStore } = {}) {
  validateAdapterName(adapter);
  const directory = await protectHubHome(home, { secretStore });
  const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
  if (config.version !== 2) throw new Error('Security migration required.');
  config.adapters = enabled ? [...new Set([...config.adapters, adapter])] : config.adapters.filter(item => item !== adapter);
  await writeSecureJson(path.join(directory, 'hub.json'), config, { exclusive: false });
  return { adapter, enabled, restartRequired: true };
}

export async function setDeviceFeatures(home, deviceId, features, { secretStore } = {}) {
  const directory = await protectHubHome(home, { secretStore });
  const config = hubRecord(await readJson(path.join(directory, 'hub.json')));
  const device = config.devices.find(item => item.id === deviceId);
  if (config.version !== 2 || !device) throw new Error('An enrolled v2 device is required.');
  device.features = [...validateAdapterFeatures(device.adapter, features)];
  await writeSecureJson(path.join(directory, 'hub.json'), config, { exclusive: false });
  return { deviceId, features: device.features, restartRequired: true };
}
