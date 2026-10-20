import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MQTTTLSAdapter } from '../lib/adapters/mqtt-tls.mjs';

const require = createRequire(import.meta.url);
let sdkEntry;
try { sdkEntry = require.resolve('mqtt'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const SDK_SKIP = sdkEntry ? false : 'Optional mqtt@5.16.1 is not installed; run npm run adapter:mqtt:install to run real SDK fixtures.';

// Native TLS identities exist only in memory. Every address, topic and credential below is synthetic.
function authority() {
  const issuerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag, ...parts) => {
    const bytes = Buffer.concat(parts), lengths = []; let size = bytes.length;
    do { lengths.unshift(size & 255); size >>>= 8; } while (size);
    return Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | lengths.length, ...lengths])]), bytes]);
  };
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = text => der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from(text)))));
  const issuer = name('MQTT SDK fixture CA');
  const time = value => der(0x17, Buffer.from(new Date(value).toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const validity = der(0x30, time(Date.now() - 86400000), time(Date.now() + 86400000));
  return () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const extensions = der(0xa3, der(0x30,
      der(0x30, Buffer.from('0603551d11', 'hex'), der(4, der(0x30, der(0x87, Buffer.from([127, 0, 0, 1]))))),
      der(0x30, Buffer.from('0603551d13', 'hex'), der(1, Buffer.from([255])), der(4, der(0x30)))));
    const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([2])), algorithm, issuer, validity,
      name('MQTT SDK fixture leaf'), keys.publicKey.export({ type: 'spki', format: 'der' }), extensions);
    const raw = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, issuerKeys.privateKey)));
    return { cert: ['-----BEGIN CERTIFICATE-----', ...raw.toString('base64').match(/.{1,64}/g), '-----END CERTIFICATE-----', ''].join('\n'),
      key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), pin: createHash('sha256').update(raw).digest('hex') };
  };
}

function codec() {
  const sdkRequire = createRequire(sdkEntry);
  assert.equal(sdkRequire('mqtt/package.json').version, '5.16.1');
  return sdkRequire('mqtt-packet'); // The optional SDK's existing runtime dependency, not a new project dependency.
}

async function broker(t, identity, packetCodec, parserFactory = packetCodec.parser) {
  const connections = new Set(), secureSockets = new Set(), packets = [], failures = [], notices = new EventEmitter();
  let applicationBytes = 0;
  const server = tls.createServer({ cert: identity.cert, key: identity.key, minVersion: 'TLSv1.2' }, socket => {
    secureSockets.add(socket); socket.on('close', () => secureSockets.delete(socket));
    const parser = parserFactory({ protocolVersion: 5 }); let received = 0;
    parser.on('error', () => { failures.push('fixture-parser'); socket.destroy(); });
    parser.on('packet', packet => {
      packets.push(packet);
      if (packet.cmd === 'connect') socket.write(packetCodec.generate({ cmd: 'connack', sessionPresent: false, reasonCode: 0, properties: {} }, { protocolVersion: 5 }));
      else if (packet.cmd === 'subscribe') socket.write(packetCodec.generate({ cmd: 'suback', messageId: packet.messageId, granted: [0], properties: {} }, { protocolVersion: 5 }));
      else if (packet.cmd === 'pingreq') socket.write(Buffer.from([0xd0, 0]));
      notices.emit('packet');
    });
    socket.on('data', bytes => {
      applicationBytes += bytes.length;
      received += bytes.length;
      if (received > 65536) { failures.push('fixture-input-limit'); socket.destroy(); return; }
      parser.parse(bytes);
    });
  });
  server.on('connection', socket => { connections.add(socket); socket.on('error', () => {}); socket.on('close', () => { connections.delete(socket); notices.emit('closed'); }); });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { packets, failures, connections, notices, port: server.address().port,
    get applicationBytes() { return applicationBytes; },
    publish(messages) {
      const wire = Buffer.concat(messages.map(message => packetCodec.generate({ cmd: 'publish', qos: 0, retain: false, properties: {}, ...message }, { protocolVersion: 5 })));
      for (const socket of secureSockets) socket.write(wire);
    },
    raw(bytes) { for (const socket of secureSockets) socket.write(bytes); },
  };
}

function config(identity, port) {
  return { host: '127.0.0.1', port, certificatePem: identity.cert, certificatePin: identity.pin,
    topic: 'fixture/sdk/sensor', measurement: 'temperatureC', username: 'synthetic-sdk-user', password: 'synthetic-sdk-password' };
}

function stateUntil(adapter, predicate) {
  if (predicate(adapter.snapshot())) return Promise.resolve(adapter.snapshot());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cancel(); reject(new Error('Synthetic MQTT fixture state timed out.')); }, 2000);
    const cancel = adapter.subscribe(event => { if (predicate(event.data)) { clearTimeout(timer); cancel(); resolve(event.data); } });
  });
}

test('real optional MQTT SDK uses pinned native TLS, exact subscription and sensor projection with no publish capability', { skip: SDK_SKIP, timeout: 5000 }, async t => {
  const packetCodec = codec(), identity = authority()(), fixture = await broker(t, identity, packetCodec);
  const selected = config(identity, fixture.port), adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sdk-sensor', config: selected }), events = [];
  t.after(() => adapter.close()); adapter.subscribe(event => events.push(event));
  await adapter.start();
  assert.deepEqual(adapter.supportedActions, []);
  const connect = fixture.packets.find(packet => packet.cmd === 'connect');
  assert.equal(connect.protocolVersion, 5); assert.equal(connect.clean, true);
  assert.equal(connect.username, selected.username); assert.equal(connect.password.toString(), selected.password);
  assert.equal(connect.properties.maximumPacketSize, 1024); assert.equal(connect.properties.receiveMaximum, 1);
  const subscriptions = fixture.packets.filter(packet => packet.cmd === 'subscribe');
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0].subscriptions, [{ topic: selected.topic, qos: 0, nl: true, rap: true, rh: 2 }]);
  const first = stateUntil(adapter, state => state.fields.temperatureC?.value === 20.5);
  fixture.publish([{ topic: selected.topic, payload: '20.5' }]); await first;
  const next = stateUntil(adapter, state => state.fields.temperatureC?.value === 21.75);
  fixture.publish([
    { topic: 'fixture/sdk/wrong', payload: '100' }, { topic: selected.topic, payload: '37', retain: true },
    { topic: selected.topic, payload: '{}' }, { topic: selected.topic, payload: 'NaN' },
    { topic: selected.topic, payload: '21.75' },
  ]);
  const state = await next;
  assert.equal(state.fields.temperatureC.verification, 'broker-reported'); assert.equal(state.fields.temperatureC.source, 'mqtt-tls');
  assert.equal(Date.parse(state.fields.temperatureC.expiresAt) - Date.parse(state.fields.temperatureC.observedAt), 60000);
  assert.deepEqual([...new Set(events.flatMap(event => event.data.fields.temperatureC ? [event.data.fields.temperatureC.value] : []))], [20.5, 21.75]);
  const exposed = JSON.stringify(events);
  for (const secret of [selected.host, selected.topic, selected.username, selected.password, selected.certificatePin]) assert.equal(exposed.includes(secret), false);
  await assert.rejects(adapter.execute({ action: 'mqtt.publish', args: { topic: selected.topic, payload: '1' } }), { code: 'UNSUPPORTED_ACTION' });
  await adapter.close(); assert.equal(adapter.snapshot().connection.phase, 'closed');
  assert.equal(fixture.packets.some(packet => packet.cmd === 'publish'), false); assert.deepEqual(fixture.failures, []);
});

test('real MQTT SDK sends zero CONNECT application bytes to a substituted TLS identity', { skip: SDK_SKIP, timeout: 5000 }, async t => {
  const packetCodec = codec(), leaf = authority(), selected = leaf(), replacement = leaf();
  const fixture = await broker(t, replacement, packetCodec), adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sdk-sensor', config: config(selected, fixture.port) });
  t.after(() => adapter.close());
  await assert.rejects(adapter.start(), error => ['TLS_CERTIFICATE_INVALID', 'TLS_PIN_MISMATCH', 'MQTT_CONNECTION_FAILED'].includes(error.code));
  await adapter.close();
  assert.equal(fixture.applicationBytes, 0); assert.deepEqual(fixture.packets, []); assert.deepEqual(fixture.failures, []);
});

test('real MQTT SDK parser never receives an oversized broker Remaining Length header', { skip: SDK_SKIP, timeout: 5000 }, async t => {
  const packetCodec = codec(), originalParser = packetCodec.parser, identity = authority()();
  const fixture = await broker(t, identity, packetCodec, originalParser), parsedChunks = [];
  t.mock.method(packetCodec, 'parser', function (...args) {
    const parser = originalParser.apply(this, args), parse = parser.parse;
    parser.parse = function (bytes) { parsedChunks.push(Buffer.from(bytes)); return parse.call(this, bytes); };
    return parser;
  });
  const adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sdk-sensor', config: config(identity, fixture.port) });
  t.after(() => adapter.close()); await adapter.start();
  assert.ok(parsedChunks.length > 0); const before = parsedChunks.reduce((total, bytes) => total + bytes.length, 0);
  const offline = stateUntil(adapter, state => state.connection.phase === 'offline');
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fixture.notices.removeListener('closed', changed); reject(new Error('Synthetic MQTT fixture socket did not close.')); }, 2000);
    const changed = () => { if (fixture.connections.size === 0) { clearTimeout(timer); fixture.notices.removeListener('closed', changed); resolve(); } };
    fixture.notices.on('closed', changed);
  });
  fixture.raw(Buffer.from([0x30, 0xff, 0xff, 0xff, 0x7f])); await offline;
  await closed;
  assert.equal(parsedChunks.reduce((total, bytes) => total + bytes.length, 0), before);
  await adapter.close(); assert.equal(fixture.packets.some(packet => packet.cmd === 'publish'), false);
});
