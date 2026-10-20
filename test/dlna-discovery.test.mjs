import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { discoverSelectedAVTransport } from '../lib/dlna-discovery.mjs';
import { DLNAClient } from '../lib/dlna.mjs';
import { discover, parseDescription } from '../discover.mjs';

const HOST = '192.168.30.40', OTHER = '192.168.30.99', INTERFACE = '192.168.30.2';
const TYPE = 'urn:schemas-upnp-org:service:AVTransport:1', ORIGIN = `http://${HOST}:1255`;
const INPUTS = { GetTransportInfo: ['InstanceID'], SetAVTransportURI: ['InstanceID', 'CurrentURI', 'CurrentURIMetaData'], Play: ['InstanceID', 'Speed'], Pause: ['InstanceID'], Stop: ['InstanceID'] };
const ssdp = location => Buffer.from(`HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nLOCATION: ${location}\r\n\r\n`);
const xml = value => value.replaceAll('&', '&amp;');
const description = (extra = {}) => `<root><URLBase>${xml(extra.base ?? ORIGIN + '/')}</URLBase><device><friendlyName>Synthetic private TV name</friendlyName><manufacturer>LG Electronics</manufacturer><modelName>LG synthetic fixture</modelName><serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><SCPDURL>http://${OTHER}/never-inspect.xml</SCPDURL><controlURL>/never-control</controlURL></service>
  <service><serviceType>${extra.type ?? TYPE}</serviceType><SCPDURL>${xml(extra.scpd ?? '/avt.xml')}</SCPDURL><controlURL>${xml(extra.control ?? '/AVTransport/random/control.xml')}</controlURL><eventSubURL>${xml(extra.events ?? '/AVTransport/event.xml')}</eventSubURL></service>
  </serviceList></device></root>`;
const scpd = (inputs = INPUTS) => `<scpd><actionList>${Object.entries(inputs).map(([name, args]) => `<action><name>${name}</name><argumentList>${args.map(name => `<argument><name>${name}</name><direction>in</direction><relatedStateVariable>unused</relatedStateVariable></argument>`).join('')}</argumentList></action>`).join('')}<action><name>UnreviewedDeviceAction</name><argumentList/></action></actionList></scpd>`;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function transportFixture(t, { packets, pages = {}, stall = false, interfaces, failSocket = false, nativeHTTP = false, pendingBind = false } = {}) {
  const sockets = [], sends = [], gets = [], requests = [];
  const networkInterfaces = () => interfaces ?? { fixture: [{ address: INTERFACE, family: 'IPv4', internal: false }] };
  const socketFactory = () => {
    const socket = new EventEmitter(); socket.closed = false; socket.sent = false; sockets.push(socket);
    socket.bind = (_port, address, callback) => {
      socket.binding = true;
      socket.finishBind = () => { socket.binding = false; if (socket.closed) return; if (failSocket && sockets[0] === socket) { socket.emit('error', Error('synthetic bind failure')); return; } socket.address = address; callback(); };
      if (!pendingBind) queueMicrotask(socket.finishBind);
    };
    socket.setMulticastInterface = address => assert.equal(address, socket.address);
    socket.setMulticastTTL = value => assert.equal(value, 2);
    socket.send = (bytes, port, address) => {
      assert.equal(socket.closed, false); sends.push({ bytes: bytes.toString(), port, address });
      if (!socket.sent) { socket.sent = true; queueMicrotask(() => { for (const [address, packet] of packets ?? [[HOST, ssdp(ORIGIN + '/root.xml')]]) socket.emit('message', packet, { address }); }); }
    };
    socket.close = callback => { if (pendingBind && socket.binding) throw Object.assign(Error('synthetic bind pending'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }); socket.closed = true; callback?.(); socket.emit('close'); };
    return socket;
  };
  t.mock.method(os, 'networkInterfaces', networkInterfaces); t.mock.method(dgram, 'createSocket', socketFactory);
  if (!nativeHTTP) {
    t.mock.method(net, 'createConnection', () => { throw new Error('Selected discovery must not probe any TCP port.'); });
    t.mock.method(http, 'get', (url, options, callback) => {
      gets.push(url.href); assert.equal(url.hostname, HOST); assert.equal(options.agent, false); assert.ok([INTERFACE, '192.168.30.3'].includes(options.localAddress));
      const request = new EventEmitter(); request.destroyed = false; request.destroy = () => { request.destroyed = true; }; requests.push(request);
      queueMicrotask(() => {
        if (request.destroyed) return;
        const page = pages[url.pathname] ?? { body: url.pathname === '/root.xml' ? description() : scpd() };
        const response = new EventEmitter(); response.statusCode = page.status ?? 200; response.headers = page.headers ?? {}; response.destroy = () => { response.destroyed = true; }; request.response = response;
        callback(response);
        if (!stall) queueMicrotask(() => { if (response.destroyed) return; response.emit('data', Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body ?? '')); response.emit('end'); });
      });
      return request;
    });
  }
  return { sockets, sends, gets, requests, dependencies: { socketFactory, networkInterfaces } };
}

test('selected discovery ignores foreign SSDP replies before HTTP and fetches only the selected AVTransport schema without port probes', async t => {
  const f = transportFixture(t, { packets: [[OTHER, ssdp(`http://${OTHER}/private.xml`)], [HOST, ssdp(`http://${OTHER}/redirect-target.xml`)], [HOST, ssdp(ORIGIN + '/root.xml')]] });
  const result = await discoverSelectedAVTransport({ host: HOST, interfaceAddress: INTERFACE, durationMs: 2 }, f.dependencies);
  assert.deepEqual(f.gets, [ORIGIN + '/root.xml', ORIGIN + '/avt.xml']); assert.equal(f.sockets.every(socket => socket.closed), true);
  assert.equal(result.devices.length, 1); assert.equal(result.devices[0].address, HOST);
  const selected = result.devices[0].description.services;
  assert.equal(selected.length, 1); assert.equal(selected[0].controlURL, ORIGIN + '/AVTransport/random/control.xml');
  assert.deepEqual(selected[0].actions.map(action => action.name), Object.keys(INPUTS));
  assert.equal(JSON.stringify(result).includes('Synthetic private TV name'), false); assert.equal(JSON.stringify(result).includes(OTHER), false);
  assert.equal(f.sends.length, 3); assert.equal(f.sends.every(send => send.address === '239.255.255.250' && send.port === 1900), true);
});

test('UPnP 1.1 dotted headers and every legal HTTP token character are accepted without widening the selected target', async t => {
  // Synthetic response shaped by OCF UPnP Device Architecture 1.1 section 1.3.3.
  // Header names use the complete RFC 9110 section 5.6.2 tchar grammar.
  const headers = ['CACHE-CONTROL: max-age=1800', 'EXT:', 'SERVER: Synthetic/1.0 UPnP/1.1 Synthetic/1.0',
    'BOOTID.UPNP.ORG: 1', 'CONFIGID.UPNP.ORG: 1', 'SEARCHPORT.UPNP.ORG: 1900', "X-!#$%&'*+-.^_`|~0123456789AZ: synthetic"];
  const response = location => Buffer.from(['HTTP/1.1 200 OK', ...headers, 'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    'USN: uuid:synthetic-device::urn:schemas-upnp-org:device:MediaRenderer:1', `LOCATION: ${location}`, '', ''].join('\r\n'));
  const f = transportFixture(t, { packets: [[OTHER, response(`http://${OTHER}/private.xml`)], [HOST, response(`http://${OTHER}/wrong.xml`)], [HOST, response(ORIGIN + '/root.xml')]] });
  const result = await discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies);
  assert.deepEqual(f.gets, [ORIGIN + '/root.xml', ORIGIN + '/avt.xml']); assert.equal(result.devices[0].address, HOST);
  assert.equal(f.sockets.every(socket => socket.closed), true);
});

test('invalid header names, duplicates, folding and control characters deny all descriptor requests', async t => {
  for (const headers of ['Bad Header: value', 'Bad/Header: value', 'Bad(Header): value', 'X-Kelvin: value', ': empty-name', 'MissingColon',
    ' Folded: value', 'X-Bad\rName: value', 'X-Bad: value\rcontinuation', 'X-Bad: value\u0001control',
    'BOOTID.UPNP.ORG: 1\r\nbootid.upnp.org: 2', 'X-Extension: 1\r\nx-extension: 2',
    `Location: ${ORIGIN}/other.xml`]) {
    const packet = Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: ${ORIGIN}/root.xml\r\n${headers}\r\n\r\n`);
    const f = transportFixture(t, { packets: [[HOST, packet]] });
    await assert.rejects(discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies));
    assert.deepEqual(f.gets, []); assert.equal(f.sockets.every(socket => socket.closed), true); t.mock.restoreAll();
  }
});

test('DLNA default source uses selected discovery once and reuses its verified service for read, pause, play and stop', async t => {
  const f = transportFixture(t); let state = 'PLAYING'; const actions = [];
  const client = new DLNAClient({ host: HOST, interfaceAddress: INTERFACE, discoveryDurationMs: 2, localHttpFn: async (_url, request) => {
    assert.equal(request.expectedHost, HOST); const action = request.headers.SOAPAction.match(/#(\w+)"$/)[1]; actions.push(action);
    if (action === 'Pause') state = 'PAUSED_PLAYBACK'; if (action === 'Play') state = 'PLAYING'; if (action === 'Stop') state = 'STOPPED';
    return { status: 200, body: `<${action}Response><CurrentTransportState>${state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed></${action}Response>` };
  } });
  await client.connect(); await client.connect(); assert.equal((await client.status()).transportState, 'PLAYING');
  for (const action of ['pause', 'play', 'stop']) assert.equal((await client.media(action)).confirmed, true);
  assert.equal(f.sockets.length, 1); assert.equal(f.gets.length, 2); assert.deepEqual(actions, ['GetTransportInfo', 'Pause', 'GetTransportInfo', 'Play', 'GetTransportInfo', 'Stop', 'GetTransportInfo']);
  client.close(); assert.equal(actions.length, 7); await assert.rejects(client.status(), { code: 'CLIENT_CLOSED' });
});

test('wrong-host, hostname, credential, fragment, query and duplicate LOCATION replies cause zero HTTP requests', async t => {
  for (const location of [`http://${OTHER}/root.xml`, 'http://unselected.example/root.xml', `http://owner:secret@${HOST}/root.xml`, ORIGIN + '/root.xml#fragment', ORIGIN + '/root.xml?token=secret']) {
    const f = transportFixture(t, { packets: [[HOST, ssdp(location)]] });
    await assert.rejects(discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies)); assert.deepEqual(f.gets, []); assert.equal(f.sockets.every(socket => socket.closed), true);
    t.mock.restoreAll();
  }
  const f = transportFixture(t, { packets: [[HOST, Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: ${ORIGIN}/root.xml\r\nlocation: ${ORIGIN}/other.xml\r\n\r\n`)]] });
  await assert.rejects(discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies)); assert.deepEqual(f.gets, []);
});

test('URLBase and every used AVTransport URL stay on the selected literal host before the SCPD request', async t => {
  for (const change of [{ base: `http://${OTHER}/` }, { base: ORIGIN + '/?secret=x' }, { base: ORIGIN + '/#x' }, { base: `http://owner:secret@${HOST}/` },
    { scpd: `http://${OTHER}/avt.xml` }, { control: `http://${OTHER}/control` }, { events: `http://${OTHER}/events` }, { scpd: ORIGIN + '/avt.xml?secret=x' }, { control: ORIGIN + '/control#x' }]) {
    const f = transportFixture(t, { pages: { '/root.xml': { body: description(change) } } });
    await assert.rejects(discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies)); assert.deepEqual(f.gets, [ORIGIN + '/root.xml']); t.mock.restoreAll();
  }
  // The explicit general parser remains descriptive; only selected mode tightens URLBase.
  assert.equal(parseDescription(description({ base: `http://${OTHER}/` }), ORIGIN + '/root.xml').services[1].controlURL.startsWith(`http://${OTHER}/`), true);
});

test('redirects, compressed, oversized and invalid UTF8 descriptors fail closed with static errors and destroyed HTTP requests', async t => {
  for (const page of [{ status: 302, headers: { location: `http://${OTHER}/private` } }, { headers: { 'content-encoding': 'gzip' }, body: description() },
    { headers: { 'content-length': '99999999' }, body: description() }, { body: Buffer.alloc(2 * 1024 * 1024 + 1) }, { body: Buffer.from([0xff]) }]) {
    const f = transportFixture(t, { pages: { '/root.xml': page } });
    await assert.rejects(discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies), error => error.code === 'SELECTED_DISCOVERY_FAILED' && !String(error).includes(OTHER));
    assert.equal(f.gets.length, 1); assert.equal(f.requests.every(request => request.destroyed), true); t.mock.restoreAll();
  }
});

test('missing or malformed fixed schemas never become a connected controller or emit a SOAP write', async t => {
  for (const body of [scpd({ Play: INPUTS.Play }), scpd({ GetTransportInfo: ['ForeignInput'] }), scpd({ GetTransportInfo: ['InstanceID', 'InstanceID'] }),
    scpd().replace('</actionList>', '<action><name>Play</name><argumentList/></action></actionList>')]) {
    const f = transportFixture(t, { pages: { '/avt.xml': { body } } }); let writes = 0;
    const client = new DLNAClient({ host: HOST, discoveryDurationMs: 1, localHttpFn: async () => { writes++; } });
    await assert.rejects(client.connect(), { code: 'DISCOVERY_FAILED' }); assert.equal(writes, 0); assert.equal(f.gets.length, 2); client.close(); t.mock.restoreAll();
  }
});

test('no response and socket failure close all selected discovery sockets without HTTP', async t => {
  for (const options of [{ packets: [] }, { failSocket: true, interfaces: { fixture: [{ address: INTERFACE, family: 'IPv4', internal: false }, { address: '192.168.30.3', family: 'IPv4', internal: false }] } }]) {
    const f = transportFixture(t, options); await assert.rejects(discoverSelectedAVTransport({ host: HOST, durationMs: 2 }, f.dependencies));
    assert.equal(f.sockets.every(socket => socket.closed), true); assert.deepEqual(f.gets, []); t.mock.restoreAll();
  }
});

test('closing DLNA during discovery aborts sockets and denies any late descriptor or control dispatch', async t => {
  const f = transportFixture(t); let writes = 0;
  const client = new DLNAClient({ host: HOST, discoveryDurationMs: 30000, localHttpFn: async () => { writes++; } });
  const pending = client.connect(); const denied = assert.rejects(pending, { code: 'CLIENT_CLOSED' }); await flush(); client.close(); await denied;
  for (const socket of f.sockets) socket.emit('message', ssdp(ORIGIN + '/root.xml'), { address: HOST }); await flush();
  assert.equal(f.sockets.every(socket => socket.closed), true); assert.deepEqual(f.gets, []); assert.equal(writes, 0);
});

test('HTTP inspection has a full wall-clock deadline and cancellation destroys requests before late responses can fetch a schema', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = transportFixture(t, { stall: true });
  const pending = discoverSelectedAVTransport({ host: HOST, durationMs: 10 }, f.dependencies), denied = assert.rejects(pending);
  await flush(); t.mock.timers.tick(10); await flush(); assert.equal(f.gets.length, 1);
  t.mock.timers.tick(3000); await flush(); await denied; assert.equal(f.requests[0].destroyed, true); assert.equal(f.gets.length, 1);
  f.requests[0].response.emit('data', Buffer.from(description())); f.requests[0].response.emit('end'); await flush(); assert.equal(f.gets.length, 1);
});

test('abort during a pending UDP bind waits for its close and never sends a discovery packet or HTTP request', async t => {
  const f = transportFixture(t, { pendingBind: true }), controller = new AbortController();
  const pending = discoverSelectedAVTransport({ host: HOST, durationMs: 30000, signal: controller.signal }, f.dependencies), denied = assert.rejects(pending, { code: 'DISCOVERY_ABORTED' });
  controller.abort(); assert.equal(f.sockets[0].closed, false); f.sockets[0].finishBind(); await denied;
  assert.equal(f.sockets[0].closed, true); assert.deepEqual(f.sends, []); assert.deepEqual(f.gets, []);
});

test('a stalled bind reports incomplete cleanup at its bound and closes safely if listening arrives later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = transportFixture(t, { pendingBind: true }), controller = new AbortController();
  const pending = discoverSelectedAVTransport({ host: HOST, durationMs: 30000, signal: controller.signal }, f.dependencies), denied = assert.rejects(pending, { code: 'DISCOVERY_CLEANUP_FAILED' });
  controller.abort(); t.mock.timers.tick(500); await flush(); await denied; assert.equal(f.sockets[0].closed, false);
  f.sockets[0].finishBind(); await flush(); assert.equal(f.sockets[0].closed, true); assert.deepEqual(f.sends, []); assert.deepEqual(f.gets, []);
});

test('closing during stalled descriptor HTTP destroys it and blocks late schema reads or SOAP writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = transportFixture(t, { stall: true }); let writes = 0;
  const client = new DLNAClient({ host: HOST, discoveryDurationMs: 10, localHttpFn: async () => { writes++; } });
  const pending = client.connect(), denied = assert.rejects(pending, { code: 'CLIENT_CLOSED' }); await flush(); t.mock.timers.tick(10); await flush();
  assert.equal(f.gets.length, 1); client.close(); await denied; assert.equal(f.requests[0].destroyed, true);
  f.requests[0].response.emit('data', Buffer.from(description())); f.requests[0].response.emit('end'); await flush();
  assert.equal(f.gets.length, 1); assert.equal(writes, 0);
});

test('an unavailable selected interface fails before opening discovery or HTTP and does not fall back to another interface', async t => {
  const f = transportFixture(t);
  await assert.rejects(discoverSelectedAVTransport({ host: HOST, interfaceAddress: '192.168.30.3', durationMs: 1 }, f.dependencies), { code: 'INVALID_DISCOVERY_INTERFACE' });
  assert.deepEqual(f.sockets, []); assert.deepEqual(f.gets, []);
});

test('the explicit general scanner preserves broad descriptor and port-inspection semantics', async t => {
  const f = transportFixture(t, { nativeHTTP: true, packets: [[OTHER, ssdp(`http://${OTHER}/root.xml`)], [HOST, ssdp(ORIGIN + '/root.xml')]] }), gets = [], ports = [];
  t.mock.method(http, 'get', (url, _options, callback) => {
    gets.push(url.href); const request = new EventEmitter(); request.destroy = () => {};
    queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; response.resume = () => {}; callback(response);
      queueMicrotask(() => { response.emit('data', Buffer.from(url.pathname === '/root.xml' ? description({ base: `${url.origin}/` }) : scpd())); response.emit('end'); }); }); return request;
  });
  t.mock.method(net, 'createConnection', options => { ports.push(options); const socket = new EventEmitter(); socket.destroy = () => {}; socket.setTimeout = () => {}; queueMicrotask(() => socket.emit('connect')); return socket; });
  const report = await discover({ durationMs: 1, interfaceAddress: INTERFACE });
  assert.equal(report.mode, 'read-only-discovery'); assert.equal(report.devices.length, 2);
  assert.ok(gets.includes(`http://${OTHER}/root.xml`)); assert.equal(ports.length, 16); assert.equal(ports.some(value => value.host === OTHER), true);
  assert.equal(f.sockets.every(socket => socket.closed), true);
});

test('native loopback HTTP fixture verifies relative LG-style paths and does not follow redirects', { timeout: 5000 }, async t => {
  const f = transportFixture(t, { nativeHTTP: true }); const paths = []; let redirect = false;
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    if (redirect) { response.writeHead(302, { Location: `http://${OTHER}/never` }); response.end(); return; }
    response.setHeader('Content-Type', 'text/xml'); response.end(request.url === '/root.xml' ? description({ base: `http://${HOST}:${server.address().port}/` }) : scpd());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const original = http.get;
  t.mock.method(http, 'get', (url, options, callback) => { assert.equal(url.hostname, HOST); assert.equal(options.localAddress, INTERFACE); const loopback = new URL(url); loopback.hostname = '127.0.0.1'; loopback.port = server.address().port; return original(loopback, { ...options, localAddress: '127.0.0.1' }, callback); });
  const first = await discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies);
  assert.equal(first.devices[0].description.services[0].controlURL, `http://${HOST}:${server.address().port}/AVTransport/random/control.xml`); assert.deepEqual(paths, ['/root.xml', '/avt.xml']);
  redirect = true; await assert.rejects(discoverSelectedAVTransport({ host: HOST, durationMs: 1 }, f.dependencies)); assert.deepEqual(paths, ['/root.xml', '/avt.xml', '/root.xml']);
});
