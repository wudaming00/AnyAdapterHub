import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ECOVACSX11Adapter, ECOVACS_ACTIONS, createECOVACSRunner } from '../lib/adapters/ecovacs-x11.mjs';

const config = { pythonPath: '/owner/python', credentialFile: '/private/credentials.bin', selectedDeviceSha256: 'a'.repeat(64) };
const status = { reachable: true, state: 'docked', battery_percent: 88, task_state: 'idle', task_paused: false, station_state: 'idle' };
const fixture = (runner = async () => ({ status })) => new ECOVACSX11Adapter({ deviceId: 'vacuum-1', config, runner });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };

test('ECOVACS state projection excludes account IDs, names, tokens, maps and raw firmware claims', async t => {
  const adapter = fixture(async () => ({ status: { ...status, device_id: 'sensitive-did', token: 'secret', map: 'floor-plan', account: 'private@example.com', firmware: 'unverified' } }));
  t.after(() => adapter.close());
  const events = []; adapter.subscribe(event => events.push(event));
  const snapshot = await adapter.snapshot();
  assert.deepEqual(snapshot.fields.vacuum.value, { reachable: true, batteryPercent: 88, state: 'docked', taskState: 'idle', stationState: 'idle', taskPaused: false });
  assert.equal(snapshot.fields.vacuum.source, 'ecovacs-cloud-https');
  assert.equal(snapshot.connection.phase, 'online');
  const serialized = JSON.stringify([snapshot, events]);
  for (const privateValue of ['sensitive-did', 'secret', 'floor-plan', 'private@example.com', config.credentialFile, 'unverified']) assert.equal(serialized.includes(privateValue), false);
  assert.equal(Object.isFrozen(snapshot.fields.vacuum.value), true);
  assert.deepEqual(adapter.supportedActions, ECOVACS_ACTIONS);
});

test('fixed movement action waits for worker preflight before checking current authorization', async t => {
  const order = [];
  const adapter = fixture(async ({ action }, context) => {
    order.push('cloud-preflight'); context.assertDispatch(); order.push(action);
    return { accepted: true, state_verified: true, verification_status: 'verified', status: { ...status, state: 'cleaning', task_state: 'cleaning' } };
  });
  t.after(() => adapter.close());
  const result = await adapter.execute({ action: 'vacuum.start', args: {} }, { assertDispatch() { order.push('authorize'); } });
  assert.deepEqual(order, ['cloud-preflight', 'authorize', 'vacuum.start']);
  assert.equal(result.confirmed, true); assert.equal(result.taskComplete, false);
  assert.equal((await adapter.snapshot({ refresh: false })).fields.vacuum.value.state, 'cleaning');
});

test('revocation during preflight stops movement and a timeout after dispatch is never retried', async t => {
  let commands = 0;
  const adapter = fixture(async (_, context) => { context.assertDispatch(); commands += 1; throw Object.assign(new Error('vendor secret'), { code: 'WORKER_TIMEOUT' }); });
  t.after(() => adapter.close());
  await assert.rejects(adapter.execute({ action: 'vacuum.start' }, { assertDispatch() { throw Object.assign(new Error('revoked'), { code: 'GRANT_REVOKED' }); } }));
  assert.equal(commands, 0);
  const result = await adapter.execute({ action: 'vacuum.start' }, { assertDispatch() {} });
  assert.equal(commands, 1); assert.equal(result.uncertain, true); assert.equal(result.confirmed, false);
  assert.equal(JSON.stringify(result).includes('vendor secret'), false);
});

test('cloud acceptance and station service never become cleaning completion', async t => {
  const adapter = fixture(async (_, context) => { context.assertDispatch(); return { accepted: true, state_verified: false, verification_status: 'task_active_at_station', status: { ...status, task_state: 'cleaning', station_state: 'washing_mop' } }; });
  t.after(() => adapter.close());
  const result = await adapter.execute({ action: 'vacuum.start' });
  assert.equal(result.requestAccepted, true); assert.equal(result.confirmed, false); assert.equal(result.taskComplete, false);
  assert.equal(result.verificationStatus, 'task_active_at_station');
});

test('adapter rejects device routing, room/map/settings actions and all action parameters', async t => {
  let calls = 0; const adapter = fixture(async () => { calls += 1; return { status }; }); t.after(() => adapter.close());
  for (const action of ['vacuum.room.clean', 'vacuum.map.read', 'vacuum.settings.set', 'device.select', 'power.off']) await assert.rejects(adapter.execute({ action }), { code: 'UNKNOWN_ACTION' });
  for (const args of [{ deviceId: 'other' }, { command: 'clean' }, { region: 'CN' }, { url: 'http://attacker' }, { fanSpeed: 3 }, Object.create({ deviceId: 'other' })]) await assert.rejects(adapter.execute({ action: 'vacuum.start', args }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(calls, 0);
});

test('read settings and maintenance are normalized and require a successful read for confirmation', async t => {
  let successfulReads = 1;
  const adapter = fixture(async () => ({ details: { successfulReads, settings: { fanSpeed: 'MAX', childLock: true, volume: 40, account: 'private', workMode: 'http://private', waterAmount: Infinity },
    maintenance: [{ component: 'DUST_BAG', remainingPercent: null, counterStatus: 'not_applicable', device_id: 'private' }, { component: 'MAIN_BRUSH', remainingPercent: 50, counterStatus: 'counter_remaining' }], map: 'private-plan' } }));
  t.after(() => adapter.close());
  const result = await adapter.execute({ action: 'vacuum.details.read' });
  assert.equal(result.confirmed, true); assert.equal(result.details.firmwareVerified, false);
  assert.deepEqual(result.details.settings, { fanSpeed: 'MAX', volume: 40, childLock: true });
  assert.equal(result.details.maintenance[0].counterStatus, 'not_applicable');
  assert.equal(result.details.maintenance[1].physicalCondition, 'not_assessed');
  assert.equal(JSON.stringify(result).includes('private'), false);
  successfulReads = 0; assert.equal((await adapter.execute({ action: 'vacuum.details.read' })).confirmed, false);
});

test('polling and movement share a queue, close drains pending operations', async () => {
  const gate = deferred(); const order = []; let first = true;
  const adapter = fixture(async ({ action }, context) => {
    order.push(action);
    if (first) { first = false; await gate.promise; return { status }; }
    context.assertDispatch(); return { accepted: true, state_verified: false, status };
  });
  const start = adapter.start(); const command = adapter.execute({ action: 'vacuum.dock' });
  const closing = adapter.close(); await nextTurn(); assert.deepEqual(order, ['status']);
  await assert.rejects(adapter.snapshot(), { code: 'ADAPTER_CLOSED' });
  gate.resolve(); await start; await command; await closing;
  assert.deepEqual(order, ['status', 'vacuum.dock']);
});

function subprocess(onRequest) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; };
  let input = '';
  child.stdin.on('data', chunk => { input += chunk.toString(); if (input.includes('\n')) onRequest(child, input); });
  return child;
}
test('worker runner sends fixed args without shell; credential path enters stdin and environment is minimized', async t => {
  const previous = process.env.ANYADAPTER_TEST_UNRELATED_CREDENTIAL;
  process.env.ANYADAPTER_TEST_UNRELATED_CREDENTIAL = 'not-a-real-credential';
  t.after(() => { if (previous === undefined) delete process.env.ANYADAPTER_TEST_UNRELATED_CREDENTIAL; else process.env.ANYADAPTER_TEST_UNRELATED_CREDENTIAL = previous; });
  let invocation; let child;
  const runner = createECOVACSRunner(config, { spawnFn: (...args) => {
    invocation = args;
    child = subprocess((process, input) => { assert.equal(JSON.parse(input).credentialFile, config.credentialFile); setImmediate(() => { process.stdout.write(JSON.stringify({ type: 'result', value: { status } }) + '\n'); process.emit('close', 0); }); });
    return child;
  } });
  assert.deepEqual(await runner({ action: 'status' }), { status });
  assert.equal(invocation[0], config.pythonPath); assert.deepEqual(invocation[1].slice(0, 3), ['-I', '-B', '-u']);
  assert.equal(invocation[1].some(value => value === config.credentialFile), false);
  assert.equal(invocation[2].shell, false); assert.equal(invocation[2].windowsHide, true);
  assert.equal(invocation[2].env.ANYADAPTER_TEST_UNRELATED_CREDENTIAL, undefined);
  const allowedEnv = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
  assert.ok(Object.keys(invocation[2].env).every(key => allowedEnv.has(key.toUpperCase())));
  assert.equal(Object.keys(invocation[2].env).some(key => /proxy|^python|token|key|^ssl_cert/i.test(key)), false);
  assert.equal(child.killed, false);
});

test('worker handshake refuses revoked authorization and malformed/oversized output', async () => {
  let child;
  const runner = createECOVACSRunner(config, { spawnFn: () => {
    child = subprocess(process => { setImmediate(() => process.stdout.write('{"type":"ready"}\n')); }); return child;
  } });
  await assert.rejects(runner({ action: 'vacuum.start' }, { assertDispatch() { throw Object.assign(new Error('revoked secret'), { code: 'GRANT_REVOKED' }); } }), { code: 'GRANT_REVOKED' });
  assert.equal(child.killed, true);
  const malformed = createECOVACSRunner(config, { spawnFn: () => subprocess(process => setImmediate(() => process.stdout.write('vendor secret\n'))) });
  await assert.rejects(malformed({ action: 'status' }), { code: 'WORKER_PROTOCOL' });
  const oversized = createECOVACSRunner(config, { spawnFn: () => subprocess(process => setImmediate(() => process.stdout.write('X'.repeat(300000)))) });
  await assert.rejects(oversized({ action: 'status' }), { code: 'WORKER_PROTOCOL' });
});
