import { randomUUID } from 'node:crypto';
import { types } from 'node:util';

const APP = 'com.disney.disneyplus-prod';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEYS = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK']);
const SCREENS = new Set(['home', 'search', 'results', 'details', 'player', 'profile']);
const PENDING = new Set(['queued', 'running']);
const REQUIRED = ['app.list', 'app.launch', 'navigation.key', 'navigation.sequence', 'screen.observe'];
const MAX_STEPS = 240;
// Allow bounded model reasoning and encrypted checkpoints. This is a freshness
// limit, not an exclusive screen lock; re-observe after unexpected UI changes.
const FRAME_MAX_AGE = 60000;
const fail = code => { const error = new Error('Movie workflow stopped; inspect its bounded status before continuing.'); error.code = code; throw error; };
function object(value, allowed, required = allowed) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('MOVIE_INVALID_ARGUMENTS');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).some(key => !allowed.includes(key) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable) || required.some(key => !Object.hasOwn(fields, key))) fail('MOVIE_INVALID_ARGUMENTS');
}
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) fail('MOVIE_INVALID_ARGUMENTS');
  return value.trim();
}
function matchingTitle(left, right) { return title(left).normalize('NFKC').toLowerCase() === title(right).normalize('NFKC').toLowerCase(); }
function navigationKeys(value) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 || value.length > 12 || Object.getOwnPropertySymbols(value).length) fail('MOVIE_INVALID_DECISION');
  const fields = Object.getOwnPropertyDescriptors(value), names = Object.keys(fields).filter(key => key !== 'length');
  if (names.length !== value.length || names.some((name, index) => name !== String(index) || !Object.hasOwn(fields[name], 'value') ||
    !fields[name].enumerable || !KEYS.has(fields[name].value))) fail('MOVIE_INVALID_DECISION');
  return names.map(name => fields[name].value);
}
export function createMovieRequest({ deviceId, title: requestedTitle, year, requestId = randomUUID() }, now = Date.now()) {
  if (!ID.test(deviceId ?? '') || !/^[a-zA-Z0-9-]{1,64}$/.test(requestId) || !Number.isInteger(year) || year < 1900 || year > 2100) fail('MOVIE_INVALID_ARGUMENTS');
  return { version: 1, id: requestId, request: { deviceId, title: title(requestedTitle), year, provider: 'disney-plus' },
    createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 30 * 60000).toISOString(),
    stage: 'new', sequence: 0, pending: null, lastOperation: null, frame: null, observation: null,
    details: null, playback: null, result: null };
}

/** Client-side visual-agent workflow. The Hub remains the authorization boundary.
 * save() must durably persist before resolving. No images or credentials are saved.
 * Visual assertions describe the agent's reading of a real frame, not vendor data.
 */
export class MoviePlaybackWorkflow {
  #client; #journal; #save; #now; #sleep;
  constructor({ client, journal, save, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!client || typeof save !== 'function' || journal?.version !== 1) fail('MOVIE_INVALID_ARGUMENTS');
    const checked = createMovieRequest({ ...journal.request, requestId: journal.id }, Date.parse(journal.createdAt));
    if (checked.deadlineAt !== journal.deadlineAt || !Number.isSafeInteger(journal.sequence) || journal.sequence < 0 || journal.sequence > MAX_STEPS) fail('MOVIE_INVALID_JOURNAL');
    this.#client = client; this.#journal = structuredClone(journal); this.#save = save; this.#now = now; this.#sleep = sleep;
  }
  status() {
    const j = this.#journal;
    return structuredClone({ workflowId: j.id, deviceId: j.request.deviceId, requestedTitle: j.request.title, year: j.request.year,
      stage: j.stage, deadlineAt: j.deadlineAt, sequence: j.sequence, pendingOperationId: j.pending?.operationId ?? null,
      reconciliationRequired: Boolean(j.pending), lastOperation: j.lastOperation, frame: j.frame,
      observation: j.observation, result: j.result });
  }
  async #commit(patch) { const next = { ...this.#journal, ...patch }; await this.#save(structuredClone(next)); this.#journal = next; }
  #active() {
    if (this.#now() >= Date.parse(this.#journal.deadlineAt)) fail('MOVIE_EXPIRED');
    if (['completed', 'needs_user'].includes(this.#journal.stage)) fail('MOVIE_FINISHED');
  }
  async #capabilities() {
    this.#active();
    const caps = await this.#client.capabilities(this.#journal.request.deviceId);
    if (caps.deviceId !== this.#journal.request.deviceId || REQUIRED.some(key => !caps.actions?.[key]) || !['state.read', 'screen.read'].every(key => caps.read?.includes(key))) fail('MOVIE_PERMISSION_REQUIRED');
    return caps;
  }
  async #settle(pending, { recover = false } = {}) {
    let operation;
    if (pending.operationId) operation = await this.#client.operation(pending.operationId);
    else if (recover) {
      // A lost HTTP response must not turn a stale visual decision into a new
      // submission. Look up only this authenticated client's original key.
      try { operation = await this.#client.operationByKey(this.#journal.request.deviceId, pending.key); }
      catch (error) {
        if (error.code !== 'NOT_FOUND') throw error;
        await this.#commit({ pending: null, stage: 'needs_user', frame: null, observation: null,
          result: { completed: false, reason: 'submission_not_found', reconciliationRequired: true } });
        return null;
      }
      await this.#commit({ pending: { ...pending, operationId: operation.id } });
    }
    else {
      try {
        this.#active();
        // Keep the exact timeout under this key across recovery, and refuse a
        // delayed checkpoint that would move dispatch beyond the workflow limit.
        if (!Number.isInteger(pending.timeoutMs) || pending.timeoutMs < 100 || pending.timeoutMs > 30000 ||
          this.#now() + pending.timeoutMs > Date.parse(this.#journal.deadlineAt)) fail('MOVIE_EXPIRED');
        if (pending.basis) {
          this.#freshBasis(pending.basis);
          if (this.#now() + pending.timeoutMs > this.#dispatchDeadline(pending.basis)) fail('MOVIE_FRESH_FRAME_REQUIRED');
        }
      } catch (error) {
        // No submission was attempted. Persist that fact so an ordinary slow
        // checkpoint can be recovered with observation rather than a dead end.
        await this.#commit({ pending: null, lastOperation: { id: null, action: pending.action,
          state: 'cancelled', errorCode: error.code ?? 'MOVIE_PREFLIGHT_FAILED' } });
        throw error;
      }
      const submitted = await this.#client.submit(this.#journal.request.deviceId, pending.action, pending.args,
        { idempotencyKey: pending.key, timeoutMs: pending.timeoutMs });
      operation = submitted.operation;
      await this.#commit({ pending: { ...pending, operationId: operation.id } });
    }
    const until = Math.min(this.#now() + 35000, Date.parse(this.#journal.deadlineAt));
    while (PENDING.has(operation.state) && this.#now() < until) {
      await this.#sleep(150); operation = await this.#client.operation(operation.id);
    }
    if (PENDING.has(operation.state)) fail('MOVIE_OPERATION_PENDING');
    if (operation.deviceId !== this.#journal.request.deviceId || operation.action !== pending.action) fail('MOVIE_OPERATION_MISMATCH');
    const lastOperation = { id: operation.id, action: pending.action, state: operation.state,
      errorCode: operation.error?.code ?? operation.result?.error?.code ?? null };
    if (pending.action === 'navigation.sequence') {
      const count = operation.result?.transportSentCount;
      const progressAvailable = Number.isInteger(count) && count >= 0 && count <= pending.args.keys.length;
      Object.assign(lastOperation, { progressAvailable, transportSentCount: progressAvailable ? count : null,
        sequenceComplete: progressAvailable && operation.result?.sequenceComplete === true && count === pending.args.keys.length });
    }
    // Unknown writes are never replayed. A new observation reconciles visible effects.
    await this.#commit({ pending: null, lastOperation, ...pending.after,
      frame: null, observation: null });
    return operation;
  }
  async #send(action, args, after = {}, basis = null) {
    this.#active();
    if (this.#journal.pending) fail('MOVIE_RECONCILIATION_REQUIRED');
    if (this.#journal.sequence >= MAX_STEPS) fail('MOVIE_STEP_LIMIT');
    const sequence = this.#journal.sequence + 1;
    if (basis) this.#freshBasis(basis);
    const timeoutMs = Math.min(30000, this.#dispatchDeadline(basis) - this.#now() - 1000);
    if (timeoutMs < 100) fail(basis ? 'MOVIE_FRESH_FRAME_REQUIRED' : 'MOVIE_EXPIRED');
    const pending = { action, args, key: `movie:${this.#journal.id}:${sequence}`, timeoutMs, operationId: null, after, basis };
    await this.#commit({ sequence, pending });
    return this.#settle(pending);
  }
  /** Explicitly reconcile the original operation/key, never create a replacement. */
  async resume() {
    this.#active(); await this.#capabilities();
    if (this.#journal.pending) await this.#settle(this.#journal.pending, { recover: true });
    if (this.#journal.stage === 'needs_user') return this.status();
    if (['new', 'waiting', 'launching'].includes(this.#journal.stage)) return this.prepare();
    return this.observe();
  }
  #ready(state) {
    const field = state?.fields?.foreground;
    return state?.deviceId === this.#journal.request.deviceId && ['online', 'degraded'].includes(state.connection?.phase) &&
      field?.stale !== true && Date.parse(field?.expiresAt) > this.#now() &&
      Date.parse(field?.observedAt) <= this.#now() && this.#now() - Date.parse(field?.observedAt) < 15000;
  }
  async prepare() {
    if (this.#journal.stage === 'completed') return this.status();
    const caps = await this.#capabilities();
    if (this.#journal.pending) fail('MOVIE_RECONCILIATION_REQUIRED');
    if (!['new', 'waiting', 'launching'].includes(this.#journal.stage)) return this.status();
    let state = await this.#client.state(this.#journal.request.deviceId);
    if (this.#journal.stage === 'new') {
      if (!this.#ready(state)) {
        if (!caps.actions?.['power.wake']) fail('MOVIE_WAKE_PERMISSION_REQUIRED');
        const wake = await this.#send('power.wake', {}, { stage: 'waiting' });
        if (['failed', 'cancelled', 'expired'].includes(wake.state) || wake.result?.error) fail('MOVIE_WAKE_FAILED');
      } else await this.#commit({ stage: 'waiting' });
    }
    const until = Math.min(this.#now() + 90000, Date.parse(this.#journal.deadlineAt));
    while (!this.#ready(state) && this.#now() < until) {
      this.#active(); await this.#sleep(1500); state = await this.#client.state(this.#journal.request.deviceId);
    }
    if (!this.#ready(state)) fail('MOVIE_DEVICE_OFFLINE');
    const apps = await this.#send('app.list', {}, { stage: 'launching' });
    if (apps.state !== 'confirmed' || !apps.result?.apps?.some(app => app.id === APP && app.launchAllowed === true)) fail('MOVIE_APP_UNAVAILABLE');
    const launched = await this.#send('app.launch', { id: APP }, { stage: 'navigating' });
    if (launched.state !== 'confirmed' || launched.result?.observedAppId !== APP) fail('MOVIE_LAUNCH_UNCONFIRMED');
    return this.observe();
  }
  async observe() {
    await this.#capabilities();
    if (this.#journal.pending) fail('MOVIE_RECONCILIATION_REQUIRED');
    if (['new', 'waiting', 'launching'].includes(this.#journal.stage)) fail('MOVIE_NOT_READY');
    // A fresh image invalidates the previously asserted Play focus. Reconfirm
    // exact details against the new image instead of carrying focus across time.
    const after = this.#journal.stage === 'ready_to_play' ? { stage: 'navigating', details: null } : {};
    const operation = await this.#send('screen.observe', { screenshot: true }, after);
    const frame = operation.result?.frame, observation = operation.result?.observation;
    if (operation.state !== 'confirmed' || frame?.deviceId !== this.#journal.request.deviceId || frame?.operationId !== operation.id ||
      !['screenshotVerified', 'completed', 'cleanupVerified', 'restored', 'overlayClosed', 'communicationVerified'].every(key => observation?.[key] === true) ||
      observation?.originalAppId !== APP || observation?.sample?.appId !== APP) fail('MOVIE_OBSERVATION_UNVERIFIED');
    await this.#commit({ frame, observation });
    // Reading actual bytes also checks screen.read, ownership scope and frame TTL.
    await this.#frame(frame.id);
    return this.status();
  }
  async #frame(frameId) {
    const { frame } = this.#journal;
    if (!frame || frame.id !== frameId || frame.deviceId !== this.#journal.request.deviceId ||
      Date.parse(frame.expiresAt) <= this.#now() || Date.parse(frame.createdAt) > this.#now() ||
      this.#now() - Date.parse(frame.createdAt) > FRAME_MAX_AGE) fail('MOVIE_FRESH_FRAME_REQUIRED');
    this.#freshBasis(this.#basis());
    const bytes = await this.#client.frame(frameId);
    this.#active(); this.#freshBasis(this.#basis());
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length !== frame.byteLength || bytes.length > 2 * 1024 * 1024) fail('MOVIE_FRAME_INVALID');
    return bytes;
  }
  #basis() {
    const { frame, observation } = this.#journal;
    return { startedAt: observation?.startedAt, capturedAt: observation?.imageReceivedAt,
      finishedAt: observation?.finishedAt, createdAt: frame?.createdAt, expiresAt: frame?.expiresAt };
  }
  #freshBasis(basis) {
    const times = ['startedAt', 'capturedAt', 'finishedAt', 'createdAt', 'expiresAt'].map(key => Date.parse(basis[key]));
    const [started, captured, finished, created, expires] = times;
    if (times.some(time => !Number.isFinite(time)) || started > captured || captured > finished || finished > created ||
      created > this.#now() || expires <= this.#now() || this.#now() - started > FRAME_MAX_AGE || this.#now() - captured > FRAME_MAX_AGE) fail('MOVIE_FRESH_FRAME_REQUIRED');
  }
  #dispatchDeadline(basis) {
    return Math.min(Date.parse(this.#journal.deadlineAt), ...(basis ? [Date.parse(basis.startedAt) + FRAME_MAX_AGE,
      Date.parse(basis.capturedAt) + FRAME_MAX_AGE, Date.parse(basis.expiresAt)] : []));
  }
  async frame() { this.#active(); return this.#frame(this.#journal.frame?.id); }
  async step(decision) {
    await this.#capabilities();
    if (this.#journal.pending) fail('MOVIE_RECONCILIATION_REQUIRED');
    object(decision, ['kind', 'frameId', 'keys', 'screen', 'selectedProfileUnlocked', 'title', 'year', 'playFocused', 'positionSeconds', 'reason'], ['kind', 'frameId']);
    await this.#frame(decision.frameId);
    const basis = this.#basis();
    const { request, stage } = this.#journal;
    switch (decision.kind) {
      case 'keys': {
        object(decision, ['kind', 'frameId', 'keys', 'screen', 'selectedProfileUnlocked'], ['kind', 'frameId', 'keys', 'screen']);
        const keys = navigationKeys(decision.keys);
        if (!['navigating', 'verifying'].includes(stage) || !SCREENS.has(decision.screen)) fail('MOVIE_INVALID_DECISION');
        if (stage === 'verifying' && !(decision.screen === 'player' && keys.length === 1 && keys[0] === 'UP')) fail('MOVIE_INVALID_DECISION');
        if (decision.screen === 'profile' && !(decision.selectedProfileUnlocked === true && keys.length === 1 && keys[0] === 'ENTER')) fail('MOVIE_PROFILE_CONSENT_REQUIRED');
        await this.#commit({ frame: null, observation: null });
        const operation = await this.#send('navigation.sequence', { keys, notAfter: new Date(this.#dispatchDeadline(basis)).toISOString() }, {}, basis);
        if (!['confirmed', 'unconfirmed'].includes(operation.state) || operation.result?.error || operation.result?.sequenceComplete !== true ||
          operation.result?.uncertain === true || operation.result?.transportSentCount !== keys.length) fail('MOVIE_KEY_RECONCILE');
        await this.#sleep(250);
        return this.observe();
      }
      case 'details':
        object(decision, ['kind', 'frameId', 'title', 'year', 'playFocused']);
        if (stage !== 'navigating' || !matchingTitle(decision.title, request.title) || decision.year !== request.year || decision.playFocused !== true) fail('MOVIE_TITLE_MISMATCH');
        await this.#commit({ stage: 'ready_to_play', details: { frameId: decision.frameId, title: request.title, year: request.year, source: 'agent-visual' } });
        return this.status();
      case 'play': {
        object(decision, ['kind', 'frameId']);
        if (stage !== 'ready_to_play' || this.#journal.details?.frameId !== decision.frameId) fail('MOVIE_DETAILS_REQUIRED');
        const operation = await this.#send('navigation.key', { key: 'ENTER' }, { stage: 'verifying' }, basis);
        if (!['confirmed', 'unconfirmed'].includes(operation.state) || operation.result?.error) fail('MOVIE_PLAY_RECONCILE');
        await this.#sleep(3000); return this.observe();
      }
      case 'player-play': {
        object(decision, ['kind', 'frameId', 'title']);
        if (stage !== 'verifying' || !matchingTitle(decision.title, request.title)) fail('MOVIE_PLAYBACK_UNVERIFIED');
        const caps = await this.#client.capabilities(request.deviceId);
        if (!caps.actions?.['media.control']) fail('MOVIE_PERMISSION_REQUIRED');
        const operation = await this.#send('media.control', { action: 'play' }, {}, basis);
        if (!['confirmed', 'unconfirmed'].includes(operation.state) || operation.result?.error) fail('MOVIE_PLAY_RECONCILE');
        await this.#sleep(1000); return this.observe();
      }
      case 'playback': {
        object(decision, ['kind', 'frameId', 'title', 'positionSeconds']);
        const observation = this.#journal.observation;
        if (stage !== 'verifying' || !this.#journal.details || !matchingTitle(decision.title, request.title) ||
          !Number.isInteger(decision.positionSeconds) || decision.positionSeconds < 0 || decision.positionSeconds > 18000 ||
          observation?.sample?.playerAppId !== APP || !observation.sample.players?.some(player => player.isFullScreen === true && player.playStateNow === 'playing')) fail('MOVIE_PLAYBACK_UNVERIFIED');
        const previous = this.#journal.playback;
        const current = { frameId: decision.frameId, positionSeconds: decision.positionSeconds, observedAt: basis.capturedAt };
        if (previous && previous.frameId !== current.frameId && current.positionSeconds > previous.positionSeconds &&
          Date.parse(current.observedAt) - Date.parse(previous.observedAt) >= 1000) {
          await this.#commit({ stage: 'completed', frame: null, observation: null, playback: current,
            result: { completed: true, verificationScope: 'agent_visual_and_system_player', agentReportedTitleVerified: true,
              deviceReportedTitleVerified: false, progressAdvanced: true } });
        } else {
          if (previous?.frameId === current.frameId) fail('MOVIE_FRESH_FRAME_REQUIRED');
          await this.#commit({ playback: current, frame: null, observation: null });
        }
        return this.status();
      }
      case 'blocked':
        object(decision, ['kind', 'frameId', 'reason']);
        if (!['login', 'pin', 'purchase', 'profile', 'unknown'].includes(decision.reason)) fail('MOVIE_INVALID_DECISION');
        await this.#commit({ stage: 'needs_user', frame: null, observation: null, result: { completed: false, reason: decision.reason } });
        return this.status();
      default: fail('MOVIE_INVALID_DECISION');
    }
  }
}
