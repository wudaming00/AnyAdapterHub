import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { protectHubHome, readJson, writeSecureJson } from './config.mjs';
import { HubClient } from './client.mjs';
import { createMovieRequest, MoviePlaybackWorkflow } from './movie-workflow.mjs';
import { resolveCredential } from '../security/credentials.mjs';
import * as systemStore from '../security/secret-store.mjs';
import { assertPrivateRegularFile } from '../platform/private-storage.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error('Movie workflow local storage is unavailable or does not match this request.'); error.code = code; throw error; };
const same = (left, right) => timingSafeEqual(Buffer.from(hash(left), 'hex'), Buffer.from(hash(right), 'hex'));

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) fail('MOVIE_LEASE_INVALID');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; fail('MOVIE_LEASE_UNAVAILABLE'); }
}

/** SQLite's short transaction serializes acquisition and dead-PID recovery.
 * No transaction spans device I/O. A live PID, including a reused PID, is never
 * taken over. The lease database contains no credentials, titles or frames.
 */
async function acquireLease(home, binding, secretStore) {
  const file = path.join(home, 'movie-leases.sqlite');
  try {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.close();
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(file);
  assertPrivateRegularFile(info);
  if (info.size > 2 * 1024 * 1024) fail('MOVIE_LEASE_INVALID');
  await protectHubHome(home, { secretStore });
  let database, inTransaction = false;
  const nonce = randomUUID();
  try {
    database = new DatabaseSync(file);
    database.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS movie_leases (binding TEXT PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL) STRICT;');
    database.exec('BEGIN IMMEDIATE'); inTransaction = true;
    const existing = database.prepare('SELECT pid FROM movie_leases WHERE binding = ?').get(binding);
    if (existing && processAlive(existing.pid)) fail('MOVIE_BUSY');
    if (!existing && database.prepare('SELECT COUNT(*) AS count FROM movie_leases').get().count >= 1024) fail('MOVIE_LEASE_LIMIT');
    database.prepare('INSERT INTO movie_leases(binding,pid,nonce) VALUES(?,?,?) ON CONFLICT(binding) DO UPDATE SET pid=excluded.pid, nonce=excluded.nonce').run(binding, process.pid, nonce);
    database.exec('COMMIT'); inTransaction = false;
  } catch (error) {
    if (inTransaction) { try { database.exec('ROLLBACK'); } catch {} }
    database?.close();
    if (/^MOVIE_[A-Z_]+$/.test(error.code ?? '')) throw error;
    fail('MOVIE_LEASE_UNAVAILABLE');
  }
  return () => {
    try { database.prepare('DELETE FROM movie_leases WHERE binding = ? AND pid = ? AND nonce = ?').run(binding, process.pid, nonce); }
    catch { fail('MOVIE_LEASE_RELEASE_FAILED'); }
    finally { database.close(); }
  };
}

async function currentEnvelope(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Local credential broker. Only the scoped workflow is passed to the caller;
 * credential plaintext and encrypted journal records stay inside this boundary.
 * Explicit secret-store injection is for portable fixtures; production uses DPAPI.
 */
export async function withMovieWorkflow({ home = '.device-hub', credentialPath, deviceId, requestId, create, secretStore = systemStore } = {}, run) {
  if (typeof run !== 'function' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId ?? '') || !/^[A-Za-z0-9-]{1,64}$/.test(requestId ?? '')) fail('MOVIE_INVALID_ARGUMENTS');
  const requested = create === undefined ? null : createMovieRequest({ deviceId, requestId, title: create?.title, year: create?.year });
  const directory = await protectHubHome(path.resolve(home), { secretStore });
  const record = await readJson(path.resolve(credentialPath ?? path.join(directory, 'client.json')));
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.grantId ?? '')) fail('MOVIE_SCOPED_CREDENTIAL_REQUIRED');
  const credential = await resolveCredential(record, { secretStore });
  // A copied owner credential with invented grant metadata is still an owner
  // credential. Reject it before constructing a client or contacting the Hub.
  const owner = await resolveCredential(await readJson(path.join(directory, 'owner.json')), { secretStore });
  if (credential.url !== owner.url || credential.certificatePin !== owner.certificatePin) fail('MOVIE_HUB_MISMATCH');
  if (same(credential.token, owner.token)) fail('MOVIE_SCOPED_CREDENTIAL_REQUIRED');
  const hubBinding = hash(JSON.stringify([credential.url, credential.certificatePin]));
  const binding = hash(JSON.stringify([hubBinding, record.grantId, hash(credential.token), deviceId, requestId]));
  const leaseBinding = hash(JSON.stringify([hubBinding, deviceId]));
  const purpose = `movie/journal:${binding}`;
  const file = path.join(directory, `movie-${binding}.json`);
  const release = await acquireLease(directory, leaseBinding, secretStore);
  try {
    let envelope = await currentEnvelope(file);
    let journal;
    if (envelope) {
      if (!secretStore.isSecretEnvelope(envelope)) fail('MOVIE_INVALID_JOURNAL');
      journal = await secretStore.openSecret(envelope, { purpose });
      if (journal?.id !== requestId || journal?.request?.deviceId !== deviceId) fail('MOVIE_JOURNAL_MISMATCH');
      if (requested && JSON.stringify(requested.request) !== JSON.stringify(journal.request)) fail('MOVIE_INTENT_CONFLICT');
    } else {
      if (!requested) fail('MOVIE_NOT_FOUND');
      journal = requested;
    }
    const immutable = JSON.stringify({ version: journal.version, id: journal.id, request: journal.request, createdAt: journal.createdAt, deadlineAt: journal.deadlineAt });
    const save = async next => {
      if (JSON.stringify({ version: next?.version, id: next?.id, request: next?.request, createdAt: next?.createdAt, deadlineAt: next?.deadlineAt }) !== immutable) fail('MOVIE_INTENT_CONFLICT');
      const nextEnvelope = await secretStore.sealSecret(next, { purpose });
      const temporary = path.join(directory, `movie-write-${randomUUID()}.json`);
      let created;
      try {
        await writeSecureJson(temporary, nextEnvelope, { onCreated: (_file, identity) => { created = identity; } });
        const existing = await currentEnvelope(file);
        if (JSON.stringify(existing) !== JSON.stringify(envelope)) fail('MOVIE_JOURNAL_CHANGED');
        await rename(temporary, file);
        created = null; envelope = nextEnvelope;
      } finally {
        if (created) {
          const current = await lstat(temporary, { bigint: true }).catch(() => null);
          if (current && current.isFile() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) await unlink(temporary);
        }
      }
    };
    // Construct before the initial write: invalid journals never become valid
    // simply by being passed through the broker.
    const workflow = new MoviePlaybackWorkflow({ client: new HubClient(credential), journal, save });
    if (!envelope) await save(journal);
    return await run(workflow);
  } finally { release(); }
}
