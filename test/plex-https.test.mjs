import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHubIdentityManager } from '../lib/security/hub-identity.mjs';
import { testSecretStore } from './helpers/secrets.mjs';
import { PlexAdapter } from '../lib/adapters/plex.mjs';

const ID = 'synthetic-plex-selected-machine';
async function fixture(t, { substituteCertificate = false, redirect = false } = {}) {
  const manager = createHubIdentityManager(testSecretStore()), identity = await manager.createHubIdentity();
  const keys = await manager.openHubIdentity(identity), enrolled = substituteCertificate ? await manager.createHubIdentity() : identity, seen = [];
  const server = https.createServer(keys, (req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers });
    if (redirect) { res.writeHead(302, { Location: 'https://unselected-plex.invalid/identity' }); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ MediaContainer: { size: 1, machineIdentifier: ID, claimed: true, version: '1.40.2.8395-c67dce28e' } }));
  });
  server.on('tlsClientError', () => {}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const adapter = new PlexAdapter({ deviceId: 'fixture-plex', config: { origin: `https://127.0.0.1:${server.address().port}`,
    certificate: enrolled.certificate, certificatePin: enrolled.certificatePin, machineIdentifier: ID } });
  t.after(() => adapter.close()); return { adapter, seen };
}

test('Plex real pinned HTTPS reads only public JSON identity and sends no token, cookies or client identifiers', async t => {
  const { adapter, seen } = await fixture(t), state = await adapter.snapshot();
  assert.equal(state.fields.server.value.available, true); assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET'); assert.equal(seen[0].path, '/identity'); assert.equal(seen[0].headers.accept, 'application/json');
  for (const header of ['authorization', 'x-plex-token', 'x-plex-client-identifier', 'cookie']) assert.equal(Object.hasOwn(seen[0].headers, header), false);
  assert.equal(JSON.stringify(state).includes(ID), false);
});

test('Plex rejects substituted server certificates and never follows an identity redirect', async t => {
  const substitute = await fixture(t, { substituteCertificate: true });
  await assert.rejects(substitute.adapter.snapshot(), { code: 'STATE_UNAVAILABLE' }); assert.equal(substitute.seen.length, 0);
  const redirect = await fixture(t, { redirect: true });
  await assert.rejects(redirect.adapter.snapshot(), { code: 'STATE_UNAVAILABLE' }); assert.equal(redirect.seen.length, 1);
});
