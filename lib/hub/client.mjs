import { randomUUID } from 'node:crypto';

/** Small non-MCP client. Local execution and permissions stay in the hub process. */
export class HubClient {
  #url; #token;
  constructor({ url = 'http://127.0.0.1:8765', token }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Hub client requires a loopback HTTP origin.');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Hub bearer credential required.');
    this.#url = parsed.origin; this.#token = token;
  }
  async #request(route, { method = 'GET', value, signal, image = false } = {}) {
    const response = await fetch(this.#url + route, { method, signal: signal ?? AbortSignal.timeout(10000), redirect: 'error',
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
    const response = await fetch(`${this.#url}/v1/events?after=${afterId}`, { headers: { Authorization: 'Bearer ' + this.#token }, signal, redirect: 'error' });
    if (!response.ok) { const error = new Error('Event stream denied.'); error.status = response.status; throw error; }
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
    } finally { await response.body.cancel().catch(() => {}); }
  }
}
