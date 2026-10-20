import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TVController, KEYBOARD_MAX_AGE_MS } from '../lib/tv-controller.mjs';

const FOREGROUND = 'ssap://com.webos.applicationManager/getForegroundAppInfo';
const IME = 'ssap://com.webos.service.ime/registerRemoteKeyboard';
const INSERT = 'ssap://com.webos.service.ime/insertText';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture({ focus, foreground = true, delayed = false, request } = {}) {
  const subscriptions = [], writes = [], sockets = [];
  let time = 100;
  const client = { registered: true, timeoutMs: 100,
    sanitize: value => value, close() { this.registered = false; },
    async request(uri, payload) { writes.push({ uri, payload }); return request ? request(uri, payload) : { returnValue: true, socketPath: 'wss://192.168.30.40:3001/pointer' }; },
    subscribe(uri, _payload, options) {
      const subscription = { uri, options, unsubscribed: false, unsubscribe() { this.unsubscribed = true; } };
      subscriptions.push(subscription);
      if (uri === FOREGROUND && foreground) options.onUpdate({ appId: 'com.fixture.app' });
      options.onUpdate({ subscribed: true });
      if (uri === IME && focus !== undefined) options.onUpdate({ currentWidget: { focus, value: 'private-initial-widget' } });
      if (delayed) return new Promise(resolve => { subscription.acknowledge = () => resolve(subscription); });
      return Promise.resolve(subscription);
    },
  };
  const controller = new TVController({ host: '192.168.30.40', ssapClient: client, keyboardNowFn: () => time,
    pointerWebSocketFactory: () => {
      const socket = new EventEmitter(); socket.readyState = 1; socket.terminate = () => {};
      socket.send = (_frame, callback) => callback(); sockets.push(socket);
      queueMicrotask(() => socket.emit('open')); return socket;
    } });
  const latest = uri => subscriptions.filter(subscription => subscription.uri === uri).at(-1);
  return { controller, client, subscriptions, writes, sockets, latest, advance: amount => { time += amount; },
    update: payload => latest(IME).options.onUpdate(payload) };
}

test('immediate observation returns pending metadata before acknowledgement and never invents focus', async () => {
  const f = fixture({ delayed: true });
  const first = await f.controller.observeKeyboard();
  assert.equal(first.pending, true); assert.equal(first.subscribed, false); assert.equal(first.focusKnown, false); assert.equal(first.focused, null);
  f.latest(FOREGROUND).acknowledge(); await flush(); f.latest(IME).acknowledge(); await flush();
  const ready = await f.controller.observeKeyboard();
  assert.equal(ready.subscribed, true); assert.equal(ready.focusKnown, false); assert.equal(ready.observedAt, null);
  assert.deepEqual(f.writes, []); f.controller.close();
});

test('actual boolean events produce bounded metadata while widget text and foreground IDs stay private', async () => {
  const f = fixture(); await f.controller.startKeyboard();
  f.update({ currentWidget: { focus: true, value: 'private-value', text: 'private-text', contentType: 'password' } });
  const observed = await f.controller.observeKeyboard();
  assert.equal(observed.focused, true); assert.equal(observed.focusKnown, true); assert.equal(observed.ageMs, 0);
  assert.match(observed.observedAt, /^\d{4}-/); assert.equal(observed.fresh, true);
  assert.equal(/private-|com\.fixture/.test(JSON.stringify(observed)), false);
  assert.deepEqual(await f.controller.keyboardState(), { currentWidget: { focus: true } });
  f.controller.close();
});

test('typing fails immediately with no subscription/fresh focus and late events cannot cause delayed writes', async () => {
  const f = fixture();
  await assert.rejects(f.controller.typeText('never-send-private', { timeoutMs: 100000 }), { code: 'IME_FOCUS_UNVERIFIED' });
  assert.equal(f.subscriptions.length, 0);
  await f.controller.startKeyboard(); f.update({ currentWidget: { focus: true } }); await flush();
  assert.deepEqual(f.writes, []);
  await f.controller.typeText('explicit-second-request'); assert.equal(f.writes.filter(write => write.uri === INSERT).length, 1);
  f.controller.close();
});

test('stale events and a backwards clock cannot authorize text; observation refreshes read subscriptions', async () => {
  const f = fixture(); await f.controller.startKeyboard(); f.update({ focus: true });
  f.advance(KEYBOARD_MAX_AGE_MS + 1);
  await assert.rejects(f.controller.typeText('stale'), { code: 'IME_FOCUS_UNVERIFIED' });
  const old = f.latest(IME), oldGeneration = (await f.controller.observeKeyboard()).generation;
  await flush(); assert.equal(old.unsubscribed, true);
  old.options.onUpdate({ focus: true });
  assert.equal((await f.controller.observeKeyboard()).focusKnown, false);
  await flush(); f.update({ focus: true }); f.advance(-1);
  await assert.rejects(f.controller.typeText('backwards'), { code: 'IME_FOCUS_UNVERIFIED' });
  assert.ok((await f.controller.observeKeyboard()).generation >= oldGeneration); assert.deepEqual(f.writes, []); f.controller.close();
});

test('freshness cannot be widened and option getters/proxies/unknown fields fail without execution', () => {
  const f = fixture(); let invoked = 0;
  for (const options of [{ maxAgeMs: KEYBOARD_MAX_AGE_MS + 1 }, { waitMs: 30001 }, { endpoint: 'secret' },
    Object.defineProperty({}, 'waitMs', { enumerable: true, get() { invoked++; return 0; } }),
    new Proxy({}, { ownKeys() { invoked++; return []; } })]) assert.throws(() => f.controller.observeKeyboard(options));
  assert.equal(invoked, 0); assert.equal(f.subscriptions.length, 0); f.controller.close();
});

test('an explicit read wait survives navigation but obsolete subscription callbacks cannot grant focus', async () => {
  const f = fixture(); const pending = f.controller.observeKeyboard({ waitMs: 100 }); await flush();
  const old = f.latest(IME), before = (await f.controller.observeKeyboard()).generation;
  await f.controller.key('RIGHT'); await flush();
  assert.equal(old.unsubscribed, true); old.options.onUpdate({ focus: true });
  await assert.rejects(f.controller.typeText('old-context'), { code: 'IME_FOCUS_UNVERIFIED' });
  f.update({ currentWidget: { focus: true } });
  const observed = await pending; assert.equal(observed.focused, true); assert.ok(observed.generation > before);
  assert.equal(f.writes.some(write => write.uri === INSERT), false); f.controller.close();
});

test('foreground app changes, launch/observer and explicit invalidation discard prior focus', async () => {
  const f = fixture(); await f.controller.startKeyboard(); f.update({ focus: true });
  const old = f.latest(IME); f.latest(FOREGROUND).options.onUpdate({ appId: 'com.fixture.other' }); await flush();
  old.options.onUpdate({ focus: true }); await assert.rejects(f.controller.typeText('old-app'), { code: 'IME_FOCUS_UNVERIFIED' });
  f.update({ focus: true }); await f.controller.launchObserver(`http://192.168.30.2:1234/${'a'.repeat(48)}/assets/loader.html`);
  await assert.rejects(f.controller.typeText('overlay'), { code: 'IME_FOCUS_UNVERIFIED' });
  await flush(); f.update({ focus: true }); f.controller.invalidateKeyboardFocus();
  await assert.rejects(f.controller.typeText('invalidated'), { code: 'IME_FOCUS_UNVERIFIED' }); f.controller.close();
});

test('loss/change during the insertion microtask and inside dispatch guard is rechecked before text bytes', async () => {
  const f = fixture(); await f.controller.startKeyboard(); f.update({ focus: true });
  const first = f.controller.typeText('microtask'); f.update({ focus: false });
  await assert.rejects(first, { code: 'IME_NOT_FOCUSED' });
  f.update({ focus: true });
  const switched = f.controller.typeText('different-widget'); f.update({ focus: false }); f.update({ focus: true });
  await assert.rejects(switched, { code: 'IME_NOT_FOCUSED' });
  await assert.rejects(f.controller.withDispatchGuard(() => { f.update({ focus: false }); f.update({ focus: true }); }, () => f.controller.typeText('guard-switch')), { code: 'IME_NOT_FOCUSED' });
  await assert.rejects(f.controller.withDispatchGuard(() => f.controller.invalidateKeyboardFocus(), () => f.controller.typeText('guard')), { code: 'IME_NOT_FOCUSED' });
  assert.equal(f.writes.some(write => write.uri === INSERT), false); f.controller.close();
});

test('abort/timeout remove only the observer wait, preserve the shared subscription and never insert', async () => {
  const f = fixture(); const abort = new AbortController();
  const pending = f.controller.observeKeyboard({ waitMs: 100, signal: abort.signal }); const denied = assert.rejects(pending, { code: 'ABORT_ERR' });
  await flush(); abort.abort(); await denied;
  assert.equal(f.latest(IME).unsubscribed, false);
  await assert.rejects(f.controller.observeKeyboard({ waitMs: 5 }), { code: 'TIMEOUT' });
  f.update({ focus: false }); assert.equal((await f.controller.observeKeyboard()).focused, false);
  assert.deepEqual(f.writes, []); f.controller.close();
});

test('close cancels pending registration/wait and ignores late focus with no subscriptions left alive', async () => {
  const f = fixture({ delayed: true });
  const pending = f.controller.observeKeyboard({ waitMs: 100 }); const denied = assert.rejects(pending, { code: 'CLIENT_CLOSED' });
  f.controller.close(); f.latest(FOREGROUND).acknowledge(); await denied; await flush();
  assert.equal(f.latest(FOREGROUND).unsubscribed, true); assert.equal(f.latest(IME), undefined);
  await assert.rejects(f.controller.observeKeyboard(), { code: 'CLIENT_CLOSED' }); assert.deepEqual(f.writes, []);
});

test('subscription failure/disconnect invalidate telemetry and a later attempt uses fresh subscriptions', async () => {
  const f = fixture(); await f.controller.startKeyboard(); f.update({ focus: true });
  const old = f.latest(IME); old.options.onError(new Error('private-device-error-text'));
  await assert.rejects(f.controller.typeText('after-error'), { code: 'IME_FOCUS_UNVERIFIED' });
  await f.controller.startKeyboard(); old.options.onUpdate({ focus: true });
  assert.equal((await f.controller.observeKeyboard()).focusKnown, false); await flush();
  f.update({ focus: true }); f.client.registered = false;
  await assert.rejects(f.controller.typeText('disconnected'), { code: 'IME_FOCUS_UNVERIFIED' });
  await assert.rejects(f.controller.observeKeyboard({ waitMs: 10 }), error => error.code === 'NOT_REGISTERED' || error.code === 'IME_SUBSCRIPTION_FAILED');
  assert.equal(f.writes.some(write => write.uri === INSERT), false); f.controller.close();
});

test('an ambiguous insertion timeout is not replayed and does not disclose text', async () => {
  const f = fixture({ request: uri => { if (uri === INSERT) throw Object.assign(Error('private-typed-content'), { code: 'TIMEOUT' }); return {}; } });
  await f.controller.startKeyboard(); f.update({ focus: true });
  await assert.rejects(f.controller.typeText('private-typed-content'), error => error.code === 'TIMEOUT' && !String(error).includes('private-typed-content'));
  assert.equal(f.writes.filter(write => write.uri === INSERT).length, 1); f.controller.close();
});

test('IME focus without a valid foreground observation stays unknown', async () => {
  const f = fixture({ focus: true, foreground: false }); await f.controller.startKeyboard();
  await assert.rejects(f.controller.typeText('unknown-app'), { code: 'IME_FOCUS_UNVERIFIED' });
  assert.equal((await f.controller.observeKeyboard()).focusKnown, false); f.controller.close();
});

test('malformed focus payloads invalidate old evidence without invoking widget accessors or proxies', async () => {
  const f = fixture(); await f.controller.startKeyboard(); let invoked = 0;
  for (const payload of [{ currentWidget: { focus: 'true' } }, { currentWidget: null },
    { currentWidget: Object.defineProperty({}, 'focus', { get() { invoked++; return true; } }) },
    Object.defineProperty({}, 'currentWidget', { get() { invoked++; return { focus: true }; } })]) {
    f.update({ focus: true }); f.update(payload);
    await assert.rejects(f.controller.typeText('malformed'), { code: 'IME_FOCUS_UNVERIFIED' });
  }
  f.update(new Proxy({}, { getOwnPropertyDescriptor() { invoked++; return {}; } }));
  assert.equal(invoked, 0); assert.deepEqual(f.writes, []); f.controller.close();
});

test('the explicit wait is bounded to 32 observers and an aborted wait releases its slot', async () => {
  const f = fixture(), controller = new AbortController();
  const waits = Array.from({ length: 32 }, () => {
    const pending = f.controller.observeKeyboard({ waitMs: 100, signal: controller.signal });
    return assert.rejects(pending, { code: 'ABORT_ERR' });
  });
  await assert.rejects(f.controller.observeKeyboard({ waitMs: 100 }), { code: 'IME_WAIT_LIMIT' });
  controller.abort(); await Promise.all(waits); await flush();
  const next = f.controller.observeKeyboard({ waitMs: 100 }); await flush(); f.update({ focus: false });
  assert.equal((await next).focused, false); f.controller.close();
});

test('registration failures remain static through the direct start and observation APIs', async () => {
  const f = fixture(); f.client.subscribe = async () => { throw Object.assign(Error('private-widget-text'), { code: 'REMOTE_PRIVATE_ERROR' }); };
  await assert.rejects(f.controller.startKeyboard(), error => error.code === 'IME_SUBSCRIPTION_FAILED' && !String(error).includes('private-widget-text'));
  await assert.rejects(f.controller.observeKeyboard({ waitMs: 100 }), error => error.code === 'IME_SUBSCRIPTION_FAILED' && !String(error).includes('private-widget-text'));
  f.controller.close();
});

test('dispatch guards require synchronous undefined without reading then getters or leaking rejected async guards', async () => {
  const f = fixture(); await f.controller.startKeyboard(); f.update({ focus: true }); let invoked = 0;
  const thenGetter = Object.defineProperty({}, 'then', { get() { invoked++; throw Error('must not execute'); } });
  for (const guard of [() => false, () => 1, () => thenGetter, () => new Proxy({}, { get() { invoked++; } }),
    async () => {}, async () => { throw Error('private-async-guard'); }]) {
    await assert.rejects(f.controller.withDispatchGuard(guard, () => f.controller.typeText('denied')), { code: 'INVALID_DISPATCH_CALLBACK' });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked, 0); assert.deepEqual(f.writes, []);
  await f.controller.withDispatchGuard(() => {}, () => f.controller.typeText('explicit-valid'));
  assert.equal(f.writes.filter(write => write.uri === INSERT).length, 1); f.controller.close();
});
