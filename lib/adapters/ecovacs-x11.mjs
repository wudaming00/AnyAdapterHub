import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

export const ECOVACS_ACTIONS = Object.freeze(['vacuum.start', 'vacuum.pause', 'vacuum.resume', 'vacuum.stop', 'vacuum.dock', 'vacuum.details.read']);
const CONTROLS = new Set(ECOVACS_ACTIONS.filter(action => action !== 'vacuum.details.read'));
const PHASES = new Set(['unknown', 'idle', 'cleaning', 'paused', 'returning', 'docked', 'error']);
const STATIONS = new Set(['unknown', 'idle', 'washing_mop', 'emptying_dustbin', 'drying_mop', 'cleaning', 'paused']);
const WORKER = fileURLToPath(new URL('../../optional/ecovacs/worker.py', import.meta.url));
const OUTPUT_LIMIT = 256 * 1024;
const CHILD_ENV = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
export class ECOVACSAdapterError extends Error {
  constructor(code, message = 'The selected vacuum operation could not be completed.') { super(message); this.name = 'ECOVACSAdapterError'; this.code = code; }
}
const fail = code => { throw new ECOVACSAdapterError(code); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const own = value => value && Object.getPrototypeOf(value) === Object.prototype;
const assertContext = context => {
  if (context.signal?.aborted) fail('ABORTED');
  if (context.deadlineAt !== undefined && (!Number.isFinite(Date.parse(context.deadlineAt)) || Date.parse(context.deadlineAt) <= Date.now())) fail('DEADLINE_EXCEEDED');
};

/** Fixed executable + fixed script; neither agent arguments nor cloud data become shell text. */
export function createECOVACSRunner(config, { spawnFn = spawn } = {}) {
  return (command, context = {}) => new Promise((resolve, reject) => {
    let child; let settled = false; let buffer = ''; let total = 0; let lines = 0; let ready = false; let result;
    const done = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort);
      if (error) { child?.kill(); reject(new ECOVACSAdapterError(/^[A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'WORKER_FAILURE')); }
      else resolve(value);
    };
    const abort = () => done(new ECOVACSAdapterError('ABORTED'));
    const timer = setTimeout(() => done(new ECOVACSAdapterError('WORKER_TIMEOUT')), 110000); timer.unref?.();
    try {
      assertContext(context);
      // -I ignores PYTHONPATH/user site packages. The optional worker has no server or discovery interface.
      child = spawnFn(config.pythonPath, ['-I', '-B', '-u', WORKER], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => CHILD_ENV.has(key.toUpperCase()))) });
      context.signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => done(new ECOVACSAdapterError('WORKER_UNAVAILABLE')));
      child.stdin.on('error', () => done(new ECOVACSAdapterError('WORKER_FAILURE')));
      child.stderr.on('data', () => {}); // Never reflect vendor logs or authentication responses.
      child.stdout.on('data', chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > OUTPUT_LIMIT) return done(new ECOVACSAdapterError('WORKER_PROTOCOL'));
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (++lines > 3 || !line) return done(new ECOVACSAdapterError('WORKER_PROTOCOL'));
          let message;
          try { message = JSON.parse(line); } catch { return done(new ECOVACSAdapterError('WORKER_PROTOCOL')); }
          if (!own(message)) return done(new ECOVACSAdapterError('WORKER_PROTOCOL'));
          if (message.type === 'ready' && CONTROLS.has(command.action) && !ready && result === undefined) {
            ready = true;
            try {
              // Repeat central authorization after the cloud preflight, immediately before allowing movement.
              assertContext(context); context.assertDispatch?.();
              child.stdin.end(JSON.stringify({ dispatch: true, deadlineAt: context.deadlineAt ?? new Date(Date.now() + 30000).toISOString() }) + '\n');
            } catch (error) { return done(error); }
          } else if (message.type === 'result' && result === undefined && (!CONTROLS.has(command.action) || ready)) result = message.value;
          else if (message.type === 'error' && /^[A-Z_]{2,64}$/.test(message.code ?? '')) return done(new ECOVACSAdapterError(message.code));
          else return done(new ECOVACSAdapterError('WORKER_PROTOCOL'));
        }
      });
      child.on('close', code => {
        if (code !== 0 || buffer.trim() || !own(result)) return done(new ECOVACSAdapterError('WORKER_FAILURE'));
        done(null, result);
      });
      child.stdin.write(JSON.stringify({ ...command, credentialFile: config.credentialFile, selectedDeviceSha256: config.selectedDeviceSha256 }) + '\n');
      if (!CONTROLS.has(command.action)) child.stdin.end();
    } catch (error) { done(error); }
  });
}

function projectStatus(value) {
  if (!own(value) || typeof value.reachable !== 'boolean') fail('INVALID_DEVICE_RESPONSE');
  return {
    reachable: value.reachable,
    batteryPercent: Number.isInteger(value.battery_percent) && value.battery_percent >= 0 && value.battery_percent <= 100 ? value.battery_percent : null,
    state: PHASES.has(value.state) ? value.state : 'unknown',
    taskState: ['idle', 'cleaning'].includes(value.task_state) ? value.task_state : 'unknown',
    stationState: STATIONS.has(value.station_state) ? value.station_state : 'unknown',
    taskPaused: typeof value.task_paused === 'boolean' ? value.task_paused : null,
  };
}
// Worker telemetry is projected a second time. Free text, arbitrary nested data, IDs and URLs never pass.
function projectDetails(value) {
  if (!own(value)) fail('INVALID_DEVICE_RESPONSE');
  const settings = {};
  const finite = number => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e9;
  for (const key of ['fanSpeed', 'workMode', 'waterAmount', 'volume', 'childLock', 'autoEmpty', 'continuousCleaning', 'carpetBoost', 'cleanCount', 'efficiencySupported']) {
    const entry = value.settings?.[key];
    if (typeof entry === 'boolean' || finite(entry)) settings[key] = entry;
    else if (typeof entry === 'string' && /^[A-Z_]{1,48}$/.test(entry)) settings[key] = entry;
  }
  const maintenance = Array.isArray(value.maintenance) ? value.maintenance.slice(0, 32).flatMap(entry => {
    if (!own(entry) || !/^[A-Z_]{1,48}$/.test(entry.component ?? '')) return [];
    return [{ component: entry.component, remainingPercent: finite(entry.remainingPercent) && entry.remainingPercent >= 0 && entry.remainingPercent <= 100 ? entry.remainingPercent : null,
      counterStatus: ['not_applicable', 'unknown', 'counter_due', 'counter_remaining'].includes(entry.counterStatus) ? entry.counterStatus : 'unknown', physicalCondition: 'not_assessed' }];
  }) : [];
  return { settings, maintenance, successfulReads: Number.isInteger(value.successfulReads) && value.successfulReads >= 0 && value.successfulReads <= 64 ? value.successfulReads : 0,
    roomCleaning: 'not_available', firmwareVerified: false };
}

export class ECOVACSX11Adapter {
  #runner; #tail = Promise.resolve(); #queued = 0; #closing = false; #listeners = new Set(); #revision = 0;
  #fields = {}; #phase = 'unknown'; #started = false; #timer; #startPromise;
  constructor({ deviceId, config, runner } = {}) {
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID');
    if (!own(config) || !/^[a-f0-9]{64}$/.test(config.selectedDeviceSha256 ?? '') || typeof config.pythonPath !== 'string' || typeof config.credentialFile !== 'string') fail('INVALID_CONFIG');
    this.deviceId = deviceId; this.adapterId = 'ecovacs-x11'; this.supportedActions = ECOVACS_ACTIONS;
    this.#runner = runner ?? createECOVACSRunner(structuredClone(config));
  }
  #snapshot() { return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision, assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields })); }
  #publish() { this.#revision += 1; const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.#snapshot() }); for (const listener of this.#listeners) { try { listener(event); } catch {} } }
  #cell(name, value, oldestAt) { this.#fields[name] = { value, observedAt: new Date().toISOString(), expiresAt: new Date(oldestAt + 90000).toISOString(), source: 'ecovacs-cloud-https', verification: 'device-reported' }; }
  #record(raw, oldestAt) { const status = projectStatus(raw); this.#cell('vacuum', status, oldestAt); this.#phase = status.reachable ? 'online' : 'offline'; this.#publish(); return status; }
  #failure() { this.#phase = 'offline'; for (const field of Object.values(this.#fields)) field.expiresAt = new Date(0).toISOString(); this.#publish(); }
  #enqueue(task) {
    if (this.#closing) return Promise.reject(new ECOVACSAdapterError('ADAPTER_CLOSED'));
    if (this.#queued >= 16) return Promise.reject(new ECOVACSAdapterError('QUEUE_FULL'));
    this.#queued += 1; const operation = this.#tail.then(task); this.#tail = operation.catch(() => {}).finally(() => { this.#queued -= 1; }); return operation;
  }
  async #refresh() {
    const oldestAt = Date.now();
    try { const result = await this.#runner({ action: 'status' }); this.#record(result.status, oldestAt); return this.#snapshot(); }
    catch (error) { this.#failure(); throw error; }
  }
  snapshot({ refresh = true } = {}) { return this.#enqueue(() => refresh ? this.#refresh() : this.#snapshot()); }
  subscribe(listener) { if (typeof listener !== 'function') fail('INVALID_LISTENER'); if (this.#closing) fail('ADAPTER_CLOSED'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async start({ pollMs = 30000 } = {}) {
    if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) fail('INVALID_POLL_INTERVAL');
    if (this.#closing) fail('ADAPTER_CLOSED'); if (this.#started) return this.#startPromise ?? this.#snapshot();
    this.#started = true;
    const poll = async () => { try { await this.snapshot(); } catch {} if (this.#started && !this.#closing) { this.#timer = setTimeout(poll, Math.max(30000, pollMs)); this.#timer.unref?.(); } return this.#snapshot(); };
    this.#startPromise = poll(); return this.#startPromise;
  }
  execute({ action, args = {} } = {}, context = {}) {
    if (!ECOVACS_ACTIONS.includes(action)) return Promise.reject(new ECOVACSAdapterError('UNKNOWN_ACTION'));
    if (!own(args) || Reflect.ownKeys(args).length) return Promise.reject(new ECOVACSAdapterError('INVALID_ARGUMENTS'));
    return this.#enqueue(async () => {
      assertContext(context); const oldestAt = Date.now(); let dispatched = false;
      const dispatch = () => { assertContext(context); context.assertDispatch?.(); dispatched = true; };
      try {
        if (!CONTROLS.has(action)) dispatch();
        const raw = await this.#runner({ action }, { ...context, assertDispatch: dispatch });
        if (action === 'vacuum.details.read') { const details = projectDetails(raw.details); return freeze({ action, confirmed: details.successfulReads > 0, verificationScope: 'reported_settings_and_service_counters', details }); }
        if (!dispatched) fail('WORKER_PROTOCOL');
        if (raw.status) this.#record(raw.status, oldestAt);
        return freeze({ action, requestAccepted: typeof raw.accepted === 'boolean' ? raw.accepted : null,
          confirmed: raw.accepted === true && raw.state_verified === true, uncertain: raw.uncertain === true,
          verificationScope: 'vacuum_state', verificationStatus: ['verified', 'task_active_at_station', 'awaiting_state_change', 'rejected_or_unknown'].includes(raw.verification_status) ? raw.verification_status : 'rejected_or_unknown',
          taskComplete: false });
      } catch (error) {
        this.#failure();
        if (dispatched && CONTROLS.has(action)) return freeze({ action, requestAccepted: null, confirmed: false, uncertain: true, taskComplete: false, error: { code: /^[A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'DEVICE_OPERATION_FAILED' } });
        throw error instanceof ECOVACSAdapterError ? error : new ECOVACSAdapterError('DEVICE_OPERATION_FAILED');
      }
    });
  }
  async close() { this.#closing = true; this.#started = false; clearTimeout(this.#timer); await this.#tail; this.#listeners.clear(); }
}
