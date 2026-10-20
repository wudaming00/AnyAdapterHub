import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
import { validatePlexConfig, validateProtectedPlexConfig, protectPlexConfig, loadPlexConfig } from '../lib/adapters/plex-config.mjs';

const store = testSecretStore();
async function fixture() {
  const identity = await testIdentity(store);
  return { origin: 'https://127.0.0.1:32400', certificate: identity.certificate, certificatePin: identity.certificatePin,
    machineIdentifier: 'synthetic-selected-machine-identifier' };
}
async function savedFile(t, config) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-plex-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json'); await writeFile(file, JSON.stringify(config)); return file;
}

test('Plex public identity enrollment uses only validated target metadata and no authentication or encryption provider', async t => {
  const clear = await fixture(), saved = await protectPlexConfig(clear);
  assert.equal(saved.timeoutMs, 8000); assert.equal(Object.isFrozen(saved), true);
  assert.deepEqual(Object.keys(saved).sort(), ['certificate', 'certificatePin', 'machineIdentifier', 'origin', 'timeoutMs']);
  assert.deepEqual(validateProtectedPlexConfig(saved), saved);
  let touched = 0;
  const providerOptions = { get secretStore() { touched++; throw Error('Must not request credentials'); } };
  assert.deepEqual(await protectPlexConfig(clear, providerOptions), saved);
  assert.deepEqual(await loadPlexConfig(await savedFile(t, saved), providerOptions), saved); assert.equal(touched, 0);
});

test('Plex configuration rejects credentials, alternate routes, downgrade and changed trust', async () => {
  const clear = await fixture();
  for (const changes of [{ origin: 'http://127.0.0.1:32400' }, { origin: 'https://user:private@plex.invalid' },
    { origin: 'https://plex.invalid/identity' }, { origin: 'https://plex.invalid/?token=private' }, { origin: clear.origin + '/' },
    { machineIdentifier: '' }, { machineIdentifier: 'x'.repeat(129) }, { machineIdentifier: 'private/../other' },
    { token: 'private-unused-token' }, { tokenSecret: {} }, { clientIdentifier: 'unused' }, { libraryId: '1' }, { route: '/library/sections' },
    { certificatePin: '0'.repeat(64) }, { certificate: clear.certificate + clear.certificate }, { timeoutMs: 99 }, { timeoutMs: 15001 }, { policy: 'unrestricted' }]) {
    assert.throws(() => validatePlexConfig({ ...clear, ...changes }), { code: 'INVALID_CONFIG' });
  }
});

test('Plex configuration and metadata reject executable properties and proxies without evaluation', async () => {
  const clear = await fixture(); let touched = 0;
  const getter = { ...clear }; Object.defineProperty(getter, 'machineIdentifier', { enumerable: true, get() { touched++; return 'private'; } });
  for (const value of [getter, new Proxy(clear, { ownKeys() { touched++; throw Error('private'); } }),
    Object.assign(Object.create({ token: 'private' }), clear), { ...clear, [Symbol('private')]: 'private' },
    { ...clear, origin: { toString() { touched++; return clear.origin; } } }]) assert.throws(() => validatePlexConfig(value), { code: 'INVALID_CONFIG' });
  assert.equal(touched, 0);
});

test('Plex local file failures remain static and never echo target paths or contents', async t => {
  const file = await savedFile(t, { private: 'sensitive fixture text' });
  await assert.rejects(loadPlexConfig(file), error => error.code === 'INVALID_CONFIG' && !String(error).includes('sensitive') && !String(error).includes(file));
});
