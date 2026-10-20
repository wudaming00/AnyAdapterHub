import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { MQTTFrameGuard, createMQTTWireTransport } from '../lib/adapters/mqtt-wire.mjs';
import { createMQTTTLSStream } from '../lib/adapters/mqtt-tls.mjs';

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const frame = bytes => Buffer.from(bytes);
function input(guard, bytes) { return new Promise((resolve, reject) => guard.write(bytes, error => error ? reject(error) : resolve())); }

test('broker frame headers stay private until a complete bounded frame; coalesced and split frames survive', async () => {
  const guard = new MQTTFrameGuard(), output = []; guard.on('data', bytes => output.push(bytes));
  await input(guard, frame([0x30])); assert.equal(output.length, 0);
  await input(guard, frame([0x80])); assert.equal(output.length, 0);
  await input(guard, frame([0x01])); assert.equal(output.length, 0);
  await input(guard, Buffer.alloc(127, 0x61)); assert.equal(output.length, 0);
  await input(guard, frame([0x62, 0xd0, 0x00, 0xd0, 0x00]));
  assert.equal(output[0].length, 131); assert.deepEqual(output.slice(1), [frame([0xd0, 0]), frame([0xd0, 0])]);
  guard.end(); await once(guard, 'end');
});

test('oversized Remaining Length is rejected as soon as its header declares it, with zero parser bytes', async () => {
  for (const bytes of [[0x30, 0xff, 0x07], [0x30, 0xff, 0x7f], [0x30, 0xff, 0xff, 0xff, 0x7f]]) {
    const guard = new MQTTFrameGuard(), output = []; guard.on('data', bytes => output.push(bytes)); guard.on('error', () => {});
    const closed = once(guard, 'close');
    await assert.rejects(input(guard, frame(bytes)), { code: 'MQTT_FRAME_TOO_LARGE' });
    await closed.catch(() => {}); assert.deepEqual(output, []); assert.equal(guard.readableLength, 0);
  }
});

test('invalid/nonminimal varints, invalid fixed headers and truncated frames fail with static errors', async () => {
  for (const bytes of [[0x30, 0x80, 0x00], [0x30, 0x80, 0x80, 0x80, 0x80], [0x00, 0], [0xf0, 0], [0xd1, 0], [0x36, 0]]) {
    const guard = new MQTTFrameGuard(), output = []; guard.on('data', bytes => output.push(bytes)); guard.on('error', () => {});
    await assert.rejects(input(guard, frame(bytes)), { code: 'MQTT_FRAME_INVALID' }); assert.deepEqual(output, []);
  }
  for (const bytes of [[0x30], [0x30, 0x80], [0x30, 1]]) {
    const guard = new MQTTFrameGuard(), output = []; guard.on('data', bytes => output.push(bytes));
    const failed = once(guard, 'error'); guard.end(frame(bytes));
    assert.equal((await failed)[0].code, 'MQTT_FRAME_TRUNCATED'); assert.deepEqual(output, []);
  }
});

test('1024-byte frames are accepted and guard backpressure prevents unbounded coalesced output', async () => {
  const guard = new MQTTFrameGuard(), expected = Buffer.concat([frame([0x30, 0xfd, 0x07]), Buffer.alloc(1021, 0x61)]);
  let finished = false;
  guard.write(Buffer.concat([expected, expected, expected, expected]), () => { finished = true; });
  await flush(); assert.equal(finished, false); assert.ok(guard.readableLength <= 1024);
  const output = []; guard.on('data', bytes => output.push(bytes));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, true); guard.end(); await once(guard, 'end');
  assert.deepEqual(Buffer.concat(output), Buffer.concat([expected, expected, expected, expected]));
});

test('transport rejects oversized fake broker frames before downstream data and releases the underlying socket', async () => {
  let disposed = false; const outbound = [];
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { outbound.push(Buffer.from(chunk)); callback(); },
    destroy(error, callback) { disposed = true; callback(error); } });
  const transport = createMQTTWireTransport(socket), output = []; transport.on('data', bytes => output.push(bytes));
  const failed = once(transport, 'error'); socket.push(frame([0x30, 0xff, 0x7f]));
  assert.equal((await failed)[0].code, 'MQTT_FRAME_TOO_LARGE'); await flush();
  assert.equal(disposed, true); assert.deepEqual(output, []); assert.deepEqual(outbound, []);
});

test('transport honors outbound write backpressure and tears down a partially delivered broker header', async () => {
  let pendingWrite, destroyed = false;
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { pendingWrite = callback; },
    destroy(error, callback) { destroyed = true; callback(error); } });
  const transport = createMQTTWireTransport(socket); transport.on('error', () => {});
  let wrote = false; transport.write(Buffer.from('synthetic-CONNECT'), () => { wrote = true; });
  await flush(); assert.equal(wrote, false); pendingWrite(); await flush(); assert.equal(wrote, true);
  socket.push(frame([0x30, 0x80])); transport.destroy(); await once(transport, 'close'); assert.equal(destroyed, true);
});

test('downstream parser backpressure also bounds the transport wrapper, including later readable events', async () => {
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
  const transport = createMQTTWireTransport(socket); transport.on('error', () => {});
  const expected = Buffer.concat([frame([0x30, 0xfd, 0x07]), Buffer.alloc(1021)]);
  for (let n = 0; n < 100; n++) socket.push(expected);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(transport.readableLength <= 2048); // At most a bounded coalesced pair, never all queued broker frames.
  transport.destroy(); await once(transport, 'close'); assert.equal(socket.destroyed, true);
});

// Native TLS loopback fixtures generate a CA and signed leaf in memory. They do not contact household devices.
function caAndLeaf() {
  const rootKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag, ...parts) => {
    const bytes = Buffer.concat(parts), lengths = []; let size = bytes.length;
    do { lengths.unshift(size & 255); size >>>= 8; } while (size);
    return Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | lengths.length, ...lengths])]), bytes]);
  };
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = text => der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from(text)))));
  const time = value => der(0x17, Buffer.from(new Date(value).toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const rootName = name('MQTT fixture CA'), validity = der(0x30, time(Date.now() - 86400000), time(Date.now() + 86400000));
  const encode = raw => ['-----BEGIN CERTIFICATE-----', ...raw.toString('base64').match(/.{1,64}/g), '-----END CERTIFICATE-----', ''].join('\n');
  const leaf = () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const extensions = der(0xa3, der(0x30,
      der(0x30, Buffer.from('0603551d11', 'hex'), der(4, der(0x30, der(0x87, Buffer.from([127, 0, 0, 1]))))),
      der(0x30, Buffer.from('0603551d13', 'hex'), der(1, Buffer.from([255])), der(4, der(0x30)))));
    const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([2])), algorithm, rootName, validity,
      name('MQTT fixture leaf'), keys.publicKey.export({ type: 'spki', format: 'der' }), extensions);
    const raw = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, rootKeys.privateKey)));
    return { cert: encode(raw), key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      pin: createHash('sha256').update(raw).digest('hex') };
  };
  return { leaf };
}

async function nativeBroker(t, identity) {
  const received = [], sockets = new Set();
  const server = tls.createServer({ ...identity, minVersion: 'TLSv1.2' }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', bytes => { received.push(Buffer.from(bytes)); socket.write(frame([0x20, 3, 0, 0, 0])); });
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { received, port: server.address().port };
}

test('native TLS accepts an explicitly pinned CA-signed leaf with normal verification and sends no CONNECT on substitution', async t => {
  const authority = caAndLeaf(), selected = authority.leaf(), replacement = authority.leaf();
  const good = await nativeBroker(t, selected);
  const config = { host: '127.0.0.1', port: good.port, certificatePem: selected.cert, certificatePin: selected.pin,
    topic: 'fixture/sensor', measurement: 'temperatureC', username: 'synthetic-user', password: 'synthetic-password' };
  const stream = createMQTTTLSStream(config); stream.on('error', () => {});
  t.after(() => stream.destroy());
  const response = once(stream, 'data'); stream.write(Buffer.from('synthetic-CONNECT-credentials'));
  assert.deepEqual((await response)[0], frame([0x20, 3, 0, 0, 0]));
  assert.equal(Buffer.concat(good.received).toString(), 'synthetic-CONNECT-credentials'); stream.destroy();
  const wrong = await nativeBroker(t, replacement), rejected = createMQTTTLSStream({ ...config, port: wrong.port });
  t.after(() => rejected.destroy()); const error = once(rejected, 'error');
  rejected.write(Buffer.from('synthetic-CONNECT-credentials'), () => {});
  await error; await flush(); assert.deepEqual(wrong.received, []);
});
