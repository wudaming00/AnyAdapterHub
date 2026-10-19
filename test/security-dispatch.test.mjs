import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { TVController, wakeTV } from '../lib/tv-controller.mjs';
import { DLNAClient } from '../lib/dlna.mjs';
import { LGWebOSAdapter } from '../lib/adapters/lg-webos.mjs';
import { observeTV, OBSERVER_APP } from '../lib/tv-observer.mjs';

// No network, account, paired television or live local configuration is used.
const HOST = '192.168.77.80';
const APP = 'com.example.video';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const revoked = () => Object.assign(new Error('Grant revoked.'), { code: 'GRANT_REVOKED' });
const ordinary = { id: APP, systemApp: false, privilegedJail: false, defaultWindowType: 'card',
  deeplinkingParams: { content: '$CONTENTID' } };

function fixture({ response, dlnaClient, pointerWebSocketFactory, subscribe } = {}) {
  const calls = [];
  const ssapClient = { registered: false, timeoutMs: 500,
    async connect() { this.registered = true; }, close() { this.registered = false; }, sanitize: value => value,
    async request(uri, payload) { calls.push({ uri, payload }); return response?.(uri, payload) ?? { returnValue: true }; },
    async subscribe(uri, payload, options) { return subscribe?.(options) ?? { unsubscribe() {} }; },
  };
  const controller = new TVController({ host: HOST, ssapClient, dlnaClient, pointerWebSocketFactory });
  const adapter = new LGWebOSAdapter({ deviceId: 'fixture-tv', config: { host: HOST, allowTemporaryObserver: true },
    controllerFactory: () => controller });
  let allowed = true;
  return { adapter, controller, calls, revoke() { allowed = false; }, context: { assertDispatch() { if (!allowed) throw revoked(); } } };
}

for (const action of ['app.launch', 'app.content.launch']) {
  test(`${action}: revocation while app metadata is pending prevents the subsequent launch`, async t => {
    const ready = deferred(), gate = deferred();
    const f = fixture({ response: async uri => {
      if (uri.endsWith('/listApps')) { ready.resolve(); await gate.promise; return { apps: [ordinary] }; }
      return { returnValue: true };
    } });
    t.after(() => f.adapter.close());
    const pending = f.adapter.execute({ action, args: { id: APP, ...(action === 'app.content.launch' ? { content: 'example' } : {}) } }, f.context);
    await ready.promise; f.revoke(); gate.resolve();
    await assert.rejects(pending, { code: 'GRANT_REVOKED' });
    assert.equal(f.calls.some(call => call.uri === 'ssap://system.launcher/launch'), false);
  });
}

test('a deadline that expires during app metadata lookup prevents dispatch', async t => {
  const ready = deferred(), gate = deferred();
  const f = fixture({ response: async uri => {
    if (uri.endsWith('/listApps')) { ready.resolve(); await gate.promise; return { apps: [ordinary] }; }
    return { returnValue: true };
  } });
  t.after(() => f.adapter.close());
  const pending = f.adapter.execute({ action: 'app.launch', args: { id: APP } },
    { deadlineAt: new Date(Date.now() + 50).toISOString(), ...f.context });
  await ready.promise; await delay(65); gate.resolve();
  await assert.rejects(pending, { code: 'DEADLINE_EXCEEDED' });
  assert.equal(f.calls.some(call => call.uri === 'ssap://system.launcher/launch'), false);
});

test('text insertion: waiting for focus does not preserve a revoked grant', async t => {
  let subscription; const ready = deferred();
  const f = fixture({ subscribe(options) { subscription = options; ready.resolve(); return { unsubscribe() {} }; } });
  t.after(() => f.adapter.close());
  const pending = f.adapter.execute({ action: 'text.insert', args: { text: 'fixture text' } }, f.context);
  await ready.promise; await nextTurn(); f.revoke(); subscription.onUpdate({ focus: true });
  await assert.rejects(pending, { code: 'GRANT_REVOKED' });
  assert.equal(f.calls.some(call => call.uri.endsWith('/insertText')), false);
});

test('pointer: revocation during the WebSocket handshake prevents the button frame', async t => {
  let socket; const ready = deferred(); const frames = [];
  const f = fixture({ response: () => ({ socketPath: `ws://${HOST}:3000/pointer` }), pointerWebSocketFactory() {
    socket = new EventEmitter(); Object.assign(socket, { readyState: 0,
      send(frame, done) { frames.push(frame); done(); }, terminate() { this.readyState = 3; this.emit('close'); } });
    ready.resolve(); return socket;
  } });
  t.after(() => f.adapter.close());
  const pending = f.adapter.execute({ action: 'navigation.key', args: { key: 'ENTER' } }, f.context);
  await ready.promise; f.revoke(); socket.readyState = 1; socket.emit('open');
  await assert.rejects(pending, { code: 'GRANT_REVOKED' });
  assert.deepEqual(frames, []);
});

test('DLNA: revocation during discovery prevents a subsequent mutation', async t => {
  const ready = deferred(), gate = deferred(); const writes = [];
  const f = fixture({ dlnaClient: { async connect() { ready.resolve(); await gate.promise; }, close() {},
    async play(...args) { writes.push(args); return { confirmed: true }; } } });
  t.after(() => f.adapter.close());
  const pending = f.adapter.execute({ action: 'dlna.play', args: { url: 'https://example.com/fixture.mp4', mimeType: 'video/mp4' } }, f.context);
  await ready.promise; f.revoke(); gate.resolve();
  await assert.rejects(pending, { code: 'GRANT_REVOKED' });
  assert.deepEqual(writes, []);
});

test('DLNA multi-step playback rechecks before Play after SetAVTransportURI returns', async () => {
  let allowed = true; const writes = [];
  const type = 'urn:schemas-upnp-org:service:AVTransport:1';
  const inputs = names => names.map(name => ({ name, direction: 'in' }));
  const client = new DLNAClient({ host: HOST, service: { serviceType: type, controlURL: `http://${HOST}:1234/control`, actions: [
    { name: 'GetTransportInfo', arguments: inputs(['InstanceID']) },
    { name: 'SetAVTransportURI', arguments: inputs(['InstanceID', 'CurrentURI', 'CurrentURIMetaData']) },
    { name: 'Play', arguments: inputs(['InstanceID', 'Speed']) },
  ] }, localHttpFn: async (_url, request) => {
    const action = request.headers.SOAPAction.match(/#(\w+)"$/)[1]; writes.push(action); allowed = false;
    return { status: 200, body: `<u:${action}Response xmlns:u="${type}"/>` };
  } });
  await client.connect();
  await assert.rejects(client.play('https://example.com/fixture.mp4', { mimeType: 'video/mp4',
    assertDispatch() { if (!allowed) throw revoked(); } }), { code: 'GRANT_REVOKED' });
  assert.deepEqual(writes, ['SetAVTransportURI']);
  client.close();
});

test('wake: authorization is rechecked after UDP bind before sending the magic packet', async () => {
  let bound; let closed = false; let writes = 0; let allowed = true;
  const socket = new EventEmitter(); Object.assign(socket, { bind(_port, _address, callback) { bound = callback; },
    setBroadcast() {}, send() { writes++; }, close() { closed = true; } });
  const pending = wakeTV('44:11:22:33:44:66', { socketFactory: () => socket,
    assertDispatch() { if (!allowed) throw revoked(); } });
  allowed = false; bound();
  await assert.rejects(pending, { code: 'GRANT_REVOKED' });
  assert.equal(writes, 0); assert.equal(closed, true);
});

test('execution guard does not contaminate subsequent trusted controller work or reads', async () => {
  const f = fixture(); await f.controller.connect();
  await f.controller.withDispatchGuard(() => { throw revoked(); }, async () => {
    await f.controller.apps();
    await assert.rejects(f.controller.mute(true), { code: 'GRANT_REVOKED' });
  });
  await f.controller.mute(false);
  assert.equal(f.calls.filter(call => call.uri.endsWith('/setMute')).length, 1);
  f.controller.close();
});

function observerFixture({ revokeBeforeLaunch = false } = {}) {
  const actions = []; let allowed = true; let closed = false;
  const server = new EventEmitter(); Object.assign(server, { listen(_port, _address, done) { done(); },
    address: () => ({ port: 48111 }), closeAllConnections() {}, close(done) { closed = true; done(); } });
  const controller = { host: HOST,
    identity: async () => ({ vendor: 'LG', model: 'OLED65B8PUA', firmware: '05.50.70' }),
    status: async () => ({ foreground: { payload: { appId: APP } } }),
    async apps() { if (revokeBeforeLaunch) allowed = false; return { apps: [{ id: OBSERVER_APP }] }; },
    async launchObserver() { actions.push('launch'); allowed = false; throw new Error('Synthetic partial launch.'); },
    async closeApp() { actions.push('close'); },
    async waitForApp() { actions.push('restore-check'); return { confirmed: true }; },
  };
  return { actions, closed: () => closed, run: () => observeTV(controller, { assertDispatch() { if (!allowed) throw revoked(); } },
    { routeAddress: async () => '192.168.77.11', serverFactory: () => server }) };
}

test('observation: revocation during preflight refuses overlay launch and closes its listener', async () => {
  const f = observerFixture({ revokeBeforeLaunch: true });
  await assert.rejects(f.run(), { code: 'GRANT_REVOKED' });
  assert.deepEqual(f.actions, []); assert.equal(f.closed(), true);
});

test('observation: revocation after launch cannot prevent restoration and receiver cleanup', async () => {
  const f = observerFixture(); const result = await f.run();
  assert.deepEqual(f.actions, ['launch', 'close', 'restore-check']); assert.equal(f.closed(), true);
  assert.equal(result.metadata.overlayClosed, true); assert.equal(result.metadata.restored, true);
});

test('LG action registry is immutable and does not advertise unrelated device actions', () => {
  const f = fixture();
  assert.ok(Object.isFrozen(f.adapter.supportedActions)); assert.ok(Object.isFrozen(f.adapter.readonlyActions));
  assert.equal(f.adapter.supportedActions.includes('screen.observe'), true);
  assert.equal(f.adapter.supportedActions.some(action => action.startsWith('vacuum.')), false);
  assert.throws(() => { f.adapter.supportedActions = []; }, TypeError);
});
