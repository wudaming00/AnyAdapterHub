import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ACTIONS, READ_CAPABILITIES, authorize, validateGrant, validateAction, redactHub } from './policy.mjs';

export class HubError extends Error {
  constructor(code, message) { super(message); this.name = 'HubError'; this.code = code; }
}
const fail = (code, message) => { throw new HubError(code, message); };
const TERMINAL = new Set(['confirmed', 'unconfirmed', 'failed', 'expired', 'unknown', 'cancelled']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
function grantFields(value) {
  return Object.fromEntries(['id', 'label', 'deviceIds', 'capabilities', 'expiresAt', 'revokedAt'].map(key => [key, value[key]]));
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function publicOperation(operation) {
  if (!operation) return null;
  const { args: _args, requestHash: _hash, idempotencyKey: _key, ...safe } = operation;
  return safe;
}
export function publicError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z_]{2,64}$/.test(error.code) ? error.code : 'DEVICE_FAILURE';
  // Device errors can include URLs, credentials and submitted text. Never reflect them to clients.
  const messages = {
    ACCESS_DENIED: 'This grant does not authorize the request.', GRANT_REVOKED: 'Grant has been revoked.',
    GRANT_EXPIRED: 'Grant has expired.', UNAUTHORIZED: 'Valid bearer authentication is required.',
    INVALID_ARGUMENTS: 'Request arguments are invalid.', UNKNOWN_ACTION: 'Unknown action.',
    LOCAL_POLICY_DENIED: 'Local device policy denied the action.', DEADLINE_EXCEEDED: 'Request deadline elapsed before dispatch.',
    IDEMPOTENCY_CONFLICT: 'Idempotency key was already used for a different request.',
    NOT_FOUND: 'Requested resource was not found.', HUB_CLOSING: 'Hub is stopping.', BUSY: 'Device queue is full.',
  };
  return { code, message: messages[code] ?? 'The request could not be completed; inspect local device evidence before retrying.' };
}

/** Transport-independent hub. Device effects are never automatically retried. */
export class HubRuntime {
  #store; #devices = new Map(); #ownerHash; #queues = new Map(); #pending = new Map(); #cancelSubscriptions = [];
  #closing = false; #started = false; #pruneTimer; #ready = false;
  constructor({ store, devices, ownerTokenHash }) {
    if (!/^[a-f0-9]{64}$/.test(ownerTokenHash)) fail('INVALID_CONFIG', 'Owner credential hash is required.');
    this.#store = store; this.#ownerHash = ownerTokenHash;
    if (!Array.isArray(devices) || devices.length > 64) fail('INVALID_CONFIG', 'A bounded device registry is required.');
    for (const device of devices) {
      if (!device || typeof device.id !== 'string' || !ID.test(device.id) || this.#devices.has(device.id) || typeof device.label !== 'string' || !device.label || device.label.length > 128 || !device.adapter) fail('INVALID_CONFIG', 'Invalid device registration.');
      // Executable adapters are reviewed local code. Freeze their capability
      // intersection at enrollment; community profiles cannot expand it.
      const supported = device.adapter.supportedActions ?? Object.keys(ACTIONS);
      if (!Array.isArray(supported) || !supported.length || new Set(supported).size !== supported.length || supported.some(action => !Object.hasOwn(ACTIONS, action))) fail('INVALID_CONFIG', 'Adapter capabilities must be reviewed exact action IDs.');
      this.#devices.set(device.id, { ...device, supportedActions: Object.freeze([...supported]) });
    }
  }
  get ready() { return this.#ready && !this.#closing; }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) fail('UNAUTHORIZED', 'Bearer token is invalid.');
    const hash = tokenHash(token);
    if (timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(this.#ownerHash, 'hex'))) return { id: 'owner', owner: true, hash };
    const grant = this.#store.getGrantByHash(hash);
    if (!grant) fail('UNAUTHORIZED', 'Bearer token is invalid.');
    if (grant.revokedAt) fail('GRANT_REVOKED', 'Grant has been revoked.');
    if (Date.parse(grant.expiresAt) <= Date.now()) fail('GRANT_EXPIRED', 'Grant has expired.');
    validateGrant(grantFields(grant));
    return { id: grant.id, owner: false, hash };
  }
  #grant(principal) {
    if (!principal || typeof principal.hash !== 'string') fail('UNAUTHORIZED', 'Authentication is required.');
    if (principal.owner && principal.id === 'owner' && principal.hash === this.#ownerHash) return null;
    const grant = this.#store.getGrantByHash(principal.hash);
    if (!grant || grant.id !== principal.id) fail('UNAUTHORIZED', 'Authentication is required.');
    return grantFields(grant);
  }
  authorize(principal, deviceId, capability) {
    if (!this.#devices.has(deviceId)) fail('NOT_FOUND', 'Unknown device.');
    const grant = this.#grant(principal);
    if (grant) authorize(grant, { deviceId, capability });
  }
  #owner(principal) { if (this.#grant(principal) !== null) fail('ACCESS_DENIED', 'Owner authentication required.'); }
  requestShutdown(principal) { this.#owner(principal); this.beginClose(); return { accepted: true }; }
  issueGrant(principal, { label, deviceIds, capabilities, expiresAt }) {
    this.#owner(principal);
    const grant = validateGrant({ id: randomUUID(), label, deviceIds, capabilities, expiresAt, revokedAt: null });
    if (Date.parse(grant.expiresAt) <= Date.now() || grant.deviceIds.some(id => !this.#devices.has(id))) fail('INVALID_ARGUMENTS', 'Grant devices and expiry must be valid.');
    if (grant.capabilities.some(cap => !READ_CAPABILITIES.includes(cap) && !grant.deviceIds.some(id => this.#devices.get(id).supportedActions.includes(cap)))) fail('INVALID_ARGUMENTS', 'Grant includes an action unsupported by its devices.');
    const token = randomBytes(32).toString('base64url');
    const metadata = this.#store.putGrant({ ...grant, tokenHash: tokenHash(token) });
    this.#store.appendEvent({ type: 'grant.created', data: { grantId: grant.id } });
    return { grant: metadata, token };
  }
  listGrants(principal) { this.#owner(principal); return this.#store.listGrants(); }
  revokeGrant(principal, id) {
    this.#owner(principal);
    const grant = this.#store.revokeGrant(id);
    if (!grant) fail('NOT_FOUND', 'Unknown grant.');
    this.#store.appendEvent({ type: 'grant.revoked', data: { grantId: id } });
    return grant;
  }
  listDevices(principal) {
    const result = [];
    for (const [id, device] of this.#devices) {
      try { this.authorize(principal, id, 'state.read'); }
      catch (error) { if (error.code === 'ACCESS_DENIED') continue; throw error; }
      result.push({ id, label: device.label, adapter: device.adapterName ?? 'lg-webos', state: this.state(principal, id) });
    }
    return result;
  }
  capabilities(principal, id) {
    this.authorize(principal, id, 'state.read');
    const grant = this.#grant(principal);
    const device = this.#devices.get(id);
    return { deviceId: id, actions: Object.fromEntries(Object.entries(ACTIONS).filter(([action]) => device.supportedActions.includes(action) && (!grant || grant.capabilities.includes(action)))),
      read: READ_CAPABILITIES.filter(cap => (cap !== 'screen.read' || device.supportedActions.includes('screen.observe')) && (!grant || grant.capabilities.includes(cap))) };
  }
  state(principal, id) {
    this.authorize(principal, id, 'state.read');
    const state = this.#store.getSnapshot(id);
    if (!state) return { deviceId: id, connection: { phase: 'unknown' }, assembledAt: null, fields: {} };
    const now = Date.now();
    for (const field of Object.values(state.fields ?? {})) field.stale = !Number.isFinite(Date.parse(field.expiresAt)) || Date.parse(field.expiresAt) <= now;
    return state;
  }
  events(principal, { afterId = 0, limit = 100 } = {}) {
    const ids = [];
    for (const id of this.#devices.keys()) {
      try { this.authorize(principal, id, 'events.read'); ids.push(id); }
      catch (error) { if (error.code !== 'ACCESS_DENIED') throw error; }
    }
    if (!ids.length) fail('ACCESS_DENIED', 'Event access required.');
    return this.#store.events({ afterId, limit, deviceIds: ids });
  }
  operation(principal, id) {
    const isOwner = this.#grant(principal) === null;
    const operation = this.#store.getOperation(id);
    if (!operation || (!isOwner && operation.clientId !== principal.id)) fail('NOT_FOUND', 'Unknown operation.');
    this.authorize(principal, operation.deviceId, operation.action);
    return publicOperation(operation);
  }
  /** Read-only reconciliation: this cannot create, retry or dispatch work.
   * Even the owner searches only its own principal's idempotency namespace.
   */
  operationByKey(principal, deviceId, key) {
    this.#grant(principal);
    if (typeof deviceId !== 'string' || !ID.test(deviceId) || typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) fail('INVALID_ARGUMENTS', 'Exact device and bounded idempotency key required.');
    const operation = this.#store.findOperationByIdempotency(principal.id, key);
    if (!operation || operation.deviceId !== deviceId || operation.clientId !== principal.id) fail('NOT_FOUND', 'Unknown operation.');
    this.authorize(principal, deviceId, operation.action);
    return publicOperation(operation);
  }
  frame(principal, id) {
    this.#grant(principal);
    const frame = this.#store.getFrame(id);
    if (!frame) fail('NOT_FOUND', 'Frame missing or expired.');
    this.authorize(principal, frame.deviceId, 'screen.read');
    return frame;
  }
  submit(principal, deviceId, request) {
    if (this.#closing) fail('HUB_CLOSING', 'Hub is stopping.');
    if (!request || Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).some(key => !['action', 'args', 'idempotencyKey', 'timeoutMs'].includes(key))) fail('INVALID_ARGUMENTS', 'Invalid request.');
    const { action, idempotencyKey, timeoutMs = 30000 } = request;
    this.authorize(principal, deviceId, action);
    const device = this.#devices.get(deviceId);
    if (!device.supportedActions.includes(action)) fail('UNKNOWN_ACTION', 'Action is not supported by this device adapter.');
    const args = validateAction(action, request.args ?? {}, { deviceConfig: device.config });
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) fail('INVALID_ARGUMENTS', 'Idempotency key and bounded timeout are required.');
    const requestHash = createHmac('sha256', this.#ownerHash).update(canonical({ deviceId, action, args, timeoutMs })).digest('hex');
    const previous = this.#store.findOperationByIdempotency(principal.id, idempotencyKey);
    if (previous) {
      if (previous.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'Idempotency conflict.');
      return { operation: publicOperation(previous), created: false };
    }
    if ((this.#pending.get(deviceId) ?? 0) >= 16) fail('BUSY', 'Device queue is full.');
    const { operation, created } = this.#store.createOperation({ id: randomUUID(), clientId: principal.id, deviceId, action,
      args: redactHub(args), requestHash, idempotencyKey, deadlineAt: new Date(Date.now() + timeoutMs).toISOString() });
    if (created) {
      this.#pending.set(deviceId, (this.#pending.get(deviceId) ?? 0) + 1);
      const run = (this.#queues.get(deviceId) ?? Promise.resolve()).catch(() => {}).then(() => this.#execute(principal, device, operation, args));
      this.#queues.set(deviceId, run.catch(() => {}));
      run.finally(() => this.#pending.set(deviceId, this.#pending.get(deviceId) - 1)).catch(() => {});
    }
    return { operation: publicOperation(operation), created };
  }
  async #execute(principal, device, operation, args) {
    let dispatched = false;
    const assertDispatch = () => {
      if (this.#closing) fail('HUB_CLOSING', 'Hub is stopping.');
      this.authorize(principal, device.id, operation.action);
      if (Date.now() >= Date.parse(operation.deadlineAt)) fail('DEADLINE_EXCEEDED', 'Deadline elapsed before dispatch.');
      dispatched = true;
    };
    try {
      // The adapter repeats this check inside its shared queue after any pending poll.
      this.authorize(principal, device.id, operation.action);
      if (Date.now() >= Date.parse(operation.deadlineAt)) fail('DEADLINE_EXCEEDED', 'Deadline elapsed before dispatch.');
      this.#store.updateOperation(operation.id, { state: 'running' });
      const context = { deadlineAt: operation.deadlineAt, assertDispatch };
      let result;
      if (operation.action === 'screen.observe') {
        const observed = await device.adapter.observe(args, context);
        let frame = null;
        if (observed.image) frame = this.#store.putFrame({ id: randomUUID(), deviceId: device.id, operationId: operation.id,
          bytes: observed.image, mimeType: observed.mimeType, expiresAt: new Date(Date.now() + 5 * 60000).toISOString() });
        const meta = observed.metadata ?? {};
        const confirmed = meta.communicationVerified === true && meta.completed === true && meta.overlayClosed === true && meta.restored === true &&
          (args.screenshot === false || (Boolean(observed.image) && meta.screenshotVerified === true && meta.cleanupVerified === true));
        result = { observation: redactHub(meta), frame, confirmed,
          verification: 'observation', titlePlaybackVerified: false };
      } else result = redactHub(await device.adapter.execute({ action: operation.action, args }, context));
      this.#store.updateOperation(operation.id, { state: result?.uncertain === true ? 'unknown' : result?.confirmed === true ? 'confirmed' :
        (result?.requestAccepted === false || result?.error) ? 'failed' : 'unconfirmed', result });
    } catch (error) {
      const state = dispatched ? 'unknown' : error.code === 'DEADLINE_EXCEEDED' ? 'expired' :
        ['GRANT_EXPIRED', 'GRANT_REVOKED', 'ACCESS_DENIED', 'HUB_CLOSING'].includes(error.code) ? 'cancelled' : 'failed';
      this.#store.updateOperation(operation.id, { state, error: publicError(error) });
    }
  }
  async wait(principal, operationId, { timeoutMs = 35000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (true) {
      const operation = this.operation(principal, operationId);
      if (TERMINAL.has(operation.state) || Date.now() >= until) return operation;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  async start({ pollMs = 5000 } = {}) {
    if (this.#started) return; this.#started = true;
    this.#store.recoverInterrupted(); this.#store.pruneFrames();
    this.#pruneTimer = setInterval(() => { try { this.#store.pruneFrames(); } catch {} }, 30000);
    this.#pruneTimer.unref();
    for (const [id, device] of this.#devices) {
      this.#cancelSubscriptions.push(device.adapter.subscribe(event => {
        if (event.type !== 'device.state' || event.deviceId !== id || this.#closing) return;
        const snapshot = redactHub(event.data);
        this.#store.putSnapshot(id, snapshot);
        this.#store.appendEvent({ type: 'device.state', deviceId: id, data: snapshot });
      }));
    }
    this.#ready = true;
    await Promise.allSettled([...this.#devices.values()].map(device => device.adapter.start({ pollMs })));
  }
  beginClose() {
    this.#closing = true;
    clearInterval(this.#pruneTimer);
  }
  async close() {
    this.beginClose();
    await Promise.allSettled([...this.#queues.values()]);
    for (const cancel of this.#cancelSubscriptions) cancel();
    await Promise.allSettled([...this.#devices.values()].map(device => device.adapter.close()));
    this.#store.close();
  }
}
