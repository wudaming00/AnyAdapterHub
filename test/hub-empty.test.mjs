import test from 'node:test';
import assert from 'node:assert/strict';
import { HubStore } from '../lib/hub/store.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';
import { HubServer } from '../lib/hub/server.mjs';
import { HubClient } from '../lib/hub/client.mjs';
import { createHubIdentityManager } from '../lib/security/hub-identity.mjs';
import { testSecretStore } from './helpers/secrets.mjs';

test('an empty core serves authenticated HTTPS with no device authority', async t => {
  const store = new HubStore({ filePath: ':memory:' });
  const token = 'fixture_empty_core_owner_abcdefghijklmnopqrstuvwxyz';
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(token), devices: [] });
  const identities = createHubIdentityManager(testSecretStore());
  const identity = await identities.createHubIdentity();
  const tls = await identities.openHubIdentity(identity);
  const server = new HubServer({ runtime, tls: { key: tls.key, cert: tls.cert } });
  t.after(async () => { await server.close(); await runtime.close(); });
  await runtime.start();
  const address = await server.listen({ port: 0 });
  const client = new HubClient({ url: address.url, token, certificate: identity.certificate, certificatePin: identity.certificatePin });
  assert.equal(runtime.ready, true);
  assert.deepEqual(await client.devices(), { devices: [] });
  await assert.rejects(client.state('not-enrolled'), { status: 404, code: 'NOT_FOUND' });
  await assert.rejects(client.submit('not-enrolled', 'power.off'), { status: 404, code: 'NOT_FOUND' });
  await assert.rejects(client.issueGrant({ label: 'No implicit enrollment', deviceIds: ['not-enrolled'], capabilities: ['state.read'],
    expiresAt: new Date(Date.now() + 60000).toISOString() }), { status: 400, code: 'INVALID_ARGUMENTS' });
  assert.deepEqual(await client.grants(), { grants: [] });
  const unknown = new HubClient({ url: address.url, token: 'fixture_unknown_client_abcdefghijklmnopqrstuvwxyz', certificate: identity.certificate, certificatePin: identity.certificatePin });
  await assert.rejects(unknown.devices(), { status: 401, code: 'UNAUTHORIZED' });
});
