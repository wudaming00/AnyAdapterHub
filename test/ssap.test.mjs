import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, loadLegacyManifest } from '../lg-tv.mjs';
import {
  SSAPClient, AUDIT_PERMISSIONS, AUDIT_ENDPOINTS, POINTER_ENDPOINT,
  auditTV, redact, validateLocalHost, validateCaptureURL, downloadCapture,
} from '../lib/ssap.mjs';

const HOST = '192.168.20.30';
const KEY = 'unit-test-private-client-key';

class FakeSocket extends EventEmitter {
  sent = [];
  terminated = false;
  constructor(onSend) { super(); this.onSend = onSend; }
  send(text, callback) {
    const frame = JSON.parse(text);
    this.sent.push(frame);
    callback?.();
    queueMicrotask(() => { if (!this.terminated) this.onSend?.(frame, this); });
  }
  reply(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  terminate() { if (!this.terminated) { this.terminated = true; this.emit('close'); } }
}

function harness(onSend, options = {}) {
  let socket;
  let connectionOptions;
  let connectionCount = 0;
  const client = new SSAPClient({ host: HOST, timeoutMs: 150, clientKey: KEY, ...options,
    webSocketFactory: (url, wsOptions) => {
      connectionCount++;
      connectionOptions = { url, ...wsOptions };
      socket = new FakeSocket(onSend);
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
  });
  return { client, get socket() { return socket; }, get connectionOptions() { return connectionOptions; },
    get connectionCount() { return connectionCount; } };
}

function accept(frame, socket) {
  if (frame.type === 'register') socket.reply({ id: frame.id, type: 'registered', payload: { 'client-key': KEY } });
}

test('unpaired audit refuses locally without opening any socket', async () => {
  const h = harness(accept, { clientKey: undefined });
  await assert.rejects(h.client.connect(), { code: 'PAIRING_REQUIRED' });
  assert.equal(h.connectionCount, 0);
});

test('explicit upstream compatibility manifest is preserved exactly and detached from caller mutation', async () => {
  const { manifest } = await loadLegacyManifest();
  const expected = structuredClone(manifest);
  const h = harness(accept, { registrationManifest: manifest });
  manifest.signed.appId = 'caller-mutated-after-construction';
  manifest.signatures[0].signature = 'caller-mutated-after-construction';
  await h.client.connect();
  assert.deepEqual(h.socket.sent[0].payload.manifest, expected);
  assert.equal(h.socket.sent[0].payload.manifest.signed.appId, 'com.lge.test');
  assert.deepEqual(h.socket.sent[0].payload.manifest.signatures, expected.signatures);
  h.client.close();
  const normal = harness(accept);
  await normal.client.connect();
  assert.equal(normal.socket.sent[0].payload.manifest.signed, undefined);
  assert.equal(normal.socket.sent[0].payload.manifest.signatures, undefined);
  normal.client.close();
});

test('legacy CLI defaults to separate key file, preserves own key and copies only device preferences', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lg-legacy-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ownFile = path.join(directory, '.lg-tv.local.json');
  const ownKey = 'fixture-own-key-do-not-copy';
  const legacyKey = 'fixture-new-legacy-key';
  const original = JSON.stringify({ schemaVersion: 1, devices: { [HOST]: {
    clientKey: ownKey, permissions: [...AUDIT_PERMISSIONS], profile: 'control',
    webOSMajor: 4, mac: '44:66:88:AA:CC:EE', wake: { broadcast: '192.168.20.255', bindAddress: '192.168.20.2' },
  } } });
  await writeFile(ownFile, original);
  const log = []; let constructed;
  const result = await main(['pair', '--host', HOST, '--secure', '--profile', 'legacy-lgtv2'], {
    baseDirectory: directory, stdout: (value) => log.push(value), stderr: (value) => log.push(value),
    resolveKey: async profile => profile.clientKey, protectKey: async profile => profile,
    clientFactory: (options) => {
      constructed = options;
      return { port: 3001, secure: true, sanitize: (value) => redact(value, [legacyKey]),
        connect: async () => { await options.onClientKey(legacyKey); return { registered: true }; }, close: () => {},
      };
    },
  });
  assert.equal(result, 0);
  assert.equal(constructed.clientKey, undefined);
  assert.equal(constructed.registrationManifest.signed.appId, 'com.lge.test');
  assert.equal(await readFile(ownFile, 'utf8'), original);
  const legacyText = await readFile(path.join(directory, '.lg-tv.legacy.local.json'), 'utf8');
  const record = JSON.parse(legacyText).devices[HOST];
  assert.equal(record.clientKey, legacyKey);
  assert.equal(record.profile, 'legacy-lgtv2');
  assert.equal(record.webOSMajor, 4);
  assert.deepEqual(record.wake, { broadcast: '192.168.20.255', bindAddress: '192.168.20.2' });
  assert.equal(legacyText.includes(ownKey), false);
  assert.equal(log.join('\n').includes(legacyKey), false);
  assert.match(log.join('\n'), /LG Remote App/);
  const upstream = await loadLegacyManifest();
  assert.deepEqual(record.registrationManifest, upstream.manifest);
  assert.equal(record.registrationManifestMetadata.sha256, upstream.metadata.sha256);
});

test('legacy pairing failure leaves both files unchanged and refuses the own-app config path', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lg-legacy-failure-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ownFile = path.join(directory, '.lg-tv.local.json');
  const legacyFile = path.join(directory, '.lg-tv.legacy.local.json');
  const own = JSON.stringify({ schemaVersion: 1, devices: { [HOST]: { clientKey: KEY, permissions: [...AUDIT_PERMISSIONS], profile: 'control' } } });
  const { manifest, metadata } = await loadLegacyManifest();
  const legacy = JSON.stringify({ schemaVersion: 1, devices: { [HOST]: {
    clientKey: 'older-legacy-fixture-key', permissions: manifest.permissions, profile: 'legacy-lgtv2',
    registrationManifest: manifest, registrationManifestMetadata: metadata,
  } } });
  await writeFile(ownFile, own); await writeFile(legacyFile, legacy);
  let connections = 0;
  const options = { baseDirectory: directory, stdout: () => {}, stderr: () => {},
    resolveKey: async profile => profile.clientKey, protectKey: async profile => profile,
    clientFactory: () => ({ sanitize: (value) => value,
      connect: async () => { connections++; throw Object.assign(new Error('403 user denied'), { code: 'TV_REJECTED' }); }, close: () => {},
    }),
  };
  assert.equal(await main(['pair', '--host', HOST, '--profile', 'legacy-lgtv2'], options), 1);
  assert.equal(connections, 1);
  assert.equal(await readFile(ownFile, 'utf8'), own);
  assert.equal(await readFile(legacyFile, 'utf8'), legacy);
  assert.equal(await main(['pair', '--host', HOST, '--profile', 'legacy-lgtv2', '--config', '.lg-tv.local.json'], options), 1);
  assert.equal(connections, 1);
  assert.equal(await readFile(ownFile, 'utf8'), own);
});

test('explicit pair prompts once and awaits private key persistence before requests', async () => {
  let prompts = 0; let saved; let releaseSave;
  const saveFinished = new Promise((resolve) => { releaseSave = resolve; });
  const h = harness((frame, socket) => {
    if (frame.type === 'register') {
      socket.reply({ id: frame.id, type: 'response', payload: { pairingType: 'PROMPT' } });
      socket.reply({ id: frame.id, type: 'response', payload: { pairingType: 'PROMPT' } });
      socket.reply({ id: frame.id, type: 'registered', payload: { 'client-key': KEY } });
    } else socket.reply({ id: frame.id, type: 'response', payload: { ok: true } });
  }, { clientKey: undefined, onPairing: () => prompts++, onClientKey: async (key) => { saved = key; await saveFinished; } });
  const registration = h.client.connect({ allowPairing: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.equal(saved, KEY);
  assert.equal(h.client.registered, false);
  await assert.rejects(h.client.request('ssap://audio/getVolume'), { code: 'NOT_REGISTERED' });
  assert.equal(h.socket.sent.length, 1);
  assert.equal(h.socket.sent[0].payload.pairingType, 'PROMPT');
  assert.equal(h.socket.sent[0].payload.manifest.signed, undefined);
  assert.deepEqual(h.socket.sent[0].payload.manifest.permissions, AUDIT_PERMISSIONS);
  releaseSave();
  assert.deepEqual(await registration, { registered: true });
  assert.equal(JSON.stringify(h.client).includes(KEY), false);
  assert.deepEqual(await h.client.request('ssap://audio/getVolume'), { ok: true });
  h.client.close();
});

test('saved-key registration omits prompt and stops if television asks for pairing', async () => {
  let prompted = 0;
  const h = harness((frame, socket) => socket.reply({ id: frame.id, type: 'response', payload: { pairingType: 'PROMPT' } }),
    { onPairing: () => prompted++ });
  await assert.rejects(h.client.connect(), { code: 'PAIRING_REQUIRED' });
  assert.equal(h.socket.sent[0].payload['client-key'], KEY);
  assert.equal(h.socket.sent[0].payload.pairingType, undefined);
  assert.equal(h.socket.sent.length, 1);
  assert.equal(prompted, 0);
  assert.equal(h.socket.terminated, true);
});

test('request IDs correlate out-of-order replies and redact keys from payloads/errors', async () => {
  const h = harness(accept);
  await h.client.connect();
  const first = h.client.request('ssap://audio/getVolume');
  const second = h.client.request('ssap://system/getSystemInfo');
  const [, one, two] = h.socket.sent;
  assert.notEqual(one.id, two.id);
  h.socket.reply({ id: 'unknown', type: 'response', payload: { value: 'ignore' } });
  h.socket.reply({ id: two.id, type: 'response', payload: { name: 'TV', 'client-key': KEY, nested: `prefix:${KEY}` } });
  h.socket.reply({ id: one.id, type: 'response', payload: { volume: 17 } });
  assert.deepEqual(await first, { volume: 17 });
  assert.deepEqual(await second, { name: 'TV', 'client-key': '[REDACTED]', nested: 'prefix:[REDACTED]' });
  const failed = h.client.request('ssap://audio/getStatus');
  const last = h.socket.sent.at(-1);
  h.socket.reply({ id: last.id, type: 'error', error: `denied ${KEY}`, payload: { clientKey: KEY } });
  await assert.rejects(failed, (error) => error.code === 'TV_REJECTED' && !JSON.stringify(error).includes(KEY) && !error.message.includes(KEY));
  h.client.close();
});

test('request timeout clears only its request and connection close rejects outstanding work', async () => {
  const h = harness(accept);
  await h.client.connect();
  await assert.rejects(h.client.request('ssap://audio/getVolume', {}, { timeoutMs: 5 }), { code: 'TIMEOUT' });
  assert.equal(h.client.registered, true);
  const outstanding = h.client.request('ssap://system/getSystemInfo');
  h.socket.terminate();
  await assert.rejects(outstanding, { code: 'CONNECTION_CLOSED' });
  await assert.rejects(h.client.request('ssap://audio/getVolume'), { code: 'NOT_REGISTERED' });
});

test('subscribeOnce correlates its first state response and unsubscribes the same ID', async () => {
  const h = harness(accept);
  await h.client.connect();
  const pending = h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard');
  const subscription = h.socket.sent.at(-1);
  assert.equal(subscription.type, 'subscribe');
  h.socket.reply({ id: 'other-subscription', type: 'response', payload: { currentWidget: { focus: true } } });
  h.socket.reply({ id: subscription.id, type: 'response', payload: { subscribed: true, currentWidget: { focus: false } } });
  assert.deepEqual(await pending, { subscribed: true, currentWidget: { focus: false } });
  assert.deepEqual(h.socket.sent.at(-1), { id: subscription.id, type: 'unsubscribe' });
  const count = h.socket.sent.length;
  h.socket.reply({ id: subscription.id, type: 'response', payload: { currentWidget: { focus: true } } });
  assert.equal(h.socket.sent.length, count);
  h.client.close();
});

test('subscribeOnce handles event responses, errors, timeout cleanup, and connection close', async () => {
  const h = harness(accept);
  await h.client.connect();
  const event = h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard');
  h.socket.reply({ id: h.socket.sent.at(-1).id, type: 'event', payload: { currentWidget: { focus: true } } });
  assert.equal((await event).currentWidget.focus, true);
  const failure = h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard');
  h.socket.reply({ id: h.socket.sent.at(-1).id, type: 'error', error: '401 permission denied' });
  await assert.rejects(failure, { code: 'TV_REJECTED' });
  const timeout = h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard', {}, { timeoutMs: 5 });
  const timedId = h.socket.sent.at(-1).id;
  await assert.rejects(timeout, { code: 'TIMEOUT' });
  assert.deepEqual(h.socket.sent.at(-1), { id: timedId, type: 'unsubscribe' });
  const closed = h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard');
  h.socket.terminate();
  await assert.rejects(closed, { code: 'CONNECTION_CLOSED' });
  await assert.rejects(h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard'), { code: 'NOT_REGISTERED' });
});

test('subscribeOnce skips registration ack until payload predicate accepts a state event', async () => {
  const h = harness(accept);
  await h.client.connect();
  const pending = h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard', {}, {
    acceptPayload: (payload) => Object.hasOwn(payload, 'currentWidget'),
  });
  const subscription = h.socket.sent.at(-1);
  h.socket.reply({ id: subscription.id, type: 'response', payload: { subscribed: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.socket.sent.at(-1).type, 'subscribe');
  h.socket.reply({ id: subscription.id, type: 'response', payload: { currentWidget: { focus: true } } });
  assert.equal((await pending).currentWidget.focus, true);
  assert.deepEqual(h.socket.sent.at(-1), { id: subscription.id, type: 'unsubscribe' });
  const noState = h.client.subscribeOnce('ssap://com.webos.service.ime/registerRemoteKeyboard', {}, {
    timeoutMs: 5, acceptPayload: () => false,
  });
  const noStateId = h.socket.sent.at(-1).id;
  h.socket.reply({ id: noStateId, type: 'response', payload: { subscribed: true } });
  await assert.rejects(noState, { code: 'TIMEOUT' });
  assert.deepEqual(h.socket.sent.at(-1), { id: noStateId, type: 'unsubscribe' });
  h.client.close();
});

test('persistent subscription retains events after ack and stops only on explicit unsubscribe', async () => {
  const h = harness(accept);
  await h.client.connect();
  const updates = []; const errors = [];
  const pending = h.client.subscribe('ssap://com.webos.service.ime/registerRemoteKeyboard', {}, {
    onUpdate: (payload) => updates.push(payload), onError: (error) => errors.push(error), timeoutMs: 20,
  });
  const frame = h.socket.sent.at(-1);
  h.socket.reply({ id: frame.id, type: 'response', payload: { subscribed: true } });
  const subscription = await pending;
  assert.equal(subscription.id, frame.id);
  assert.equal(h.socket.sent.at(-1).type, 'subscribe');
  h.socket.reply({ id: frame.id, type: 'response', payload: { currentWidget: { focus: true }, clientKey: KEY } });
  assert.deepEqual(updates, [{ subscribed: true }, { currentWidget: { focus: true }, clientKey: '[REDACTED]' }]);
  subscription.unsubscribe();
  assert.deepEqual(h.socket.sent.at(-1), { id: frame.id, type: 'unsubscribe' });
  h.socket.reply({ id: frame.id, type: 'event', payload: { currentWidget: { focus: false } } });
  assert.equal(updates.length, 2);
  h.client.close();
  assert.equal(errors.length, 0);
});

test('persistent subscription handles initial timeout, later TV errors, and close notifications', async () => {
  const h = harness(accept);
  await h.client.connect();
  await assert.rejects(h.client.subscribe('ssap://com.webos.service.ime/registerRemoteKeyboard', {}, {
    onUpdate: () => {}, timeoutMs: 5,
  }), { code: 'TIMEOUT' });
  assert.equal(h.socket.sent.at(-1).type, 'unsubscribe');
  const errors = [];
  const register = async () => {
    const promise = h.client.subscribe('ssap://com.webos.service.ime/registerRemoteKeyboard', {}, {
      onUpdate: () => {}, onError: (error) => errors.push(error),
    });
    const frame = h.socket.sent.at(-1);
    h.socket.reply({ id: frame.id, type: 'response', payload: { subscribed: true } });
    return promise;
  };
  const first = await register();
  h.socket.reply({ id: first.id, type: 'error', error: `401 denied ${KEY}` });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'TV_REJECTED');
  assert.equal(errors[0].message.includes(KEY), false);
  await register();
  h.socket.terminate();
  assert.equal(errors.length, 2);
  assert.equal(errors[1].code, 'CONNECTION_CLOSED');
});

test('registration timeout, malformed responses, and failed private save close cleanly', async () => {
  const timeout = harness(() => {}, { timeoutMs: 5 });
  await assert.rejects(timeout.client.connect(), { code: 'TIMEOUT' });
  assert.equal(timeout.socket.terminated, true);
  const malformed = harness((_frame, socket) => socket.emit('message', Buffer.from('not JSON')));
  await assert.rejects(malformed.client.connect(), { code: 'PROTOCOL_ERROR' });
  const unsaved = harness(accept, { onClientKey: async () => { throw new Error(KEY); } });
  await assert.rejects(unsaved.client.connect({ allowPairing: true }), (error) => error.code === 'KEY_SAVE_FAILED' && !error.message.includes(KEY));
  assert.equal(unsaved.client.registered, false);
});

test('audit sends only fixed read queries and records permission failures without mutations', async () => {
  const h = harness((frame, socket) => {
    if (frame.type === 'register') accept(frame, socket);
    else if (frame.uri.endsWith('/listApps')) socket.reply({ id: frame.id, type: 'error', error: '401 insufficient permissions' });
    else socket.reply({ id: frame.id, type: 'response', payload: { returnValue: true, value: 'sample' } });
  });
  await h.client.connect();
  const report = await auditTV(h.client);
  assert.deepEqual(h.socket.sent.slice(1).map((frame) => frame.uri), AUDIT_ENDPOINTS.map((endpoint) => endpoint.uri));
  assert.ok(h.socket.sent.slice(1).every((frame) => frame.type === 'request' && Object.keys(frame.payload).length === 0));
  assert.equal(report.results.length, 10);
  assert.equal(report.results.find((item) => item.name === 'apps').status, 'error');
  assert.match(report.results.find((item) => item.name === 'apps').error.message, /permissions/);
  assert.equal(JSON.stringify(report).includes(KEY), false);
  assert.equal(report.results.some((item) => /executeOneShot|launch$|insertText|setVolume|turnOff/.test(item.uri)), false);
  h.client.close();
});

test('pointer audit only obtains endpoint URL; no input socket is opened', async () => {
  const h = harness((frame, socket) => {
    if (frame.type === 'register') accept(frame, socket);
    else socket.reply({ id: frame.id, type: 'response', payload: frame.uri === POINTER_ENDPOINT
      ? { socketPath: `ws://${HOST}:3000/resources/pointer` } : {} });
  });
  await h.client.connect();
  const report = await auditTV(h.client, { includePointer: true });
  assert.equal(report.results.at(-1).uri, POINTER_ENDPOINT);
  assert.equal(h.connectionCount, 1);
  h.client.close();
});

test('private address validation and explicit secure transport options are enforced', async () => {
  for (const value of ['8.8.8.8', 'example.com', 'http://192.168.1.5', '192.168.1.5:3000']) {
    assert.throws(() => validateLocalHost(value), { code: 'INVALID_HOST' });
  }
  assert.equal(validateLocalHost('fd00::123'), 'fd00::123');
  const plain = harness(accept);
  await plain.client.connect();
  assert.equal(Object.hasOwn(plain.connectionOptions, 'rejectUnauthorized'), false);
  plain.client.close();
  const secure = harness(accept, { secure: true });
  await secure.client.connect();
  assert.equal(secure.connectionOptions.url, `wss://${HOST}:3001`);
  assert.notEqual(secure.connectionOptions.rejectUnauthorized, false);
  assert.equal(secure.connectionOptions.followRedirects, false);
  secure.client.close();
});

test('capture URL must remain on the same literal host and contain no URL credentials', () => {
  assert.equal(validateCaptureURL(`http://${HOST}:8080/capture.jpg`, HOST).hostname, HOST);
  for (const value of ['file:///tmp/capture.jpg', 'https://example.com/a.jpg', 'http://192.168.20.31/a.jpg',
    `http://user:password@${HOST}/a.jpg`, `http://${HOST}/capture.jpg#fragment`]) {
    assert.throws(() => validateCaptureURL(value, HOST), { code: 'INVALID_CAPTURE_URL' });
  }
  assert.deepEqual(redact({ authorization: 'x', password: 'x', clientKey: 'x', child: { 'client-key': 'x' } }),
    { authorization: '[REDACTED]', password: '[REDACTED]', clientKey: '[REDACTED]', child: { 'client-key': '[REDACTED]' } });
});

test('injected capture transport retains certificate checks and validates the same host first', async () => {
  let recorded;
  const requestFactory = (url, options, callback) => {
    recorded = { url: url.href, ...options };
    const request = new EventEmitter();
    request.destroy = () => request.emit('close');
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/jpeg' };
      callback(response);
      response.emit('data', Buffer.from([0xff, 0xd8]));
      response.emit('end');
      request.emit('close');
    });
    return request;
  };
  await downloadCapture(`https://${HOST}/capture.jpg`, HOST, { requestFactory });
  assert.equal(recorded.rejectUnauthorized, true);
  await downloadCapture(`https://${HOST}/capture.jpg`, HOST, { requestFactory, certificatePin: 'a'.repeat(64) });
  assert.equal(recorded.rejectUnauthorized, true);
  await downloadCapture(`http://${HOST}/capture.jpg`, HOST, { requestFactory });
  assert.equal(recorded.rejectUnauthorized, true);
  recorded = undefined;
  await assert.rejects(downloadCapture('https://example.com/capture.jpg', HOST, { requestFactory }), { code: 'INVALID_CAPTURE_URL' });
  assert.equal(recorded, undefined);
});

test('capture download refuses redirects/non-images and caps response size (loopback fixture only)', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/image' }); res.end(); }
    else if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>'); }
    else { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requestFactory = (url, options, callback) => http.get(url, options, callback);
  const image = await downloadCapture(`${base}/image`, '127.0.0.1', { requestFactory });
  assert.equal(image.bytes, 4);
  assert.equal(image.contentType, 'image/jpeg');
  for (const route of ['/redirect', '/html']) await assert.rejects(downloadCapture(base + route, '127.0.0.1', { requestFactory }), { code: 'CAPTURE_DOWNLOAD_FAILED' });
  await assert.rejects(downloadCapture(`${base}/image`, '127.0.0.1', { requestFactory, maxBytes: 2 }), { code: 'CAPTURE_TOO_LARGE' });
});
