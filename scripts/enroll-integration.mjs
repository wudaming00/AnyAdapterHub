import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readJson, protectHubHome, writePrivateJson } from '../lib/hub/config.mjs';
import { protectHomeAssistantConfig } from '../lib/adapters/home-assistant-config.mjs';
import { protectMQTTConfig } from '../lib/adapters/mqtt-config.mjs';

const fail = (code = 'INVALID_ENROLLMENT') => { const error = new Error('Local integration enrollment could not complete.'); error.code = code; throw error; };
// Fixed reviewed source, not executable device/profile-supplied metadata.
const INTEGRATIONS = {
  'home-assistant': { metadata: ['origin', 'entityId', 'certificatePin', 'timeoutMs'], certificate: 'certificate', secrets: [['token', 'Home Assistant token', 4096]], protect: protectHomeAssistantConfig },
  'mqtt-tls': { metadata: ['host', 'port', 'certificatePin', 'topic', 'measurement'], certificate: 'certificatePem', secrets: [['username', 'MQTT username', 256], ['password', 'MQTT password', 4096]], protect: protectMQTTConfig },
  'philips-hue': { metadata: ['origin', 'certificatePin', 'lightId', 'bridgeId', 'timeoutMs'], certificate: 'certificate', secrets: [['applicationKey', 'Hue application key', 4096]], protect: async (value, options) => (await import('../lib/adapters/philips-hue-config.mjs')).protectPhilipsHueConfig(value, options) },
  'shelly-gen2': { metadata: ['origin', 'certificatePin', 'expectedDeviceId', 'componentId', 'loadClass', 'timeoutMs'], certificate: 'certificate', secrets: [['password', 'Shelly admin password', 4096]], prepare: metadata => ({ ...metadata, username: 'admin' }), protect: async (value, options) => (await import('../lib/adapters/shelly-gen2-config.mjs')).protectShellyGen2Config(value, options) },
  switchbot: { metadata: ['vendorDeviceId', 'deviceType', 'timeoutMs'], secrets: [['token', 'SwitchBot token', 4096], ['secret', 'SwitchBot signing secret', 4096]], protect: async (value, options) => (await import('../lib/adapters/switchbot-config.mjs')).protectSwitchBotConfig(value, options) },
  'lg-thinq': { metadata: ['vendorDeviceId', 'deviceType', 'countryCode', 'clientId', 'timeoutMs'], secrets: [['token', 'ThinQ token', 4096], ['apiKey', 'ThinQ application API key', 4096]], prepare: metadata => ({ ...metadata, clientId: metadata.clientId ?? randomUUID() }), protect: async (value, options) => (await import('../lib/adapters/lg-thinq-config.mjs')).protectLGThinQConfig(value, options) },
  'home-assistant-sensor': { metadata: ['origin', 'entityId', 'measurement', 'certificatePin', 'timeoutMs'], certificate: 'certificate', secrets: [['token', 'Home Assistant token', 4096]], protect: async (value, options) => (await import('../lib/adapters/home-assistant-sensor-config.mjs')).protectHASensorConfig(value, options) },
  openhab: { metadata: ['origin', 'certificatePin', 'itemName', 'itemType', 'timeoutMs'], certificate: 'certificate', secrets: [['token', 'openHAB API token', 4096]], protect: async (value, options) => (await import('../lib/adapters/openhab-config.mjs')).protectOpenHABConfig(value, options) },
  plex: { metadata: ['origin', 'certificatePin', 'machineIdentifier', 'timeoutMs'], certificate: 'certificate', secrets: [], protect: async (value, options) => (await import('../lib/adapters/plex-config.mjs')).protectPlexConfig(value, options) },
  awair: { metadata: ['vendorDeviceId', 'deviceType', 'timeoutMs'], secrets: [['token', 'Awair token', 4096]], protect: async (value, options) => (await import('../lib/adapters/awair-config.mjs')).protectAwairConfig(value, options) },
  purpleair: { metadata: ['vendorDeviceId', 'timeoutMs'], secrets: [['apiKey', 'PurpleAir read API key', 4096]], protect: async (value, options) => (await import('../lib/adapters/purpleair-config.mjs')).protectPurpleAirConfig(value, options) },
};
function record(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail();
  return value;
}
function options(value) {
  record(value, ['adapter', 'target', 'home', 'out']);
  if (typeof value.adapter !== 'string' || !Object.hasOwn(INTEGRATIONS, value.adapter) || ['target', 'home', 'out'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 32768 || value[key].includes('\0')) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.local\.json$/.test(value.out)) fail();
  return value;
}
export function parseEnrollmentArgs(args) {
  if (!Array.isArray(args) || args.length !== 8) fail();
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = typeof args[i] === 'string' ? args[i].replace(/^--/, '') : '';
    if (args[i] !== `--${key}` || !['adapter', 'target', 'home', 'out'].includes(key) || Object.hasOwn(result, key)) fail();
    result[key] = args[i + 1];
  }
  return options(result);
}

/** No echo, command-line credentials, environment credentials or piped input. */
export function readMaskedSecret(label, limit, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function' || input.isRaw) fail('INTERACTIVE_TERMINAL_REQUIRED');
  return new Promise((resolve, reject) => {
    let value = '', done = false;
    const finish = error => {
      if (done) return; done = true;
      input.removeListener('keypress', keypress); input.removeListener('error', onError);
      try { input.setRawMode(false); } catch { error = Object.assign(new Error('Local credential entry failed.'), { code: 'ENROLLMENT_CANCELLED' }); }
      try { input.pause(); output.write('\n'); } catch { error = Object.assign(new Error('Local credential entry failed.'), { code: 'ENROLLMENT_CANCELLED' }); }
      const result = value; value = '';
      if (error) reject(error); else resolve(result);
    };
    const onError = () => finish(Object.assign(new Error('Local credential entry failed.'), { code: 'ENROLLMENT_CANCELLED' }));
    const keypress = (text, key = {}) => {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return onError();
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl || key.meta || typeof text !== 'string' || /[\u0000-\u001f\u007f]/.test(text)) return;
      if (Buffer.byteLength(value + text) > limit) return onError();
      value += text;
    };
    try {
      output.write(label + ': ');
      emitKeypressEvents(input); input.on('keypress', keypress); input.once('error', onError);
      input.setRawMode(true); input.resume();
    } catch { onError(); }
  });
}

async function certificate(file) {
  // Open first: every type/size check is bound to the handle actually read.
  // NONBLOCK prevents a substituted FIFO from stalling before fstat on POSIX.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    // File identifiers are 64-bit values; Number can alias distinct NTFS inodes.
    const info = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size > 16384n || !current.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) fail();
    const bytes = Buffer.alloc(16385); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > 16384) fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

/** Trusted owner-side library flow; injected providers are for explicit fixtures. */
export async function enrollIntegration(input, { prompt = readMaskedSecret, secretStore } = {}) {
  const selected = options(input), targetPath = path.resolve(selected.target);
  const integration = INTEGRATIONS[selected.adapter];
  const target = await readJson(targetPath);
  record(target, [...integration.metadata, ...(integration.certificate ? ['certificateFile'] : [])]);
  let pem;
  if (integration.certificate) {
    if (typeof target.certificateFile !== 'string' || !target.certificateFile || target.certificateFile.includes('\0') || target.certificateFile.length > 32768) fail();
    pem = await certificate(path.resolve(path.dirname(targetPath), target.certificateFile));
  }
  const home = await protectHubHome(selected.home, { secretStore }), output = path.join(home, selected.out);
  try { await lstat(output); fail('ENROLLMENT_FILE_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { certificateFile: _file, ...metadata } = target;
  let clear, protectedConfig;
  try {
    clear = integration.prepare ? integration.prepare(metadata) : { ...metadata };
    if (integration.certificate) clear[integration.certificate] = pem;
    for (const [key, label, limit] of integration.secrets) clear[key] = await prompt(label + ' (hidden)', limit);
    protectedConfig = await integration.protect(clear, { secretStore });
    await writePrivateJson(output, protectedConfig, { secretStore });
    return Object.freeze({ saved: true, adapter: selected.adapter, networkAccessed: false, enabled: false, granted: false });
  } finally { if (clear) for (const [key] of integration.secrets) if (Object.hasOwn(clear, key)) clear[key] = ''; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const selected = parseEnrollmentArgs(process.argv.slice(2));
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail('INTERACTIVE_TERMINAL_REQUIRED');
    console.log(JSON.stringify(await enrollIntegration(selected)));
  } catch (error) {
    const code = ['INVALID_ENROLLMENT', 'INTERACTIVE_TERMINAL_REQUIRED', 'ENROLLMENT_CANCELLED', 'ENROLLMENT_FILE_EXISTS'].includes(error?.code) ? error.code : 'ENROLLMENT_FAILED';
    console.error(JSON.stringify({ saved: false, code })); process.exitCode = 1;
  }
}
