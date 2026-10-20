import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createPinnedTVAgent, normalizeCertificatePin, probeTVIdentityCertificate } from '../lib/security/tv-tls.mjs';
import { SSAPClient, downloadCapture, POINTER_ENDPOINT } from '../lib/ssap.mjs';
import { TVController } from '../lib/tv-controller.mjs';
import { getLocalText } from '../discover.mjs';

// Fresh synthetic certificates/keys are generated in memory. No private key,
// household address, paired TV, cloud account or persistent certificate is used.
function certificate({ serialBytes = randomBytes(16), keys = generateKeyPairSync('rsa', { modulusLength: 2048 }) } = {}) {
  const der = (tag, ...parts) => {
    const data = Buffer.concat(parts);
    let length = data.length;
    const encoded = [];
    do { encoded.unshift(length & 255); length >>>= 8; } while (length);
    return Buffer.concat([Buffer.from([tag]), Buffer.from(data.length < 128 ? [data.length] : [128 | encoded.length, ...encoded]), data]);
  };
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('AdaptAny offline TLS fixture')))));
  const utc = date => Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z');
  const serial = Buffer.from(serialBytes);
  // DER INTEGER must be positive and minimally encoded. Masking alone can
  // leave an unnecessary leading zero, which OpenSSL rejects intermittently.
  serial[0] = (serial[0] & 127) || 1;
  const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, serial), algorithm, name,
    der(0x30, der(0x17, utc(new Date(Date.now() - 86400000))), der(0x17, utc(new Date(Date.now() + 86400000)))),
    name, keys.publicKey.export({ type: 'spki', format: 'der' }));
  const raw = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, keys.privateKey)));
  return { key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: ['-----BEGIN CERTIFICATE-----', ...raw.toString('base64').match(/.{1,64}/g), '-----END CERTIFICATE-----', ''].join('\n'),
    pin: createHash('sha256').update(raw).digest('hex') };
}

test('synthetic certificate serials stay valid for zero-leading random inputs', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const prefix of ['0000', '0001', '007f', '0080', '8001', 'ffff']) {
    const serialBytes = Buffer.from(prefix + '00'.repeat(14), 'hex');
    const identity = certificate({ serialBytes, keys });
    const parsed = new X509Certificate(identity.cert);
    assert.match(parsed.serialNumber, /^[0-7][0-9A-F]{31}$/);
    assert.notEqual(parsed.serialNumber.slice(0, 2), '00');
    const server = https.createServer(identity);
    server.close();
  }
});

async function fixture(t, { pointerURL } = {}) {
  const identity = certificate(); const sockets = new Set(); const requests = [], upgrades = [], messages = [], frames = [];
  const server = https.createServer(identity, (request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'image/jpeg' }); response.end(Buffer.from([255, 216, 255, 217]));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  server.on('upgrade', (request, socket, head) => {
    upgrades.push(request.url);
    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('message', bytes => {
        if (request.url === '/pointer') { frames.push(bytes.toString()); return; }
        const message = JSON.parse(bytes.toString()); messages.push(message);
        if (message.type === 'register') ws.send(JSON.stringify({ id: message.id, type: 'registered', payload: { 'client-key': 'synthetic-pairing-key' } }));
        else if (message.uri === POINTER_ENDPOINT) ws.send(JSON.stringify({ id: message.id, type: 'response', payload: {
          socketPath: pointerURL ?? `wss://127.0.0.1:${server.address().port}/pointer` } }));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => wss.close(resolve));
  });
  return { ...identity, server, port: server.address().port, requests, upgrades, messages, frames };
}

test('real SSAP fails locally without a pin or on plaintext; fake injection is code-only', async () => {
  assert.throws(() => new SSAPClient({ host: '127.0.0.1', clientKey: 'synthetic-pairing-key' }), { code: 'TLS_PIN_REQUIRED' });
  assert.throws(() => new SSAPClient({ host: '127.0.0.1', secure: false, certificatePin: 'a'.repeat(64) }), { code: 'TLS_REQUIRED' });
  assert.throws(() => normalizeCertificatePin('not-a-pin'), { code: 'TLS_PIN_REQUIRED' });
  assert.equal(normalizeCertificatePin('AA:'.repeat(31) + 'AA'), 'aa'.repeat(32));
});

test('enrollment probe only observes a certificate and sends no HTTP, upgrade or pairing data', async t => {
  const f = await fixture(t);
  const observed = await probeTVIdentityCertificate({ host: '127.0.0.1', port: f.port });
  assert.equal(observed.certificatePin, f.pin); assert.equal(observed.trust, 'unverified-first-observation');
  await delay(15);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.upgrades, []); assert.deepEqual(f.messages, []);
});

test('wrong certificate pin prevents HTTP Upgrade and prevents the pairing key from being sent', async t => {
  const f = await fixture(t);
  const client = new SSAPClient({ host: '127.0.0.1', port: f.port, certificatePin: 'a'.repeat(64), clientKey: 'synthetic-pairing-key' });
  t.after(() => client.close());
  await assert.rejects(client.connect(), { code: 'TLS_PIN_MISMATCH' });
  assert.deepEqual(f.upgrades, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.messages, []);
});

test('matching pinned certificate permits registration after authentication', async t => {
  const f = await fixture(t);
  const client = new SSAPClient({ host: '127.0.0.1', port: f.port, certificatePin: f.pin, clientKey: 'synthetic-pairing-key' });
  t.after(() => client.close());
  await client.connect();
  assert.equal(client.secure, true); assert.equal(client.registered, true);
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].payload['client-key'], 'synthetic-pairing-key');
});

test('real pointer channel authenticates the same pin before a button is sent', async t => {
  const f = await fixture(t);
  const controller = new TVController({ host: '127.0.0.1', port: f.port, certificatePin: f.pin, clientKey: 'synthetic-pairing-key' });
  t.after(() => controller.close());
  await controller.connect(); await controller.key('HOME'); await delay(10);
  assert.deepEqual(f.frames, ['type:button\nname:HOME\n\n']);
});

test('real pointer channel refuses plaintext downgrade from a pinned SSAP session', async t => {
  const f = await fixture(t, { pointerURL: 'ws://127.0.0.1:9/pointer' });
  const controller = new TVController({ host: '127.0.0.1', port: f.port, certificatePin: f.pin, clientKey: 'synthetic-pairing-key' });
  t.after(() => controller.close());
  await controller.connect();
  await assert.rejects(controller.key('HOME'), { code: 'TLS_REQUIRED' });
  assert.deepEqual(f.frames, []); assert.deepEqual(f.upgrades, ['/']);
});

test('pointer endpoint presenting another certificate never receives a button or upgrade', async t => {
  const other = await fixture(t);
  const f = await fixture(t, { pointerURL: `wss://127.0.0.1:${other.port}/pointer` });
  const controller = new TVController({ host: '127.0.0.1', port: f.port, certificatePin: f.pin, clientKey: 'synthetic-pairing-key' });
  t.after(() => controller.close());
  await controller.connect();
  await assert.rejects(controller.key('HOME'), { code: 'TLS_PIN_MISMATCH' });
  assert.deepEqual(other.frames, []); assert.deepEqual(other.upgrades, []);
});

test('private image download requires HTTPS and a matching pin before sending its request', async t => {
  const f = await fixture(t);
  await assert.rejects(downloadCapture(`http://127.0.0.1:${f.port}/capture`, '127.0.0.1'), { code: 'TLS_REQUIRED' });
  await assert.rejects(downloadCapture(`https://127.0.0.1:${f.port}/capture`, '127.0.0.1'), { code: 'TLS_PIN_REQUIRED' });
  await assert.rejects(downloadCapture(`https://127.0.0.1:${f.port}/capture`, '127.0.0.1', { certificatePin: 'a'.repeat(64) }), { code: 'TLS_PIN_MISMATCH' });
  assert.deepEqual(f.requests, []);
  const image = await downloadCapture(`https://127.0.0.1:${f.port}/capture`, '127.0.0.1', { certificatePin: f.pin });
  assert.deepEqual(image.data, Buffer.from([255, 216, 255, 217])); assert.deepEqual(f.requests, ['/capture']);
});

test('a pinned agent cannot be reused to route requests to a different host', async () => {
  const agent = createPinnedTVAgent({ host: '127.0.0.1', certificatePin: 'a'.repeat(64) });
  const error = await new Promise(resolve => agent.createConnection({ host: '192.168.77.80', port: 3001 }, resolve));
  assert.equal(error.code, 'TLS_TARGET_MISMATCH'); agent.destroy();
});

test('a stalled TLS peer times out before any authenticated application traffic', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(probeTVIdentityCertificate({ host: '127.0.0.1', port: server.address().port, timeoutMs: 30 }), { code: 'TLS_TIMEOUT' });
});

test('closing a pinned agent cancels a pending handshake without handing out a socket', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const agent = createPinnedTVAgent({ host: '127.0.0.1', certificatePin: 'a'.repeat(64), timeoutMs: 1000 });
  const result = new Promise(resolve => agent.createConnection({ host: '127.0.0.1', port: server.address().port }, (error, socket) => resolve({ error, socket })));
  agent.destroy();
  const outcome = await result;
  assert.equal(outcome.error.code, 'TLS_CLIENT_CLOSED'); assert.equal(outcome.socket, undefined);
});

test('HTTPS discovery uses system certificate verification unless an exact pin is supplied', async t => {
  const recorded = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    recorded.push(options);
    const request = new EventEmitter(); request.destroy = () => request.emit('close');
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200; callback(response);
      response.emit('data', Buffer.from('<fixture/>')); response.emit('end'); request.emit('close');
    });
    return request;
  });
  assert.equal(await getLocalText('https://192.168.77.80/root', '192.168.77.80'), '<fixture/>');
  assert.equal(recorded[0].rejectUnauthorized, true); assert.equal(recorded[0].agent, undefined);
  await getLocalText('https://192.168.77.80/root', '192.168.77.80', { certificatePin: 'a'.repeat(64) });
  assert.equal(recorded[1].rejectUnauthorized, true); assert.ok(recorded[1].agent);
});
