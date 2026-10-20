import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { types } from 'node:util';
import { readJson, protectHubHome, writePrivateJson } from '../lib/hub/config.mjs';
import { protectHomeAssistantConfig } from '../lib/adapters/home-assistant-config.mjs';
import { protectMQTTConfig } from '../lib/adapters/mqtt-config.mjs';

const fail = (code = 'INVALID_ENROLLMENT') => { const error = new Error('Local integration enrollment could not complete.'); error.code = code; throw error; };
const ADAPTERS = ['home-assistant', 'mqtt-tls'];
function record(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail();
  return value;
}
function options(value) {
  record(value, ['adapter', 'target', 'home', 'out']);
  if (!ADAPTERS.includes(value.adapter) || ['target', 'home', 'out'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 32768 || value[key].includes('\0')) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.local\.json$/.test(value.out)) fail();
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
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 16384) fail();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat(), current = await lstat(file);
    if (!info.isFile() || info.size > 16384 || current.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino || current.dev !== info.dev || current.ino !== info.ino) fail();
    const bytes = Buffer.alloc(16385); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > 16384) fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

/** Trusted owner-side library flow; injected providers are for explicit fixtures. */
export async function enrollIntegration(input, { prompt = readMaskedSecret, secretStore } = {}) {
  const selected = options(input), targetPath = path.resolve(selected.target);
  const target = await readJson(targetPath);
  record(target, selected.adapter === 'home-assistant'
    ? ['origin', 'entityId', 'certificateFile', 'certificatePin', 'timeoutMs']
    : ['host', 'port', 'certificateFile', 'certificatePin', 'topic', 'measurement']);
  if (typeof target.certificateFile !== 'string' || !target.certificateFile || target.certificateFile.includes('\0') || target.certificateFile.length > 32768) fail();
  const pem = await certificate(path.resolve(path.dirname(targetPath), target.certificateFile));
  const home = await protectHubHome(selected.home, { secretStore }), output = path.join(home, selected.out);
  try { await lstat(output); fail('ENROLLMENT_FILE_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { certificateFile: _file, ...metadata } = target;
  let clear, protectedConfig;
  try {
    if (selected.adapter === 'home-assistant') {
      clear = { ...metadata, certificate: pem, token: await prompt('Home Assistant token (hidden)', 4096) };
      protectedConfig = await protectHomeAssistantConfig(clear, { secretStore });
    } else {
      clear = { ...metadata, certificatePem: pem, username: await prompt('MQTT username (hidden)', 256), password: await prompt('MQTT password (hidden)', 4096) };
      protectedConfig = await protectMQTTConfig(clear, { secretStore });
    }
    await writePrivateJson(output, protectedConfig, { secretStore });
    return Object.freeze({ saved: true, adapter: selected.adapter, networkAccessed: false, enabled: false, granted: false });
  } finally { if (clear) for (const key of ['token', 'username', 'password']) if (Object.hasOwn(clear, key)) clear[key] = ''; }
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
