import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MQTTTLSAdapter, createMQTTTLSChecker } from '../lib/adapters/mqtt-tls.mjs';

function identity() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag, ...parts) => {
    const bytes = Buffer.concat(parts), lengths = []; let size = bytes.length;
    do { lengths.unshift(size & 255); size >>>= 8; } while (size);
    return Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | lengths.length, ...lengths])]), bytes]);
  };
  const algorithm = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('MQTT offline fixture')))));
  const time = value => der(0x17, Buffer.from(new Date(value).toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const san = der(0xa3, der(0x30, der(0x30, Buffer.from('0603551d11', 'hex'), der(4, der(0x30, der(0x87, Buffer.from([127, 0, 0, 1])))))));
  const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    der(0x30, time(Date.now() - 86400000), time(Date.now() + 86400000)), name, keys.publicKey.export({ type: 'spki', format: 'der' }), san);
  const raw = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, keys.privateKey)));
  const certificatePem = ['-----BEGIN CERTIFICATE-----', ...raw.toString('base64').match(/.{1,64}/g), '-----END CERTIFICATE-----', ''].join('\n');
  return { certificatePem, certificatePin: createHash('sha256').update(raw).digest('hex'), raw };
}
const certificate = identity();
const config = (extra = {}) => ({ host: '127.0.0.1', port: 8883, certificatePem: certificate.certificatePem,
  certificatePin: certificate.certificatePin, topic: 'fixture/private-sensor', measurement: 'temperatureC',
  username: 'synthetic-user', password: 'synthetic-password', ...extra });
const peer = raw => ({ raw, subjectaltname: 'IP Address:127.0.0.1', subject: { CN: 'MQTT offline fixture' } });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function factory({ autoConnect = true, ack = true, cleanup = true, certificateRaw = certificate.raw } = {}) {
  const clients = [], settings = [], subscriptions = [], writes = [];
  const connectFactory = options => {
    settings.push(options);
    const client = new EventEmitter(); clients.push(client); client.ended = 0; client.destroyed = 0;
    client.stream = { destroy() { client.destroyed++; } };
    client.subscribe = (topic, subscriptionOptions, callback) => {
      subscriptions.push({ topic, options: subscriptionOptions });
      if (ack) queueMicrotask(() => callback(null, [{ topic, qos: 0 }]));
    };
    client.publish = () => { writes.push('PUBLISH'); throw new Error('publishing must not occur'); };
    client.end = (force, endOptions, callback) => { client.ended++; assert.equal(force, true); if (cleanup) queueMicrotask(callback); };
    if (autoConnect) queueMicrotask(() => {
      const error = options.checkServerIdentity(options.host, peer(certificateRaw));
      if (error) client.emit('error', error);
      else { writes.push('CONNECT'); client.emit('connect'); }
    });
    return client;
  };
  return { connectFactory, clients, settings, subscriptions, writes };
}

test('constructors, listener registration and rejected actions stay inert and expose no credentials', async () => {
  const f = factory(), adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: f.connectFactory });
  const cancel = adapter.subscribe(() => {});
  assert.deepEqual(adapter.supportedActions, []); assert.ok(Object.isFrozen(adapter.supportedActions));
  assert.equal(f.clients.length, 0);
  await assert.rejects(adapter.execute({ action: 'mqtt.publish', args: { topic: 'other', payload: '1' } }), { code: 'UNSUPPORTED_ACTION' });
  assert.equal(f.writes.length, 0);
  assert.equal(JSON.stringify(adapter).includes('synthetic-user'), false);
  cancel(); await adapter.close();
  await assert.rejects(adapter.start(), { code: 'ADAPTER_CLOSED' });
});

test('adapter and start options reject accessors/proxies and arbitrary transport overrides without invoking getters', async () => {
  let reads = 0;
  const accessor = { deviceId: 'fixture-sensor' };
  Object.defineProperty(accessor, 'config', { enumerable: true, get() { reads++; return config(); } });
  for (const value of [accessor, new Proxy({}, { get() { reads++; }, getPrototypeOf() { reads++; } }),
    { deviceId: 'fixture-sensor', config: config(), publish: () => {} }]) {
    assert.throws(() => new MQTTTLSAdapter(value), { code: 'INVALID_CONFIG' });
  }
  const adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: factory().connectFactory });
  await assert.rejects(adapter.start({ server: 'other' }), { code: 'INVALID_CONFIG' });
  const startOptions = {}; Object.defineProperty(startOptions, 'pollMs', { enumerable: true, get() { reads++; return 1000; } });
  await assert.rejects(adapter.start(startOptions), { code: 'INVALID_CONFIG' });
  assert.equal(reads, 0); await adapter.close();
});

test('TLS trust, pin, validity and hostname are required before MQTT CONNECT credentials can be sent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const checker = createMQTTTLSChecker(config());
  assert.equal(checker('127.0.0.1', peer(certificate.raw)), undefined);
  assert.equal(checker('127.0.0.2', peer(certificate.raw)).code, 'TLS_CERTIFICATE_INVALID');
  // Hostname checks derive from authenticated DER, never caller-supplied textual certificate fields.
  assert.equal(checker('127.0.0.1', { ...peer(certificate.raw), subjectaltname: 'IP Address:127.0.0.2' }), undefined);
  let reads = 0; const accessor = {};
  Object.defineProperty(accessor, 'raw', { get() { reads++; return certificate.raw; } });
  assert.equal(checker('127.0.0.1', accessor).code, 'TLS_CERTIFICATE_INVALID'); assert.equal(reads, 0);
  const f = factory({ certificateRaw: identity().raw });
  const adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: f.connectFactory });
  await assert.rejects(adapter.start(), { code: 'TLS_PIN_MISMATCH' });
  assert.deepEqual(f.writes, []); assert.deepEqual(f.subscriptions, []);
  assert.equal(f.settings[0].rejectUnauthorized, true); assert.equal(f.settings[0].minVersion, 'TLSv1.2');
  assert.equal(f.settings[0].allowPartialTrustChain, true);
  assert.equal(f.settings[0].ca, certificate.certificatePem);
  t.mock.timers.tick(60000); await flush(); assert.equal(f.clients.length, 1); // Changed trust never retries automatically.
  await adapter.close();
});

test('one exact QoS0 subscription projects finite readings with fixed receipt TTL and no topic or identifiers', async () => {
  const f = factory(), events = [];
  const adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: f.connectFactory });
  adapter.subscribe(event => events.push(event));
  const first = adapter.start(), second = adapter.start(); assert.equal(first, second); await first;
  assert.equal(f.clients.length, 1);
  assert.deepEqual(f.subscriptions, [{ topic: config().topic, options: { qos: 0, nl: true, rap: true, rh: 2 } }]);
  const settings = f.settings[0];
  assert.equal(settings.protocol, 'mqtts'); assert.equal(settings.host, config().host); assert.equal(settings.port, 8883);
  assert.equal(settings.reconnectPeriod, 0); assert.equal(settings.resubscribe, false); assert.equal(settings.queueQoSZero, false);
  assert.equal(settings.protocolVersion, 5); assert.equal(settings.properties.maximumPacketSize, 1024);
  f.clients[0].emit('message', config().topic, Buffer.from('23.5'), { retain: false });
  const snapshot = adapter.snapshot(), cell = snapshot.fields.temperatureC;
  assert.equal(cell.value, 23.5); assert.equal(cell.source, 'mqtt-tls'); assert.equal(cell.verification, 'broker-reported');
  assert.equal(Date.parse(cell.expiresAt) - Date.parse(cell.observedAt), 60000);
  for (const text of [JSON.stringify(snapshot), JSON.stringify(events), JSON.stringify(adapter)]) {
    for (const forbidden of [config().topic, config().host, config().username, config().password, config().certificatePin, 'clientId']) assert.equal(text.includes(forbidden), false);
  }
  assert.deepEqual(f.writes, ['CONNECT']); await adapter.close();
});

test('retained, oversized, malformed, nonfinite, out-of-range and wrong-topic telemetry cannot replace or freshen a reading', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = factory(), adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: f.connectFactory });
  await adapter.start(); const client = f.clients[0];
  client.emit('message', config().topic, Buffer.from('20'), { retain: false });
  const original = adapter.snapshot().fields.temperatureC;
  t.mock.timers.tick(61000);
  for (const payload of ['NaN', 'Infinity', '1e999', '151', '-101', '{}', '[1]', '"21"', '+1', '01', '', 'x'.repeat(257)]) {
    client.emit('message', config().topic, Buffer.from(payload), { retain: false });
  }
  client.emit('message', config().topic, Buffer.from([0xff]), { retain: false });
  client.emit('message', config().topic, Buffer.from('25'), { retain: true });
  client.emit('message', config().topic, Buffer.from('25'), {});
  client.emit('message', 'fixture/other', Buffer.from('25'), { retain: false });
  client.emit('message', config().topic, '25', { retain: false });
  assert.deepEqual(adapter.snapshot().fields.temperatureC, original);
  assert.ok(Date.parse(original.expiresAt) < Date.now()); await adapter.close();
});

test('all fixed measurement boundaries are enforced without interpreting JSON objects or arbitrary fields', async () => {
  for (const [measurement, valid, invalid] of [['humidityPercent', '100', '101'], ['co2Ppm', '400', '-1'], ['pm25UgM3', '12', '-1'],
    ['illuminanceLux', '500', '1000001'], ['powerWatts', '-5', '10000001'], ['energyKwh', '4.5', '-1']]) {
    const f = factory(), selected = config({ measurement });
    const adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: selected, connectFactory: f.connectFactory });
    await adapter.start(); f.clients[0].emit('message', selected.topic, Buffer.from(valid), { retain: false });
    assert.equal(adapter.snapshot().fields[measurement].value, Number(valid));
    f.clients[0].emit('message', selected.topic, Buffer.from(invalid), { retain: false });
    assert.equal(adapter.snapshot().fields[measurement].value, Number(valid)); await adapter.close();
  }
});

test('disconnect expires cached evidence, reconnects once per backoff and ignores old-session/after-close events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const f = factory(), events = [], adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: f.connectFactory });
  adapter.subscribe(event => events.push(event)); await adapter.start();
  const old = f.clients[0]; old.emit('message', config().topic, Buffer.from('20'), { retain: false }); old.emit('close');
  await flush(); // Backoff begins only after the previous SDK cleanup acknowledges completion.
  assert.equal(adapter.snapshot().fields.temperatureC.expiresAt, new Date(0).toISOString());
  t.mock.timers.tick(999); await flush(); assert.equal(f.clients.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(f.clients.length, 2); assert.equal(f.subscriptions.length, 2);
  old.emit('message', config().topic, Buffer.from('80'), { retain: false });
  f.clients[1].emit('message', config().topic, Buffer.from('21'), { retain: false });
  assert.equal(adapter.snapshot().fields.temperatureC.value, 21);
  await adapter.close(); const count = events.length;
  f.clients[1].emit('message', config().topic, Buffer.from('22'), { retain: false }); f.clients[1].emit('close');
  t.mock.timers.tick(60000); await flush();
  assert.equal(events.length, count); assert.equal(f.clients.length, 2); assert.equal(adapter.snapshot().connection.phase, 'closed');
});

test('missing CONNACK/subscription acknowledgement and stuck cleanup are bounded; close settles an in-flight start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const f = factory({ ack: false, cleanup: false });
  const adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: f.connectFactory });
  const pending = adapter.start(); const rejected = assert.rejects(pending, { code: 'MQTT_CONNECTION_TIMEOUT' });
  await flush(); t.mock.timers.tick(5000); await rejected;
  const closing = adapter.close(); assert.equal(adapter.close(), closing);
  const incomplete = assert.rejects(closing, { code: 'MQTT_CLEANUP_INCOMPLETE' }); t.mock.timers.tick(500); await incomplete;
  assert.equal(f.clients[0].destroyed, 1);
  assert.equal(adapter.snapshot().connection.phase, 'cleanup-incomplete');
  t.mock.timers.tick(60000); await flush(); assert.equal(f.clients.length, 1);
  const g = factory({ autoConnect: false });
  const other = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: g.connectFactory });
  const start = other.start(), denied = assert.rejects(start, { code: 'ADAPTER_CLOSED' });
  await other.close(); await denied;
});

test('consecutive read-only reconnection failures stop after five bounded backoff attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const f = factory({ autoConnect: false }), adapter = new MQTTTLSAdapter({ deviceId: 'fixture-sensor', config: config(), connectFactory: f.connectFactory });
  const first = assert.rejects(adapter.start(), { code: 'MQTT_CONNECTION_TIMEOUT' });
  t.mock.timers.tick(5000); await first; await flush();
  for (const backoff of [1000, 2000, 4000, 8000, 16000]) {
    t.mock.timers.tick(backoff); await flush(); t.mock.timers.tick(5000); await flush();
  }
  assert.equal(f.clients.length, 6); t.mock.timers.tick(300000); await flush(); assert.equal(f.clients.length, 6);
  await adapter.close(); assert.deepEqual(f.writes, []);
});

test('SDK absence leaves imports and construction inert; only explicit start reports the optional dependency', async () => {
  const loader = 'data:text/javascript,' + encodeURIComponent("export async function resolve(name,context,next){ if(name==='mqtt'){ const e=new Error('blocked fixture');e.code='ERR_MODULE_NOT_FOUND';throw e;} return next(name,context); }");
  const source = `import assert from 'node:assert/strict'; import {MQTTTLSAdapter} from ${JSON.stringify(new URL('../lib/adapters/mqtt-tls.mjs', import.meta.url).href)};
    const adapter=new MQTTTLSAdapter({deviceId:'fixture-sensor',config:${JSON.stringify(config())}});
    assert.deepEqual(adapter.supportedActions,[]); await assert.rejects(adapter.start(),{code:'ADAPTER_DEPENDENCY_MISSING'}); await adapter.close();`;
  await promisify(execFile)(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', source],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
});

test('debug environment fails before SDK import or any injected factory without changing globals or leaking credentials', async () => {
  const loader = 'data:text/javascript,' + encodeURIComponent("export async function resolve(name,context,next){ if(name==='mqtt'){throw new Error('SDK MUST NOT LOAD');} return next(name,context); }");
  for (const [key, value] of [['DEBUG', '*'], ['NODE_DEBUG', 'mqtt-fixture'], ['NODE_DEBUG_NATIVE', 'MQTT_FIXTURE']]) {
    const source = `import assert from 'node:assert/strict'; import {MQTTTLSAdapter} from ${JSON.stringify(new URL('../lib/adapters/mqtt-tls.mjs', import.meta.url).href)};
      const config=${JSON.stringify(config())}; let factories=0;
      const fixture=new MQTTTLSAdapter({deviceId:'fixture-sensor',config,connectFactory(){factories++;console.error(config.username,config.password,config.topic);}});
      await assert.rejects(fixture.start(),{code:'MQTT_DEBUG_ENABLED'}); assert.equal(factories,0); await fixture.close();
      const production=new MQTTTLSAdapter({deviceId:'fixture-sensor',config});
      await assert.rejects(production.start(),{code:'MQTT_DEBUG_ENABLED'});await production.close();
      assert.equal(process.env[${JSON.stringify(key)}],${JSON.stringify(value)});`;
    const result = await promisify(execFile)(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', source], {
      windowsHide: true, timeout: 15000, maxBuffer: 65536,
      env: { ...process.env, DEBUG: '', NODE_DEBUG: '', NODE_DEBUG_NATIVE: '', [key]: value },
    });
    for (const secret of [config().username, config().password, config().topic]) assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stdout, '');
  }
});

test('debug logging enabled later is checked again before reconnect factory invocation', async () => {
  const source = `import assert from 'node:assert/strict';import {mock}from'node:test';import{EventEmitter}from'node:events';
    import{MQTTTLSAdapter}from ${JSON.stringify(new URL('../lib/adapters/mqtt-tls.mjs', import.meta.url).href)};
    mock.timers.enable({apis:['setTimeout']});let calls=0,client;
    const adapter=new MQTTTLSAdapter({deviceId:'fixture-sensor',config:${JSON.stringify(config())},connectFactory(){
      calls++;client=new EventEmitter();client.subscribe=(topic,opts,cb)=>cb(null,[{topic,qos:0}]);client.end=(force,opts,cb)=>cb();
      queueMicrotask(()=>client.emit('connect'));return client;}});
    await adapter.start();process.env.DEBUG='*';client.emit('close');for(let n=0;n<8;n++)await Promise.resolve();
    mock.timers.tick(1000);for(let n=0;n<8;n++)await Promise.resolve();assert.equal(calls,1);await adapter.close();mock.timers.reset();`;
  const result = await promisify(execFile)(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], {
    windowsHide: true, timeout: 15000, maxBuffer: 65536, env: { ...process.env, DEBUG: '', NODE_DEBUG: '', NODE_DEBUG_NATIVE: '' },
  });
  for (const secret of [config().username, config().password, config().topic]) assert.equal(result.stderr.includes(secret), false);
});
