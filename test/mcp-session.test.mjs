import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TVMcpServer, PROTOCOL_VERSION, compactApps, runStdio } from '../mcp-tv.mjs';

const config = () => ({ host: '192.168.50.40', clientKey: 'synthetic-only-key', certificatePin: 'a'.repeat(64), secure: true,
  permissions: ['TEST'], registrationManifest: { manifestVersion: 1, permissions: ['TEST'] },
  allowTemporaryObserver: true, mediaRoots: [path.resolve('assets')], allowedUrlOrigins: ['https://example.org'], wake: { bindAddress: '192.168.50.2' } });
const call = (name, args = {}, id = name) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const decoded = response => JSON.parse(response.result.content[0].text).result;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const focus = generation => ({ subscribed: true, pending: false, focusKnown: true, focused: true, fresh: true, generation, observedAt: '2026-10-20T00:00:00.000Z', ageMs: 0 });

async function fixture(options = {}) {
  const calls = [], controllers = [], hosts = []; let current = config(), loads = 0;
  const server = new TVMcpServer({ cleanupTimeoutMs: 20,
    loadConfig: async () => { loads++; if (current instanceof Error) throw current; return current; },
    controllerFactory: async selected => {
      calls.push(['factory', selected]);
      const controller = { registered: false, closed: false, connects: 0,
        async connect(options) { assert.deepEqual(options, { allowPairing: false }); if (!this.registered) this.connects++; this.registered = true; },
        async close() { calls.push(['close', this]); this.closed = true; this.registered = false; },
        async status() { calls.push(['status', this]); return { foreground: { status: 'ok', payload: { appId: 'synthetic.app' } } }; },
        async key(key) { calls.push(['key', key, this]); return { returnValue: true }; },
        async dlnaPlay() { calls.push(['dlnaPlay', this]); return { confirmed: true, transportState: 'PLAYING' }; },
        async dlnaStatus() { calls.push(['dlnaStatus', this]); return { transportState: 'STOPPED' }; },
        async apps() { return { launchPoints: [{ id: 'synthetic.app', title: 'Synthetic', icon: 'private-icon' }] }; },
        async observeKeyboard() { return focus(1); },
      };
      controllers.push(controller); return controller;
    },
    mediaHostFactory: async () => {
      const host = { closes: 0, async close() { this.closes++; }, async serve() { return { url: 'http://192.168.50.2:12345/synthetic.mp4', mimeType: 'video/mp4', bytes: 12 }; } };
      hosts.push(host); return host;
    }, ...options });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { server, controllers, hosts, calls, get loads() { return loads; }, set config(value) { current = value; } };
}

test('one controller and registration are reused while every request reloads config and exposes only numeric timings', async () => {
  const f = await fixture();
  for (const name of ['tv_status', 'tv_apps', 'tv_key']) {
    const response = await f.server.handle(call(name, name === 'tv_key' ? { key: 'HOME' } : {})); assert.equal(response.result.isError, false);
    assert.deepEqual(Object.keys(response.result._meta.timings).sort(), ['configLoadMs', 'controllerReadyMs', 'queueWaitMs', 'totalMs'].sort());
    assert.equal(Object.values(response.result._meta.timings).every(value => Number.isFinite(value) && value >= 0), true);
    assert.equal(JSON.stringify(response).includes(config().clientKey), false);
  }
  assert.equal(f.loads, 3); assert.equal(f.controllers.length, 1); assert.equal(f.controllers[0].connects, 1); assert.equal(f.controllers[0].closed, false);
  await f.server.close(); await f.server.close(); assert.equal(f.calls.filter(item => item[0] === 'close').length, 1);
});

test('each selected identity, credential, pin, authority or local policy change retires the old session before another effect', async () => {
  for (const change of [{ host: '192.168.50.41' }, { clientKey: 'replacement-synthetic-key' }, { certificatePin: 'b'.repeat(64) },
    { permissions: ['OTHER'] }, { registrationManifest: { manifestVersion: 1, permissions: ['OTHER'] } }, { secure: false },
    { wake: { bindAddress: '192.168.50.3' } }, { allowTemporaryObserver: false }, { mediaRoots: [] }, { allowedUrlOrigins: [] }]) {
    const f = await fixture(); await f.server.handle(call('tv_status')); f.config = { ...config(), ...change };
    const result = await f.server.handle(call('tv_key', { key: 'HOME' })); assert.equal(result.result.isError, false);
    assert.equal(f.controllers.length, 2); assert.equal(f.controllers[0].closed, true);
    assert.ok(f.calls.findIndex(item => item[0] === 'close') < f.calls.findLastIndex(item => item[0] === 'factory'));
    assert.equal(f.calls.filter(item => item[0] === 'key').length, 1); await f.server.close();
  }
});

test('config is checked after effect-queue waiting; revoked URL policy cannot use the previous session', async () => {
  const f = await fixture(); await f.server.handle(call('tv_status')); const gate = deferred(), entered = deferred();
  f.controllers[0].key = async () => { entered.resolve(); await gate.promise; return { returnValue: true }; };
  const first = f.server.handle(call('tv_key', { key: 'HOME' }, 1)); await entered.promise;
  const queued = f.server.handle(call('tv_open_url', { url: 'https://example.org/movie' }, 2)); f.config = { ...config(), allowedUrlOrigins: [] }; gate.resolve();
  await first; assert.equal((await queued).result.isError, true); assert.equal(f.controllers[0].closed, true); assert.equal(f.controllers.length, 1);
  await f.server.close();
});

test('missing config and executable config values invalidate a warm session without executing callbacks', async () => {
  let invoked = 0;
  const values = [new Error('synthetic private loader detail'), { ...config(), get permissions() { invoked++; return ['TEST']; } },
    { ...config(), registrationManifest: { toJSON() { invoked++; return {}; } } }, new Proxy(config(), { ownKeys() { invoked++; return []; } })];
  for (const value of values) {
    const f = await fixture(); await f.server.handle(call('tv_status')); f.config = value;
    const response = await f.server.handle(call('tv_key', { key: 'HOME' })); assert.equal(response.result.isError, true);
    assert.equal(f.controllers[0].closed, true); assert.equal(f.controllers.length, 1); assert.equal(f.calls.some(item => item[0] === 'key'), false);
    assert.equal(JSON.stringify(response).includes('synthetic private loader detail'), false); await f.server.close();
  }
  assert.equal(invoked, 0);
});

test('disconnected sessions are replaced on the next explicit request; ambiguous effects are never replayed', async () => {
  const f = await fixture(); await f.server.handle(call('tv_status')); f.controllers[0].registered = false;
  await f.server.handle(call('tv_status')); assert.equal(f.controllers.length, 2); assert.equal(f.controllers[0].closed, true);
  let effects = 0; f.controllers[1].key = async () => { effects++; throw Object.assign(Error('synthetic ambiguous transport failure'), { code: 'CONNECTION_CLOSED' }); };
  assert.equal((await f.server.handle(call('tv_key', { key: 'ENTER' }))).result.isError, true); assert.equal(effects, 1); assert.equal(f.controllers[1].closed, true);
  await f.server.handle(call('tv_status')); assert.equal(f.controllers.length, 3); assert.equal(effects, 1); await f.server.close();
});

test('compact applications omit icons, URLs and vendor data and never execute getters or proxies', () => {
  let callbacks = 0;
  const apps = [{ id: 'synthetic.app', title: 'Synthetic', icon: 'private-icon', params: { token: 'private-token' } }, { id: 'synthetic.app', title: 'duplicate' },
    { id: 'invalid/id', title: 'invalid' }, { get id() { callbacks++; return 'getter.app'; } }, new Proxy({}, { getOwnPropertyDescriptor() { callbacks++; } })];
  assert.deepEqual(compactApps({ launchPoints: apps }), { apps: [{ id: 'synthetic.app', title: 'Synthetic' }], truncated: false });
  assert.deepEqual(compactApps({ get launchPoints() { callbacks++; return apps; } }), { apps: [], truncated: false });
  const many = compactApps({ launchPoints: Array.from({ length: 300 }, (_, i) => ({ id: `synthetic.${i}`, title: 'x'.repeat(300) })) });
  assert.equal(many.apps.length, 256); assert.equal(many.apps[0].title.length, 256); assert.equal(many.truncated, true); assert.equal(callbacks, 0);
});

test('explicit media release works without TV or configuration and never claims TV playback stopped', async () => {
  const f = await fixture(); await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }));
  f.config = new Error('configuration unavailable'); const before = f.calls.length;
  const response = await f.server.handle(call('tv_release_media')); assert.equal(response.result.isError, false);
  assert.deepEqual(decoded(response), { localMediaReleased: true, ownedMediaHostsRemaining: 0, tvPlaybackStopped: false, verificationScope: 'local_media_host_only' });
  assert.equal(f.hosts[0].closes, 1); assert.equal(f.calls.slice(before).some(item => ['factory', 'dlnaStatus', 'dlnaPlay', 'key'].includes(item[0])), false);
  assert.equal(decoded(await f.server.handle(call('tv_release_media'))).localMediaReleased, true); await f.server.close();
});

test('failed or stalled media cleanup retains ownership, reports failure and does not duplicate an in-flight close', async () => {
  const f = await fixture(); await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') })); const completion = deferred();
  f.hosts[0].close = async () => { f.hosts[0].closes++; await completion.promise; };
  const failed = await f.server.handle(call('tv_release_media')); assert.equal(failed.result.isError, true); assert.equal(decoded(failed).localMediaReleased, false);
  assert.equal(decoded(failed).ownedMediaHostsRemaining, 1); assert.equal(f.server.mediaHost, f.hosts[0]);
  const again = await f.server.handle(call('tv_release_media')); assert.equal(again.result.isError, true); assert.equal(f.hosts[0].closes, 1);
  completion.resolve(); await tick(); assert.equal(decoded(await f.server.handle(call('tv_release_media'))).localMediaReleased, true); await f.server.close();
});

test('stuck controller cleanup denies replacing a session instead of dispatching through an unclosed identity', async () => {
  const f = await fixture(); await f.server.handle(call('tv_status')); const completion = deferred();
  f.controllers[0].close = () => completion.promise; f.config = { ...config(), clientKey: 'replacement-synthetic-key' };
  assert.equal((await f.server.handle(call('tv_key', { key: 'HOME' }))).result.isError, true); assert.equal(f.controllers.length, 1); assert.equal(f.calls.some(item => item[0] === 'key'), false);
  completion.resolve(); await tick(); await f.server.close();
});

test('config failure with a leftover media host blocks every recovered target until that host cleanup succeeds', async () => {
  const f = await fixture(); await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }));
  f.hosts[0].close = async () => { throw Error('synthetic cleanup failure'); }; f.config = new Error('invalid synthetic configuration');
  assert.equal((await f.server.handle(call('tv_status'))).result.isError, true); assert.equal(f.controllers[0].closed, true);
  f.config = { ...config(), host: '192.168.50.41' };
  assert.equal((await f.server.handle(call('tv_key', { key: 'HOME' }))).result.isError, true);
  assert.equal(f.controllers.length, 1); assert.equal(f.calls.some(item => item[0] === 'key'), false);
  f.hosts[0].close = async () => {}; assert.equal((await f.server.handle(call('tv_status'))).result.isError, false); assert.equal(f.controllers.length, 2);
  await f.server.close();
});

test('an unconfirmed cast reports failed candidate cleanup and retains that resource for explicit release', async () => {
  const f = await fixture(); await f.server.handle(call('tv_status'));
  f.controllers[0].dlnaPlay = async () => ({ confirmed: false, uncertain: true, transportState: 'TRANSITIONING' });
  const host = { async serve() { return { url: 'http://192.168.50.2/synthetic.mp4', mimeType: 'video/mp4', bytes: 12 }; }, async close() { throw Error('synthetic cleanup failure'); } };
  f.server.mediaHostFactory = async () => host;
  const response = await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }));
  assert.equal(response.result.isError, true); assert.match(decoded(response).cleanupWarning, /could not be closed/);
  assert.equal(decoded(await f.server.handle(call('tv_release_media'))).ownedMediaHostsRemaining, 1);
  host.close = async () => {}; assert.equal(decoded(await f.server.handle(call('tv_release_media'))).localMediaReleased, true); await f.server.close();
});

test('two outstanding hosts block another cast before host creation or DLNA dispatch when old cleanup fails', async () => {
  const f = await fixture(); await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }));
  f.hosts[0].close = async () => { throw Error('synthetic cleanup failure'); };
  const replacement = await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }));
  assert.equal(replacement.result.isError, false); assert.match(decoded(replacement).cleanupWarning, /could not be closed/);
  assert.equal((await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }))).result.isError, true);
  assert.equal(f.hosts.length, 2); assert.equal(f.calls.filter(item => item[0] === 'dlnaPlay').length, 2);
  f.hosts[0].close = async () => {}; await f.server.close();
});

test('focus waits release the effect queue and revalidate configuration before returning boolean evidence', async () => {
  const f = await fixture(); await f.server.handle(call('tv_status')); const pending = deferred(), entered = deferred();
  f.controllers[0].observeKeyboard = options => { if (options.waitMs) { entered.resolve(); return pending.promise; } return Promise.resolve(focus(2)); };
  const observation = f.server.handle(call('tv_keyboard_state', { waitMs: 30000 }, 'focus')); await entered.promise;
  assert.equal((await f.server.handle(call('tv_key', { key: 'SEARCH' }))).result.isError, false); pending.resolve(focus(1));
  assert.equal(decoded(await observation).generation, 2); assert.equal(f.loads, 4); await f.server.close();
});

test('a focus wait cannot return evidence for a configuration replaced during the wait', async () => {
  const f = await fixture(); await f.server.handle(call('tv_status')); const pending = deferred(), entered = deferred();
  f.controllers[0].observeKeyboard = options => { if (options.waitMs) { entered.resolve(); return pending.promise; } return Promise.resolve(focus(1)); };
  const observation = f.server.handle(call('tv_keyboard_state', { waitMs: 30000 })); await entered.promise;
  f.config = { ...config(), certificatePin: 'b'.repeat(64) }; pending.resolve(focus(1)); assert.equal((await observation).result.isError, true); assert.equal(f.controllers[0].closed, true); await f.server.close();
});

test('stdio reads navigation while focus waits and cancels remaining focus waits at EOF', { timeout: 2000 }, async () => {
  const f = await fixture(); await f.server.handle(call('tv_status')); const started = deferred(), navigated = deferred(), pending = deferred();
  f.controllers[0].observeKeyboard = options => {
    if (!options.waitMs) return Promise.resolve(focus(2));
    options.signal.addEventListener('abort', () => pending.reject(Object.assign(Error('cancelled'), { code: 'ABORT_ERR' })), { once: true }); started.resolve(); return pending.promise;
  };
  f.controllers[0].key = async () => { navigated.resolve(); return { returnValue: true }; };
  const input = new PassThrough(), responses = [];
  const output = new Writable({ write(chunk, _encoding, done) { responses.push(JSON.parse(chunk.toString())); done(); } });
  const running = runStdio({ input, output, server: f.server });
  input.write(JSON.stringify(call('tv_keyboard_state', { waitMs: 30000 }, 'focus')) + '\n'); await started.promise;
  input.write(JSON.stringify(call('tv_key', { key: 'SEARCH' }, 'navigation')) + '\n'); await navigated.promise;
  input.end(); await running;
  assert.equal(responses.find(item => item.id === 'navigation').result.isError, false); assert.equal(responses.find(item => item.id === 'focus').result.isError, true);
  assert.equal(f.controllers[0].closed, true); assert.equal(responses.length, 2);
});

test('a real stdout write error still closes its retained media host and controller exactly once', { timeout: 1000 }, async () => {
  const f = await fixture(); await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }));
  const input = new PassThrough(), output = new Writable({ write(_chunk, _encoding, done) { done(Error('synthetic stdout failure')); } });
  const running = runStdio({ input, output, server: f.server, outputTimeoutMs: 20 }), denied = assert.rejects(running, /MCP output transport failed/);
  input.end(JSON.stringify(call('tv_status')) + '\n'); await denied;
  assert.equal(f.hosts[0].closes, 1); assert.equal(f.controllers[0].closed, true); assert.equal(f.calls.filter(item => item[0] === 'close').length, 1);
});

test('stdout closing without a write callback or drain cannot trap retained local resources', { timeout: 1000 }, async () => {
  const f = await fixture(); await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') })); const written = deferred();
  const input = new PassThrough(), output = new Writable({ highWaterMark: 1, write() { written.resolve(); } });
  const running = runStdio({ input, output, server: f.server, outputTimeoutMs: 20 }), denied = assert.rejects(running, /MCP output transport failed/);
  input.write(JSON.stringify(call('tv_status')) + '\n'); await written.promise; output.destroy(); await denied;
  assert.equal(f.hosts[0].closes, 1); assert.equal(f.controllers[0].closed, true); assert.equal(f.calls.filter(item => item[0] === 'close').length, 1);
});

test('a stdout write with no callback, close or drain reaches its deadline and still releases local resources', { timeout: 1000 }, async () => {
  const f = await fixture(); await f.server.handle(call('tv_cast_file', { filePath: path.resolve('synthetic.mp4') }));
  const input = new PassThrough(), output = new Writable({ highWaterMark: 1, write() {} });
  const running = runStdio({ input, output, server: f.server, outputTimeoutMs: 20 }), denied = assert.rejects(running, /MCP output transport failed/);
  input.write(JSON.stringify(call('tv_status')) + '\n'); await denied; output.destroy();
  assert.equal(f.hosts[0].closes, 1); assert.equal(f.controllers[0].closed, true); assert.equal(f.calls.filter(item => item[0] === 'close').length, 1);
});

test('broken stdout while connection preparation is pending prevents a late command after connect resolves', { timeout: 1000 }, async () => {
  const entered = deferred(), connected = deferred(), broken = deferred(); let effects = 0, closes = 0;
  const controller = { async connect() { entered.resolve(); await connected.promise; }, async close() { closes++; }, async key() { effects++; return { returnValue: true }; } };
  const f = await fixture({ controllerFactory: async () => controller });
  const input = new PassThrough(), output = new Writable({ write(_chunk, _encoding, done) { done(Error('synthetic output failure')); broken.resolve(); } });
  const running = runStdio({ input, output, server: f.server, outputTimeoutMs: 20 }), denied = assert.rejects(running, /MCP output transport failed/);
  input.write(JSON.stringify(call('tv_key', { key: 'SEARCH' })) + '\n'); await entered.promise;
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'ping' }) + '\n'); await broken.promise; await tick(); connected.resolve(); await denied;
  assert.equal(effects, 0); assert.equal(closes, 1);
});

test('broken stdout during real controller pointer preparation denies the final send and closes the prepared socket', { timeout: 1000 }, async t => {
  let TVController;
  try { ({ TVController } = await import('../lib/tv-controller.mjs')); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("package 'ws'")) { t.skip('Optional pinned LG ws dependency is not installed; no production transport was imported.'); return; } throw error; }
  const entered = deferred(), pointerReply = deferred(), broken = deferred(), sockets = []; let frames = 0, closes = 0;
  const ssap = { registered: false, timeoutMs: 100, sanitize: value => value,
    async connect() { this.registered = true; }, close() { this.registered = false; closes++; },
    async request() { entered.resolve(); await pointerReply.promise; return { returnValue: true, socketPath: `wss://${config().host}:3001/pointer` }; } };
  const f = await fixture({ controllerFactory: async options => new TVController({ ...options, ssapClient: ssap, pointerWebSocketFactory: () => {
    const socket = new EventEmitter(); socket.readyState = 1; sockets.push(socket); socket.send = (_frame, callback) => { frames++; callback(); };
    socket.terminate = () => { socket.readyState = 3; }; queueMicrotask(() => socket.emit('open')); return socket;
  } }) });
  const input = new PassThrough(), output = new Writable({ write(_chunk, _encoding, done) { done(Error('synthetic output failure')); broken.resolve(); } });
  const running = runStdio({ input, output, server: f.server, outputTimeoutMs: 20 }), denied = assert.rejects(running, /MCP output transport failed/);
  input.write(JSON.stringify(call('tv_key', { key: 'SEARCH' })) + '\n'); await entered.promise;
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'ping' }) + '\n'); await broken.promise; await tick(); pointerReply.resolve(); await denied;
  assert.equal(frames, 0); assert.equal(closes, 1); assert.equal(sockets.every(socket => socket.readyState === 3), true);
});

test('MCP with the real controller distinguishes subscription ACK, follows navigation to a real focus event and then permits typing', { timeout: 2000 }, async t => {
  let TVController;
  try { ({ TVController } = await import('../lib/tv-controller.mjs')); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("package 'ws'")) { t.skip('Optional pinned LG ws dependency is not installed; no production transport was imported.'); return; } throw error; }
  const writes = [], subscriptions = [], sockets = []; let searched = false, registrations = 0, factories = 0;
  const ssap = { registered: false, timeoutMs: 100,
    async connect() { if (!this.registered) registrations++; this.registered = true; }, close() { this.registered = false; }, sanitize(value) { return value; },
    async request(uri, payload) { writes.push({ uri, payload }); return { returnValue: true, socketPath: `wss://${config().host}:3001/pointer` }; },
    async subscribe(uri, _payload, options) {
      const subscription = { uri, options, unsubscribe() { this.closed = true; } }; subscriptions.push(subscription);
      if (uri.endsWith('/getForegroundAppInfo')) options.onUpdate({ appId: 'synthetic.app' });
      options.onUpdate({ subscribed: true });
      if (searched && uri.endsWith('/registerRemoteKeyboard')) options.onUpdate({ currentWidget: { focus: true, text: 'private-widget-text' } });
      return subscription;
    } };
  const f = await fixture({ controllerFactory: async options => {
    factories++; return new TVController({ ...options, ssapClient: ssap, pointerWebSocketFactory: () => {
      const socket = new EventEmitter(); socket.readyState = 1; sockets.push(socket);
      socket.send = (frame, callback) => { assert.match(frame, /name:SEARCH/); searched = true; callback(); };
      socket.terminate = () => { socket.readyState = 3; }; queueMicrotask(() => socket.emit('open')); return socket;
    } });
  } });
  const initial = await f.server.handle(call('tv_keyboard_state')); assert.equal(initial.result.isError, false); assert.equal(decoded(initial).focusKnown, false);
  await tick(); assert.equal(subscriptions.length, 2); assert.equal(decoded(await f.server.handle(call('tv_keyboard_state'))).focused, null);
  const waiting = f.server.handle(call('tv_keyboard_state', { waitMs: 1000 })); await tick();
  assert.equal((await f.server.handle(call('tv_key', { key: 'SEARCH' }))).result.isError, false);
  const observed = await waiting; assert.equal(observed.result.isError, false); assert.equal(decoded(observed).focused, true);
  const typed = await f.server.handle(call('tv_type_text', { text: 'Synthetic movie', replace: true })); assert.equal(typed.result.isError, false);
  assert.equal(writes.filter(item => item.uri.endsWith('/insertText')).length, 1); assert.equal(factories, 1); assert.equal(registrations, 1);
  assert.equal(JSON.stringify([initial, observed, typed]).includes('private-widget-text'), false);
  await f.server.close(); assert.equal(ssap.registered, false); assert.equal(sockets.every(socket => socket.readyState === 3), true); assert.equal(subscriptions.every(subscription => subscription.closed), true);
});
