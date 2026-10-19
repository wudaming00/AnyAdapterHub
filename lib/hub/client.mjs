import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';

/** Small non-MCP client. Local execution and permissions stay in the hub process. */
export class HubClient {
  #url; #token; #tls;
  constructor({ url = 'https://127.0.0.1:8765', token, certificate, certificatePin, allowInsecureLoopback = false }) {
    const parsed = new URL(url);
    if (!(parsed.protocol === 'https:' || parsed.protocol === 'http:' && allowInsecureLoopback) || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Hub client requires a loopback HTTPS origin.');
    if (parsed.protocol === 'https:') {
      const cert = new X509Certificate(certificate);
      if (!/^[a-f0-9]{64}$/.test(certificatePin ?? '') || createHash('sha256').update(cert.raw).digest('hex') !== certificatePin || !cert.checkIP('127.0.0.1')) throw new Error('Hub certificate identity mismatch.');
      this.#tls = { ca: certificate, rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity: (host, peer) => checkServerIdentity(host, peer) || (createHash('sha256').update(peer.raw).digest('hex') !== certificatePin ? new Error('Hub certificate pin mismatch.') : undefined) };
    }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Hub bearer credential required.');
    this.#url = parsed.origin; this.#token = token;
  }
  async #fetch(route, { method = 'GET', headers, body, signal } = {}) {
    if (!this.#tls) return fetch(this.#url + route, { method, headers, body, signal, redirect: 'error' });
    return new Promise((resolve, reject) => {
      let headerTimer;
      const request = https.request(this.#url + route, { ...this.#tls, method, headers, signal, agent: false }, response => {
        clearTimeout(headerTimer);
        const stream = response;
        const collect = async () => { const chunks = []; let size = 0; for await (const bytes of stream) { size += bytes.length; if (size > 34 * 1024 * 1024) { stream.destroy(); throw new Error('Hub response exceeds limit.'); } chunks.push(bytes); } return Buffer.concat(chunks); };
        const result = { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
          body: stream, json: async () => JSON.parse((await collect()).toString('utf8')), arrayBuffer: collect };
        resolve(result);
      });
      headerTimer = setTimeout(() => request.destroy(), 10000);
      request.on('close', () => clearTimeout(headerTimer));
      request.on('error', () => { clearTimeout(headerTimer); reject(new Error('Authenticated Hub TLS connection failed.')); });
      request.end(body);
    });
  }
  async #request(route, { method = 'GET', value, signal, image = false } = {}) {
    const response = await this.#fetch(route, { method, signal: signal ?? AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + this.#token, ...(value ? { 'Content-Type': 'application/json' } : {}) },
      body: value === undefined ? undefined : JSON.stringify(value) });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({ error: { code: 'HTTP_FAILURE', message: 'Hub request failed.' } }));
      const error = new Error(problem.error.message); error.code = problem.error.code; error.status = response.status; throw error;
    }
    return image ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  devices() { return this.#request('/v1/devices'); }
  state(deviceId) { return this.#request(`/v1/devices/${encodeURIComponent(deviceId)}/state`); }
  capabilities(deviceId) { return this.#request(`/v1/devices/${encodeURIComponent(deviceId)}/capabilities`); }
  submit(deviceId, action, args = {}, { idempotencyKey = randomUUID(), timeoutMs = 30000 } = {}) {
    return this.#request(`/v1/devices/${encodeURIComponent(deviceId)}/actions`, { method: 'POST', value: { action, args, idempotencyKey, timeoutMs } });
  }
  operation(id) { return this.#request(`/v1/operations/${encodeURIComponent(id)}`); }
  frame(id) { return this.#request(`/v1/frames/${encodeURIComponent(id)}`, { image: true }); }
  async execute(deviceId, action, args = {}, options = {}) {
    const submitted = await this.submit(deviceId, action, args, options);
    let operation = submitted.operation;
    const deadline = Date.now() + (options.waitMs ?? 40000);
    while (['queued', 'running'].includes(operation.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
      operation = await this.operation(operation.id);
    }
    return operation;
  }
  issueGrant(grant) { return this.#request('/v1/grants', { method: 'POST', value: grant }); }
  grants() { return this.#request('/v1/grants'); }
  revokeGrant(id) { return this.#request(`/v1/grants/${encodeURIComponent(id)}/revoke`, { method: 'POST', value: {} }); }
  shutdown() { return this.#request('/v1/shutdown', { method: 'POST', value: {} }); }
  async *events({ afterId = 0, signal } = {}) {
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('Invalid event cursor.');
    const response = await this.#fetch(`/v1/events?after=${afterId}`, { headers: { Authorization: 'Bearer ' + this.#token }, signal });
    if (!response.ok) {
      if (response.body.cancel) await response.body.cancel().catch(() => {}); else response.body.destroy();
      const error = new Error('Event stream denied.'); error.status = response.status; throw error;
    }
    const decoder = new TextDecoder(); let pending = '';
    try {
      for await (const bytes of response.body) {
        pending += decoder.decode(bytes, { stream: true });
        if (pending.length > 1024 * 1024) throw new Error('Event stream exceeded buffer limit.');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const line = block.split('\n').find(item => item.startsWith('data: '));
          if (line) yield JSON.parse(line.slice(6));
        }
      }
    } finally { if (response.body.cancel) await response.body.cancel().catch(() => {}); else response.body.destroy(); }
  }
}
