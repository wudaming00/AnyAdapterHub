import test from 'node:test';
import assert from 'node:assert/strict';
import { LGWebOSAdapter } from '../lib/adapters/lg-webos.mjs';
import { authorize, validateAction } from '../lib/hub/policy.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('async and thenable dispatch decisions cannot release owned media or execute getters', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.execute({ action: 'media.file.cast', args: { filePath: '/synthetic.mp4' } });
  let touched = 0;
  for (const guard of [() => true, async () => {}, async () => { throw Error('not authorized'); },
    () => Object.defineProperty({}, 'then', { get() { touched++; throw Error('must not run'); } })]) {
    await assert.rejects(f.adapter.execute({ action: 'media.host.release' }, { assertDispatch: guard }), { code: 'INVALID_CONTEXT' });
  }
  assert.equal(touched, 0); assert.equal(f.calls.includes('host.close'), false);
});

function fixture({ focus, cleanupFailure = false, features = ['media'], appsWait } = {}) {
  const calls = [], hosts = []; let factoryCount = 0;
  const controller = {
    registered: true,
    connect: async () => { calls.push('connect'); },
    close: async () => { calls.push('controller.close'); },
    observeKeyboard: async options => { calls.push(['focus', options]); return focus ?? { focused: null, focusKnown: false, state: 'unknown' }; },
    apps: async () => { await appsWait; return { apps: [] }; },
    dlnaPlay: async () => ({ requestAccepted: true, confirmed: true, transportState: 'PLAYING' }),
    status: async () => ({ foreground: { status: 'ok', payload: { appId: 'example.app' } } }),
  };
  const adapter = new LGWebOSAdapter({
    deviceId: 'fixture-tv', features, config: { host: '192.168.30.40', clientKey: 'synthetic-key' },
    controllerFactory: async () => { factoryCount++; return controller; },
    mediaHostFactory: async () => {
      const host = {
        serve: async () => ({ url: 'http://192.168.30.2:13579/synthetic.mp4', mimeType: 'video/mp4', bytes: 1 }),
        close: async () => { calls.push('host.close'); if (cleanupFailure) throw Error('private path must not escape'); },
      };
      hosts.push(host); return host;
    },
  });
  return { adapter, calls, hosts, factoryCount: () => factoryCount };
}

test('Hub focus read is immediate, privacy-filtered and never treats an unknown subscription as focus', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'text.focus.read' });
  assert.equal(result.focusKnown, false); assert.equal(result.focused, null); assert.equal(result.confirmed, false);
  assert.equal(result.verificationScope, 'fresh_keyboard_focus_event');
  assert.deepEqual(f.calls.find(Array.isArray), ['focus', { waitMs: 0, maxAgeMs: 1500 }]);
  assert.equal(f.adapter.readonlyActions.includes('text.focus.read'), true);
  assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
});

test('Hub focus read copies only bounded evidence and preserves explicit unfocused events', async t => {
  const f = fixture({ focus: { focusKnown: true, focused: false, observedAt: new Date().toISOString(), ageMs: 5,
    text: 'private field contents', clientKey: 'synthetic-key', arbitrary: 'never expose' } });
  t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'text.focus.read' });
  assert.equal(result.focusKnown, true); assert.equal(result.focused, false); assert.equal(result.confirmed, true);
  assert.equal(result.focusAgeMs, 5);
  for (const hidden of ['private field contents', 'synthetic-key', 'arbitrary']) assert.equal(JSON.stringify(result).includes(hidden), false);
});

test('release with no owned listeners never creates a controller or contacts a television', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  const result = await f.adapter.execute({ action: 'media.host.release' });
  assert.equal(result.confirmed, true); assert.equal(result.cleanupVerified, true); assert.equal(result.remainingOwnedHosts, 0);
  assert.equal(result.playbackVerified, false); assert.equal(result.verificationScope, 'local_media_listener_cleanup');
  assert.equal(f.factoryCount(), 0); assert.deepEqual(f.calls, []);
});

test('old, future or incomplete focus metadata never confirms a text target', async t => {
  for (const focus of [
    { focused: true, focusKnown: true, ageMs: 1501, observedAt: new Date().toISOString() },
    { focused: true, focusKnown: true, ageMs: 1, observedAt: new Date(Date.now() - 5000).toISOString() },
    { focused: true, focusKnown: true, ageMs: 1, observedAt: new Date(Date.now() + 10000).toISOString() },
    { focused: true, focusKnown: true },
  ]) {
    const f = fixture({ focus }); t.after(() => f.adapter.close());
    const result = await f.adapter.execute({ action: 'text.focus.read' });
    assert.equal(result.confirmed, false); assert.equal(result.focusKnown, false); assert.equal(result.focused, null);
  }
});

test('release closes only owned hosts without requiring DLNA discovery or falsely stopping playback', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.execute({ action: 'media.file.cast', args: { filePath: '/synthetic.mp4' } });
  const before = f.calls.length;
  const result = await f.adapter.execute({ action: 'media.host.release' });
  assert.equal(result.cleanupVerified, true); assert.equal(result.remainingOwnedHosts, 0); assert.equal(result.playbackVerified, false);
  assert.deepEqual(f.calls.slice(before), ['host.close']);
  await f.adapter.execute({ action: 'media.host.release' });
  assert.equal(f.calls.filter(call => call === 'host.close').length, 1);
});

test('failed cleanup retains ownership for reconciliation and excludes exception details', async () => {
  const f = fixture({ cleanupFailure: true });
  await f.adapter.execute({ action: 'media.file.cast', args: { filePath: '/synthetic.mp4' } });
  const result = await f.adapter.execute({ action: 'media.host.release' });
  assert.equal(result.confirmed, false); assert.equal(result.cleanupVerified, false); assert.equal(result.remainingOwnedHosts, 1);
  assert.equal(result.error.code, 'MEDIA_CLEANUP_FAILED');
  assert.equal(JSON.stringify(result).includes('private path'), false);
  await assert.rejects(f.adapter.close(), { code: 'MEDIA_CLEANUP_FAILED' });
});

test('new operations need exact grants and no target, PID, timeout or endpoint override is accepted', async t => {
  const f = fixture({ features: [] }); t.after(() => f.adapter.close());
  await assert.rejects(f.adapter.execute({ action: 'media.host.release' }), { code: 'FEATURE_NOT_ENABLED' });
  for (const name of ['text.focus.read', 'media.host.release']) {
    for (const args of [{ pid: 1 }, { host: '192.168.30.99' }, { endpoint: 'arbitrary' }, { waitMs: 8000 }]) {
      assert.throws(() => validateAction(name, args), { code: 'INVALID_ARGUMENTS' });
    }
    const grant = { id: 'fixture-grant', label: 'fixture', deviceIds: ['fixture-tv'], capabilities: [name],
      expiresAt: new Date(Date.now() + 60000).toISOString(), revokedAt: null };
    assert.doesNotThrow(() => authorize(grant, { deviceId: 'fixture-tv', capability: name }));
    assert.throws(() => authorize(grant, { deviceId: 'other-tv', capability: name }), { code: 'ACCESS_DENIED' });
    assert.throws(() => authorize({ ...grant, revokedAt: new Date().toISOString() }, { deviceId: 'fixture-tv', capability: name }), { code: 'GRANT_REVOKED' });
    assert.throws(() => authorize({ ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() }, { deviceId: 'fixture-tv', capability: name }), { code: 'GRANT_EXPIRED' });
    assert.throws(() => authorize({ ...grant, capabilities: ['state.read'] }, { deviceId: 'fixture-tv', capability: name }), { code: 'ACCESS_DENIED' });
  }
  assert.deepEqual(f.calls, []);
});

test('release rechecks authority after queue waits and never closes a host on revoked authority', async t => {
  const gate = deferred(), f = fixture({ appsWait: gate.promise }); t.after(() => f.adapter.close());
  await f.adapter.execute({ action: 'media.file.cast', args: { filePath: '/synthetic.mp4' } });
  const blocker = f.adapter.execute({ action: 'app.list' });
  let revoked = false;
  const release = f.adapter.execute({ action: 'media.host.release' }, { assertDispatch() {
    if (revoked) throw Object.assign(Error('denied'), { code: 'GRANT_REVOKED' });
  } });
  const rejected = assert.rejects(release, { code: 'GRANT_REVOKED' });
  revoked = true; gate.resolve(); await blocker; await rejected;
  assert.equal(f.calls.includes('host.close'), false);
});
