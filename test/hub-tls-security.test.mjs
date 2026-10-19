import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createSecretStore } from '../lib/security/secret-store.mjs';
import { createHubIdentityManager } from '../lib/security/hub-identity.mjs';
import { HubStore } from '../lib/hub/store.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';
import { HubServer } from '../lib/hub/server.mjs';
import { HubClient } from '../lib/hub/client.mjs';

const OWNER = 'ephemeral_fixture_owner_abcdefghijklmnopqrstuvwxyz';
function identities() {
  const key = randomBytes(32);
  const store = createSecretStore({ provider: 'test-aes-gcm', protect(clear, entropy) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(entropy);
    return Buffer.concat([nonce, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
  }, unprotect(bytes, entropy) {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAAD(entropy); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  } });
  return createHubIdentityManager(store);
}
class Adapter {
  listeners = new Set();
  constructor(deviceId) { this.deviceId = deviceId; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() {
    const timestamp = new Date().toISOString();
    for (const listener of this.listeners) listener({ type: 'device.state', deviceId: this.deviceId,
      data: { deviceId: this.deviceId, assembledAt: timestamp, connection: { phase: 'online' }, fields: { power: { value: true, observedAt: timestamp, expiresAt: new Date(Date.now() + 60000).toISOString(), source: 'offline-fixture' } } } });
  }
  async start() { this.emit(); }
  async close() {}
}
async function fixture(t) {
  const manager = identities(), identity = await manager.createHubIdentity(), tls = await manager.openHubIdentity(identity);
  const store = new HubStore({ filePath: ':memory:' }), first = new Adapter('tv-one'), second = new Adapter('tv-two');
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(OWNER), devices: [first, second].map(adapter => ({ id: adapter.deviceId, label: adapter.deviceId, adapter, adapterName: 'offline-fixture', config: {} })) });
  await runtime.start();
  const server = new HubServer({ runtime, tls }); const address = await server.listen({ port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); });
  const credentials = { url: address.url, certificate: identity.certificate, certificatePin: identity.certificatePin, token: OWNER };
  return { manager, identity, tls, store, runtime, server, address, credentials, owner: new HubClient(credentials), first, second };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TLS fixture deadline.')), 2500); })]); }
  finally { clearTimeout(timer); }
}

test('real HTTPS serves scoped GET/SSE, owner grants and revocation errors with verified TLS', async t => {
  const f = await fixture(t);
  const issued = await f.owner.issueGrant({ label: 'TLS fixture', deviceIds: ['tv-one'], capabilities: ['state.read', 'events.read'], expiresAt: new Date(Date.now() + 60000).toISOString() });
  const reader = new HubClient({ ...f.credentials, token: issued.token });
  assert.equal((await reader.state('tv-one')).fields.power.value, true);
  await assert.rejects(reader.state('tv-two'), error => error.status === 403 && error.code === 'ACCESS_DENIED');
  await assert.rejects(reader.grants(), error => error.status === 403 && error.code === 'ACCESS_DENIED');
  const controller = new AbortController(), stream = reader.events({ signal: controller.signal });
  try { const first = await bounded(stream.next()); assert.equal(first.value.deviceId, 'tv-one'); assert.equal(first.value.type, 'device.state'); }
  finally { await stream.return(); controller.abort(); }
  await f.owner.revokeGrant(issued.grant.id);
  await assert.rejects(reader.state('tv-one'), error => error.status === 403 && error.code === 'GRANT_REVOKED');
});

test('production constructors reject missing TLS, HTTP URLs, absent certificate and wrong declared pin', async t => {
  const f = await fixture(t);
  assert.throws(() => new HubServer({ runtime: f.runtime }), /TLS/);
  assert.throws(() => new HubClient({ token: OWNER, url: f.address.url.replace('https:', 'http:') }), /HTTPS/);
  assert.throws(() => new HubClient({ token: OWNER, url: f.address.url }), /./);
  assert.throws(() => new HubClient({ ...f.credentials, certificatePin: '0'.repeat(64) }), /identity mismatch/);
});

test('certificate substitution fails before any HTTP authorization reaches a TLS impostor', async t => {
  const manager = identities(), legitimate = await manager.createHubIdentity(), attacker = await manager.createHubIdentity(), attackerTLS = await manager.openHubIdentity(attacker);
  const seen = [];
  const server = https.createServer(attackerTLS, (request, response) => { seen.push(request.headers.authorization); response.end('{}'); });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new HubClient({ url: `https://127.0.0.1:${server.address().port}`, token: OWNER, certificate: legitimate.certificate, certificatePin: legitimate.certificatePin });
  await assert.rejects(bounded(client.state('tv-one')), /TLS connection failed/);
  assert.deepEqual(seen, []);
});

test('an HTTP process occupying the selected port receives no bearer header from the TLS client', async t => {
  const manager = identities(), identity = await manager.createHubIdentity();
  const headers = [], packets = [];
  const server = http.createServer((request, response) => { headers.push(request.headers.authorization); response.end('{}'); });
  server.on('clientError', (error, socket) => { if (error.rawPacket) packets.push(error.rawPacket); socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new HubClient({ url: `https://127.0.0.1:${server.address().port}`, token: OWNER, certificate: identity.certificate, certificatePin: identity.certificatePin });
  await assert.rejects(bounded(client.state('tv-one')), /TLS connection failed/);
  assert.deepEqual(headers, []);
  assert.equal(Buffer.concat(packets).includes(Buffer.from(OWNER)), false);
});
