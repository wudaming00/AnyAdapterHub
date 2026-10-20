import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeHub, addHubDevice, loadHubConfig, readJson, setAdapterEnabled, setDeviceFeatures } from '../lib/hub/config.mjs';
import { createAdapter, loadAdapterConfig } from '../lib/hub/adapters.mjs';
import { HomeAssistantAdapter } from '../lib/adapters/home-assistant.mjs';
import { protectHomeAssistantConfig } from '../lib/adapters/home-assistant-config.mjs';
import { protectMQTTConfig } from '../lib/adapters/mqtt-config.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';
import { HubStore } from '../lib/hub/store.mjs';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OWNER_TOKEN = 'fixture_owner_abcdefghijklmnopqrstuvwxyz_123456';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-popular-integration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const secretStore = testSecretStore(), identity = await testIdentity(secretStore);
  const ha = { origin: 'https://127.0.0.1:8123', certificate: identity.certificate, certificatePin: identity.certificatePin,
    entityId: 'light.private_fixture_entity', token: 'fixture_ha_private_token_abcdefghijklmnopqrstuvwxyz' };
  const mqtt = { host: '127.0.0.1', port: 8883, certificatePem: identity.certificate, certificatePin: identity.certificatePin,
    topic: 'private-fixture/sensors/temperature', measurement: 'temperatureC', username: 'fixture-mqtt-private-user', password: 'fixture-mqtt-private-password' };
  const haPath = path.join(directory, 'ha-fixture.json'), mqttPath = path.join(directory, 'mqtt-fixture.json');
  await writeFile(haPath, JSON.stringify(await protectHomeAssistantConfig(ha, { secretStore })), { mode: 0o600 });
  await writeFile(mqttPath, JSON.stringify(await protectMQTTConfig(mqtt, { secretStore })), { mode: 0o600 });
  return { directory, home: path.join(directory, 'hub'), secretStore, identity, ha, mqtt, haPath, mqttPath };
}

test('generic HA initialization and MQTT addition retain encrypted config references and independent feature gates', async t => {
  const f = await fixture(t);
  const initialized = await initializeHub({ home: f.home, adapterName: 'home-assistant', configPath: f.haPath,
    id: 'light-a', secretStore: f.secretStore, identity: f.identity });
  assert.equal(initialized.deviceId, 'light-a');
  let loaded = await loadHubConfig(f.home, { secretStore: f.secretStore });
  assert.equal(loaded.devices[0].adapterName, 'home-assistant');
  assert.equal(loaded.devices[0].config.token, f.ha.token); assert.deepEqual(loaded.devices[0].features, []);
  const readonly = await createAdapter({ adapterName: loaded.devices[0].adapterName, id: loaded.devices[0].id,
    config: loaded.devices[0].config, features: loaded.devices[0].features });
  t.after(() => readonly.close()); assert.deepEqual(readonly.supportedActions, []);

  await assert.rejects(setDeviceFeatures(f.home, 'light-a', ['dimming'], { secretStore: f.secretStore }), { code: 'INVALID_FEATURES' });
  await setDeviceFeatures(f.home, 'light-a', ['control'], { secretStore: f.secretStore });
  await assert.rejects(addHubDevice({ home: f.home, adapterName: 'mqtt-tls', configPath: f.mqttPath, id: 'sensor-a',
    features: ['control'], secretStore: f.secretStore }), { code: 'INVALID_FEATURES' });
  await addHubDevice({ home: f.home, adapterName: 'mqtt-tls', configPath: f.mqttPath, id: 'sensor-a', secretStore: f.secretStore });
  loaded = await loadHubConfig(f.home, { secretStore: f.secretStore });
  assert.deepEqual(loaded.devices.map(device => [device.id, device.adapterName, device.features]),
    [['light-a', 'home-assistant', ['control']], ['sensor-a', 'mqtt-tls', []]]);
  assert.equal(loaded.devices[1].config.password, f.mqtt.password);
  const power = await createAdapter({ adapterName: 'home-assistant', id: 'light-a', config: loaded.devices[0].config, features: loaded.devices[0].features });
  const sensor = await createAdapter({ adapterName: 'mqtt-tls', id: 'sensor-a', config: loaded.devices[1].config });
  t.after(() => power.close()); t.after(() => sensor.close());
  assert.deepEqual(power.supportedActions, ['light.power.set']); assert.deepEqual(sensor.supportedActions, []);

  const registry = await readJson(path.join(f.home, 'hub.json'));
  assert.deepEqual(registry.adapters, ['home-assistant', 'mqtt-tls']);
  assert.deepEqual(registry.devices.map(device => device.configPath), [f.haPath, f.mqttPath]);
  const serialized = JSON.stringify(registry);
  for (const value of [f.ha.token, f.ha.entityId, f.mqtt.topic, f.mqtt.username, f.mqtt.password, f.identity.certificatePin]) assert.equal(serialized.includes(value), false);
  assert.equal((await readFile(f.haPath, 'utf8')).includes(f.ha.token), false);
  assert.equal((await readFile(f.mqttPath, 'utf8')).includes(f.mqtt.password), false);
});

test('generic MQTT initialization and HA addition load their own credentials and reject target overrides', async t => {
  const f = await fixture(t);
  await initializeHub({ home: f.home, adapterName: 'mqtt-tls', configPath: f.mqttPath,
    id: 'sensor-a', secretStore: f.secretStore, identity: f.identity });
  await addHubDevice({ home: f.home, adapterName: 'home-assistant', configPath: f.haPath, id: 'light-a',
    features: ['control', 'dimming'], secretStore: f.secretStore });
  const loaded = await loadHubConfig(f.home, { secretStore: f.secretStore });
  assert.deepEqual(loaded.devices.map(device => device.adapterName), ['mqtt-tls', 'home-assistant']);
  assert.equal(loaded.devices[0].config.topic, f.mqtt.topic); assert.equal(loaded.devices[1].config.entityId, f.ha.entityId);
  for (const [adapterName, configPath] of [['home-assistant', f.haPath], ['mqtt-tls', f.mqttPath]]) {
    await assert.rejects(loadAdapterConfig(adapterName, { configPath, host: '127.0.0.2', secretStore: f.secretStore }), { code: 'INVALID_CONFIG' });
  }
  await setAdapterEnabled(f.home, 'mqtt-tls', false, { secretStore: f.secretStore });
  assert.deepEqual((await loadHubConfig(f.home, { secretStore: f.secretStore })).devices.map(device => device.id), ['light-a']);
  const registry = await readJson(path.join(f.home, 'hub.json'));
  assert.equal(registry.devices.length, 2);
});

test('empty core and disabled MQTT/HA registrations load without importing adapter code, config loaders or the MQTT SDK', async t => {
  const f = await fixture(t), loader = path.join(f.directory, 'block-popular-loader.mjs');
  await writeFile(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'mqtt' || /(?:home-assistant(?:-config)?|mqtt-(?:tls|config))\\.mjs$/.test(specifier)) {
      const error = new Error('Disabled integration must remain unloaded'); error.code = 'ERR_MODULE_NOT_FOUND'; throw error;
    }
    return nextResolve(specifier, context);
  }`);
  const source = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { initializeHub, loadHubConfig, readJson, writePrivateJson } from './lib/hub/config.mjs';
    import { adapterMetadata } from './lib/hub/adapters.mjs';
    import { testSecretStore, testIdentity } from './test/helpers/secrets.mjs';
    const home = process.argv[1], secretStore = testSecretStore(), identity = await testIdentity(secretStore);
    assert.ok(adapterMetadata().some(item => item.id === 'mqtt-tls'));
    await initializeHub({home,secretStore,identity});
    assert.deepEqual((await loadHubConfig(home,{secretStore})).devices, []);
    const registry = await readJson(path.join(home,'hub.json'));
    registry.devices = ['mqtt-tls','home-assistant'].map((adapter,index) => ({id:'disabled-'+index,label:'Disabled fixture',adapter,
      configPath:path.join(path.dirname(home),'does-not-exist-'+index+'.json'),features:[]}));
    await writePrivateJson(path.join(home,'hub.json'),registry,{exclusive:false,secretStore});
    assert.deepEqual((await loadHubConfig(home,{secretStore})).devices, []);
    console.log('EMPTY_DISABLED_NO_OPTIONAL_IMPORT_OK');
  `;
  const result = await run(process.execPath, ['--no-warnings', '--experimental-loader', pathToFileURL(loader).href,
    '--input-type=module', '-e', source, path.join(f.directory, 'child-hub')],
  { cwd: ROOT, windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 });
  assert.match(result.stdout, /EMPTY_DISABLED_NO_OPTIONAL_IMPORT_OK/);
});

test('HubRuntime accepts explicit empty capabilities from actual read-only HA and MQTT adapters', async t => {
  const f = await fixture(t);
  const ha = await createAdapter({ adapterName: 'home-assistant', id: 'light-a', config: f.ha });
  const mqtt = await createAdapter({ adapterName: 'mqtt-tls', id: 'sensor-a', config: f.mqtt });
  t.after(() => ha.close()); t.after(() => mqtt.close());
  const store = new HubStore({ filePath: ':memory:' });
  t.after(() => store.close());
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(OWNER_TOKEN), devices: [
    { id: 'light-a', label: 'Read-only light', adapterName: 'home-assistant', adapter: ha, config: f.ha },
    { id: 'sensor-a', label: 'Read-only sensor', adapterName: 'mqtt-tls', adapter: mqtt, config: f.mqtt },
  ] });
  t.after(() => runtime.close());
  const owner = runtime.authenticate(OWNER_TOKEN);
  assert.deepEqual(runtime.capabilities(owner, 'light-a').actions, {});
  assert.deepEqual(runtime.capabilities(owner, 'sensor-a').actions, {});
  assert.deepEqual(runtime.listDevices(owner).map(device => device.id), ['light-a', 'sensor-a']);
  assert.throws(() => runtime.issueGrant(owner, { label: 'Denied write', deviceIds: ['sensor-a'], capabilities: ['light.power.set'],
    expiresAt: new Date(Date.now() + 60000).toISOString() }), { code: 'INVALID_ARGUMENTS' });
});

async function runtimeFixture(t, { onPost, onRead, timeoutMs = 8000 } = {}) {
  const f = await fixture(t); let writes = 0;
  const make = (deviceId, entityId, features) => {
    let on = false;
    return new HomeAssistantAdapter({ deviceId, config: { ...f.ha, entityId, timeoutMs }, features, request: async options => {
      if (options.method === 'POST') {
        await onPost?.(); options.beforeDispatch(); writes += 1; on = options.path.endsWith('/turn_on'); return [];
      }
      options.beforeDispatch();
      await onRead?.();
      return { entity_id: entityId, state: on ? 'on' : 'off', attributes: { brightness: on ? 255 : 0,
        supported_color_modes: ['brightness'], friendly_name: 'private-source-name', token: f.ha.token, extra: { topic: f.mqtt.topic } },
      context: { user_id: 'private-user-context' } };
    } });
  };
  const devices = [
    { id: 'light-a', label: 'Fixture light A', adapterName: 'home-assistant', adapter: make('light-a', f.ha.entityId, ['control']), config: f.ha },
    { id: 'light-b', label: 'Fixture light B', adapterName: 'home-assistant', adapter: make('light-b', 'light.private_second_entity', ['control', 'dimming']), config: { ...f.ha, entityId: 'light.private_second_entity' } },
  ];
  const store = new HubStore({ filePath: ':memory:' });
  const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(OWNER_TOKEN), devices });
  t.after(() => runtime.close());
  const owner = runtime.authenticate(OWNER_TOKEN);
  await runtime.start();
  const grant = (deviceIds, capabilities) => {
    const issued = runtime.issueGrant(owner, { label: 'Fixture scoped client', deviceIds, capabilities,
      expiresAt: new Date(Date.now() + 60000).toISOString() });
    return { ...issued, principal: runtime.authenticate(issued.token) };
  };
  return { ...f, runtime, store, owner, grant, writes: () => writes };
}

test('Hub grants cannot cross selected devices or add capabilities unsupported by that exact adapter', async t => {
  const f = await runtimeFixture(t);
  const one = f.grant(['light-a'], ['state.read', 'events.read', 'light.power.set']);
  assert.deepEqual(f.runtime.listDevices(one.principal).map(device => device.id), ['light-a']);
  assert.deepEqual(Object.keys(f.runtime.capabilities(one.principal, 'light-a').actions), ['light.power.set']);
  assert.throws(() => f.runtime.state(one.principal, 'light-b'), { code: 'ACCESS_DENIED' });
  assert.throws(() => f.runtime.submit(one.principal, 'light-b', { action: 'light.power.set', args: { on: true }, idempotencyKey: 'cross-device' }), { code: 'ACCESS_DENIED' });
  const both = f.grant(['light-a', 'light-b'], ['state.read', 'events.read', 'light.power.set', 'light.brightness.set']);
  assert.throws(() => f.runtime.submit(both.principal, 'light-a', { action: 'light.brightness.set', args: { brightness: 50 }, idempotencyKey: 'unsupported-brightness' }), { code: 'UNKNOWN_ACTION' });
  assert.equal(f.writes(), 0);
  const created = f.runtime.submit(one.principal, 'light-a', { action: 'light.power.set', args: { on: true }, idempotencyKey: 'valid-power' });
  const result = await f.runtime.wait(one.principal, created.operation.id, { timeoutMs: 2000 });
  assert.equal(result.state, 'confirmed'); assert.equal(result.result.physicalEffectVerified, false); assert.equal(f.writes(), 1);
  const existing = f.runtime.submit(one.principal, 'light-a', { action: 'light.power.set', args: { on: true }, idempotencyKey: 'valid-power' });
  assert.equal(existing.created, false); assert.equal(existing.operation.id, created.operation.id); assert.equal(f.writes(), 1);
});

test('Hub grant revocation during actual HA pre-dispatch wait cancels the operation without a mutation', async t => {
  const entered = deferred(), gate = deferred();
  const f = await runtimeFixture(t, { onPost: async () => { entered.resolve(); await gate.promise; } });
  t.after(() => gate.resolve());
  const client = f.grant(['light-a'], ['state.read', 'events.read', 'light.power.set']);
  const { operation } = f.runtime.submit(client.principal, 'light-a', { action: 'light.power.set', args: { on: true }, idempotencyKey: 'revoke-before-post' });
  await entered.promise; f.runtime.revokeGrant(f.owner, client.grant.id); gate.resolve();
  const result = await f.runtime.wait(f.owner, operation.id, { timeoutMs: 2000 });
  assert.equal(result.state, 'cancelled'); assert.equal(result.error.code, 'GRANT_REVOKED'); assert.equal(f.writes(), 0);
});

test('runtime state, filtered events and public operations exclude raw HA target, token and response metadata', async t => {
  const f = await runtimeFixture(t);
  const client = f.grant(['light-a'], ['state.read', 'events.read', 'light.power.set']);
  const { operation } = f.runtime.submit(client.principal, 'light-a', { action: 'light.power.set', args: { on: true }, idempotencyKey: 'privacy' });
  const finished = await f.runtime.wait(client.principal, operation.id, { timeoutMs: 2000 });
  const events = f.runtime.events(client.principal);
  assert.ok(events.length > 0); assert.ok(events.every(event => event.deviceId === 'light-a'));
  const state = f.runtime.state(client.principal, 'light-a');
  assert.equal(state.fields.light.value.power, true); assert.equal(state.fields.light.stale, false);
  const serialized = JSON.stringify([state, events, finished]);
  for (const privateValue of [f.ha.entityId, 'light.private_second_entity', f.ha.origin, f.ha.token, f.ha.certificatePin,
    OWNER_TOKEN, client.token, f.mqtt.topic, f.mqtt.username, f.mqtt.password, 'private-source-name', 'private-user-context']) assert.equal(serialized.includes(privateValue), false);
  assert.equal(Object.hasOwn(finished, 'args'), false);
});

test('HA preflight that expires during POST TLS preparation never reaches Hub dispatch or mutates the light', async t => {
  let now, ageRequests = false;
  const f = await runtimeFixture(t, { timeoutMs: 15000,
    onRead: async () => { if (ageRequests) now += 10000; },
    onPost: async () => { now += 6000; },
  });
  // Generate/validate the fixture certificate before freezing the wall clock;
  // OpenSSL's real notBefore can otherwise cross into the next second.
  now = Date.now(); t.mock.method(Date, 'now', () => now);
  const client = f.grant(['light-a'], ['state.read', 'light.power.set']);
  ageRequests = true;
  const { operation } = f.runtime.submit(client.principal, 'light-a', { action: 'light.power.set', args: { on: true }, idempotencyKey: 'expired-preflight-after-tls' });
  const result = await f.runtime.wait(client.principal, operation.id, { timeoutMs: 2000 });
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'STALE_STATE'); assert.equal(f.writes(), 0);
});
