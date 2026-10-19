import path from 'node:path';
import { readdir, rename, unlink, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { readJson, protectHubHome, writeSecureJson } from '../hub/config.mjs';
import { protectCredential, resolveCredential, protectTVKey, resolveTVKey, resolveTVKeyForMigration } from './credentials.mjs';
import * as hubIdentities from './hub-identity.mjs';
import * as systemStore from './secret-store.mjs';
import { probeTVIdentityCertificate } from './tv-tls.mjs';

/** Never replace credentials while a process still owns the configured port. */
export async function assertHubOffline({ port }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Hub port.');
  return new Promise((resolve, reject) => {
    let socket, settled = false;
    const finish = offline => {
      if (settled) return; settled = true; clearTimeout(timer); socket?.destroy();
      if (offline) resolve();
      else { const error = new Error('Stop the running Hub before migrating local credentials.'); error.code = 'HUB_MUST_BE_STOPPED'; reject(error); }
    };
    const timer = setTimeout(() => finish(false), 500);
    try { socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => finish(false)); socket.once('error', error => finish(error.code === 'ECONNREFUSED')); }
    catch { finish(false); }
  });
}

/** Owner-local migration: stage and verify encrypted records before replacement.
 * No plaintext backup is created. An interrupted migration is safe to rerun.
 * First certificate enrollment is TOFU, not independently verified identity.
 */
export async function migrateSecurity({ home, tvConfigPaths = [], secretStore = systemStore,
  identityStore = hubIdentities, probeTV = probeTVIdentityCertificate, assertOffline = assertHubOffline, io = {} }) {
  // Explicit code-only injection enables portable fault/re-entry tests. The CLI
  // supplies none of these providers and production never selects a fallback.
  const files = { readJson, protectHubHome, writeSecureJson, readdir, rename, unlink, lstat, ...io };
  const cryptoOptions = { secretStore };
  const preliminary = await files.readJson(path.join(path.resolve(home), 'hub.json'));
  await assertOffline({ port: preliminary.port });
  const directory = await files.protectHubHome(home, cryptoOptions);
  const hub = await files.readJson(path.join(directory, 'hub.json'));
  if (hub.port !== preliminary.port) throw new Error('Hub configuration changed during migration.');
  const identityPath = path.join(directory, 'identity.json');
  let identity;
  try { identity = await files.readJson(identityPath); await identityStore.openHubIdentity(identity); }
  catch (error) { if (error.code !== 'ENOENT') throw error; identity = await identityStore.createHubIdentity(); }
  const records = [{ file: identityPath, value: identity }];
  let credentialCount = 0, pairingCount = 0, pendingTVIdentities = 0;
  for (const name of await files.readdir(directory)) {
    if (!name.endsWith('.json') || ['hub.json', 'identity.json', 'process.json'].includes(name)) continue;
    const file = path.join(directory, name), old = await files.readJson(file);
    if (!Object.hasOwn(old, 'token') && !Object.hasOwn(old, 'tokenSecret')) continue;
    const previous = old.tokenSecret ? await resolveCredential(old, cryptoOptions) : old;
    if (![`http://127.0.0.1:${hub.port}`, `https://127.0.0.1:${hub.port}`].includes(previous.url)) throw new Error('Credential belongs to a different Hub.');
    const value = await protectCredential({ ...previous, url: `https://127.0.0.1:${hub.port}`, certificatePin: identity.certificatePin, certificate: identity.certificate }, cryptoOptions);
    if ((await resolveCredential(value, cryptoOptions)).token !== previous.token) throw new Error('Credential migration verification failed.');
    records.push({ file, value }); credentialCount++;
  }
  const paths = new Set([...hub.devices.filter(device => device.adapter === 'lg-webos').map(device => device.configPath), ...tvConfigPaths].map(file => path.resolve(file)));
  const pins = new Map();
  for (const file of paths) {
    const saved = await files.readJson(file);
    const profiles = saved.devices && typeof saved.devices === 'object' ? Object.entries(saved.devices) : [[saved.host, saved]];
    for (const [host, profile] of profiles) {
      if (!profile.clientKey && !profile.clientKeySecret) continue;
      const clientKey = profile.clientKeySecret ? await resolveTVKeyForMigration(profile, host, cryptoOptions) : profile.clientKey;
      // A TLS-only probe carries no pairing credentials and does not wake the TV.
      let certificatePin = profile.certificatePin;
      if (!certificatePin) {
        let observed = pins.get(host);
        if (!pins.has(host)) {
          try { observed = await probeTV({ host, port: 3001, timeoutMs: 5000 }); }
          catch (error) { if (!['TLS_TIMEOUT', 'TLS_CONNECTION_FAILED'].includes(error.code)) throw error; observed = null; }
          pins.set(host, observed);
        }
        certificatePin = observed?.certificatePin;
      }
      const encrypted = await protectTVKey({ ...profile, clientKey, secure: true, port: 3001, certificatePin,
        certificateTrust: certificatePin ? (profile.certificateTrust?.method !== 'pending-tv-tls-enrollment' && profile.certificateTrust || { method: 'tofu-existing-device', enrolledAt: new Date().toISOString() }) : { method: 'pending-tv-tls-enrollment' } }, host, cryptoOptions);
      if (!certificatePin) { delete encrypted.certificatePin; pendingTVIdentities++; }
      if (await resolveTVKey(encrypted, host, cryptoOptions) !== clientKey) throw new Error('TV credential migration verification failed.');
      if (saved.devices) saved.devices[host] = encrypted;
      else { for (const key of Object.keys(saved)) delete saved[key]; Object.assign(saved, encrypted); }
      pairingCount++;
    }
    records.push({ file, value: saved });
  }
  hub.version = 2;
  hub.adapters ??= [...new Set(hub.devices.map(item => item.adapter))];
  // Optional enhancements require a separate local enable step after migration.
  for (const device of hub.devices) device.features ??= [];
  records.push({ file: path.join(directory, 'hub.json'), value: hub });
  const staged = [];
  try {
    for (const record of records) {
      try { const current = await files.lstat(record.file); if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) throw new Error('Unsafe migration target.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temp = `${record.file}.encrypted-${randomBytes(12).toString('hex')}.tmp`;
      await files.writeSecureJson(temp, record.value);
      staged.push({ ...record, temp });
      if (JSON.stringify(await files.readJson(temp)) !== JSON.stringify(record.value)) throw new Error('Encrypted staging verification failed.');
    }
    for (const record of staged) await files.rename(record.temp, record.file);
  } finally { for (const record of staged) await files.unlink(record.temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  await files.protectHubHome(directory, cryptoOptions);
  return { encryptedCredentials: credentialCount, encryptedPairings: pairingCount, tls: true, pendingTVIdentities,
    firstTrust: [...pins.values()].some(Boolean) ? 'TOFU on existing selected TV; no independent identity verification' : 'existing pins preserved or TLS enrollment pending', restartRequired: true };
}
