import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../privileged-probe/bridge-observe.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const runId = '1234567890abcdef';
const token = 'abcdef1234567890abcdef1234567890';

function harness(options = {}) {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const posts = [];
  const calls = [];
  const bridges = [];
  const config = { runId, token, callbackOrigin: 'http://192.168.77.11:61234', durationMs: 10000, intervalMs: 1000, ...options.config };
  function setTimeout(fn, delay = 0) { const key = ++id; timers.set(key, { time: now + delay, fn }); return key; }
  function XMLHttpRequest() {
    this.open = (method, url) => { this.method = method; this.url = url; };
    this.setRequestHeader = () => {};
    this.send = body => {
      posts.push({ url: this.url, payload: JSON.parse(body), at: now });
      this.status = 204;
      setTimeout(() => this.onload(), 0);
    };
  }
  function PalmServiceBridge() {
    bridges.push(this);
    this.cancelled = false;
    this.cancel = () => { this.cancelled = true; };
    this.call = (uri, raw) => {
      calls.push({ uri, payload: JSON.parse(raw), at: now });
      const respond = (payload, delay = 0) => setTimeout(() => {
        if (!this.cancelled) this.onservicecallback(JSON.stringify(payload));
      }, delay);
      if (uri.endsWith('/upload')) {
        respond({ returnValue: true, subscribed: true, url: `http://192.168.77.11:61234/${token}/image`, sourceFile: 'secret-source' });
        if (!options.hangUpload) respond({ completed: true, completionCode: 0, httpCode: 201,
          url: `http://192.168.77.11:61234/${token}/image` }, 100);
      } else if (uri.includes('tv.capture')) {
        respond(options.captureFailure ? { returnValue: false, errorCode: 'CAPTURE_ERROR_03' } :
          { returnValue: true, capturedWidth: 0, capturedHeight: 0 });
      } else if (uri.includes('.acb/')) {
        respond({ returnValue: true, appId: 'com.disney.disneyplus-prod', acbs: [
          { playStateNow: 'playing', playerType: 'video', url: 'https://provider.invalid/private', account: 'private-account' },
        ] });
      } else {
        respond({ returnValue: true, appId: 'com.disney.disneyplus-prod' });
      }
    };
  }
  const location = options.location || { protocol: 'http:', hostname: '192.168.77.11', host: '192.168.77.11:61234' };
  vm.runInNewContext(script.replace('__LG_AGENT_CONFIG__', JSON.stringify(config)), {
    window: {}, location, XMLHttpRequest, PalmServiceBridge, Date: { now: () => now },
    setTimeout, clearTimeout: key => timers.delete(key),
  });
  function tick(target) {
    let loops = 0;
    while (true) {
      const pending = [...timers.entries()].filter(([, timer]) => timer.time <= target).sort((a, b) => a[1].time - b[1].time || a[0] - b[0]);
      if (!pending.length) break;
      if (++loops > 10000) throw new Error('timer loop');
      const [key, timer] = pending[0]; timers.delete(key); now = timer.time; timer.fn();
    }
    now = target;
  }
  return { posts, calls, bridges, tick };
}

test('transparent bridge sends readiness then fixed observational RPCs and waits for completed upload', () => {
  assert.equal(html.split('__LG_AGENT_CONFIG__').length - 1, 1);
  assert.match(html, /background:transparent!important/);
  const h = harness();
  assert.equal(h.posts[0].payload.type, 'bridge-ready');
  h.tick(1000);
  assert.equal(h.calls.length, 4);
  assert.equal(h.posts.filter(post => post.payload.type === 'sample').length, 0);
  h.tick(1100);
  const sample = h.posts.find(post => post.payload.type === 'sample').payload;
  assert.equal(sample.capture.payload.capturedWidth, 0);
  assert.equal(sample.capture.upload.payload.completed, true);
  assert.equal(sample.acbForeground.payload.acbs[0].playStateNow, 'playing');
  assert.equal(JSON.stringify(sample).includes(token), false);
  assert.equal(JSON.stringify(sample).includes('provider.invalid'), false);
  assert.equal(JSON.stringify(sample).includes('private-account'), false);
  assert.equal(JSON.stringify(sample).includes('secret-source'), false);
  const upload = h.calls.find(call => call.uri.endsWith('/upload'));
  assert.equal(upload.payload.fileName, `/media/internal/downloads/lg-agent-probe-${runId}.jpg`);
  assert.equal(upload.payload.fileLabel, 'capture');
  assert.equal(upload.payload.url, `http://192.168.77.11:61234/${token}/image?runId=${runId}&sample=1`);
  assert.ok(h.calls.every(call => [
    'luna://com.webos.applicationManager/getForegroundAppInfo',
    'luna://com.webos.service.acb/getForegroundAppInfo',
    'luna://com.webos.service.tv.capture/executeOneShot',
    'luna://com.webos.service.downloadmanager/upload',
  ].includes(call.uri)));
  h.tick(20000);
  assert.equal(h.posts.filter(post => post.payload.type === 'done').length, 1);
  assert.ok(h.calls.every(call => call.at < 10000));
  assert.ok(h.bridges.every(bridge => bridge.cancelled));
});

test('bridge still reports app and ACB status when capture fails and avoids upload', () => {
  const h = harness({ captureFailure: true }); h.tick(1100);
  const sample = h.posts.find(post => post.payload.type === 'sample').payload;
  assert.equal(sample.capture.payload.errorCode, 'CAPTURE_ERROR_03');
  assert.equal(sample.appForeground.payload.appId, 'com.disney.disneyplus-prod');
  assert.equal(h.calls.some(call => call.uri.endsWith('/upload')), false);
});

test('bridge upload acknowledgement alone times out instead of claiming completion', () => {
  const h = harness({ hangUpload: true }); h.tick(6000);
  const sample = h.posts.find(post => post.payload.type === 'sample').payload;
  assert.equal(sample.capture.upload.error, 'upload-timeout');
  assert.equal(sample.capture.upload.payload.completed, undefined);
  assert.equal(JSON.stringify(sample).includes(token), false);
});

test('bridge rejects mismatched or public callback origins before any action', () => {
  const mismatch = harness({ config: { callbackOrigin: 'http://192.168.77.12:61234' } });
  assert.equal(mismatch.posts.length, 0); assert.equal(mismatch.calls.length, 0);
  const external = harness({ config: { callbackOrigin: 'http://example.com:61234' },
    location: { protocol: 'http:', hostname: 'example.com', host: 'example.com:61234' } });
  assert.equal(external.posts.length, 0); assert.equal(external.calls.length, 0);
});

test('bridge one-shot completes immediately after its delivered report', () => {
  const h = harness({ config: { sampleLimit: 1 } });
  h.tick(20000);
  assert.equal(h.calls.length, 4);
  assert.equal(h.posts.filter(post => post.payload.type === 'sample').length, 1);
  const done = h.posts.find(post => post.payload.type === 'done');
  assert.equal(done.payload.reason, 'sample-complete');
  assert.equal(done.at, 1100);
});

test('bridge state-only one-shot never requests capture or upload', () => {
  const h = harness({ config: { sampleLimit: 1, screenshot: false } });
  h.tick(20000);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.uri.endsWith('/getForegroundAppInfo')));
  const sample = h.posts.find(post => post.payload.type === 'sample').payload;
  assert.equal(sample.capture.skipped, true);
  assert.equal(h.posts.find(post => post.payload.type === 'done').payload.reason, 'sample-complete');
});

test('bridge validates optional limits and screenshot flags', () => {
  for (const config of [{ sampleLimit: null }, { sampleLimit: 0 }, { sampleLimit: 11 }, { sampleLimit: 1.2 },
    { sampleLimit: '1' }, { screenshot: 'false' }]) {
    const h = harness({ config });
    h.tick(20000);
    assert.equal(h.posts.length, 0);
    assert.equal(h.calls.length, 0);
  }
});
