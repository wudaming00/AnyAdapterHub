import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import { TVMcpServer, TV_TOOLS, PROTOCOL_VERSION, loadPrivateConfig, redactOutput, runStdio } from '../mcp-tv.mjs';

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' },
} };
const readyNotification = { jsonrpc: '2.0', method: 'notifications/initialized' };
const toolCall = (name, args = {}, id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const config = { host: '192.168.1.2', clientKey: 'private-test-key', mac: '02:00:00:00:00:01', wake: {}, allowTemporaryObserver: true,
  mediaRoots: [path.resolve('assets')], allowedUrlOrigins: ['https://example.org', 'http://192.168.1.3'] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const decoded = response => JSON.parse(response.result.content[0].text).result;
const state = ({ volume = 0, muted = false, devices = [{ id: 'HDMI_1', appId: 'reported.hdmi.app' }] } = {}) => ({
  capturedAt: '2026-10-19T00:00:00.000Z',
  volume: { status: 'ok', payload: { volumeStatus: { volume, muted } } },
  audio: { status: 'ok', payload: { mute: muted, volume } },
  inputs: { status: 'ok', payload: { devices } },
});
const localFile = path.resolve('private-test-movie.mp4');

function mediaHosts() {
  const hosts = [];
  const mediaHostFactory = async options => {
    const host = { options, closeCount: 0, serveCalls: [], url: `http://192.168.1.3:1234/media/private-${hosts.length}.mp4`,
      async serve(filePath, settings) {
        this.serveCalls.push([filePath, settings]);
        return { url: this.url, mimeType: settings.mimeType ?? 'video/mp4', bytes: 4096 };
      },
      async close() { this.closeCount += 1; },
    };
    hosts.push(host);
    return host;
  };
  return { hosts, mediaHostFactory };
}

async function fixture(overrides = {}) {
  const calls = [];
  const fake = { connect: async (...args) => calls.push(['connect', ...args]), close: async () => calls.push(['close']) };
  for (const method of ['status', 'apps', 'keyboardState', 'launch', 'launchContent', 'openUrl', 'playUrl', 'typeText', 'key', 'move', 'click', 'scroll',
    'media', 'setVolume', 'mute', 'setInput', 'soundOutput', 'screen', 'powerOff']) {
    fake[method] = async (...args) => { calls.push([method, ...args]); return { returnValue: true }; };
  }
  fake.status = async () => { calls.push(['status']); return state(); };
  fake.waitForApp = async (id, options) => {
    calls.push(['waitForApp', id, options]);
    return { confirmed: true, appId: id, elapsedMs: 1, foreground: { appId: id } };
  };
  fake.dlnaPlay = async (...args) => { calls.push(['dlnaPlay', ...args]); return {
    requestAccepted: true, confirmed: true, playbackVerified: true, transportConfirmed: true, transportState: 'PLAYING',
  }; };
  fake.dlnaStatus = async () => { calls.push(['dlnaStatus']); return { transportState: 'PLAYING', transportStatus: 'OK', currentSpeed: '1' }; };
  fake.dlnaMedia = async action => { calls.push(['dlnaMedia', action]); return {
    requestAccepted: true, confirmed: true, transportConfirmed: true, playbackVerified: action === 'play',
    transportState: { play: 'PLAYING', pause: 'PAUSED_PLAYBACK', stop: 'STOPPED' }[action],
  }; };
  fake.screenshot = async () => { calls.push(['screenshot']); return { data: png, contentType: 'image/png', bytes: png.length }; };
  const server = new TVMcpServer({ loadConfig: async () => config,
    controllerFactory: async options => { calls.push(['factory', options]); return fake; },
    wake: async (...args) => { calls.push(['wake', ...args]); return { sent: true }; }, ...overrides });
  await server.handle(initialize);
  await server.handle(readyNotification);
  return { server, fake, calls };
}

test('initialization negotiates the pinned protocol without loading configuration or contacting TV', async () => {
  const server = new TVMcpServer({ loadConfig: () => assert.fail('configuration should remain lazy') });
  assert.equal((await server.handle({ ...initialize, params: { ...initialize.params, protocolVersion: '2099-01-01' } })).result.protocolVersion, PROTOCOL_VERSION);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).error.code, -32002);
  assert.equal(await server.handle(readyNotification), null);
  const listed = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(TV_TOOLS.length, 25);
  assert.equal(listed.result.tools.length, TV_TOOLS.length);
  assert.equal(listed.result.tools.find(t => t.name === 'tv_status').annotations.readOnlyHint, true);
  assert.equal(listed.result.tools.find(t => t.name === 'tv_type_text').annotations.idempotentHint, false);
  assert.equal(listed.result.tools.find(t => t.name === 'tv_power').annotations.destructiveHint, false);
  const observer = listed.result.tools.find(t => t.name === 'tv_observe');
  assert.equal(observer.annotations.readOnlyHint, false);
  assert.equal(observer.annotations.idempotentHint, false);
  assert.deepEqual(observer.inputSchema.properties, {});
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 'ping', method: 'ping' })).result, {});
  assert.equal((await server.handle(initialize)).error.code, -32600);
});

test('tool call mappings use the controller contract and always close', async () => {
  const { server, calls } = await fixture();
  const examples = [
    ['tv_status', {}, ['status']], ['tv_apps', {}, ['apps']], ['tv_keyboard_state', {}, ['keyboardState']],
    ['tv_launch', { id: 'example.app', params: {}, contentId: '123' }, ['launch', 'example.app', {}, '123']],
    ['tv_launch_content', { id: 'example.app', content: 'provider-content-id' }, ['launchContent', 'example.app', 'provider-content-id']],
    ['tv_open_url', { url: 'https://example.org/movie' }, ['openUrl', 'https://example.org/movie']],
    ['tv_play_url', { url: 'https://example.org/movie.mp4', mimeType: 'video/mp4', title: 'Movie', loop: false },
      ['playUrl', 'https://example.org/movie.mp4', { mimeType: 'video/mp4', title: 'Movie', loop: false }]],
    ['tv_type_text', { text: 'hello', replace: true }, ['typeText', 'hello', { replace: true }]],
    ['tv_key', { key: 'ENTER' }, ['key', 'ENTER']],
    ['tv_pointer_move', { dx: -2, dy: 30 }, ['move', -2, 30]], ['tv_pointer_click', {}, ['click']],
    ['tv_pointer_scroll', { dx: 0, dy: -3 }, ['scroll', 0, -3]],
    ['tv_media', { action: 'fastForward' }, ['media', 'fastForward']],
    ['tv_set_volume', { volume: 0 }, ['setVolume', 0]], ['tv_mute', { muted: false }, ['mute', false]],
    ['tv_set_input', { id: 'HDMI_1' }, ['setInput', 'HDMI_1']],
    ['tv_sound_output', { id: 'external_arc' }, ['soundOutput', 'external_arc']],
    ['tv_screen', { on: false }, ['screen', false]], ['tv_power', { action: 'off' }, ['powerOff']],
  ];
  for (const [name, args, expected] of examples) {
    calls.length = 0;
    const response = await server.handle(toolCall(name, args));
    assert.equal(response.result.isError, false, name);
    assert.deepEqual(calls[1], ['connect', { allowPairing: false }]);
    assert.ok(calls.some(call => { try { assert.deepEqual(call, expected); return true; } catch { return false; } }), name);
    assert.deepEqual(calls.at(-1), ['close']);
  }
});

test('app launches confirm actual foreground but never claim content playback', async () => {
  const { server, fake, calls } = await fixture();
  const launched = await server.handle(toolCall('tv_launch', { id: 'example.app' }));
  assert.equal(launched.result.isError, false);
  assert.equal(decoded(launched).requestAccepted, true);
  assert.equal(decoded(launched).confirmed, true);
  assert.equal(decoded(launched).foregroundVerified, true);
  assert.equal(decoded(launched).verificationScope, 'foreground_app');
  assert.ok(calls.some(call => call[0] === 'waitForApp' && call[1] === 'example.app'));
  const content = await server.handle(toolCall('tv_launch_content', { id: 'example.app', content: 'known-title' }));
  assert.equal(decoded(content).confirmed, true);
  assert.equal(decoded(content).contentPlaybackVerified, false);

  fake.waitForApp = async () => { throw Object.assign(new Error('Foreground app timed out'), {
    code: 'TIMEOUT', payload: { lastObservedAppId: 'old.app', lastObserved: { appId: 'old.app' } },
  }); };
  const timedOut = await server.handle(toolCall('tv_launch', { id: 'example.app' }));
  assert.equal(timedOut.result.isError, true);
  assert.equal(decoded(timedOut).requestAccepted, true);
  assert.equal(decoded(timedOut).confirmed, false);
  assert.equal(decoded(timedOut).lastObservedAppId, 'old.app');
  assert.equal(decoded(timedOut).error.code, 'TIMEOUT');
  assert.deepEqual(calls.at(-1), ['close']);

  fake.waitForApp = async () => ({ confirmed: true, foreground: { appId: 'wrong.app' } });
  const wrong = await server.handle(toolCall('tv_launch', { id: 'example.app' }));
  assert.equal(wrong.result.isError, true);
  assert.equal(decoded(wrong).foregroundVerified, false);
  fake.launch = async () => ({ returnValue: false });
  fake.waitForApp = async () => assert.fail('Rejected requests should not be verified');
  assert.equal(decoded(await server.handle(toolCall('tv_launch', { id: 'example.app' }))).error.code, 'REQUEST_REJECTED');
});

test('input verification uses reported app IDs and missing metadata stays uncertain', async () => {
  const { server, fake, calls } = await fixture();
  const response = await server.handle(toolCall('tv_set_input', { id: 'HDMI_1' }));
  assert.equal(response.result.isError, false);
  assert.equal(decoded(response).expectedAppId, 'reported.hdmi.app');
  assert.equal(decoded(response).verificationScope, 'input_foreground');
  assert.ok(calls.some(call => call[0] === 'waitForApp' && call[1] === 'reported.hdmi.app'));
  assert.ok(calls.findIndex(call => call[0] === 'status') < calls.findIndex(call => call[0] === 'setInput'));

  fake.status = async () => state({ devices: [{ id: 'HDMI_1' }] });
  fake.waitForApp = async () => assert.fail('Missing appId must never be guessed');
  const missing = await server.handle(toolCall('tv_set_input', { id: 'HDMI_1' }));
  assert.equal(missing.result.isError, true);
  assert.equal(decoded(missing).requestAccepted, true);
  assert.equal(decoded(missing).confirmed, false);
  assert.equal(decoded(missing).error.code, 'INPUT_METADATA_UNAVAILABLE');
});

test('volume and mute require matching typed readback after acknowledged writes', async () => {
  const { server, fake, calls } = await fixture();
  fake.status = async () => { calls.push(['status']); return state({ volume: 25, muted: true }); };
  for (const [name, args, setter, expected] of [
    ['tv_set_volume', { volume: 25 }, 'setVolume', 25], ['tv_mute', { muted: true }, 'mute', true],
  ]) {
    calls.length = 0;
    const response = await server.handle(toolCall(name, args));
    assert.equal(response.result.isError, false);
    assert.equal(decoded(response).confirmed, true);
    assert.equal(decoded(response).observed, expected);
    assert.ok(calls.findIndex(call => call[0] === setter) < calls.findIndex(call => call[0] === 'status'));
  }
  const different = await server.handle(toolCall('tv_set_volume', { volume: 26 }));
  assert.equal(different.result.isError, true);
  assert.equal(decoded(different).requestAccepted, true);
  assert.equal(decoded(different).observed, 25);
  fake.status = async () => ({ volume: { status: 'ok', payload: { volumeStatus: { volume: '25', muted: 'true' } } } });
  assert.equal(decoded(await server.handle(toolCall('tv_set_volume', { volume: 25 }))).confirmed, false);
  assert.equal(decoded(await server.handle(toolCall('tv_mute', { muted: true }))).confirmed, false);
  fake.status = async () => ({ audio: { status: 'error', payload: { mute: true } } });
  const missing = await server.handle(toolCall('tv_mute', { muted: true }));
  assert.equal(missing.result.isError, true);
  assert.equal(decoded(missing).observed, null);
});

test('direct media and generic controls report acceptance without claiming completion', async () => {
  const { server } = await fixture();
  const played = await server.handle(toolCall('tv_play_url', { url: 'https://example.org/movie.mp4', mimeType: 'video/mp4' }));
  assert.equal(played.result.isError, false);
  assert.equal(decoded(played).requestAccepted, true);
  assert.equal(decoded(played).confirmed, false);
  assert.equal(decoded(played).playbackVerified, false);
  const opened = await server.handle(toolCall('tv_open_url', { url: 'https://example.org' }));
  assert.equal(decoded(opened).requestAccepted, true);
  assert.equal(decoded(opened).confirmed, false);
});

test('DLNA tools preserve verified renderer results and work without SSAP pairing', async () => {
  const { server, fake, calls } = await fixture({ loadConfig: async () => ({ host: config.host, wake: {}, allowedUrlOrigins: config.allowedUrlOrigins }) });
  fake.connect = async () => assert.fail('DLNA must not open SSAP or start pairing');
  const url = 'http://192.168.1.3/movie.mp4';
  const played = await server.handle(toolCall('tv_dlna_play', { url, mimeType: 'video/mp4', title: 'Local movie' }));
  assert.equal(played.result.isError, false);
  assert.deepEqual(decoded(played), {
    requestAccepted: true, confirmed: true, playbackVerified: true, transportConfirmed: true, transportState: 'PLAYING',
  });
  assert.ok(calls.some(call => call[0] === 'dlnaPlay' && call[1] === url && call[2].mimeType === 'video/mp4' && call[2].title === 'Local movie'));
  assert.deepEqual(calls.at(-1), ['close']);
  const status = await server.handle(toolCall('tv_dlna_status'));
  assert.equal(status.result.isError, false);
  assert.equal(decoded(status).transportState, 'PLAYING');
  assert.equal(TV_TOOLS.find(tool => tool.name === 'tv_dlna_status').annotations.readOnlyHint, true);
  for (const action of ['play', 'pause', 'stop']) {
    const response = await server.handle(toolCall('tv_dlna_media', { action }));
    assert.equal(response.result.isError, false, action);
    assert.equal(decoded(response).confirmed, true);
    assert.equal(decoded(response).playbackVerified, action === 'play');
    assert.ok(calls.some(call => call[0] === 'dlnaMedia' && call[1] === action));
  }
});

test('DLNA uncertainty and UPnP errors retain structured evidence without claiming playback', async () => {
  const { server, fake, calls } = await fixture();
  fake.dlnaPlay = async () => ({ requestAccepted: true, confirmed: false, playbackVerified: false, transportState: 'STOPPED' });
  const unconfirmed = await server.handle(toolCall('tv_dlna_play', { url: 'https://example.org/movie.mp4', mimeType: 'video/mp4' }));
  assert.equal(unconfirmed.result.isError, true);
  assert.equal(decoded(unconfirmed).requestAccepted, true);
  assert.equal(decoded(unconfirmed).confirmed, false);
  fake.dlnaMedia = async () => { throw Object.assign(new Error(`Transport timed out ${config.clientKey}`), {
    code: 'DLNA_TIMEOUT', upnpError: 701,
    payload: { uncertain: true, requestAccepted: true, confirmed: false, playbackVerified: false, transportState: 'TRANSITIONING',
      detail: 'https://example.org/media?token=private-token' },
  }); };
  const timeout = await server.handle(toolCall('tv_dlna_media', { action: 'pause' }));
  assert.equal(timeout.result.isError, true);
  assert.equal(decoded(timeout).requestAccepted, true);
  assert.equal(decoded(timeout).uncertain, true);
  assert.equal(decoded(timeout).error.code, 'DLNA_TIMEOUT');
  assert.equal(decoded(timeout).error.upnpError, 701);
  assert.equal(JSON.stringify(timeout).includes(config.clientKey), false);
  assert.equal(JSON.stringify(timeout).includes('private-token'), false);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('file casts retain a TV-only listener until a confirmed DLNA stop or server close', async () => {
  const { hosts, mediaHostFactory } = mediaHosts();
  const { server, fake, calls } = await fixture({ mediaHostFactory,
    loadConfig: async () => ({ host: config.host, wake: { bindAddress: '192.168.1.3' }, mediaRoots: config.mediaRoots }) });
  fake.connect = async () => assert.fail('File casting must not open SSAP');
  const result = await server.handle(toolCall('tv_cast_file', { filePath: localFile, title: 'Selected movie' }));
  assert.equal(result.result.isError, false);
  assert.equal(decoded(result).confirmed, true);
  assert.equal(decoded(result).bytes, 4096);
  assert.equal(decoded(result).mimeType, 'video/mp4');
  assert.deepEqual(hosts[0].options, { tvHost: config.host, bindAddress: '192.168.1.3', mediaRoots: config.mediaRoots });
  assert.deepEqual(hosts[0].serveCalls, [[localFile, { mimeType: undefined }]]);
  assert.ok(calls.some(call => call[0] === 'dlnaPlay' && call[1] === hosts[0].url
    && call[2].mimeType === 'video/mp4' && call[2].title === 'Selected movie'));
  assert.deepEqual(calls.at(-1), ['close']);
  assert.equal(hosts[0].closeCount, 0);
  assert.equal(JSON.stringify(result).includes(localFile), false);
  assert.equal(JSON.stringify(result).includes(hosts[0].url), false);
  await server.handle(toolCall('tv_dlna_media', { action: 'pause' }));
  assert.equal(hosts[0].closeCount, 0);
  server.loadConfig = async () => config;
  fake.connect = async (...args) => calls.push(['connect', ...args]);
  assert.equal((await server.handle(toolCall('tv_media', { action: 'stop' }))).result.isError, false);
  assert.equal(hosts[0].closeCount, 0);
  const stop = fake.dlnaMedia;
  fake.dlnaMedia = async () => ({ requestAccepted: true, confirmed: false, transportState: 'PLAYING' });
  await server.handle(toolCall('tv_dlna_media', { action: 'stop' }));
  assert.equal(hosts[0].closeCount, 0);
  fake.dlnaMedia = stop;
  assert.equal((await server.handle(toolCall('tv_dlna_media', { action: 'stop' }))).result.isError, false);
  assert.equal(hosts[0].closeCount, 1);
  await server.close();
  await server.close();
  assert.equal(hosts[0].closeCount, 1);
  assert.equal((await server.handle(toolCall('tv_dlna_status'))).error.code, -32000);
});

test('confirmed stop also releases a file listener when the renderer reports no media present', async () => {
  const { hosts, mediaHostFactory } = mediaHosts();
  const { server, fake } = await fixture({ mediaHostFactory });
  await server.handle(toolCall('tv_cast_file', { filePath: localFile }));
  fake.dlnaMedia = async () => ({ requestAccepted: true, confirmed: true, transportState: 'NO_MEDIA_PRESENT' });
  assert.equal((await server.handle(toolCall('tv_dlna_media', { action: 'stop' }))).result.isError, false);
  assert.equal(hosts[0].closeCount, 1);
  await server.close();
});

test('failed casts close only the candidate and successful replacements release the previous host', async () => {
  const { hosts, mediaHostFactory } = mediaHosts();
  const { server, fake, calls } = await fixture({ mediaHostFactory });
  const play = fake.dlnaPlay;
  assert.equal((await server.handle(toolCall('tv_cast_file', { filePath: localFile, mimeType: 'video/mp4' }))).result.isError, false);
  fake.dlnaPlay = async () => ({ requestAccepted: true, confirmed: false, playbackVerified: false, transportState: 'TRANSITIONING' });
  const uncertain = await server.handle(toolCall('tv_cast_file', { filePath: localFile }));
  assert.equal(uncertain.result.isError, true);
  assert.equal(hosts[0].closeCount, 0);
  assert.equal(hosts[1].closeCount, 1);
  fake.dlnaPlay = async url => { throw Object.assign(new Error(`${localFile}: failed ${url}`), {
    code: 'DLNA_TIMEOUT', payload: { uncertain: true, requestAccepted: true, confirmed: false, url, filePath: localFile },
  }); };
  const failed = await server.handle(toolCall('tv_cast_file', { filePath: localFile }));
  assert.equal(failed.result.isError, true);
  assert.equal(decoded(failed).error.code, 'DLNA_TIMEOUT');
  assert.equal(decoded(failed).bytes, 4096);
  assert.equal(hosts[0].closeCount, 0);
  assert.equal(hosts[2].closeCount, 1);
  assert.equal(JSON.stringify(failed).includes(localFile), false);
  assert.equal(JSON.stringify(failed).includes(hosts[2].url), false);
  fake.dlnaPlay = play;
  assert.equal((await server.handle(toolCall('tv_cast_file', { filePath: localFile }))).result.isError, false);
  assert.equal(hosts[0].closeCount, 1);
  assert.equal(hosts[3].closeCount, 0);
  assert.equal(calls.some(call => call[0] === 'dlnaMedia' || call[0] === 'media'), false);
  await server.close();
  assert.equal(hosts[3].closeCount, 1);
});

test('file-host preparation failures are redacted and the candidate is closed without a playback request', async () => {
  let closed = 0;
  const { server, calls } = await fixture({ mediaHostFactory: async () => ({
    serve: async () => { throw new Error(`Cannot read ${localFile}`); }, close: async () => { closed += 1; },
  }) });
  const result = await server.handle(toolCall('tv_cast_file', { filePath: localFile }));
  assert.equal(result.result.isError, true);
  assert.equal(closed, 1);
  assert.equal(JSON.stringify(result).includes(localFile), false);
  assert.equal(calls.some(call => call[0] === 'dlnaPlay'), false);
  await server.close();
});

test('stdio EOF closes a retained file listener after delivering the cast result', async () => {
  const { hosts, mediaHostFactory } = mediaHosts();
  const { server } = await fixture({ mediaHostFactory });
  const input = new PassThrough();
  let delivered;
  const resultWritten = new Promise(resolve => { delivered = resolve; });
  const output = new Writable({ write(chunk, encoding, done) { delivered(JSON.parse(chunk.toString())); done(); } });
  const running = runStdio({ input, output, server });
  input.write(`${JSON.stringify(toolCall('tv_cast_file', { filePath: localFile }))}\n`);
  const response = await resultWritten;
  assert.equal(response.result.isError, false);
  assert.equal(hosts[0].closeCount, 0);
  input.end();
  await running;
  assert.equal(hosts[0].closeCount, 1);
});

test('concurrent commands wait for foreground verification and failed calls do not stall the queue', async () => {
  const { server, fake, calls } = await fixture();
  let release;
  let announce;
  const verifying = new Promise(resolve => { announce = resolve; });
  fake.waitForApp = id => { announce(); return new Promise(resolve => { release = () => resolve({ confirmed: true, foreground: { appId: id } }); }); };
  const launching = server.handle(toolCall('tv_launch', { id: 'example.app' }, 'launch'));
  await verifying;
  const key = server.handle(toolCall('tv_key', { key: 'ENTER' }, 'key'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(call => call[0] === 'key'), false);
  release();
  assert.equal((await launching).result.isError, false);
  assert.equal((await key).result.isError, false);
  assert.ok(calls.findIndex(call => call[0] === 'key') > calls.findIndex(call => call[0] === 'close'));
  const invalid = server.handle(toolCall('tv_key', { key: 'INVALID' }));
  const next = server.handle(toolCall('tv_key', { key: 'HOME' }));
  assert.equal((await invalid).error.code, -32602);
  assert.equal((await next).result.isError, false);
});

test('all tool schemas reject invalid types, missing arguments and extra arguments before loading config', async () => {
  const { server, calls } = await fixture();
  for (const definition of TV_TOOLS) {
    assert.equal((await server.handle(toolCall(definition.name, null))).error.code, -32602, definition.name);
    assert.equal((await server.handle(toolCall(definition.name, { unexpected: true }))).error.code, -32602, definition.name);
    for (const required of definition.inputSchema.required) {
      assert.equal((await server.handle(toolCall(definition.name))).error.code, -32602, `${definition.name}.${required}`);
    }
    for (const [property, schema] of Object.entries(definition.inputSchema.properties)) {
      const bad = schema.type === 'object' ? [] : schema.type === 'boolean' ? 'true' : schema.type === 'integer' ? 0.5 : 42;
      const base = Object.fromEntries(Object.entries(definition.inputSchema.properties).map(([key, spec]) =>
        [key, spec.enum?.[0] ?? (spec.type === 'string' ? 'value' : spec.type === 'boolean' ? true : spec.type === 'integer' ? 0 : {})]));
      assert.equal((await server.handle(toolCall(definition.name, { ...base, [property]: bad }))).error.code, -32602, `${definition.name}.${property}`);
    }
  }
  for (const [name, args] of [
    ['tv_set_volume', { volume: 101 }], ['tv_set_volume', { volume: -1 }],
    ['tv_key', { key: 'FACTORY_RESET' }], ['tv_media', { action: 'arbitrary_endpoint' }],
    ['tv_power', { action: 'on' }], ['tv_open_url', { url: 'file:///secret' }],
    ['tv_open_url', { url: 'https://user:password@example.org' }],
    ['tv_play_url', { url: 'https://example.org/movie.mp4', iconSrc: 'file:///private' }],
    ['tv_play_url', { url: 'https://example.org/movie.mp4', mimeType: 'not-a-mime-type' }],
    ['tv_play_url', { url: 'https://example.org/movie.mp4' }],
    ['tv_dlna_play', { url: 'https://example.org/movie.mp4' }],
    ['tv_dlna_play', { url: 'https://user:password@example.org/movie.mp4', mimeType: 'video/mp4' }],
    ['tv_dlna_play', { url: 'https://example.org/movie.mp4', mimeType: 'invalid' }],
    ['tv_dlna_media', { action: 'rewind' }],
    ['tv_cast_file', { filePath: 'relative/movie.mp4' }],
    ['tv_cast_file', { filePath: '\\\\server\\share\\movie.mp4' }],
    ['tv_cast_file', { filePath: localFile, mimeType: 'not-a-mime-type' }],
    ['tv_launch', { id: 'app/invalid' }],
    ['tv_launch', { id: 'app', params: { large: 'x'.repeat(17000) } }],
    ['tv_type_text', { text: '' }], ['tv_pointer_move', { dx: 10001, dy: 0 }],
    ['tv_pointer_scroll', { dx: 1001, dy: 0 }],
  ]) assert.equal((await server.handle(toolCall(name, args))).error.code, -32602, name);
  assert.equal((await server.handle(toolCall('tv_raw_request', {}))).error.code, -32602);
  assert.deepEqual(calls, []);
});

test('saved keys are required and no automatic pairing is attempted', async () => {
  const { server, calls } = await fixture({ loadConfig: async () => ({ host: config.host }) });
  const result = await server.handle(toolCall('tv_status'));
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /never starts pairing/);
  assert.deepEqual(calls, []);
});

test('temporary privileged observation requires local opt-in before any TV connection', async () => {
  for (const allowTemporaryObserver of [undefined, false, 'true', 1]) {
    const { server, calls } = await fixture({ loadConfig: async () => ({ ...config, allowTemporaryObserver }),
      observer: async () => assert.fail('Observer must not run without explicit opt-in') });
    const response = await server.handle(toolCall('tv_observe'));
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /explicit local allowTemporaryObserver=true/);
    assert.deepEqual(calls, []);
  }
});

test('local file casting requires configured media roots before creating a controller or host', async () => {
  for (const mediaRoots of [undefined, [], 'invalid', ['relative']]) {
    const { server, calls } = await fixture({ loadConfig: async () => ({ ...config, mediaRoots }),
      mediaHostFactory: async () => assert.fail('Host must not start without approved roots') });
    const response = await server.handle(toolCall('tv_cast_file', { filePath: localFile }));
    assert.equal(response.result.isError, true);
    assert.match(decoded(response).error.message, /mediaRoots/);
    assert.deepEqual(calls, []);
  }
});

test('caller URL tools default to deny and enforce exact configured origins before any connection', async () => {
  const commands = [
    ['tv_open_url', { url: 'https://example.org/watch' }],
    ['tv_play_url', { url: 'https://example.org/movie.mp4', mimeType: 'video/mp4' }],
    ['tv_dlna_play', { url: 'https://example.org/movie.mp4', mimeType: 'video/mp4' }],
    ['tv_launch', { id: 'example.app', contentId: 'https://example.org/watch' }],
    ['tv_launch_content', { id: 'example.app', content: 'https://example.org/watch' }],
  ];
  for (const allowedUrlOrigins of [undefined, [], ['https://example.org.evil.test'], ['http://example.org'], ['https://example.org:444']]) {
    const { server, calls } = await fixture({ loadConfig: async () => ({ ...config, allowedUrlOrigins }) });
    for (const [name, args] of commands) {
      const response = await server.handle(toolCall(name, args));
      assert.equal(response.result.isError, true, name);
      assert.match(JSON.stringify(response), /allowedUrlOrigins/);
    }
    assert.deepEqual(calls, []);
  }
  const permitted = await fixture({ loadConfig: async () => ({ ...config, allowedUrlOrigins: ['https://example.org'] }) });
  for (const [name, args] of commands) assert.equal((await permitted.server.handle(toolCall(name, args))).result.isError, false, name);
});

test('media icon URLs and normalized HTTP content IDs cannot bypass origin policy', async () => {
  const { server, calls } = await fixture();
  for (const [name, args] of [
    ['tv_play_url', { url: 'https://example.org/movie.mp4', mimeType: 'video/mp4', iconSrc: 'https://untrusted.example/icon.jpg' }],
    ['tv_launch', { id: 'example.app', contentId: '  https://untrusted.example/watch' }],
    ['tv_launch_content', { id: 'example.app', content: 'https:untrusted.example/watch' }],
    ['tv_launch_content', { id: 'example.app', content: 'ht\ntps://untrusted.example/watch' }],
  ]) assert.equal((await server.handle(toolCall(name, args))).result.isError, true, name);
  assert.deepEqual(calls, []);
  assert.equal((await server.handle(toolCall('tv_launch_content', { id: 'example.app', content: 'known-provider-id' }))).result.isError, false);
  assert.equal((await server.handle(toolCall('tv_launch_content', { id: 'example.app', content: 'ht\ntps://example.org/watch' }))).result.isError, false);
  assert.ok(calls.some(call => call[0] === 'launchContent' && call[2] === 'https://example.org/watch'));
});

test('unsafe URL literals are refused even if an injected configuration attempts to allow them', async () => {
  for (const origin of ['http://127.0.0.1', 'http://2130706433', 'http://169.254.169.254', 'http://224.0.0.1',
    'http://255.255.255.255', 'http://192.168.1.255', 'http://0.0.0.0', 'http://[::1]', 'http://[::]',
    'http://[::ffff:127.0.0.1]', 'http://[fe80::1]', 'http://[ff02::1]', 'http://localhost', 'http://tv.localhost']) {
    const { server, calls } = await fixture({ loadConfig: async () => ({ ...config, allowedUrlOrigins: [origin] }) });
    const response = await server.handle(toolCall('tv_open_url', { url: origin + '/private' }));
    assert.equal(response.result.isError, true, origin);
    assert.deepEqual(calls, []);
  }
  const publicV6 = 'https://[2001:4860:4860::8888]';
  const permitted = await fixture({ loadConfig: async () => ({ ...config, allowedUrlOrigins: [publicV6] }) });
  assert.equal((await permitted.server.handle(toolCall('tv_open_url', { url: publicV6 + '/fixture' }))).result.isError, false);
});

test('URL policy failures never echo URL credentials or sensitive query values', async () => {
  const { server } = await fixture();
  for (const url of ['https://user:private-password@untrusted.example/watch', 'https://untrusted.example/watch?token=private-token']) {
    const response = await server.handle(toolCall('tv_open_url', { url }));
    const serialized = JSON.stringify(response);
    assert.equal(response.error?.code === -32602 || response.result?.isError === true, true);
    assert.equal(serialized.includes('private-password'), false);
    assert.equal(serialized.includes('private-token'), false);
  }
});

test('public MCP launch params cannot pass arbitrary app payloads or callback URLs', async () => {
  const { server, calls } = await fixture();
  for (const params of [{ target: 'http://192.168.1.3/code.html' }, { command: 'any-payload' }, { nested: {} }]) {
    assert.equal((await server.handle(toolCall('tv_launch', { id: 'example.app', params }))).error.code, -32602);
  }
  assert.deepEqual(calls, []);
});

test('bare content IDs cannot carry custom/local schemes or obfuscated script payloads', async () => {
  const { server, calls } = await fixture();
  for (const content of ['javascript:alert(1)', 'java\nscript:alert(1)', 'luna://system/method', 'file:///tmp/private',
    'provider:arbitrary-command', '//untrusted.example/watch', 'https%3A%2F%2Funtrusted.example', 'id with spaces', 'x'.repeat(129)]) {
    for (const [name, args] of [['tv_launch', { id: 'example.app', contentId: content }], ['tv_launch_content', { id: 'example.app', content }]]) {
      assert.equal((await server.handle(toolCall(name, args))).error.code, -32602, name);
    }
  }
  assert.deepEqual(calls, []);
  for (const content of ['70GoJHflgHH9', 'e8896bfa-1052-41f7-ae2e-00255d77cf05', 'provider_id.v2']) {
    assert.equal((await server.handle(toolCall('tv_launch_content', { id: 'example.app', content }))).result.isError, false);
  }
});

test('wake requires explicit action and a saved MAC, and never opens a TV connection', async () => {
  const { server, calls } = await fixture();
  const result = await server.handle(toolCall('tv_power', { action: 'wake' }));
  assert.equal(result.result.isError, false);
  assert.deepEqual(calls, [['wake', config.mac, { broadcast: undefined, bindAddress: undefined, port: 9 }]]);
  const missing = await fixture({ loadConfig: async () => ({ host: config.host }) });
  assert.equal((await missing.server.handle(toolCall('tv_power', { action: 'wake' }))).result.isError, true);
  assert.deepEqual(missing.calls, []);
});

test('execution errors are tool errors, redact saved keys and typed text, and close failed connections', async () => {
  const { server, fake, calls } = await fixture();
  fake.typeText = async text => { throw new Error(`client-key=${config.clientKey} text=${text} https://example.org/?token=private-token`); };
  const response = await server.handle(toolCall('tv_type_text', { text: 'private-password' }));
  assert.equal(response.result.isError, true);
  const output = JSON.stringify(response);
  assert.equal(output.includes(config.clientKey), false);
  assert.equal(output.includes('private-password'), false);
  assert.equal(output.includes('private-token'), false);
  assert.deepEqual(calls.at(-1), ['close']);
  fake.connect = async () => { throw new Error('connect failed'); };
  assert.equal((await server.handle(toolCall('tv_apps'))).result.isError, true);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('responses redact nested credentials and temporary pointer socket URLs', () => {
  const value = redactOutput({ 'client-key': 'abc', nested: { authorization: 'Bearer xyz', socketPath: 'ws://192.168.1.2/key' },
    url: 'https://user:pass@example.org/file?signature=private&title=ok', message: 'abc' }, ['abc']);
  assert.equal(value['client-key'], '[redacted]');
  assert.equal(value.nested.socketPath, '[redacted]');
  const serialized = JSON.stringify(value);
  for (const secret of ['abc', 'Bearer xyz', 'user:pass', 'signature=private']) assert.equal(serialized.includes(secret), false);
  assert.equal(value.message, '[redacted]');
});

test('screenshots produce MCP image blocks, and capture failures remain errors', async () => {
  const { server, calls, fake } = await fixture();
  const response = await server.handle(toolCall('tv_screenshot'));
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.content[0], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  assert.deepEqual(JSON.parse(response.result.content[1].text), { bytes: png.length });
  assert.deepEqual(calls.at(-1), ['close']);
  fake.screenshot = async () => { throw new Error('500 screenshot execution failed'); };
  const failed = await server.handle(toolCall('tv_screenshot'));
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /500/);
  assert.equal(failed.result.content.some(c => c.type === 'image'), false);
  fake.screenshot = async () => ({ data: png, contentType: 'text/html' });
  assert.equal((await server.handle(toolCall('tv_screenshot'))).result.isError, true);
});

test('internal observations return JPEG and redacted metadata without claiming title playback', async () => {
  let seenController;
  let seenOptions;
  const { server, fake, calls } = await fixture({ observer: async (controller, options) => {
    seenController = controller;
    seenOptions = options;
    return { image: jpeg, mimeType: 'image/jpeg', metadata: {
      foregroundAppId: 'com.disney.disneyplus-prod', playerState: 'playing',
      titleVerified: false, originalAppRestored: true,
      clientKey: config.clientKey, detail: `diagnostic ${config.clientKey}`,
    } };
  } });
  const response = await server.handle(toolCall('tv_observe'));
  assert.equal(response.result.isError, false);
  assert.equal(seenController, fake);
  assert.deepEqual(seenOptions, { timeoutMs: 25000 });
  assert.deepEqual(response.result.content[0], { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' });
  const observed = JSON.parse(response.result.content[1].text).result;
  assert.equal(observed.foregroundAppId, 'com.disney.disneyplus-prod');
  assert.equal(observed.playerState, 'playing');
  assert.equal(observed.titleVerified, false);
  assert.equal(observed.originalAppRestored, true);
  assert.equal(observed.screenshotVerified, true);
  assert.equal(observed.bytes, jpeg.length);
  assert.equal(observed.mimeType, 'image/jpeg');
  assert.equal(Object.hasOwn(observed, 'image'), false);
  assert.equal(JSON.stringify(response).includes(config.clientKey), false);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('internal observation without an image preserves partial evidence with screenshot explicitly unverified', async () => {
  const { server, calls } = await fixture({ observer: async () => ({ metadata: {
    foregroundAppId: 'example.app', screenshotVerified: true,
    captureError: { code: 'CAPTURE_FAILED' }, originalAppRestored: true,
  } }) });
  const response = await server.handle(toolCall('tv_observe'));
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  assert.equal(decoded(response).screenshotVerified, false);
  assert.equal(decoded(response).foregroundAppId, 'example.app');
  assert.deepEqual(decoded(response).captureError, { code: 'CAPTURE_FAILED' });
  assert.deepEqual(calls.at(-1), ['close']);
});

test('internal observation rejects malformed or oversized images and closes the controller on failure', async () => {
  const { server, calls } = await fixture();
  for (const result of [
    { image: png, mimeType: 'image/jpeg', metadata: {} },
    { image: jpeg, mimeType: 'image/png', metadata: {} },
    { image: jpeg.toString('base64'), mimeType: 'image/jpeg', metadata: {} },
    { image: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: 'image/jpeg', metadata: {} },
    { image: jpeg, mimeType: 'image/jpeg' },
  ]) {
    server.observer = async () => result;
    const response = await server.handle(toolCall('tv_observe'));
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content.some(content => content.type === 'image'), false);
    assert.deepEqual(calls.at(-1), ['close']);
  }
  server.observer = async () => { throw new Error(`Observation failed ${config.clientKey}`); };
  const response = await server.handle(toolCall('tv_observe'));
  assert.equal(response.result.isError, true);
  assert.equal(JSON.stringify(response).includes(config.clientKey), false);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('remote commands wait for temporary observation and restoration to finish', async () => {
  let release;
  let announce;
  const observing = new Promise(resolve => { announce = resolve; });
  const { server, calls } = await fixture({ observer: async () => {
    announce();
    return new Promise(resolve => { release = () => resolve({ metadata: { originalAppRestored: true } }); });
  } });
  const observation = server.handle(toolCall('tv_observe', {}, 'observe'));
  await observing;
  const key = server.handle(toolCall('tv_key', { key: 'ENTER' }, 'key'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(call => call[0] === 'key'), false);
  release();
  assert.equal((await observation).result.isError, false);
  assert.equal((await key).result.isError, false);
  assert.ok(calls.findIndex(call => call[0] === 'key') > calls.findIndex(call => call[0] === 'close'));
});

test('private config selects the exact profile, honors explicit host and never writes', async () => {
  const registrationManifest = { manifestVersion: 1, permissions: ['TEST'] };
  const saved = { schemaVersion: 1, devices: {
    '192.168.1.2': { clientKey: 'first-key', secure: true, port: 3001, permissions: ['TEST'], registrationManifest, wake: { mac: config.mac }, allowTemporaryObserver: true,
      mediaRoots: config.mediaRoots, allowedUrlOrigins: ['https://example.org/'] },
    '192.168.1.3': { clientKey: 'second-key' },
  } };
  const readFile = async () => JSON.stringify(saved);
  const selected = await loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile, host: '192.168.1.2', env: { LG_TV_HOST: '192.168.1.3' } });
  assert.equal(selected.clientKey, 'first-key');
  assert.equal(selected.mac, config.mac);
  assert.equal(selected.allowTemporaryObserver, true);
  assert.deepEqual(selected.mediaRoots, config.mediaRoots);
  assert.deepEqual(selected.allowedUrlOrigins, ['https://example.org']);
  assert.deepEqual(selected.registrationManifest, registrationManifest);
  const other = await loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile, env: { LG_TV_HOST: '192.168.1.3' } });
  assert.equal(other.clientKey, 'second-key');
  assert.equal(other.allowTemporaryObserver, false);
  assert.deepEqual(other.mediaRoots, []);
  assert.deepEqual(other.allowedUrlOrigins, []);
  await assert.rejects(loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile, env: {} }), /Select a private/);
  await assert.rejects(loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile, host: '8.8.8.8', env: {} }), /Select a private/);
  await assert.rejects(loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile: async () => '{broken', env: {} }), /Unable to read/);
  const sole = await loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile: async () => JSON.stringify({ devices: { [config.host]: { clientKey: 'sole' } } }), env: {} });
  assert.equal(sole.clientKey, 'sole');
  for (const mediaRoots of [null, 'path', ['relative'], ['\\\\server\\share']]) {
    await assert.rejects(loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile: async () => JSON.stringify({ devices: { [config.host]: { clientKey: 'key', mediaRoots } } }), env: {} }), /mediaRoots/);
  }
  for (const allowedUrlOrigins of [null, 'https://example.org', ['https://*.example.org'], ['https://user:secret@example.org'],
    ['https://example.org/private'], ['https://example.org?token=secret'], ['https://example.org#fragment'], ['file:///tmp'], ['http://127.0.0.1']]) {
    await assert.rejects(loadPrivateConfig({ resolveKey: async profile => profile.clientKey, readFile: async () => JSON.stringify({ devices: { [config.host]: { clientKey: 'key', allowedUrlOrigins } } }), env: {} }), /origin|allowedUrlOrigins/);
  }
});

test('stdio handles split UTF-8 newline messages, silent notifications, parse errors and EOF without stdout noise', async () => {
  const { server } = await fixture();
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, done) { chunks.push(chunk.toString()); done(); } });
  const running = runStdio({ input, output, server });
  const messages = [
    readyNotification, { jsonrpc: '2.0', id: 'a', method: 'ping' },
    toolCall('tv_type_text', { text: '你好\nworld' }, 'b'), { jsonrpc: '2.0', id: 'c', method: 'unknown' },
  ];
  const wire = Buffer.from(messages.map(m => JSON.stringify(m)).join('\n') + '\nnot-json\n' + JSON.stringify({ jsonrpc: '2.0', id: 'd', method: 'ping' }));
  // Exercise boundaries within multibyte text and multiple complete messages per chunk.
  for (let i = 0; i < wire.length; i += 7) input.write(wire.subarray(i, i + 7));
  input.end();
  await running;
  const responses = chunks.join('').trim().split('\n').map(JSON.parse);
  assert.deepEqual(responses.map(r => r.id), ['a', 'b', 'c', null, 'd']);
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].error.code, -32601);
  assert.equal(responses[3].error.code, -32700);
});

test('invalid JSON-RPC envelopes are rejected; notifications receive no replies', async () => {
  const { server } = await fixture();
  for (const message of [[], null, { jsonrpc: '1.0', id: 2, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }]) {
    assert.equal((await server.handle(message)).error.code, -32600);
  }
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'unknown-notification' }), null);
});
