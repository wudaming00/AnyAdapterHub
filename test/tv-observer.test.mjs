import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { observationHandler, observeTV, OBSERVER_APP } from '../lib/tv-observer.mjs';

const jpeg = Buffer.from([255, 216, 4, 128, 0, 255, 217]);
async function invoke(handler, { url, body = Buffer.alloc(0), headers = {}, method = 'POST', host = '192.168.77.80' }) {
  const request = Readable.from([body]);
  Object.assign(request, { url, headers, method, socket: { remoteAddress: host } });
  const response = { code: null, writeHead(code) { this.code = code; this.headersSent = true; }, end() {} };
  await handler(request, response);
  return response.code;
}
function receiver() {
  const state = { errors: [] };
  return { state, handler: observationHandler({ host: '192.168.77.80', token: 'secret-fixture', runId: 'run-fixture', assets: new Map(), state }) };
}
test('callback receiver rejects wrong device, token and run identity', async () => {
  const { handler, state } = receiver();
  assert.equal(await invoke(handler, { url: '/secret-fixture/report', host: '192.168.77.81' }), 403);
  assert.equal(await invoke(handler, { url: '/wrong/report' }), 404);
  assert.equal(await invoke(handler, { url: '/secret-fixture/report', body: Buffer.from('{"runId":"wrong","type":"sample"}') }), 400);
  assert.equal(state.sample, undefined);
});
test('callback receiver bounds data and never accepts a screenshot without validated identity', async () => {
  const { handler, state } = receiver();
  assert.equal(await invoke(handler, { url: '/secret-fixture/image', body: jpeg, headers: { 'content-type': 'image/jpeg' } }), 400);
  assert.equal(await invoke(handler, { url: '/secret-fixture/image?runId=run-fixture', headers: { 'content-length': 11 * 1024 * 1024 } }), 413);
  assert.equal(await invoke(handler, { url: '/secret-fixture/image?runId=run-fixture', body: jpeg, headers: { 'content-type': 'image/jpeg' } }), 200);
  assert.deepEqual(state.image, jpeg);
  assert.equal(await invoke(handler, { url: '/secret-fixture/image?runId=run-fixture', body: jpeg, headers: { 'content-type': 'image/jpeg' } }), 400);
});
test('callback state is data and sensitive transport fields are excluded', async () => {
  const { handler, state } = receiver();
  const body = Buffer.from(JSON.stringify({ runId: 'run-fixture', type: 'sample', url: 'http://private/', token: 'secret-fixture',
    appForeground: { appId: 'demo' }, errorText: 'http://private/secret-fixture' }));
  assert.equal(await invoke(handler, { url: '/secret-fixture/report', body }), 200);
  assert.equal(state.sample.url, undefined);
  assert.equal(state.sample.token, undefined);
  assert.equal(state.sample.errorText, '[redacted-url]');
});

async function transaction({ failLaunch = false, failClose = false, wrongModel = false } = {}) {
  let handler;
  let socketClosed = false;
  const actions = [];
  const server = new EventEmitter();
  Object.assign(server, { listen(_port, _host, cb) { cb(); }, address() { return { port: 48111 }; },
    closeAllConnections() { socketClosed = true; }, close(cb) { cb(); } });
  const controller = { host: '192.168.77.80',
    identity: async () => ({ vendor: 'LG', model: wrongModel ? 'UNKNOWN' : 'OLED65B8PUA', firmware: '05.50.70' }),
    status: async () => ({ foreground: { payload: { appId: 'demo' } } }),
    apps: async () => ({ apps: [{ id: OBSERVER_APP }] }),
    async launchObserver(url) {
      actions.push('launch');
      if (failLaunch) throw new Error('Launch failed');
      const target = new URL(url);
      const prefix = target.pathname.slice(0, target.pathname.indexOf('/assets/'));
      // Capture the fixed generated page in the same receiver, without executing
      // its code or connecting to any TV/network.
      let html;
      const response = { writeHead() {}, end(body) { html = body.toString(); } };
      await handler({ url: target.pathname, method: 'GET', socket: { remoteAddress: controller.host } }, response);
      const config = JSON.parse(html.match(/var config = (\{[^\n]*\});/)[1]);
      const post = (route, payload) => invoke(handler, { url: prefix + '/' + route, body: Buffer.from(JSON.stringify({ runId: config.runId, ...payload })) });
      await post('report', { type: 'bridge-ready' });
      await invoke(handler, { url: prefix + '/image?runId=' + config.runId, body: jpeg, headers: { 'content-type': 'image/jpeg' } });
      await post('report', { type: 'sample', cleanup: { absenceVerified: true } });
      await post('done', { type: 'done' });
    },
    async closeApp(id) { actions.push('close:' + id); if (failClose) throw new Error('Close failed'); },
    async waitForApp(id) { actions.push('verify:' + id); return { confirmed: true }; },
  };
  const result = await observeTV(controller, {}, { routeAddress: async () => '192.168.77.11', serverFactory: value => { handler = value; return server; } });
  return { result, actions, socketClosed };
}
test('one observation closes its overlay and receiver before returning image and restoration evidence', async () => {
  const { result, actions, socketClosed } = await transaction();
  assert.deepEqual(result.image, jpeg);
  assert.equal(result.metadata.cleanupVerified, true);
  assert.equal(result.metadata.restored, true);
  assert.equal(result.metadata.titlePlaybackVerified, false);
  assert.deepEqual(actions, ['launch', 'close:' + OBSERVER_APP, 'verify:demo']);
  assert.equal(socketClosed, true);
});
test('launch and close failures still tear down the receiver and do not claim overlay closure', async () => {
  const failed = await transaction({ failLaunch: true, failClose: true });
  assert.equal(failed.result.image, undefined);
  assert.equal(failed.result.metadata.overlayClosed, false);
  assert.match(failed.result.metadata.error, /Launch failed/);
  assert.equal(failed.socketClosed, true);
});
test('model mismatch refuses privileged launch even when the component exists', async () => {
  const { result, actions } = await transaction({ wrongModel: true });
  assert.deepEqual(actions, []);
  assert.equal(result.image, undefined);
  assert.match(result.metadata.error, /identity does not match/i);
});
