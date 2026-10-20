import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LGWebOSAdapter } from '../lib/adapters/lg-webos.mjs';

const privateConfig = { host: '192.168.21.80', clientKey: 'secret-pairing-key', mac: '44:11:22:33:44:66',
  allowTemporaryObserver: true, wake: { bindAddress: '192.168.21.10' }, mediaRoots: ['/approved-media'] };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const status = ({ appId = 'com.disney.disneyplus-prod', volume = 15, muted = false, inputs } = {}) => ({
  host: privateConfig.host, clientKey: privateConfig.clientKey,
  foreground: { status: 'ok', payload: { appId, private: 'not-state', socketPath: 'ws://private' } },
  audio: { status: 'ok', payload: { mute: muted } },
  volume: { status: 'ok', payload: { volumeStatus: { volume, muteStatus: muted } } },
  power: { status: 'ok', payload: { state: 'Active' } },
  sound: { status: 'ok', payload: { soundOutput: 'tv_external_speaker' } },
  inputs: { status: 'ok', payload: { devices: inputs ?? [{ id: 'HDMI_3', appId: 'com.webos.app.hdmi3', connected: true,
    label: `Computer ${privateConfig.host}`, icon: 'http://private' }] } },
});

function fixture(options = {}) {
  const calls = []; const controllers = []; const mediaHosts = [];
  const values = { appId: 'com.disney.disneyplus-prod', volume: 15, muted: false };
  const factory = async config => {
    const generation = controllers.length;
    const controller = { registered: false,
      async connect(argument) { calls.push(['connect', argument, generation]); await options.connect?.(generation); this.registered = true; },
      async close() { calls.push(['close', generation]); this.registered = false; },
      async status() { calls.push(['status', generation]); return await options.status?.(generation, values) ?? status({ ...values, inputs: options.inputs }); },
      async identity() { calls.push(['identity']); return { vendor: 'LG', model: 'OLED65B8PUA', firmware: '05.50.70', host: config.host }; },
      async apps() { calls.push(['apps']); if (options.readApps) return options.readApps(generation); return { returnValue: true, apps: options.apps ?? [] }; },
      async setVolume(value) { calls.push(['setVolume', value]); if (!options.mismatchVolume) values.volume = value; return { returnValue: true }; },
      async mute(value) { calls.push(['mute', value]); values.muted = value; return { returnValue: true }; },
      async launch(id) { calls.push(['launch', id]); values.appId = id; return { returnValue: true }; },
      async launchContent(id) { calls.push(['launchContent', id]); values.appId = id; return { returnValue: true }; },
      async waitForApp(id) { calls.push(['waitForApp', id]); return { confirmed: values.appId === id, foreground: { appId: values.appId } }; },
      async setInput(id) { calls.push(['setInput', id, generation]); if (!this.registered) throw Object.assign(new Error(), { code: 'NOT_REGISTERED' }); values.appId = 'com.webos.app.hdmi3'; return { returnValue: true }; },
      async key(key) { calls.push(['key', key]); if (options.keyTimeout && generation === 0) throw Object.assign(new Error('ambiguous timeout'), { code: 'TIMEOUT' }); if (options.keyFailure && generation === 0) { this.registered = false; throw Object.assign(new Error('sensitive ' + config.clientKey), { code: 'TRANSPORT_ERROR' }); } return { sent: true, acknowledged: false }; },
      async media(action) { calls.push(['media', action]); return { returnValue: true }; },
      async dlnaStatus() { calls.push(['dlnaStatus']); return { transportState: 'STOPPED', transportStatus: 'OK', currentSpeed: '1' }; },
      async dlnaPlay(url) { calls.push(['dlnaPlay', url]); if (options.castFailure) throw Object.assign(new Error('secret media URL'), { code: 'DLNA_STATE_TIMEOUT', uncertain: true }); return { requestAccepted: true, confirmed: true, transportConfirmed: true, transportState: 'PLAYING', transportStatus: 'OK', playbackVerified: true, contentVerified: false, url }; },
      async dlnaMedia(action) { calls.push(['dlnaMedia', action]); return { requestAccepted: true, confirmed: options.stopConfirmed !== false,
        transportState: action === 'stop' ? 'STOPPED' : 'PLAYING', transportStatus: 'OK' }; },
      async wake() { calls.push(['wake']); return { sent: true, acknowledged: false, address: 'private', port: 9 }; },
    };
    controllers.push(controller); return controller;
  };
  const observer = options.observer ?? (async controller => {
    calls.push(['observe']);
    return { image: Buffer.from([255, 216, 255, 217]), mimeType: 'image/jpeg', metadata: {
      screenshotVerified: true, communicationVerified: true, overlayClosed: true, restored: true, cleanupVerified: true,
      completed: true, host: privateConfig.host, clientKey: privateConfig.clientKey,
      device: { vendor: 'LG', model: 'OLED65B8PUA', firmware: '05.50.70', host: privateConfig.host, mac: privateConfig.mac },
      titlePlaybackVerified: false, originalAppId: values.appId,
      sample: { appForeground: { payload: { appId: values.appId } }, acbForeground: { payload: { appId: values.appId,
        acbs: [{ playerType: 'mse', playStateNow: 'playing', isFullScreen: true, width: 1920, height: 1080, url: 'https://private-stream' }] } } },
    } };
  });
  const mediaHostFactory = async () => {
    const host = { closed: false,
      async serve() { calls.push(['serve']); return { url: 'http://192.168.21.10:1234/media/private-token.mp4', mimeType: 'video/mp4', bytes: 100 }; },
      async close() { calls.push(['mediaClose']); this.closed = true; },
    };
    mediaHosts.push(host); return host;
  };
  const adapter = new LGWebOSAdapter({ deviceId: 'living-room-tv', config: { ...privateConfig, ...options.config }, features: options.features ?? ['observer', 'media'], controllerFactory: factory, observer, mediaHostFactory });
  return { adapter, calls, controllers, values, mediaHosts };
}

test('basic-only LG enrollment rejects enhancement calls before authorization, connection or effects', async t => {
  const f = fixture({ features: [] }); t.after(() => f.adapter.close());
  assert.deepEqual(f.adapter.features, []);
  assert.deepEqual(f.adapter.readonlyActions, ['app.list', 'text.focus.read']);
  for (const action of ['screen.observe', 'media.url.play', 'dlna.play', 'dlna.control', 'dlna.status', 'media.file.cast', 'media.host.release']) {
    assert.equal(f.adapter.supportedActions.includes(action), false);
  }
  let dispatchChecks = 0;
  const context = { assertDispatch() { dispatchChecks++; } };
  await assert.rejects(f.adapter.observe({}, context), { code: 'FEATURE_NOT_ENABLED' });
  for (const command of [
    { action: 'dlna.status', args: {} },
    { action: 'dlna.control', args: { action: 'play' } },
    { action: 'dlna.play', args: { url: 'http://example.test/video', mimeType: 'video/mp4' } },
    { action: 'media.url.play', args: { url: 'http://example.test/video', mimeType: 'video/mp4' } },
    { action: 'media.file.cast', args: { filePath: '/approved-media/example.mp4' } },
  ]) await assert.rejects(f.adapter.execute(command, context), { code: 'FEATURE_NOT_ENABLED' });
  assert.equal(dispatchChecks, 0);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.adapter.execute({ action: 'audio.mute.set', args: { muted: true } })).confirmed, true);
  assert.equal((await f.adapter.execute({ action: 'media.control', args: { action: 'pause' } })).requestAccepted, true);
});

test('LG features are explicit, immutable and independently selected; observer keeps its local opt-in gate', async t => {
  for (const features of [['root'], ['observer', 'observer'], 'observer', null]) {
    assert.throws(() => new LGWebOSAdapter({ deviceId: 'tv', config: privateConfig, features }), { code: 'INVALID_FEATURES' });
  }
  const features = ['media'];
  const media = fixture({ features }); t.after(() => media.adapter.close());
  features.push('observer');
  assert.deepEqual(media.adapter.features, ['media']);
  assert.ok(Object.isFrozen(media.adapter.features));
  await assert.rejects(media.adapter.observe(), { code: 'FEATURE_NOT_ENABLED' });
  assert.equal((await media.adapter.execute({ action: 'dlna.status' })).confirmed, true);
  const observer = fixture({ features: ['observer'], config: { allowTemporaryObserver: false } });
  t.after(() => observer.adapter.close());
  await assert.rejects(observer.adapter.observe(), { code: 'OBSERVER_NOT_ENABLED' });
  await assert.rejects(observer.adapter.execute({ action: 'dlna.status' }), { code: 'FEATURE_NOT_ENABLED' });
  assert.deepEqual(observer.calls, []);
});

test('snapshot and event projections include freshness but no private connection data', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const events = []; const unsubscribe = f.adapter.subscribe(event => events.push(event));
  const snapshot = await f.adapter.snapshot();
  assert.equal(snapshot.fields.volume.value, 15);
  assert.equal(snapshot.fields.mute.value, false);
  assert.equal(snapshot.fields.foreground.value.appId, 'com.disney.disneyplus-prod');
  assert.equal(snapshot.fields.foreground.source, 'ssap');
  assert.equal(snapshot.fields.foreground.verification, 'device-reported');
  assert.ok(Date.parse(snapshot.fields.volume.expiresAt) > Date.now());
  const text = JSON.stringify([snapshot, events]);
  for (const forbidden of [privateConfig.host, privateConfig.clientKey, privateConfig.mac, 'socketPath', 'private-stream', 'http://private']) assert.equal(text.includes(forbidden), false);
  assert.ok(Object.isFrozen(snapshot.fields.inputs.value));
  unsubscribe(); const count = events.length; await f.adapter.snapshot(); assert.equal(events.length, count);
  assert.equal((await f.adapter.identity()).model, 'OLED65B8PUA');
  assert.deepEqual(f.calls.find(call => call[0] === 'connect')[1], { allowPairing: false });
});

test('volume and mute require readback; pointer and media commands do not claim effects', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const volume = await f.adapter.execute({ action: 'audio.volume.set', args: { volume: 20 } });
  assert.equal(volume.confirmed, true); assert.equal(volume.observed, 20);
  const mute = await f.adapter.execute({ action: 'audio.mute.set', args: { muted: true } });
  assert.equal(mute.confirmed, true); assert.equal(mute.observed, true);
  const key = await f.adapter.execute({ action: 'navigation.key', args: { key: 'DOWN' } });
  assert.equal(key.confirmed, false); assert.equal(key.requestAccepted, null); assert.equal(key.transportSent, true);
  const media = await f.adapter.execute({ action: 'media.control', args: { action: 'play' } });
  assert.equal(media.requestAccepted, true); assert.equal(media.confirmed, false); assert.equal(media.titlePlaybackVerified, false);
  const mismatch = fixture({ mismatchVolume: true }); t.after(() => mismatch.adapter.close());
  assert.equal((await mismatch.adapter.execute({ action: 'audio.volume.set', args: { volume: 99 } })).confirmed, false);
});

test('app and input verification use actual declared app IDs without guessing', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const app = await f.adapter.execute({ action: 'app.launch', args: { id: 'com.disney.disneyplus-prod' } });
  assert.equal(app.confirmed, true); assert.equal(app.titlePlaybackVerified, false);
  const input = await f.adapter.execute({ action: 'input.select', args: { id: 'HDMI_3' } });
  assert.equal(input.confirmed, true); assert.equal(input.observedAppId, 'com.webos.app.hdmi3');
  const missing = fixture({ inputs: [{ id: 'HDMI_3' }] }); t.after(() => missing.adapter.close());
  const result = await missing.adapter.execute({ action: 'input.select', args: { id: 'HDMI_3' } });
  assert.equal(result.confirmed, false); assert.equal(result.error.code, 'INPUT_METADATA_UNAVAILABLE');
  assert.equal(missing.calls.some(call => call[0] === 'waitForApp'), false);
});

test('transport failure creates a new controller for read reconciliation without repeating mutation', async t => {
  const f = fixture({ keyFailure: true }); t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'navigation.key', args: { key: 'ENTER' } });
  assert.equal(result.uncertain, true); assert.equal(result.confirmed, false);
  assert.equal(f.calls.filter(call => call[0] === 'key').length, 1);
  assert.equal(f.controllers.length, 2);
  assert.equal(result.error.code, 'TRANSPORT_ERROR');
  assert.equal(JSON.stringify(result).includes(privateConfig.clientKey), false);
  assert.equal((await f.adapter.snapshot({ refresh: false })).connection.phase, 'online');
});

const failedStatus = code => Object.fromEntries(['foreground', 'audio', 'volume', 'power', 'inputs', 'sound']
  .map(name => [name, { status: 'error', error: { code } }]));

test('a completely timed-out status batch discards a half-open controller and retries reads once', async t => {
  const f = fixture({ status: generation => generation === 0 ? failedStatus('TIMEOUT') : status() });
  t.after(() => f.adapter.close());
  const observed = await f.adapter.snapshot();
  assert.equal(observed.connection.phase, 'online');
  assert.equal(observed.fields.foreground.value.appId, 'com.disney.disneyplus-prod');
  assert.equal(f.controllers.length, 2);
  assert.deepEqual(f.calls.filter(call => call[0] === 'status').map(call => call[1]), [0, 1]);
  assert.equal(f.controllers[0].registered, false);
  assert.equal(f.calls.some(call => ['key', 'launch', 'launchContent', 'setVolume', 'mute', 'wake'].includes(call[0])), false);
});

test('input selection uses the replacement controller after its pre-read reconnects', async t => {
  const f = fixture({ status: generation => generation === 0 ? failedStatus('TIMEOUT') : status() });
  t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'input.select', args: { id: 'HDMI_3' } });
  assert.equal(result.confirmed, true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'setInput'), [['setInput', 'HDMI_3', 1]]);
  assert.equal(f.controllers[0].registered, false);
});

test('read recovery is bounded and keeps previous values expired when both connections time out', async t => {
  let reachable = true;
  const f = fixture({ status: () => reachable ? status() : failedStatus('TIMEOUT') });
  t.after(() => f.adapter.close());
  const before = await f.adapter.snapshot(); reachable = false;
  await assert.rejects(f.adapter.snapshot(), { code: 'STATE_TIMEOUT' });
  const after = await f.adapter.snapshot({ refresh: false });
  assert.equal(f.controllers.length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'status').length, 3);
  assert.equal(after.connection.phase, 'offline');
  assert.equal(after.fields.volume.observedAt, before.fields.volume.observedAt);
  assert.equal(Date.parse(after.fields.volume.expiresAt), 0);
  assert.equal(f.controllers.every(controller => controller.registered === false), true);
});

test('partial status timeouts expire missing fields without reconnecting a responsive TV', async t => {
  let partial = false;
  const f = fixture({ status: () => {
    const result = status();
    if (partial) { result.foreground = failedStatus('TIMEOUT').foreground; result.inputs = failedStatus('TIMEOUT').inputs; }
    return result;
  } });
  t.after(() => f.adapter.close());
  await f.adapter.snapshot(); partial = true;
  const after = await f.adapter.snapshot();
  assert.equal(after.connection.phase, 'degraded');
  assert.equal(f.controllers.length, 1);
  assert.equal(Date.parse(after.fields.foreground.expiresAt), 0);
  assert.equal(Date.parse(after.fields.inputs.expiresAt), 0);
  assert.ok(Date.parse(after.fields.volume.expiresAt) > Date.now());
});

test('unsupported or rejected state APIs do not trigger reconnect loops', async t => {
  const f = fixture({ status: () => failedStatus('TV_REJECTED') }); t.after(() => f.adapter.close());
  await assert.rejects(f.adapter.snapshot(), { code: 'STATE_UNAVAILABLE' });
  assert.equal(f.controllers.length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'status').length, 1);
  assert.equal((await f.adapter.snapshot({ refresh: false })).connection.phase, 'degraded');
});

test('an ambiguous key timeout only reconnects for fresh reads and never sends the key again', async t => {
  const f = fixture({ keyTimeout: true, status: generation => generation === 0 ? failedStatus('TIMEOUT') : status() });
  t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'navigation.key', args: { key: 'ENTER' } });
  assert.equal(result.error.code, 'TIMEOUT'); assert.equal(result.uncertain, true); assert.equal(result.confirmed, false);
  assert.equal(f.calls.filter(call => call[0] === 'key').length, 1);
  assert.equal(f.controllers.length, 2);
  assert.equal((await f.adapter.snapshot({ refresh: false })).connection.phase, 'online');
});

test('app inventory retries only its read after a timeout and rechecks grants before retrying', async t => {
  const f = fixture({ readApps: generation => {
    if (generation === 0) throw Object.assign(new Error('read timed out'), { code: 'TIMEOUT' });
    return { apps: [{ id: 'com.example.video', title: 'Example' }] };
  } }); t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'app.list' });
  assert.equal(result.confirmed, true); assert.equal(result.apps[0].id, 'com.example.video');
  assert.equal(f.calls.filter(call => call[0] === 'apps').length, 2);
  let valid = true;
  const revoked = fixture({ readApps: () => { valid = false; throw Object.assign(new Error('read timed out'), { code: 'TIMEOUT' }); } });
  t.after(() => revoked.adapter.close());
  await assert.rejects(revoked.adapter.execute({ action: 'app.list' }, { assertDispatch() {
    if (!valid) throw Object.assign(new Error('revoked'), { code: 'GRANT_REVOKED' });
  } }), { code: 'GRANT_REVOKED' });
  assert.equal(revoked.controllers.length, 1);
  assert.equal(revoked.calls.filter(call => call[0] === 'apps').length, 1);
});

test('changed TLS trust or unavailable explicit source never falls back or retries a read', async t => {
  for (const code of ['TLS_PIN_MISMATCH', 'SOURCE_ADDRESS_UNAVAILABLE', 'INVALID_SOURCE_ADDRESS']) {
    const f = fixture({ connect: () => { throw Object.assign(new Error('blocked connection'), { code }); } });
    t.after(() => f.adapter.close());
    await assert.rejects(f.adapter.snapshot(), { code });
    assert.equal(f.controllers.length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'connect').length, 1);
    assert.equal(f.calls.some(call => call[0] === 'status'), false);
    assert.equal((await f.adapter.snapshot({ refresh: false })).connection.phase, 'offline');
  }
});

test('polling, actions and observations share a queue; close waits for observer restoration', async () => {
  const gate = deferred(); const observationStarted = deferred(); const observationGate = deferred();
  let first = true;
  const f = fixture({ status: async () => { if (first) { first = false; await gate.promise; } return status(); },
    observer: async () => { observationStarted.resolve(); await observationGate.promise; return { metadata: { overlayClosed: true, restored: true } }; } });
  const start = f.adapter.start();
  const action = f.adapter.execute({ action: 'navigation.key', args: { key: 'DOWN' } });
  const observe = f.adapter.observe();
  await nextTurn(); assert.equal(f.calls.some(call => call[0] === 'key'), false);
  gate.resolve(); await start; await action; await observationStarted.promise;
  const queued = f.adapter.execute({ action: 'audio.mute.set', args: { muted: true } });
  const closing = f.adapter.close();
  await nextTurn(); assert.equal(f.calls.some(call => call[0] === 'mute'), false);
  assert.equal(f.calls.some(call => call[0] === 'close'), false);
  await assert.rejects(f.adapter.snapshot(), { code: 'ADAPTER_CLOSED' });
  observationGate.resolve(); await observe; await queued; await closing;
  assert.equal(f.calls.at(-1)[0], 'close');
});

test('observe preserves its frame and evidence flags while metadata and events omit private details', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const events = []; f.adapter.subscribe(event => events.push(event));
  const result = await f.adapter.observe();
  assert.ok(Buffer.isBuffer(result.image)); assert.equal(result.metadata.cleanupVerified, true);
  assert.equal(result.metadata.completed, true);
  assert.equal(result.metadata.restored, true);
  assert.deepEqual(result.metadata.device, { vendor: 'LG', model: 'OLED65B8PUA', firmware: '05.50.70' });
  const metadata = JSON.stringify(result.metadata);
  for (const forbidden of [privateConfig.host, privateConfig.clientKey, privateConfig.mac, 'private-stream']) assert.equal(metadata.includes(forbidden), false);
  const state = await f.adapter.snapshot({ refresh: false });
  assert.equal(state.fields.player.value.players[0].playStateNow, 'playing');
  const serialized = JSON.stringify([state, events]);
  assert.equal(serialized.includes('private-stream'), false); assert.equal(serialized.includes('"type":"Buffer"'), false);
  const disabled = fixture({ config: { allowTemporaryObserver: false } }); t.after(() => disabled.adapter.close());
  await assert.rejects(disabled.adapter.observe(), { code: 'OBSERVER_NOT_ENABLED' });
  assert.equal(disabled.controllers.length, 0);
});

test('dispatch grants are rechecked after queue delay and after connecting', async t => {
  const gate = deferred(); let valid = true;
  const f = fixture({ status: async () => { await gate.promise; return status(); } }); t.after(() => f.adapter.close());
  const polling = f.adapter.snapshot();
  const queued = f.adapter.execute({ action: 'navigation.key', args: { key: 'DOWN' } }, { assertDispatch() { if (!valid) throw Object.assign(new Error('Grant revoked'), { code: 'GRANT_REVOKED' }); } });
  valid = false; gate.resolve(); await polling;
  await assert.rejects(queued, { code: 'GRANT_REVOKED' });
  assert.equal(f.calls.some(call => call[0] === 'key'), false);
  const connection = deferred(); let allowed = true;
  const later = fixture({ connect: async () => connection.promise }); t.after(() => later.adapter.close());
  const pending = later.adapter.execute({ action: 'navigation.key', args: { key: 'DOWN' } }, { assertDispatch() { if (!allowed) throw Object.assign(new Error('Expired'), { code: 'GRANT_EXPIRED' }); } });
  await nextTurn(); allowed = false; connection.resolve();
  await assert.rejects(pending, { code: 'GRANT_EXPIRED' });
  assert.equal(later.calls.filter(call => call[0] === 'status').length, 0);
  assert.equal(later.calls.some(call => call[0] === 'key'), false);
});

test('expired operations, unknown actions and extra arguments never dispatch', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await assert.rejects(f.adapter.execute({ action: 'raw.luna', args: {} }), { code: 'UNKNOWN_ACTION' });
  await assert.rejects(f.adapter.execute({ action: 'app.launch', args: { id: 'app', params: { target: 'unsafe' } } }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(f.adapter.execute({ action: 'power.off', args: {} }, { deadlineAt: new Date(0).toISOString() }), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(f.controllers.length, 0);
});

test('DLNA remains lazy and local media listeners survive until verified replacement or stop', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const read = await f.adapter.execute({ action: 'dlna.status', args: {} });
  assert.equal(read.confirmed, true); assert.equal(f.calls.some(call => call[0] === 'connect'), false);
  const first = await f.adapter.execute({ action: 'media.file.cast', args: { filePath: '/approved-media/one.mp4' } });
  assert.equal(first.confirmed, true); assert.equal(f.mediaHosts[0].closed, false);
  const second = await f.adapter.execute({ action: 'media.file.cast', args: { filePath: '/approved-media/two.mp4' } });
  assert.equal(second.confirmed, true); assert.equal(f.mediaHosts[0].closed, true); assert.equal(f.mediaHosts[1].closed, false);
  const stop = await f.adapter.execute({ action: 'dlna.control', args: { action: 'stop' } });
  assert.equal(stop.confirmed, true); assert.equal(f.mediaHosts[1].closed, true);
  assert.equal(JSON.stringify([first, second, stop]).includes('private-token'), false);
  assert.equal(f.calls.some(call => call[0] === 'connect'), false);
});

test('uncertain file playback retains its listener; adapter close releases it', async () => {
  const f = fixture({ castFailure: true });
  const result = await f.adapter.execute({ action: 'media.file.cast', args: { filePath: '/approved-media/one.mp4' } });
  assert.equal(result.confirmed, false); assert.equal(result.uncertain, true);
  assert.equal(f.mediaHosts[0].closed, false);
  assert.equal(f.calls.filter(call => call[0] === 'dlnaPlay').length, 1);
  await f.adapter.close(); assert.equal(f.mediaHosts[0].closed, true);
});

test('wake does not require connecting SSAP and never claims the device woke', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'power.wake', args: {} });
  assert.equal(result.transportSent, true); assert.equal(result.confirmed, false);
  assert.equal(result.requestAccepted, null);
  assert.equal(f.calls.some(call => call[0] === 'connect'), false);
});

test('missing readback cannot reuse an expired cached value as confirmation', async t => {
  let omit = false;
  const f = fixture({ status: async () => {
    const result = status();
    if (omit) { result.volume = { status: 'ok', payload: {} }; result.audio = { status: 'ok', payload: {} }; }
    return result;
  } }); t.after(() => f.adapter.close());
  await f.adapter.snapshot(); omit = true;
  const result = await f.adapter.execute({ action: 'audio.volume.set', args: { volume: 15 } });
  assert.equal(result.confirmed, false); assert.equal(result.observed, null);
});

test('app inventory is a fixed privacy projection with conservative launch flags and no mutation', async t => {
  const f = fixture({ apps: [
    { id: 'com.disney.disneyplus-prod', title: 'Disney+', systemApp: false, privilegedJail: false,
      defaultWindowType: 'card', requiredPermissions: [], icon: 'https://provider.invalid/private-icon',
      main: 'https://provider.invalid/private-entry', clientKey: privateConfig.clientKey },
    { id: 'com.webos.app.dangbei-overlay', title: 'System overlay', systemApp: true,
      privilegedJail: true, defaultWindowType: 'overlay', requiredPermissions: ['all'],
      icon: 'https://provider.invalid/overlay', params: { target: 'https://provider.invalid/executable' } },
    { id: 'com.webos.app.browser', title: 'Web Browser', systemApp: true, privilegedJail: false,
      defaultWindowType: 'card', requiredPermissions: [] },
    { id: 'com.webos.app.unknown-system', title: 'Unreviewed system app', systemApp: true,
      privilegedJail: false, defaultWindowType: 'card', requiredPermissions: [] },
    { id: 'com.example.unclassified', title: 'Unclassified app' },
    { id: '../unsafe-path', title: 'Invalid identifier' },
  ] }); t.after(() => f.adapter.close());
  const before = await f.adapter.snapshot();
  const result = await f.adapter.execute({ action: 'app.list', args: {} });
  const after = await f.adapter.snapshot({ refresh: false });
  assert.equal(result.confirmed, true);
  assert.equal(result.verificationScope, 'installed_app_metadata');
  assert.equal(result.titlePlaybackVerified, false);
  assert.equal(result.uncertain, undefined);
  assert.equal(result.apps.length, 5);
  assert.equal(result.apps.find(app => app.id === 'com.disney.disneyplus-prod').launchAllowed, true);
  assert.equal(result.apps.find(app => app.id === 'com.webos.app.dangbei-overlay').launchAllowed, false);
  assert.equal(result.apps.find(app => app.id === 'com.webos.app.browser').launchAllowed, true);
  assert.equal(result.apps.find(app => app.id === 'com.webos.app.unknown-system').launchAllowed, false);
  assert.equal(result.apps.find(app => app.id === 'com.example.unclassified').launchAllowed, false);
  for (const app of result.apps) assert.ok(Object.keys(app).every(key => ['id', 'title', 'systemApp', 'launchAllowed'].includes(key)));
  const text = JSON.stringify(result);
  for (const forbidden of ['https://', 'provider.invalid', 'requiredPermissions', 'privilegedJail', 'defaultWindowType', 'params', privateConfig.clientKey]) assert.equal(text.includes(forbidden), false);
  assert.equal(f.calls.filter(call => call[0] === 'apps').length, 1);
  assert.equal(f.calls.some(call => ['launch', 'launchContent', 'key', 'setInput', 'setVolume', 'mute'].includes(call[0])), false);
  assert.equal(after.revision, before.revision);
  assert.equal(after.fields.volume.expiresAt, before.fields.volume.expiresAt);
  assert.equal(result.afterRevision, result.beforeRevision);
});
