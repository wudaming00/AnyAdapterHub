import test from 'node:test';
import assert from 'node:assert/strict';
import { DLNAClient, DLNAError } from '../lib/dlna.mjs';

const HOST = '192.168.30.40';
const SERVICE_TYPE = 'urn:schemas-upnp-org:service:AVTransport:1';
const args = names => names.map(name => ({ name, direction: 'in', relatedStateVariable: name }));
function service() {
  return { serviceType: SERVICE_TYPE, controlURL: `http://${HOST}:1255/AVTransport/random/control.xml`, actions: [
    { name: 'GetTransportInfo', arguments: args(['InstanceID']) },
    { name: 'SetAVTransportURI', arguments: args(['InstanceID', 'CurrentURI', 'CurrentURIMetaData']) },
    { name: 'Play', arguments: args(['InstanceID', 'Speed']) },
    { name: 'Pause', arguments: args(['InstanceID']) },
    { name: 'Stop', arguments: args(['InstanceID']) },
  ] };
}
function response(action, fields = '') {
  return { status: 200, headers: {}, body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${SERVICE_TYPE}">${fields}</u:${action}Response></s:Body></s:Envelope>` };
}
function stateResponse(state = 'PLAYING', status = 'OK') {
  return response('GetTransportInfo', `<CurrentTransportState>${state}</CurrentTransportState><CurrentTransportStatus>${status}</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`);
}
function fixture({ states = ['PLAYING'], http, ...options } = {}) {
  const calls = [];
  let time = 0;
  let position = 0;
  const client = new DLNAClient({ host: HOST, service: service(),
    nowFn: () => time, sleepFn: async delay => { time += delay; },
    localHttpFn: async (url, request) => {
      const action = request.headers.SOAPAction.match(/#(\w+)"$/)?.[1];
      const call = { action, url, ...request }; calls.push(call);
      if (http) {
        const supplied = await http(call, { advance: delay => { time += delay; } });
        if (supplied) return supplied;
      }
      if (action === 'GetTransportInfo') return stateResponse(states[Math.min(position++, states.length - 1)]);
      return response(action);
    }, ...options });
  return { client, calls };
}

test('discovery selects only the configured TV and validates its advertised AVTransport', async () => {
  const queries = [];
  const client = new DLNAClient({ host: HOST, interfaceAddress: '192.168.30.2', discoverFn: async query => {
    queries.push(query);
    return { devices: [
      { address: '192.168.30.99', description: { services: [{ ...service(), controlURL: 'http://192.168.30.99/control' }] } },
      { address: HOST, description: { services: [service()] } },
    ] };
  } });
  assert.deepEqual(await client.connect(), { connected: true, host: HOST });
  await client.connect();
  assert.equal(queries.length, 1);
  const { signal, ...query } = queries[0];
  assert.deepEqual(query, { host: HOST, interfaceAddress: '192.168.30.2', durationMs: 4500 });
  assert.equal(signal.aborted, false);
  client.close();
  await assert.rejects(client.connect(), { code: 'CLIENT_CLOSED' });
});

test('control endpoint, service type and schemas fail before any mutation', async () => {
  for (const url of ['http://example.org/control', 'http://192.168.30.99/control', `http://user:secret@${HOST}/control`,
    `file://${HOST}/control`, `http://${HOST}/control#fragment`]) {
    const { client, calls } = fixture({ service: { ...service(), controlURL: url } });
    await assert.rejects(client.connect(), { code: 'INVALID_SERVICE_URL' });
    assert.equal(calls.length, 0);
  }
  const wrong = fixture({ service: { ...service(), serviceType: 'urn:schemas-upnp-org:service:RenderingControl:1' } });
  await assert.rejects(wrong.client.connect(), { code: 'SERVICE_NOT_FOUND' });
  const incomplete = service(); incomplete.actions = incomplete.actions.filter(action => action.name !== 'Play');
  const missing = fixture({ service: incomplete });
  await missing.client.connect();
  await assert.rejects(missing.client.play('http://192.168.30.2/test.mp4', { mimeType: 'video/mp4' }), { code: 'INVALID_SERVICE_SCHEMA' });
  assert.equal(missing.calls.length, 0);
  const malformed = fixture({ service: { ...service(), actions: [{ name: 'GetTransportInfo', arguments: {} }] } });
  await assert.rejects(malformed.client.connect(), { code: 'INVALID_SERVICE_SCHEMA' });
});

test('play emits SOAP encodingStyle and escaped DIDL, then confirms actual PLAYING readback', async () => {
  const { client, calls } = fixture({ states: ['TRANSITIONING', 'PLAYING'] });
  await client.connect();
  const result = await client.play('http://192.168.30.2/movie.mp4?x=1&token=private-token', {
    mimeType: 'video/mp4', title: 'A <test> & title',
  });
  assert.deepEqual(calls.map(call => call.action), ['SetAVTransportURI', 'Play', 'GetTransportInfo', 'GetTransportInfo']);
  assert.match(calls[0].body, /s:encodingStyle="http:\/\/schemas\.xmlsoap\.org\/soap\/encoding\/"/);
  assert.match(calls[0].body, /<CurrentURI>[^<]*x=1&amp;token=private-token<\/CurrentURI>/);
  assert.match(calls[0].body, /<CurrentURIMetaData>&lt;DIDL-Lite/);
  assert.match(calls[0].body, /http-get:\*:video\/mp4:DLNA\.ORG_OP=01/);
  assert.match(calls[0].body, /object\.item\.videoItem/);
  assert.match(calls[0].body, /A &amp;lt;test&amp;gt; &amp;amp; title/);
  assert.equal(calls[0].headers['Content-Length'], Buffer.byteLength(calls[0].body));
  assert.equal(calls[0].expectedHost, HOST);
  assert.equal(result.confirmed, true);
  assert.equal(result.transportState, 'PLAYING');
  assert.equal(result.playbackVerified, true);
  assert.equal(result.contentVerified, false);
  assert.equal(result.elapsedMs, 250);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(calls.some(call => call.action === 'Stop'), false);
});

test('a Play response taking over six seconds retains the 15-second request timeout', async () => {
  const { client, calls } = fixture({ http: (call, clock) => {
    if (call.action === 'Play') { clock.advance(6111); return response('Play'); }
  } });
  await client.connect();
  const result = await client.play('http://192.168.30.2/movie.mp4', { mimeType: 'video/mp4' });
  assert.equal(calls.find(call => call.action === 'Play').timeoutMs, 15000);
  assert.equal(result.playbackVerified, true);
});

test('pause and stop require their own readback states and close never sends Stop', async () => {
  const { client, calls } = fixture({ states: ['PLAYING', 'PAUSED_PLAYBACK', 'STOPPED', 'PLAYING'] });
  await client.connect();
  const paused = await client.media('pause');
  assert.equal(paused.confirmed, true);
  assert.equal(paused.transportConfirmed, true);
  assert.equal(paused.playbackVerified, false);
  assert.equal(paused.transportState, 'PAUSED_PLAYBACK');
  assert.equal((await client.media('stop')).transportState, 'STOPPED');
  assert.equal((await client.media('play')).playbackVerified, true);
  const count = calls.length;
  client.close();
  assert.equal(calls.length, count);
  await assert.rejects(client.media('play'), { code: 'CLIENT_CLOSED' });
  await assert.rejects(client.status(), { code: 'CLIENT_CLOSED' });
  await assert.rejects(client.play('http://192.168.30.2/a', { mimeType: 'video/mp4' }), { code: 'CLIENT_CLOSED' });
});

test('ACK without state change times out as uncertain and never retries the mutation', async () => {
  const { client, calls } = fixture({ states: ['STOPPED'], timeoutMs: 600, pollMs: 250 });
  await client.connect();
  await assert.rejects(client.media('play'), error => {
    assert.equal(error.code, 'DLNA_STATE_TIMEOUT');
    assert.equal(error.uncertain, true);
    assert.equal(error.payload.requestAccepted, true);
    assert.equal(error.payload.confirmed, false);
    assert.equal(error.payload.playbackVerified, false);
    assert.equal(error.payload.transportState, 'STOPPED');
    return true;
  });
  assert.equal(calls.filter(call => call.action === 'Play').length, 1);
});

test('SOAP faults preserve UPnP errors while omitting media URLs and raw response bodies', async () => {
  const { client, calls } = fixture({ http: call => call.action === 'SetAVTransportURI' ? {
    status: 500, headers: {}, body: '<s:Fault><detail><UPnPError><errorCode>714</errorCode><errorDescription>Illegal MIME-type http://192.168.30.2/private.mp4?token=secret</errorDescription></UPnPError></detail></s:Fault>',
  } : undefined });
  await client.connect();
  await assert.rejects(client.play('http://192.168.30.2/private.mp4?token=secret', { mimeType: 'video/mp4' }), error => {
    assert.ok(error instanceof DLNAError);
    assert.equal(error.code, 'DLNA_SOAP_FAULT');
    assert.equal(error.upnpError, '714');
    assert.equal(error.payload.requestAccepted, false);
    assert.equal(error.uncertain, false);
    assert.equal(JSON.stringify(error).includes('token=secret'), false);
    assert.equal(error.message.includes('token=secret'), false);
    return true;
  });
  assert.deepEqual(calls.map(call => call.action), ['SetAVTransportURI']);
});

test('transport timeouts after dispatch remain uncertain and are not retried', async () => {
  const { client, calls } = fixture({ http: call => {
    if (call.action === 'Play') throw Object.assign(new Error('HTTP timeout http://192.168.30.2/private?token=secret'), { code: 'ETIMEDOUT' });
  } });
  await client.connect();
  await assert.rejects(client.media('play'), error => error.code === 'DLNA_TIMEOUT' && error.uncertain === true &&
    error.payload.requestAccepted === null && !error.message.includes('secret'));
  assert.equal(calls.length, 1);
});

test('a Play fault after SetURI preserves partial URI change evidence without leaking the URL', async () => {
  const { client, calls } = fixture({ http: call => call.action === 'Play' ? { status: 500, headers: {},
    body: '<s:Fault><detail><UPnPError><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail></s:Fault>',
  } : undefined });
  await client.connect();
  await assert.rejects(client.play('http://192.168.30.2/movie.mp4?token=secret', { mimeType: 'video/mp4' }), error => {
    assert.equal(error.payload.mediaUriSet, true);
    assert.equal(error.payload.partialChange, true);
    assert.equal(error.payload.failedAction, 'Play');
    assert.equal(error.payload.requestAccepted, false);
    assert.equal(error.upnpError, '701');
    assert.equal(JSON.stringify(error).includes('secret'), false);
    return true;
  });
  assert.deepEqual(calls.map(call => call.action), ['SetAVTransportURI', 'Play']);
});

test('status omits unrelated URI metadata and validates response completeness', async () => {
  const { client } = fixture({ http: () => response('GetTransportInfo',
    '<CurrentTransportState>STOPPED</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed><CurrentURI>http://example.org/private?token=secret</CurrentURI>') });
  await client.connect();
  const status = await client.status();
  assert.equal(status.transportState, 'STOPPED');
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.deepEqual(Object.keys(status), ['transportState', 'transportStatus', 'currentSpeed', 'capturedAt']);
  const malformed = fixture({ http: () => response('GetTransportInfo', '<CurrentTransportState>PLAYING</CurrentTransportState>') });
  await malformed.client.connect();
  await assert.rejects(malformed.client.status(), { code: 'DLNA_PROTOCOL_ERROR' });
});

test('unsupported actions, URL credentials/schemes and missing MIME never dispatch controls', async () => {
  const { client, calls } = fixture();
  await client.connect();
  for (const value of ['file:///tmp/a.mp4', 'javascript:alert(1)', 'https://user:secret@example.org/movie.mp4']) {
    await assert.rejects(client.play(value, { mimeType: 'video/mp4' }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(client.play('https://example.org/movie.mp4'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.play('https://example.org/movie.mp4', { mimeType: 'video/mp4\r\nInjected: x' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.media('seek'), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
