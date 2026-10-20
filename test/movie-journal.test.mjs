import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { initializeHub, writePrivateJson, readJson } from '../lib/hub/config.mjs';
import { resolveCredential } from '../lib/security/credentials.mjs';
import { withMovieWorkflow } from '../lib/hub/movie-journal.mjs';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';

const secretStore = testSecretStore();
const token = 'fixture_movie_scoped_token_abcdefghijklmnopqrstuvwxyz';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'movie-journal-fixture-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { force: true, recursive: true });
  });
  const home = path.join(root, 'hub');
  const identity = await testIdentity(secretStore);
  await initializeHub({ home, secretStore, identity });
  const grantId = randomUUID();
  const credential = { url: 'https://127.0.0.1:8765', certificate: identity.certificate, certificatePin: identity.certificatePin, token, grantId };
  const credentialPath = path.join(home, 'scoped.json');
  await writePrivateJson(credentialPath, credential, { secretStore });
  const options = { home, secretStore, credentialPath, deviceId: 'fixture-tv', requestId: 'frozen-fixture-1' };
  const create = { title: 'Frozen', year: 2013 };
  const hubBinding = hash(JSON.stringify([credential.url, credential.certificatePin]));
  return { ...options, options, create, home, credential, hubBinding,
    leaseBinding: hash(JSON.stringify([hubBinding, options.deviceId])),
    journalName: ({ grantId: selectedGrant = grantId, selectedToken = token, deviceId = options.deviceId, requestId = options.requestId } = {}) =>
      `movie-${hash(JSON.stringify([hubBinding, selectedGrant, hash(selectedToken), deviceId, requestId]))}.json` };
}

test('journal is wholly encrypted, scoped status round-trips and no secret or title is in its filename', async t => {
  const f = await fixture(t);
  const first = await withMovieWorkflow({ ...f.options, create: f.create }, workflow => workflow.status());
  assert.equal(first.requestedTitle, 'Frozen');
  assert.equal(first.stage, 'new');
  const file = path.join(f.home, f.journalName());
  const bytes = await readFile(file, 'utf8');
  assert.equal(secretStore.isSecretEnvelope(JSON.parse(bytes)), true);
  for (const value of ['Frozen', 'fixture-tv', f.options.requestId, token, f.credential.grantId]) {
    assert.equal(bytes.includes(value), false);
    assert.equal(path.basename(file).includes(value), false);
  }
  assert.deepEqual(await withMovieWorkflow(f.options, workflow => workflow.status()), first);
  assert.equal((await readdir(f.home)).some(name => name.startsWith('movie-write-')), false);
});

test('stable keys preserve immutable intent and a new key retains the earlier request', async t => {
  const f = await fixture(t);
  await withMovieWorkflow({ ...f.options, create: f.create }, workflow => workflow.status());
  const before = await readFile(path.join(f.home, f.journalName()), 'utf8');
  await assert.rejects(withMovieWorkflow({ ...f.options, create: { title: 'Enchanted', year: 2007 } }, () => assert.fail('conflicting intent reached callback')), { code: 'MOVIE_INTENT_CONFLICT' });
  assert.equal(await readFile(path.join(f.home, f.journalName()), 'utf8'), before);
  const second = await withMovieWorkflow({ ...f.options, requestId: 'second-request', create: { title: 'Enchanted', year: 2007 } }, workflow => workflow.status());
  assert.equal(second.workflowId, 'second-request');
  assert.equal(await readFile(path.join(f.home, f.journalName()), 'utf8'), before);
  assert.equal((await readdir(f.home)).filter(name => /^movie-[a-f0-9]{64}\.json$/.test(name)).length, 2);
});

test('owner credentials and owner tokens with forged grant metadata are rejected locally', async t => {
  const f = await fixture(t);
  const ownerPath = path.join(f.home, 'owner.json');
  await assert.rejects(withMovieWorkflow({ ...f.options, credentialPath: ownerPath, create: f.create }, () => assert.fail('owner reached workflow')), { code: 'MOVIE_SCOPED_CREDENTIAL_REQUIRED' });
  const owner = await resolveCredential(await readJson(ownerPath), { secretStore });
  const forgedPath = path.join(f.home, 'forged.json');
  await writePrivateJson(forgedPath, { ...owner, grantId: randomUUID() }, { secretStore });
  await assert.rejects(withMovieWorkflow({ ...f.options, credentialPath: forgedPath, create: f.create }, () => assert.fail('forged owner reached workflow')), { code: 'MOVIE_SCOPED_CREDENTIAL_REQUIRED' });
  assert.equal((await readdir(f.home)).some(name => /^movie-[a-f0-9]{64}\.json$/.test(name)), false);
});

test('journal access binds the exact grant, token, device, request and pinned Hub', async t => {
  const f = await fixture(t);
  await withMovieWorkflow({ ...f.options, create: f.create }, workflow => workflow.status());
  for (const changes of [{ grantId: randomUUID() }, { token: 'different_fixture_scoped_token_abcdefghijklmnopqrstuvwxyz' }]) {
    const credentialPath = path.join(f.home, `changed-${randomUUID()}.json`);
    await writePrivateJson(credentialPath, { ...f.credential, ...changes }, { secretStore });
    await assert.rejects(withMovieWorkflow({ ...f.options, credentialPath }, () => assert.fail('foreign grant found old journal')), { code: 'MOVIE_NOT_FOUND' });
  }
  await assert.rejects(withMovieWorkflow({ ...f.options, deviceId: 'other-tv' }, () => assert.fail('foreign device found old journal')), { code: 'MOVIE_NOT_FOUND' });
  await assert.rejects(withMovieWorkflow({ ...f.options, requestId: 'other-request' }, () => assert.fail('foreign request found old journal')), { code: 'MOVIE_NOT_FOUND' });
  const foreignHub = path.join(f.home, 'foreign-hub.json');
  await writePrivateJson(foreignHub, { ...f.credential, url: 'https://127.0.0.1:8766' }, { secretStore });
  await assert.rejects(withMovieWorkflow({ ...f.options, credentialPath: foreignHub }, () => assert.fail('foreign hub reached workflow')), { code: 'MOVIE_HUB_MISMATCH' });
});

test('copying encrypted bytes to another request name cannot change the cryptographic purpose', async t => {
  const f = await fixture(t);
  await withMovieWorkflow({ ...f.options, create: f.create }, workflow => workflow.status());
  const bytes = await readFile(path.join(f.home, f.journalName()));
  await writeFile(path.join(f.home, f.journalName({ requestId: 'copied-request' })), bytes, { mode: 0o600 });
  await assert.rejects(withMovieWorkflow({ ...f.options, requestId: 'copied-request' }, () => assert.fail('copied journal reached callback')));
});

test('a device lease excludes a concurrent request across grants and releases after a thrown callback', async t => {
  const f = await fixture(t);
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const first = withMovieWorkflow({ ...f.options, create: f.create }, async () => { entered(); await pending; throw new Error('fixture callback failure'); });
  await ready;
  const otherPath = path.join(f.home, 'other-grant.json');
  await writePrivateJson(otherPath, { ...f.credential, grantId: randomUUID(), token: 'other_fixture_scoped_token_abcdefghijklmnopqrstuvwxyz' }, { secretStore });
  await assert.rejects(withMovieWorkflow({ ...f.options, credentialPath: otherPath, requestId: 'concurrent-request', create: f.create }, () => assert.fail('concurrent callback ran')), { code: 'MOVIE_BUSY' });
  release(); await assert.rejects(first, /fixture callback failure/);
  assert.equal((await withMovieWorkflow(f.options, workflow => workflow.status())).stage, 'new');
});

test('dead-process leases recover while live and invalid PIDs remain fail closed', async t => {
  const f = await fixture(t);
  await withMovieWorkflow({ ...f.options, create: f.create }, workflow => workflow.status());
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(child, 'exit');
  assert.ok(Number.isInteger(child.pid));
  const setLease = pid => {
    const database = new DatabaseSync(path.join(f.home, 'movie-leases.sqlite'));
    try { database.prepare('INSERT OR REPLACE INTO movie_leases(binding,pid,nonce) VALUES(?,?,?)').run(f.leaseBinding, pid, randomUUID()); }
    finally { database.close(); }
  };
  setLease(child.pid);
  assert.equal((await withMovieWorkflow(f.options, workflow => workflow.status())).stage, 'new');
  setLease(process.pid);
  await assert.rejects(withMovieWorkflow(f.options, () => assert.fail('live PID was taken over')), { code: 'MOVIE_BUSY' });
  setLease(-1);
  await assert.rejects(withMovieWorkflow(f.options, () => assert.fail('invalid PID was taken over')), { code: 'MOVIE_LEASE_INVALID' });
});

test('malformed request keys and missing journals fail before any workflow action', async t => {
  const f = await fixture(t);
  for (const requestId of ['../escape', '', 'a'.repeat(65), 'request:key']) {
    await assert.rejects(withMovieWorkflow({ ...f.options, requestId, create: f.create }, () => assert.fail('bad key reached callback')), { code: 'MOVIE_INVALID_ARGUMENTS' });
  }
  await assert.rejects(withMovieWorkflow(f.options, () => assert.fail('missing journal reached callback')), { code: 'MOVIE_NOT_FOUND' });
});
