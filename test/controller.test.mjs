import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TVController, createMagicPacket, validatePointerURL, wakeTV } from '../lib/tv-controller.mjs';
import { redact, SSAPError, EXTENDED_PERMISSIONS, CONTROL_PERMISSIONS } from '../lib/ssap.mjs';
import { main } from '../lg-tv.mjs';

const HOST = '192.168.30.40';
const KEY = 'controller-fixture-private-key';
const ordinaryMetadata = id => ({ id, systemApp: false, privilegedJail: false, defaultWindowType: 'card' });

class FakeSSAP {
  registered = false;
  timeoutMs = 100;
  calls = [];
  autoFocus = true;
  constructor(respond = uri => uri.endsWith('/listApps')
    ? { apps: ['com.example.app', 'com.example.video'].map(ordinaryMetadata) } : { returnValue: true }) { this.respond = respond; }
  async connect(options) { this.connectionOptions = options; this.registered = true; return { registered: true }; }
  close() { this.registered = false; this.closed = true; }
  sanitize(value) { return redact(value, [KEY]); }
  async request(uri, payload) { this.calls.push({ uri, payload }); return this.respond(uri, payload); }
  async subscribeOnce(uri, payload, options) {
    this.subscription = { uri, payload, options };
    return { currentWidget: { focus: true } };
  }
  async subscribe(uri, payload, options) {
    if (uri.endsWith('/getForegroundAppInfo')) {
      this.foregroundSubscription = { uri, payload, options };
      options.onUpdate({ appId: 'com.example.app' });
      return { id: 'foreground-fixture', unsubscribe() {} };
    }
    this.subscription = { uri, payload, options };
    this.subscriptionCount = (this.subscriptionCount ?? 0) + 1;
    options.onUpdate({ subscribed: true });
    if (this.autoFocus) options.onUpdate({ currentWidget: { focus: true } });
    return { id: 'fixture-subscription', unsubscribe: () => { this.unsubscribed = true; } };
  }
}
class FakePointer extends EventEmitter {
  readyState = 0;
  frames = [];
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  send(frame, callback) { this.frames.push(frame); callback(); }
  terminate() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } }
}
function harness(respond, options = {}) {
  const ssap = new FakeSSAP(respond);
  const sockets = [];
  const controller = new TVController({ host: HOST, ssapClient: ssap,
    pointerWebSocketFactory: (url, wsOptions) => {
      const socket = new FakePointer(); socket.url = url; socket.options = wsOptions;
      sockets.push(socket); return socket;
    }, ...options });
  return { ssap, controller, sockets };
}

test('ordinary controller methods map to documented endpoints and exact payloads', async () => {
  const { controller, ssap } = harness();
  await controller.connect();
  assert.deepEqual(ssap.connectionOptions, { allowPairing: false });
  await controller.apps();
  await controller.launch('com.example.app', { language: 'zh' }, 'episode:123');
  await controller.openUrl('https://example.com/watch?id=123');
  await controller.startKeyboard();
  await controller.typeText('中文 query', { replace: true });
  await controller.media('pause');
  await controller.setVolume(25);
  await controller.mute(true);
  await controller.setInput('HDMI_1');
  await controller.soundOutput('tv_speaker');
  await controller.screen(false);
  await controller.screen(true);
  await controller.powerOff();
  assert.deepEqual(ssap.calls, [
    { uri: 'ssap://com.webos.applicationManager/listApps', payload: {} },
    { uri: 'ssap://com.webos.applicationManager/listApps', payload: {} },
    { uri: 'ssap://system.launcher/launch', payload: { id: 'com.example.app', params: { language: 'zh' }, contentId: 'episode:123' } },
    { uri: 'ssap://system.launcher/open', payload: { target: 'https://example.com/watch?id=123' } },
    { uri: 'ssap://com.webos.service.ime/insertText', payload: { text: '中文 query', replace: true } },
    { uri: 'ssap://media.controls/pause', payload: {} },
    { uri: 'ssap://audio/setVolume', payload: { volume: 25 } },
    { uri: 'ssap://audio/setMute', payload: { mute: true } },
    { uri: 'ssap://tv/switchInput', payload: { inputId: 'HDMI_1' } },
    { uri: 'ssap://com.webos.service.apiadapter/audio/changeSoundOutput', payload: { output: 'tv_speaker' } },
    { uri: 'ssap://com.webos.service.tv.power/turnOffScreen', payload: { standbyMode: 'active' } },
    { uri: 'ssap://com.webos.service.tv.power/turnOnScreen', payload: { standbyMode: 'active' } },
    { uri: 'ssap://system/turnOff', payload: {} },
  ]);
  controller.close();
  assert.equal(ssap.closed, true);
});

test('webOS 5+ screen endpoint differs; webOS4 error is preserved instead of claimed success', async () => {
  const modern = harness(undefined, { webOSMajor: 5 });
  await modern.controller.screen(true);
  assert.equal(modern.ssap.calls[0].uri, 'ssap://com.webos.service.tvpower/power/turnOnScreen');
  const legacy = harness(() => { throw new SSAPError(`error ${KEY}`, 'TV_REJECTED', { errorCode: 'POWER_ERROR_0005' }); });
  await assert.rejects(legacy.controller.screen(true), (error) =>
    error.payload.errorCode === 'POWER_ERROR_0005' && !error.message.includes(KEY));
  assert.equal(legacy.ssap.calls.length, 1);
});

test('waitForApp confirms asynchronous foreground change instead of treating launch ack as completion', async () => {
  let reads = 0;
  const { controller, ssap } = harness((uri) => {
    if (uri.endsWith('/getForegroundAppInfo')) return { appId: ++reads < 3 ? 'com.webos.app.hdmi3' : 'com.example.video' };
    if (uri.endsWith('/listApps')) return { apps: [ordinaryMetadata('com.example.video')] };
    return { returnValue: true };
  });
  const accepted = await controller.launch('com.example.video');
  assert.equal(accepted.returnValue, true);
  assert.equal(reads, 0);
  const observed = await controller.waitForApp('com.example.video', { timeoutMs: 100, pollMs: 1 });
  assert.equal(observed.confirmed, true);
  assert.equal(observed.appId, 'com.example.video');
  assert.equal(reads, 3);
  assert.equal(ssap.calls.filter((call) => call.uri.endsWith('/launch')).length, 1);
});

test('waitForApp timeout includes last observation and never repeats a control command', async () => {
  const { controller, ssap } = harness(() => ({ appId: 'com.webos.app.hdmi3' }));
  await assert.rejects(controller.waitForApp('com.example.video', { timeoutMs: 10, pollMs: 2 }), (error) =>
    error.code === 'TIMEOUT' && error.payload.expectedAppId === 'com.example.video' &&
    error.payload.lastObservedAppId === 'com.webos.app.hdmi3');
  assert.ok(ssap.calls.length >= 1);
  assert.ok(ssap.calls.every((call) => call.uri.endsWith('/getForegroundAppInfo')));
  controller.close();
  await assert.rejects(controller.waitForApp('com.example.video'), { code: 'CLIENT_CLOSED' });
});

test('closeApp validates ordinary apps, uses the documented close endpoint, and preserves permission errors', async () => {
  const { controller, ssap } = harness(() => { throw new SSAPError('401 permission denied', 'TV_REJECTED'); });
  await assert.rejects(controller.closeApp('com.example.video'), { code: 'TV_REJECTED' });
  assert.deepEqual(ssap.calls, [{ uri: 'ssap://system.launcher/close', payload: { id: 'com.example.video' } }]);
  assert.throws(() => controller.closeApp('com.webos.app.factorywin'), { code: 'RESTRICTED_APP' });
  assert.equal(ssap.calls.length, 1);
});

test('playUrl uses explicit MIME metadata and refuses URL schemes/credentials before playback', async () => {
  const { controller, ssap } = harness();
  await controller.playUrl('http://192.168.30.2/video.mp4', { mimeType: 'video/mp4', title: 'Local video' });
  assert.deepEqual(ssap.calls[0], { uri: 'ssap://media.viewer/open', payload: {
    target: 'http://192.168.30.2/video.mp4', title: 'Local video', description: '', mimeType: 'video/mp4', iconSrc: '', loop: false,
  } });
  assert.throws(() => controller.playUrl('file:///tmp/video.mp4', { mimeType: 'video/mp4' }), SSAPError);
  assert.throws(() => controller.playUrl('https://example.com/video', { mimeType: 'video/mp4\r\nBad: value' }), SSAPError);
  assert.throws(() => controller.playUrl('https://example.com/video', { mimeType: 'video/mp4', iconSrc: 'javascript:alert(1)' }), SSAPError);
  assert.equal(ssap.calls.length, 1);
});

test('screenshot downloads only its same-host image (loopback fixture, no TV)', async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ssap = new FakeSSAP(() => ({ imageUri: `http://127.0.0.1:${server.address().port}/capture.jpg` }));
  const controller = new TVController({ host: '127.0.0.1', ssapClient: ssap });
  const result = await controller.screenshot();
  assert.equal(result.bytes, 4);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(ssap.calls[0].uri, 'ssap://tv/executeOneShot');
  assert.deepEqual(ssap.calls[0].payload, {
    path: '/tmp/capture.jpg', method: 'DISPLAY', format: 'JPG', width: 960, height: 540,
  });
  ssap.respond = () => ({ imageUri: 'https://example.com/capture.jpg' });
  await assert.rejects(controller.screenshot(), { code: 'INVALID_CAPTURE_URL' });
  controller.close();
});

test('status reports independent query errors without hiding successful states', async () => {
  const { controller, ssap } = harness((uri) => {
    if (uri.includes('/audio/getSoundOutput')) throw new SSAPError('401 permission denied', 'TV_REJECTED');
    return { returnValue: true, volume: 20 };
  });
  const result = await controller.status();
  assert.equal(ssap.calls.length, 6);
  assert.equal(result.audio.status, 'ok');
  assert.equal(result.sound.status, 'error');
  assert.match(result.sound.error.message, /permission/);
});

test('invalid values and service-menu access are rejected before a command is sent', async () => {
  const { controller, ssap, sockets } = harness();
  const attempts = [
    () => controller.setVolume(-1), () => controller.setVolume(101), () => controller.setVolume(1.5),
    () => controller.mute('yes'), () => controller.screen('off'), () => controller.typeText('hello', { replace: 1 }),
    () => controller.typeText('x'.repeat(8193)), () => controller.setInput('HDMI_1\nname:POWER'),
    () => controller.soundOutput('speaker/../../'), () => controller.key('IN_START'), () => controller.key('EZ_ADJUST'),
    () => controller.key('HOME\nname:POWER'), () => controller.move(NaN, 0), () => controller.scroll(0, 1001),
    () => controller.launch('com.webos.app.factorywin'), () => controller.launch('com.example.calibration'),
    () => controller.launch('com.webos.app.service'),
    () => controller.launch('com.example.app', { uri: 'luna://service/doSomething' }),
    () => controller.launch('com.example.app', {}, 'javascript:alert(1)'),
    () => controller.openUrl('javascript:alert(1)'), () => controller.openUrl('file:///etc/passwd'),
    () => controller.openUrl('https://user:pass@example.com'), () => controller.media('seek'),
  ];
  for (const attempt of attempts) assert.throws(attempt, SSAPError);
  assert.equal(ssap.calls.length, 0);
  assert.equal(sockets.length, 0);
});

test('declared app content template is expanded; app-specific deep links are never guessed', async () => {
  const { controller, ssap } = harness((uri) => uri.endsWith('/listApps') ? { apps: [
    { ...ordinaryMetadata('com.example.video'), deeplinkingParams: '{"handledBy":"app","contentTarget":"$CONTENTID"}' },
    { ...ordinaryMetadata('com.example.browser'), params: { target: '$CONTENTID' } },
    { ...ordinaryMetadata('com.example.no-link'), deeplinkingParams: '{}' },
  ] } : { returnValue: true });
  await controller.launchContent('com.example.video', 'entity-123');
  assert.deepEqual(ssap.calls[1], { uri: 'ssap://system.launcher/launch', payload: {
    id: 'com.example.video', params: { handledBy: 'app', contentTarget: 'entity-123' }, contentId: 'entity-123',
  } });
  await controller.launchContent('com.example.browser', 'https://example.com');
  assert.equal(ssap.calls[3].payload.params.target, 'https://example.com');
  await assert.rejects(controller.launchContent('com.example.no-link', '123'), { code: 'NO_CONTENT_TEMPLATE' });
  await assert.rejects(controller.launchContent('com.example.missing', '123'), { code: 'APP_NOT_FOUND' });
  assert.equal(ssap.calls.filter((call) => call.uri.endsWith('/launch')).length, 2);
});

test('ordinary launch and content launch reject private Luna overlays and unclassified app metadata', async () => {
  for (const app of [
    { id: 'com.webos.app.dangbei-overlay', systemApp: true, privilegedJail: true,
      defaultWindowType: 'overlay', requiredPermissions: ['all'] },
    { ...ordinaryMetadata('com.example.hidden'), requiredPermissions: ['all'] },
    { ...ordinaryMetadata('com.example.overlay'), defaultWindowType: 'overlay' },
    { ...ordinaryMetadata('com.example.system'), systemApp: true },
    { ...ordinaryMetadata('com.example.privileged'), privilegedJail: true },
    { id: 'com.example.unclassified' },
  ]) {
    app.deeplinkingParams = { target: '$CONTENTID' };
    const { controller, ssap } = harness(uri => uri.endsWith('/listApps') ? { apps: [app] } : { returnValue: true });
    await assert.rejects(controller.launch(app.id, { target: 'https://untrusted.example/code.html' }), { code: 'RESTRICTED_APP' });
    await assert.rejects(controller.launchContent(app.id, 'https://untrusted.example/code.html'), { code: 'RESTRICTED_APP' });
    assert.equal(ssap.calls.some(call => call.uri.endsWith('/launch')), false);
  }
  const missing = harness(uri => uri.endsWith('/listApps') ? { apps: [] } : { returnValue: true });
  await assert.rejects(missing.controller.launch('com.example.missing'), { code: 'APP_NOT_FOUND' });
  assert.equal(missing.ssap.calls.some(call => call.uri.endsWith('/launch')), false);
});

test('reviewed normal system apps remain launchable only with unprivileged card metadata', async () => {
  const app = { ...ordinaryMetadata('com.webos.app.browser'), systemApp: true };
  const { controller, ssap } = harness(uri => uri.endsWith('/listApps') ? { apps: [app] } : { returnValue: true });
  await controller.launch(app.id, { target: 'https://example.com' });
  assert.equal(ssap.calls.at(-1).payload.id, app.id);
  app.privilegedJail = true;
  await assert.rejects(controller.launch(app.id), { code: 'RESTRICTED_APP' });
  assert.equal(ssap.calls.filter(call => call.uri.endsWith('/launch')).length, 1);
});

test('internal observer launch fixes the app, token path and private computer origin', async () => {
  const { controller, ssap } = harness();
  const entry = `http://192.168.30.2:12345/${'a'.repeat(48)}/assets/loader.html`;
  await controller.launchObserver(entry);
  assert.deepEqual(ssap.calls, [{ uri: 'ssap://system.launcher/launch', payload: {
    id: 'com.webos.app.dangbei-overlay', params: { target: entry },
  } }]);
  for (const invalid of [
    `http://${HOST}:12345/${'a'.repeat(48)}/assets/loader.html`,
    `http://127.0.0.1:12345/${'a'.repeat(48)}/assets/loader.html`,
    `http://203.0.113.2:12345/${'a'.repeat(48)}/assets/loader.html`,
    `https://192.168.30.2:12345/${'a'.repeat(48)}/assets/loader.html`,
    entry + '?url=https://untrusted.example', entry + '#fragment',
    entry.replace('/assets/loader.html', '/other.html'),
    entry.replace(':12345', ''), entry.replace('http://', 'http://user:password@'),
  ]) assert.throws(() => controller.launchObserver(invalid), SSAPError);
  assert.equal(ssap.calls.length, 1);
});

test('keyboard state waits for actual focus payload; typing retains one IME subscription until close', async () => {
  const { controller, ssap } = harness();
  await controller.connect();
  ssap.autoFocus = false;
  const pending = controller.keyboardState({ timeoutMs: 50 });
  await new Promise((resolve) => setImmediate(resolve));
  ssap.subscription.options.onUpdate({ currentWidget: { focus: true } });
  const result = await pending;
  assert.equal(result.currentWidget.focus, true);
  assert.equal(ssap.subscription.uri, 'ssap://com.webos.service.ime/registerRemoteKeyboard');
  await controller.typeText('first'); await controller.typeText('second');
  assert.equal(ssap.subscriptionCount, 1);
  assert.equal(ssap.unsubscribed, undefined);
  await controller.sendEnter();
  assert.equal(ssap.calls.at(-1).uri, 'ssap://com.webos.service.ime/sendEnterKey');
  controller.close();
  assert.equal(ssap.unsubscribed, true);
});

test('typeText never inserts on bare subscription acknowledgement or focus:false', async () => {
  for (const focusPayload of [undefined, { currentWidget: { focus: false, value: 'private-widget-value' } }]) {
    const { controller, ssap } = harness();
    await controller.connect();
    ssap.autoFocus = false;
    await controller.startKeyboard();
    const textValue = 'private-text-never-echo';
    const rejected = assert.rejects(controller.typeText(textValue, { timeoutMs: 15 }), (error) => error.code === 'IME_FOCUS_UNVERIFIED' &&
      !error.message.includes(textValue) && !JSON.stringify(error).includes('private-widget-value'));
    await new Promise((resolve) => setImmediate(resolve));
    if (focusPayload) ssap.subscription.options.onUpdate(focusPayload);
    await rejected;
    assert.equal(ssap.calls.some((call) => call.uri.endsWith('/insertText')), false);
    controller.close();
  }
});

test('typeText fails fast on focus:false and a later explicit insertion never returns input contents', async () => {
  const privateText = 'sensitive-text-value';
  const { controller, ssap } = harness(() => ({ returnValue: true, text: privateText, currentWidget: { value: privateText } }));
  await controller.connect();
  ssap.autoFocus = false;
  await controller.startKeyboard();
  ssap.subscription.options.onUpdate({ currentWidget: { focus: false } });
  await assert.rejects(controller.typeText(privateText), { code: 'IME_FOCUS_UNVERIFIED' });
  assert.equal(ssap.calls.length, 0);
  ssap.subscription.options.onUpdate({ currentWidget: { focus: true, value: privateText, text: privateText } });
  const result = await controller.typeText(privateText, { replace: true });
  assert.deepEqual(result, { returnValue: true, focusConfirmed: true, insertionConfirmed: false });
  assert.equal(ssap.calls.filter((call) => call.uri.endsWith('/insertText')).length, 1);
  const state = await controller.keyboardState();
  assert.deepEqual(state, { currentWidget: { focus: true } });
  assert.equal(JSON.stringify({ result, state }).includes(privateText), false);
  controller.close();
});

test('focus loss before queued insertion blocks text; explicit sendEnter remains independent', async () => {
  const { controller, ssap } = harness();
  await controller.connect();
  ssap.autoFocus = false;
  await controller.startKeyboard();
  ssap.subscription.options.onUpdate({ currentWidget: { focus: true } });
  const pending = controller.typeText('must-not-send', { timeoutMs: 100 });
  ssap.subscription.options.onUpdate({ currentWidget: { focus: false } });
  await assert.rejects(pending, { code: 'IME_NOT_FOCUSED' });
  assert.equal(ssap.calls.length, 0);
  await controller.sendEnter();
  assert.deepEqual(ssap.calls.map((call) => call.uri), ['ssap://com.webos.service.ime/sendEnterKey']);
  controller.close();
});

test('pointer is lazy, shared across concurrent commands, and sends exact terminated frames', async () => {
  const { controller, ssap, sockets } = harness(() => ({ socketPath: `wss://${HOST}:3001/resources/pointer` }));
  assert.equal(sockets.length, 0);
  await controller.connect();
  const results = await Promise.all([controller.key('home'), controller.move(10, -20)]);
  await controller.click(); await controller.scroll(0, 3);
  assert.equal(sockets.length, 1);
  assert.equal(ssap.calls.length, 1);
  assert.equal(ssap.calls[0].uri, 'ssap://com.webos.service.networkinput/getPointerInputSocket');
  assert.deepEqual(sockets[0].frames, [
    'type:button\nname:HOME\n\n', 'type:move\ndx:10\ndy:-20\ndown:0\n\n', 'type:click\n\n', 'type:scroll\ndx:0\ndy:3\n\n',
  ]);
  assert.notEqual(sockets[0].options.rejectUnauthorized, false);
  assert.deepEqual(results[0], { sent: true, transport: 'pointer', acknowledged: false });
  controller.close();
  assert.equal(sockets[0].readyState, 3);
  await assert.rejects(controller.click(), { code: 'NOT_REGISTERED' });
});

test('pointer URLs cannot cause an external connection, URL-credential leak or injection', async () => {
  const { controller, sockets } = harness(() => ({ socketPath: 'wss://example.com/pointer' }));
  await controller.connect();
  await assert.rejects(controller.key('HOME'), { code: 'INVALID_POINTER_URL' });
  assert.equal(sockets.length, 0);
  for (const value of ['http://192.168.30.40/', `wss://user:password@${HOST}/`, `ws://${HOST}/#fragment`]) {
    assert.throws(() => validatePointerURL(value, HOST), { code: 'INVALID_POINTER_URL' });
  }
  controller.close();
});

test('pointer connection timeout terminates socket and never sends input', async () => {
  let socket;
  const { controller } = harness(() => ({ socketPath: `ws://${HOST}:3000/pointer` }), { timeoutMs: 5,
    pointerWebSocketFactory: () => {
      socket = new EventEmitter(); socket.frames = [];
      socket.terminate = () => { socket.closed = true; socket.emit('close'); };
      return socket;
    },
  });
  await controller.connect();
  await assert.rejects(controller.key('HOME'), { code: 'TIMEOUT' });
  assert.equal(socket.closed, true);
  assert.deepEqual(socket.frames, []);
  controller.close();
});

test('half-open pointer send is discarded without replay while SSAP remains registered', async () => {
  const sockets = []; let late;
  const { controller, ssap } = harness(() => ({ socketPath: `wss://${HOST}:3001/pointer` }), { timeoutMs: 5,
    pointerWebSocketFactory: () => {
      const socket = new FakePointer(); sockets.push(socket);
      if (sockets.length === 1) socket.send = (frame, callback) => { socket.frames.push(frame); late = callback; };
      return socket;
    } });
  await controller.connect();
  await assert.rejects(controller.key('DOWN'), { code: 'TIMEOUT' });
  assert.equal(sockets[0].readyState, 3);
  assert.equal(ssap.registered, true);
  await controller.key('UP'); late();
  assert.deepEqual(sockets[0].frames, ['type:button\nname:DOWN\n\n']);
  assert.deepEqual(sockets[1].frames, ['type:button\nname:UP\n\n']);
  await controller.key('LEFT');
  assert.equal(sockets.length, 2);
  controller.close();
});

test('Wake-on-LAN builds a proper magic packet and rejects invalid/multicast MACs', () => {
  const packet = createMagicPacket('44:66:88:AA:CC:EE');
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 0xff));
  for (let index = 0; index < 16; index++) assert.equal(packet.subarray(6 + index * 6, 12 + index * 6).toString('hex'), '446688aaccee');
  for (const value of ['bad', '00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF', '01:00:5E:00:00:01']) assert.throws(() => createMagicPacket(value), { code: 'INVALID_MAC' });
});

test('Wake-on-LAN binds the selected local interface and sends exactly one local datagram', async () => {
  const sent = []; let binding; let closed = false;
  const result = await wakeTV('44:66:88:AA:CC:EE', { broadcast: '192.168.30.255', bindAddress: '192.168.30.2',
    socketFactory: () => {
      const socket = new EventEmitter();
      socket.bind = (port, address, callback) => { binding = { port, address }; callback(); };
      socket.setBroadcast = (enabled) => assert.equal(enabled, true);
      socket.send = (packet, port, address, callback) => { sent.push({ packet, port, address }); callback(); };
      socket.close = () => { closed = true; };
      return socket;
    },
  });
  assert.deepEqual(binding, { port: 0, address: '192.168.30.2' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].port, 9);
  assert.equal(sent[0].address, '192.168.30.255');
  assert.equal(closed, true);
  assert.equal(result.acknowledged, false);
  await assert.rejects(wakeTV('44:66:88:AA:CC:EE', { broadcast: '8.8.8.8' }), { code: 'INVALID_HOST' });
});

test('extended unsigned grants include ordinary controls but exclude firmware and test grants', () => {
  assert.ok(CONTROL_PERMISSIONS.every((permission) => EXTENDED_PERMISSIONS.includes(permission)));
  assert.ok(EXTENDED_PERMISSIONS.includes('WRITE_SETTINGS'));
  assert.ok(EXTENDED_PERMISSIONS.includes('READ_LGE_SDX'));
  assert.equal(EXTENDED_PERMISSIONS.some((permission) => permission.startsWith('TEST_')), false);
  assert.equal(EXTENDED_PERMISSIONS.includes('UPDATE_FROM_REMOTE_APP'), false);
});

test('DLNA control connects lazily once without SSAP and preserves verified results', async () => {
  const calls = []; let connects = 0; let closes = 0;
  const playing = { requestAccepted: true, confirmed: true, playbackVerified: true,
    transportConfirmed: true, transportState: 'PLAYING' };
  const paused = { requestAccepted: true, confirmed: true, playbackVerified: false,
    transportConfirmed: true, transportState: 'PAUSED_PLAYBACK' };
  const dlnaClient = {
    connect: async () => { connects++; await new Promise((resolve) => setImmediate(resolve)); },
    status: async () => { calls.push(['status']); return { transportState: 'STOPPED' }; },
    play: async (...args) => { calls.push(['play', ...args]); return playing; },
    media: async (action) => { calls.push(['media', action]); return paused; },
    close: () => { closes++; },
  };
  const { controller, ssap } = harness(undefined, { dlnaClient });
  assert.equal(connects, 0);
  await Promise.all([controller.dlnaStatus(), controller.dlnaStatus()]);
  assert.equal(connects, 1);
  assert.equal(ssap.registered, false);
  assert.equal(ssap.calls.length, 0);
  assert.deepEqual(await controller.dlnaPlay('http://192.168.30.2/video.mp4', { mimeType: 'video/mp4', title: 'Local video' }), playing);
  assert.deepEqual(await controller.dlnaMedia('pause'), paused);
  assert.deepEqual(calls.at(-2), ['play', 'http://192.168.30.2/video.mp4', { mimeType: 'video/mp4', title: 'Local video' }]);
  assert.deepEqual(calls.at(-1), ['media', 'pause']);
  controller.close();
  assert.equal(closes, 1);
  assert.equal(calls.some((call) => call[0] === 'media' && call[1] === 'stop'), false);
  await assert.rejects(controller.dlnaStatus(), { code: 'CLIENT_CLOSED' });
});

test('DLNA wrapper validates before connecting and preserves uncertain mutation errors without retry', async () => {
  let connects = 0; let mutations = 0;
  const { controller } = harness(undefined, { dlnaClient: {
    connect: async () => { connects++; },
    play: async () => { mutations++; throw Object.assign(new Error(`timeout ${KEY}`), {
      code: 'TIMEOUT', uncertain: true, upnpError: { errorCode: 714, errorDescription: `UPnP ${KEY}` },
      payload: { privateKey: KEY },
    }); },
    close: () => {},
  } });
  assert.throws(() => controller.dlnaPlay('file:///tmp/video', { mimeType: 'video/mp4' }), SSAPError);
  assert.throws(() => controller.dlnaPlay('https://example.com/video', { mimeType: 'bad' }), SSAPError);
  assert.throws(() => controller.dlnaMedia('rewind'), SSAPError);
  assert.equal(connects, 0);
  await assert.rejects(controller.dlnaPlay('http://192.168.30.2/video.mp4', { mimeType: 'video/mp4' }), (error) =>
    error.code === 'TIMEOUT' && error.uncertain === true && error.upnpError.errorCode === 714 &&
    !error.message.includes(KEY) && !JSON.stringify(error).includes(KEY));
  assert.equal(connects, 1);
  assert.equal(mutations, 1);
  controller.close();
});

test('DLNA CLI routes skip SSAP registration and carry the saved network interface', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lg-dlna-cli-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, '.lg-tv.local.json'), JSON.stringify({ schemaVersion: 1, devices: { [HOST]: {
    clientKey: KEY, permissions: [...CONTROL_PERMISSIONS], profile: 'control', secure: true, port: 3001,
    wake: { broadcast: '192.168.30.255', bindAddress: '192.168.30.2' },
  } } }));
  let registrations = 0; const calls = []; const logs = []; const optionsSeen = [];
  const execution = { baseDirectory: directory, stdout: (value) => logs.push(value), stderr: (value) => logs.push(value),
    resolveKey: async profile => profile.clientKey, protectKey: async profile => profile,
    controllerFactory: (options) => {
      optionsSeen.push(options);
      return { connect: async () => { registrations++; throw new Error('Must not register SSAP'); },
        dlnaStatus: async () => { calls.push(['status']); return { transportState: 'STOPPED' }; },
        dlnaPlay: async (...args) => { calls.push(['play', ...args]); return { playbackVerified: true, transportState: 'PLAYING' }; },
        dlnaMedia: async (action) => { calls.push(['media', action]); return { transportConfirmed: true, transportState: 'PAUSED_PLAYBACK' }; },
        sanitize: (value) => redact(value, [KEY]), close: () => {},
      };
    },
  };
  assert.equal(await main(['dlna-status', '--host', HOST], execution), 0);
  assert.equal(await main(['dlna-play', '--host', HOST, '--url', 'http://192.168.30.2/a.mp4', '--mime', 'video/mp4', '--title', 'A'], execution), 0);
  assert.equal(await main(['dlna-media', '--host', HOST, '--action', 'pause'], execution), 0);
  assert.equal(registrations, 0);
  assert.equal(optionsSeen[0].wake.bindAddress, '192.168.30.2');
  assert.equal(optionsSeen[0].dlnaTimeoutMs, 15000);
  assert.deepEqual(calls, [['status'], ['play', 'http://192.168.30.2/a.mp4', { mimeType: 'video/mp4', title: 'A' }], ['media', 'pause']]);
  assert.equal(logs.join('\n').includes(KEY), false);
});
