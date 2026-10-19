import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateSecurity, assertHubOffline } from '../lib/security/migrate.mjs';
import { createServer } from 'node:net';
import { createHubIdentityManager } from '../lib/security/hub-identity.mjs';
import { resolveCredential, resolveTVKey } from '../lib/security/credentials.mjs';
import { testSecretStore } from './helpers/secrets.mjs';

const token = 'fixture_owner_token_abcdefghijklmnopqrstuvwxyz', host = '192.168.77.80', clientKey = 'fixture-tv-pairing-key';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adaptany-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'hub'); await mkdir(home);
  const tvFile = path.join(root, 'tv.local.json');
  await writeFile(tvFile, JSON.stringify({ schemaVersion: 1, devices: { [host]: { clientKey, port: 3000, secure: false } } }));
  await writeFile(path.join(home, 'hub.json'), JSON.stringify({ version: 1, port: 8765, devices: [{ id: 'tv', label: 'Fixture TV', adapter: 'lg-webos', configPath: tvFile, host }] }));
  await writeFile(path.join(home, 'owner.json'), JSON.stringify({ token, url: 'http://127.0.0.1:8765' }));
  const secretStore = testSecretStore(), identityStore = createHubIdentityManager(secretStore);
  // Crypto/transaction tests inject filesystem protection only; ACL behavior has
  // separate config tests. Production migration uses the real private-home code.
  const io = { readJson, protectHubHome: async directory => realpath(directory),
    writeSecureJson: async (file, value) => writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }) };
  const options = { home, secretStore, identityStore, probeTV: async () => ({ certificatePin: 'a'.repeat(64) }), assertOffline: async () => {}, io };
  return { root, home, tvFile, secretStore, options };
}
async function assertNoStaging(f) {
  for (const directory of [f.root, f.home]) assert.equal((await readdir(directory)).some(name => name.includes('.encrypted-')), false);
}

test('migration encrypts tokens and TV keys, binds TLS pins, and reruns with the same identity', async t => {
  const f = await fixture(t); const result = await migrateSecurity(f.options);
  assert.equal(result.encryptedCredentials, 1); assert.equal(result.encryptedPairings, 1); assert.equal(result.pendingTVIdentities, 0);
  const owner = await readJson(path.join(f.home, 'owner.json')), profile = (await readJson(f.tvFile)).devices[host], identity = await readJson(path.join(f.home, 'identity.json'));
  assert.equal(Object.hasOwn(owner, 'token'), false); assert.equal(Object.hasOwn(profile, 'clientKey'), false);
  assert.equal((await resolveCredential(owner, { secretStore: f.secretStore })).token, token);
  assert.equal(await resolveTVKey(profile, host, { secretStore: f.secretStore }), clientKey);
  assert.equal(profile.clientKeyPurposeVersion, 2); assert.equal(profile.secure, true); assert.equal(profile.port, 3001);
  await migrateSecurity(f.options);
  assert.equal((await readJson(path.join(f.home, 'identity.json'))).certificatePin, identity.certificatePin);
  assert.equal((await readJson(path.join(f.home, 'hub.json'))).version, 2); await assertNoStaging(f);
});

test('a staging verification failure leaves originals unchanged and cleans encrypted staging files', async t => {
  const f = await fixture(t), beforeOwner = await readFile(path.join(f.home, 'owner.json'), 'utf8'), beforeTV = await readFile(f.tvFile, 'utf8');
  const io = { ...f.options.io, readJson: async file => file.includes('.encrypted-') ? { invalid: true } : readJson(file) };
  await assert.rejects(migrateSecurity({ ...f.options, io }), /staging verification/);
  assert.equal(await readFile(path.join(f.home, 'owner.json'), 'utf8'), beforeOwner); assert.equal(await readFile(f.tvFile, 'utf8'), beforeTV);
  await assertNoStaging(f);
});

test('an interrupted replacement can be rerun without plaintext backups or loss of tokens', async t => {
  const f = await fixture(t);
  const io = { ...f.options.io, rename: async (from, to) => { if (to === f.tvFile) throw new Error('Injected replacement failure.'); return rename(from, to); } };
  await assert.rejects(migrateSecurity({ ...f.options, io }), /replacement failure/);
  const partialOwner = await readJson(path.join(f.home, 'owner.json'));
  assert.equal(Object.hasOwn(partialOwner, 'token'), false); assert.equal((await resolveCredential(partialOwner, { secretStore: f.secretStore })).token, token);
  await assertNoStaging(f);
  await migrateSecurity(f.options);
  assert.equal(await resolveTVKey((await readJson(f.tvFile)).devices[host], host, { secretStore: f.secretStore }), clientKey); await assertNoStaging(f);
});

test('offline TV enrollment stays encrypted and pending, then upgrades only through an explicit rerun', async t => {
  const f = await fixture(t);
  const result = await migrateSecurity({ ...f.options, probeTV: async () => { throw Object.assign(new Error('offline fixture'), { code: 'TLS_CONNECTION_FAILED' }); } });
  assert.equal(result.pendingTVIdentities, 1);
  const pending = (await readJson(f.tvFile)).devices[host];
  assert.equal(Object.hasOwn(pending, 'clientKey'), false); assert.equal(Object.hasOwn(pending, 'certificatePin'), false);
  assert.equal(pending.certificateTrust.method, 'pending-tv-tls-enrollment');
  assert.equal(await resolveTVKey(pending, host, { secretStore: f.secretStore }), clientKey);
  await migrateSecurity(f.options);
  const active = (await readJson(f.tvFile)).devices[host]; assert.equal(active.certificateTrust.method, 'tofu-existing-device');
  assert.equal(active.certificatePin, 'a'.repeat(64)); assert.equal(await resolveTVKey(active, host, { secretStore: f.secretStore }), clientKey);
});

test('explicit migration upgrades old encrypted host-only envelopes while runtime rejects them', async t => {
  const f = await fixture(t), old = { certificatePin: 'a'.repeat(64), clientKeySecret: await f.secretStore.sealSecret(clientKey, { purpose: `lg/client-key:${host}` }) };
  await writeFile(f.tvFile, JSON.stringify({ schemaVersion: 1, devices: { [host]: old } }));
  await assert.rejects(resolveTVKey(old, host, { secretStore: f.secretStore }));
  await migrateSecurity(f.options);
  const upgraded = (await readJson(f.tvFile)).devices[host]; assert.equal(upgraded.clientKeyPurposeVersion, 2);
  assert.equal(await resolveTVKey(upgraded, host, { secretStore: f.secretStore }), clientKey);
});

test('migration refuses a listening process before touching files or ACLs', async t => {
  const f = await fixture(t); let protectedHome = false;
  await assert.rejects(migrateSecurity({ ...f.options, assertOffline: async () => { throw Object.assign(new Error('running'), { code: 'HUB_MUST_BE_STOPPED' }); },
    io: { ...f.options.io, protectHubHome: async () => { protectedHome = true; throw new Error('should not run'); } } }), { code: 'HUB_MUST_BE_STOPPED' });
  assert.equal(protectedHome, false); assert.equal(Object.hasOwn(await readJson(path.join(f.home, 'owner.json')), 'token'), true);
});

test('production offline check rejects a loopback listener and accepts a refused connection', async () => {
  const server = createServer(socket => socket.destroy()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await assert.rejects(assertHubOffline({ port }), { code: 'HUB_MUST_BE_STOPPED' });
  await new Promise(resolve => server.close(resolve));
  await assertHubOffline({ port });
});
