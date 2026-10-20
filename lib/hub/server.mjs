import http from 'node:http';
import https from 'node:https';
import { HubError, publicError } from './runtime.mjs';

const MAX_BODY = 64 * 1024;
function reject(code, message) { throw new HubError(code, message); }
const STATUS = { UNAUTHORIZED: 401, ACCESS_DENIED: 403, GRANT_REVOKED: 403, GRANT_EXPIRED: 403,
  LOCAL_POLICY_DENIED: 403, NOT_FOUND: 404, IDEMPOTENCY_CONFLICT: 409, BUSY: 429, HUB_CLOSING: 503, HUB_STARTING: 503 };
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) reject('INVALID_ARGUMENTS', 'JSON content type required.');
  if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) reject('INVALID_ARGUMENTS', 'Body is too large.');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) { request.resume(); reject('INVALID_ARGUMENTS', 'Body is too large.'); }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
    return value;
  } catch { reject('INVALID_ARGUMENTS', 'Invalid JSON object.'); }
}
function cursor(value) {
  if (value === undefined || value === null) return 0;
  if (!/^(?:0|[1-9]\d{0,14})$/.test(value) || !Number.isSafeInteger(Number(value))) reject('INVALID_ARGUMENTS', 'Invalid event cursor.');
  return Number(value);
}

/** Loopback HTTP transport; credentials never occur in URLs. */
export class HubServer {
  #runtime; #server; #port; #streams = new Set(); #active = 0; #onShutdown; #protocol;
  constructor({ runtime, onShutdown, tls, allowInsecureLoopback = false }) {
    this.#runtime = runtime;
    this.#onShutdown = onShutdown;
    if (!tls && !allowInsecureLoopback) throw new Error('An encrypted Hub TLS identity is required.');
    this.#protocol = tls ? 'https:' : 'http:';
    this.#server = (tls ? https : http).createServer({ ...tls, minVersion: 'TLSv1.2', handshakeTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => this.#handle(request, response));
    this.#server.requestTimeout = 10000;
    this.#server.headersTimeout = 5000;
    this.#server.keepAliveTimeout = 5000;
    this.#server.maxRequestsPerSocket = 100;
    this.#server.maxConnections = 64;
  }
  async listen({ port = 8765 } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) reject('INVALID_ARGUMENTS', 'Invalid port.');
    await new Promise((resolve, reject) => {
      const failed = error => { this.#server.off('listening', ready); reject(error); };
      const ready = () => { this.#server.off('error', failed); resolve(); };
      this.#server.once('error', failed).once('listening', ready).listen(port, '127.0.0.1');
    });
    this.#port = this.#server.address().port;
    return { host: '127.0.0.1', port: this.#port, url: `${this.#protocol}//127.0.0.1:${this.#port}` };
  }
  async #handle(request, response) {
    let counted = false;
    try {
      const hosts = [`127.0.0.1:${this.#port}`, `localhost:${this.#port}`];
      if (!hosts.includes(request.headers.host) || request.headers.upgrade ||
        (request.headers.origin && !hosts.map(host => this.#protocol + '//' + host).includes(request.headers.origin))) reject('ACCESS_DENIED', 'Unexpected HTTP origin or host.');
      if (this.#active >= 32) reject('BUSY', 'Too many pending requests.');
      this.#active++; counted = true;
      const target = new URL(request.url, `${this.#protocol}//127.0.0.1:${this.#port}`);
      const byKeyRoute = /^\/v1\/devices\/[A-Za-z0-9._-]+\/operations\/by-key$/.test(target.pathname);
      if (target.origin !== `${this.#protocol}//127.0.0.1:${this.#port}` || target.hash ||
        (target.pathname !== '/v1/events' && !byKeyRoute && target.search)) reject('INVALID_ARGUMENTS', 'Invalid request target.');
      if (request.method === 'GET' && target.pathname === '/health') { json(response, this.#runtime.ready ? 200 : 503, { status: this.#runtime.ready ? 'ok' : 'starting-or-stopping', apiVersion: 1 }); return; }
      if (!this.#runtime.ready) reject('HUB_STARTING', 'Hub is starting or stopping.');
      const auth = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization ?? '');
      const principal = this.#runtime.authenticate(auth?.[1]);
      const route = target.pathname;
      if (request.method === 'GET' && route === '/v1/devices') { json(response, 200, { devices: this.#runtime.listDevices(principal) }); return; }
      let match;
      if (request.method === 'GET' && (match = /^\/v1\/devices\/([A-Za-z0-9._-]+)\/(state|capabilities)$/.exec(route))) {
        json(response, 200, this.#runtime[match[2] === 'state' ? 'state' : 'capabilities'](principal, match[1])); return;
      }
      if (request.method === 'POST' && (match = /^\/v1\/devices\/([A-Za-z0-9._-]+)\/actions$/.exec(route))) {
        const result = this.#runtime.submit(principal, match[1], await body(request));
        json(response, result.created ? 202 : 200, result); return;
      }
      if (request.method === 'GET' && (match = /^\/v1\/devices\/([A-Za-z0-9._-]+)\/operations\/by-key$/.exec(route))) {
        if ([...target.searchParams.keys()].some(key => key !== 'key') || target.searchParams.getAll('key').length !== 1) reject('INVALID_ARGUMENTS', 'Exactly one bounded idempotency key required.');
        json(response, 200, this.#runtime.operationByKey(principal, match[1], target.searchParams.get('key'))); return;
      }
      if (request.method === 'GET' && (match = /^\/v1\/operations\/([A-Za-z0-9._-]+)$/.exec(route))) {
        json(response, 200, this.#runtime.operation(principal, match[1])); return;
      }
      if (request.method === 'GET' && (match = /^\/v1\/frames\/([A-Za-z0-9._-]+)$/.exec(route))) {
        const frame = this.#runtime.frame(principal, match[1]);
        response.writeHead(200, { 'Content-Type': frame.mimeType, 'Content-Length': frame.bytes.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
        response.end(frame.bytes); return;
      }
      if (request.method === 'GET' && route === '/v1/events') {
        if ([...target.searchParams.keys()].some(key => key !== 'after') || target.searchParams.getAll('after').length > 1) reject('INVALID_ARGUMENTS', 'Unknown event parameter.');
        this.#stream(principal, cursor(request.headers['last-event-id'] ?? target.searchParams.get('after')), request, response); return;
      }
      if (request.method === 'GET' && route === '/v1/grants') { json(response, 200, { grants: this.#runtime.listGrants(principal) }); return; }
      if (request.method === 'POST' && route === '/v1/grants') {
        const value = await body(request);
        if (Object.keys(value).some(key => !['label', 'deviceIds', 'capabilities', 'expiresAt'].includes(key))) reject('INVALID_ARGUMENTS', 'Invalid grant request.');
        json(response, 201, this.#runtime.issueGrant(principal, value)); return;
      }
      if (request.method === 'POST' && (match = /^\/v1\/grants\/([A-Za-z0-9._-]+)\/revoke$/.exec(route))) {
        if (Object.keys(await body(request)).length) reject('INVALID_ARGUMENTS', 'Expected an empty object.');
        json(response, 200, this.#runtime.revokeGrant(principal, match[1])); return;
      }
      if (request.method === 'POST' && route === '/v1/shutdown') {
        if (Object.keys(await body(request)).length || !this.#onShutdown) reject('INVALID_ARGUMENTS', 'Shutdown is unavailable.');
        json(response, 202, this.#runtime.requestShutdown(principal));
        setImmediate(() => Promise.resolve(this.#onShutdown()).catch(() => {})); return;
      }
      reject('NOT_FOUND', 'Unknown API route.');
    } catch (error) {
      if (!response.headersSent) json(response, STATUS[error.code] ?? 400, { error: publicError(error) });
      else response.end();
    } finally { if (counted) this.#active--; }
  }
  #stream(principal, after, request, response) {
    if (this.#streams.size >= 8) reject('BUSY', 'Too many event streams.');
    // Authorize before emitting headers. Every delivery checks revocation/expiry again.
    let initial = this.#runtime.events(principal, { afterId: after, limit: 100 });
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    let last = after, ticks = 0, closed = false, pumping = false, heartbeatDue = false;
    let timer, cancelPressure;
    const stop = (destroy = false) => {
      if (closed) return;
      closed = true; clearInterval(timer); this.#streams.delete(stop);
      const cancel = cancelPressure; cancelPressure = undefined; cancel?.();
      // A blocked or abandoned reader must not hold server shutdown open.
      if (destroy || cancel) response.destroy();
      else if (!response.destroyed) response.end();
    };
    const drain = () => new Promise(resolve => {
      let settled = false;
      const finish = okay => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        response.off('drain', ready); response.off('close', lost); response.off('error', lost);
        cancelPressure = undefined; resolve(okay);
      };
      const ready = () => finish(true), lost = () => finish(false);
      const timeout = setTimeout(lost, 3000);
      cancelPressure = lost;
      response.once('drain', ready); response.once('close', lost); response.once('error', lost);
      if (closed || response.destroyed) lost();
      else if (!response.writableNeedDrain) ready();
    });
    const write = async value => {
      if (closed || response.destroyed) return false;
      if (!response.write(value) && !await drain()) { stop(true); return false; }
      return !closed;
    };
    const pump = async supplied => {
      if (closed || pumping) return;
      pumping = true;
      try {
        const events = supplied ?? this.#runtime.events(principal, { afterId: last, limit: 100 });
        for (const event of events.slice(0, 100)) {
          if (closed) return;
          // A grant can expire or be revoked while the previous write drains.
          this.#runtime.authorize(principal, event.deviceId, 'events.read');
          if (!await write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) return;
          last = event.id;
        }
        if (heartbeatDue && !closed) { heartbeatDue = false; await write(': heartbeat\n\n'); }
      } catch { stop(); }
      finally { pumping = false; }
    };
    timer = setInterval(() => {
      if (++ticks % 30 === 0) heartbeatDue = true;
      try {
        if (pumping) {
          // Continue checking grant validity at 500 ms even during backpressure.
          this.#runtime.events(principal, { afterId: last, limit: 1 });
        } else void pump();
      } catch { stop(); }
    }, 500);
    this.#streams.add(stop);
    response.once('close', () => stop()); response.once('error', () => stop(true));
    request.once('aborted', () => stop(true));
    try { response.flushHeaders(); } catch { stop(true); return; }
    void pump(initial); initial = null;
  }
  async close() {
    for (const stop of [...this.#streams]) stop();
    this.#server.closeIdleConnections();
    await new Promise(resolve => this.#server.close(resolve));
  }
}
