import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { TVController, canLaunchOrdinaryApp } from '../tv-controller.mjs';
import { observeTV } from '../tv-observer.mjs';
import { LocalMediaHost } from '../media-host.mjs';

const TTL = 15000;
const TRANSPORT_ERRORS = new Set(['TRANSPORT_ERROR', 'CONNECTION_CLOSED', 'NOT_REGISTERED', 'CLIENT_CLOSED', 'INVALID_STATE']);
const ARGUMENTS = Object.freeze({
  'audio.volume.set': [['volume']], 'audio.mute.set': [['muted']], 'app.launch': [['id']], 'app.list': [[]],
  'app.content.launch': [['id', 'content']], 'navigation.key': [['key']],
  'pointer.move': [['dx', 'dy']], 'pointer.click': [[]], 'pointer.scroll': [['dx', 'dy']],
  'media.control': [['action']], 'input.select': [['id']], 'audio.output.set': [['id']],
  'display.set': [['on']], 'power.off': [[]], 'power.wake': [[]],
  'text.insert': [['text'], ['replace']], 'url.open': [['url']],
  'media.url.play': [['url', 'mimeType'], ['title']], 'dlna.play': [['url', 'mimeType'], ['title']],
  'dlna.control': [['action']], 'dlna.status': [[]],
  'media.file.cast': [['filePath'], ['mimeType', 'title']],
});

export class LGAdapterError extends Error {
  constructor(code, message = 'The device operation could not be completed.') {
    super(message); this.name = 'LGAdapterError'; this.code = code;
  }
}
const fail = (code, message) => { throw new LGAdapterError(code, message); };
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const part = (status, name) => status?.[name]?.status === 'ok' ? status[name].payload : undefined;
const accepted = result => typeof result?.requestAccepted === 'boolean' ? result.requestAccepted
  : typeof result?.returnValue === 'boolean' ? result.returnValue : null;
const isIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !isIP(value);

function argumentsFor(action, args) {
  if (!Object.hasOwn(ARGUMENTS, action)) fail('UNKNOWN_ACTION', 'The adapter action is not registered.');
  if (!args || Object.getPrototypeOf(args) !== Object.prototype) fail('INVALID_ARGUMENTS', 'Action arguments must be a plain object.');
  const [required, optional = []] = ARGUMENTS[action];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(args))) {
    if (![...required, ...optional].includes(key) || !Object.hasOwn(descriptor, 'value')) fail('INVALID_ARGUMENTS', 'Action arguments contain an unsupported field.');
  }
  if (required.some(key => !Object.hasOwn(args, key))) fail('INVALID_ARGUMENTS', 'Action arguments are incomplete.');
  // The central capability policy validates values and URL origins; the reviewed
  // controller independently validates protocol arguments. Never forward params.
  return args;
}

/** Standalone device adapter. The hub must enforce its capability policy before dispatch. */
export class LGWebOSAdapter {
  #config; #factory; #observer; #mediaFactory; #controller; #connected = false;
  #tail = Promise.resolve(); #queued = 0; #closing = false; #closed = false; #closePromise;
  #listeners = new Set(); #revision = 0; #fields = {}; #phase = 'unknown'; #identity;
  #started = false; #startPromise; #pollTimer; #pollMs = 5000; #mediaHosts = new Set();

  constructor({ deviceId, config, controllerFactory = options => new TVController(options),
    observer = observeTV, mediaHostFactory = options => new LocalMediaHost(options) } = {}) {
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId) || isIP(deviceId)) fail('INVALID_DEVICE_ID', 'A local opaque device ID is required.');
    if (!config || Object.getPrototypeOf(config) !== Object.prototype) fail('INVALID_CONFIG', 'A local device configuration is required.');
    this.deviceId = deviceId;
    this.adapterId = 'lg-webos';
    Object.defineProperty(this, 'supportedActions', { value: Object.freeze(Object.keys(ARGUMENTS).concat('screen.observe')), enumerable: true });
    Object.defineProperty(this, 'readonlyActions', { value: Object.freeze(['app.list', 'dlna.status']), enumerable: true });
    this.#config = structuredClone(config);
    this.#factory = controllerFactory; this.#observer = observer; this.#mediaFactory = mediaHostFactory;
  }

  #text(value, maximum = 128) {
    if (typeof value !== 'string') return undefined;
    let result = value;
    for (const secret of [this.#config.host, this.#config.clientKey, this.#config.mac, this.#config.wake?.bindAddress]) {
      if (typeof secret === 'string' && secret) result = result.split(secret).join('[redacted]');
    }
    return result.replace(/(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, '[redacted-url]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-address]')
      .replace(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/gi, '[redacted-address]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-account]')
      .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum);
  }
  #id(value) { const clean = this.#text(value); return isIdentifier(clean) ? clean : undefined; }
  #errorCode(error) { return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'DEVICE_OPERATION_FAILED'; }
  #assertSignal(signal) { if (signal?.aborted) fail('ABORTED', 'The operation was cancelled before dispatch.'); }
  #assertDispatch(context) {
    this.#assertSignal(context.signal);
    if (context.deadlineAt !== undefined && (!Number.isFinite(Date.parse(context.deadlineAt)) || Date.parse(context.deadlineAt) <= Date.now())) fail('DEADLINE_EXCEEDED', 'The operation deadline expired before dispatch.');
    context.assertDispatch?.();
  }

  #snapshot() {
    return freeze(structuredClone({ deviceId: this.deviceId, revision: this.#revision,
      assembledAt: new Date().toISOString(), connection: { phase: this.#phase }, fields: this.#fields }));
  }
  #publish() {
    this.#revision += 1;
    const event = freeze({ type: 'device.state', deviceId: this.deviceId, data: this.#snapshot() });
    for (const listener of this.#listeners) { try { listener(event); } catch {} }
  }
  #phaseTo(phase) { if (this.#phase !== phase) { this.#phase = phase; this.#publish(); } }
  #expire() {
    const expiresAt = new Date(0).toISOString();
    this.#fields = Object.fromEntries(Object.entries(this.#fields).map(([key, field]) => [key, { ...field, expiresAt }]));
  }
  #cell(name, value, { source = 'ssap', ttl = TTL, oldestAt = Date.now(), observedAt = new Date().toISOString() } = {}) {
    if (value === undefined) return;
    this.#fields[name] = { value, observedAt, expiresAt: new Date(oldestAt + ttl).toISOString(), source, verification: 'device-reported' };
  }
  #freshValue(snapshot, name) {
    const field = snapshot.fields[name];
    return field && Date.parse(field.expiresAt) > Date.now() ? field.value : undefined;
  }
  #enqueue(task, signal) {
    if (this.#closing || this.#closed) return Promise.reject(new LGAdapterError('ADAPTER_CLOSED', 'The device adapter is closing or closed.'));
    if (this.#queued >= 32) return Promise.reject(new LGAdapterError('QUEUE_FULL', 'The device operation queue is full.'));
    this.#queued += 1;
    const operation = this.#tail.then(() => { this.#assertSignal(signal); return task(); });
    this.#tail = operation.catch(() => {}).finally(() => { this.#queued -= 1; });
    return operation;
  }
  async #discardController() {
    const controller = this.#controller; this.#controller = undefined; this.#connected = false;
    try { await controller?.close?.(); } catch {}
  }
  async #ensureController(connect = true) {
    if (this.#connected && this.#controller?.registered === false) await this.#discardController();
    if (!this.#controller) this.#controller = await this.#factory(structuredClone(this.#config));
    if (connect && !this.#connected) {
      try { await this.#controller.connect({ allowPairing: false }); this.#connected = true; }
      catch (error) { await this.#discardController(); this.#expire(); this.#phaseTo('offline'); throw error; }
    }
    return this.#controller;
  }
  async #failure(error) {
    if (TRANSPORT_ERRORS.has(this.#errorCode(error)) || (this.#connected && this.#controller?.registered === false)) {
      await this.#discardController(); this.#expire(); this.#phaseTo('offline');
    } else { this.#phaseTo('degraded'); }
  }
  async #refresh() {
    const oldestAt = Date.now();
    try {
      const controller = await this.#ensureController();
      const status = await controller.status();
      const names = ['foreground', 'audio', 'volume', 'power', 'inputs', 'sound'];
      const okay = names.filter(name => status?.[name]?.status === 'ok');
      if (!okay.length) {
        const transport = names.map(name => status?.[name]?.error?.code).find(code => TRANSPORT_ERRORS.has(code));
        throw new LGAdapterError(transport ?? 'STATE_UNAVAILABLE');
      }
      const foreground = part(status, 'foreground'); const audio = part(status, 'audio');
      const volume = part(status, 'volume'); const power = part(status, 'power');
      const inputs = part(status, 'inputs'); const sound = part(status, 'sound');
      const appId = this.#id(foreground?.appId);
      const volumeValue = volume?.volumeStatus?.volume ?? volume?.volume ?? audio?.volumeStatus?.volume ?? audio?.volume;
      const muteValue = audio?.mute ?? audio?.muted ?? audio?.volumeStatus?.muteStatus ?? volume?.volumeStatus?.muteStatus ?? volume?.muted ?? volume?.muteStatus;
      const values = {
        foreground: appId ? { appId } : undefined,
        volume: Number.isInteger(volumeValue) && volumeValue >= 0 && volumeValue <= 100 ? volumeValue : undefined,
        mute: typeof muteValue === 'boolean' ? muteValue : undefined,
        power: typeof power?.state === 'string' ? { state: this.#text(power.state, 48) } : undefined,
        soundOutput: this.#id(sound?.soundOutput),
        inputs: Array.isArray(inputs?.devices) ? inputs.devices.slice(0, 32).flatMap(input => {
          const id = this.#id(input?.id); if (!id) return [];
          const value = { id }; const inputApp = this.#id(input.appId); const label = this.#text(input.label);
          if (inputApp) value.appId = inputApp;
          if (label !== undefined) value.label = label;
          if (typeof input.connected === 'boolean') value.connected = input.connected;
          return [value];
        }) : undefined,
      };
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined && this.#fields[name]) this.#fields[name] = { ...this.#fields[name], expiresAt: new Date(0).toISOString() };
        else this.#cell(name, value, { oldestAt, ttl: name === 'inputs' ? 60000 : TTL });
      }
      this.#phase = okay.length === names.length ? 'online' : 'degraded';
      this.#publish();
      return this.#snapshot();
    } catch (error) {
      await this.#failure(error);
      throw new LGAdapterError(this.#errorCode(error), 'The device state could not be refreshed.');
    }
  }
  async #readIdentity() {
    try {
      const identity = await (await this.#ensureController()).identity();
      if (identity?.vendor !== 'LG' || !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(identity?.model ?? '') ||
        !/^\d{1,3}(?:\.\d{1,3}){2}(?:-\d{1,3})?$/.test(identity?.firmware ?? '')) fail('IDENTITY_UNVERIFIED');
      this.#identity = freeze({ vendor: 'LG', model: identity.model, firmware: identity.firmware });
      return freeze({ deviceId: this.deviceId, ...this.#identity, observedAt: new Date().toISOString() });
    } catch (error) { await this.#failure(error); throw new LGAdapterError(this.#errorCode(error), 'The device identity could not be verified.'); }
  }
  identity() { return this.#enqueue(() => this.#readIdentity()); }
  snapshot({ refresh = true } = {}) { return this.#enqueue(() => refresh ? this.#refresh() : this.#snapshot()); }
  subscribe(onEvent) {
    if (typeof onEvent !== 'function') fail('INVALID_LISTENER', 'A state listener is required.');
    if (this.#closing || this.#closed) fail('ADAPTER_CLOSED');
    this.#listeners.add(onEvent);
    return () => this.#listeners.delete(onEvent);
  }
  async start({ pollMs = 5000 } = {}) {
    if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) fail('INVALID_POLL_INTERVAL');
    if (this.#closing || this.#closed) fail('ADAPTER_CLOSED');
    if (this.#started) return this.#startPromise ?? this.#snapshot();
    this.#started = true; this.#pollMs = pollMs;
    const poll = async () => {
      try { await this.snapshot(); } catch {}
      if (this.#started && !this.#closing) { this.#pollTimer = setTimeout(poll, this.#pollMs); this.#pollTimer.unref?.(); }
      return this.#snapshot();
    };
    this.#startPromise = poll();
    return this.#startPromise;
  }

  #dlnaResult(result) {
    const out = {};
    for (const key of ['requestAccepted', 'confirmed', 'transportConfirmed', 'playbackVerified', 'contentVerified']) if (typeof result?.[key] === 'boolean') out[key] = result[key];
    for (const key of ['transportState', 'transportStatus', 'currentSpeed']) if (typeof result?.[key] === 'string') out[key] = this.#text(result[key], 48);
    return out;
  }
  #recordDLNA(result) {
    const value = this.#dlnaResult(result);
    if (value.transportState) { this.#cell('dlna', Object.fromEntries(['transportState', 'transportStatus', 'currentSpeed'].filter(key => value[key] !== undefined).map(key => [key, value[key]])), { source: 'dlna' }); this.#publish(); }
    return value;
  }
  async #releaseMedia(except) {
    let failed = false;
    for (const host of [...this.#mediaHosts]) if (host !== except) {
      try { await host.close(); this.#mediaHosts.delete(host); } catch { failed = true; }
    }
    return failed;
  }
  async #confirmForeground(controller, request, appId) {
    const result = { requestAccepted: accepted(request), confirmed: false, verificationScope: 'foreground_app', titlePlaybackVerified: false };
    if (result.requestAccepted === false || !appId) return result;
    const observed = await controller.waitForApp(appId, { timeoutMs: 15000, pollMs: 250 });
    result.confirmed = observed?.confirmed === true && observed?.foreground?.appId === appId;
    result.observedAppId = this.#id(observed?.foreground?.appId) ?? null;
    return result;
  }

  execute({ action, args = {} } = {}, context = {}) {
    let checked;
    try { checked = structuredClone(argumentsFor(action, args)); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => {
      this.#assertDispatch(context);
      const beforeRevision = this.#revision;
      const result = { operationId: this.#id(context.operationId) ?? randomUUID(), action,
        requestAccepted: null, confirmed: false, titlePlaybackVerified: false, verificationScope: 'request', beforeRevision };
      let candidate;
      let mutationDispatched = false;
      let transportDispatched = false;
      let authorizationError;
      const recheck = () => {
        try { this.#assertDispatch(context); } catch (error) { authorizationError = error; throw error; }
      };
      try {
        const lazy = action.startsWith('dlna.') || action === 'media.file.cast' || action === 'power.wake';
        const controller = await this.#ensureController(!lazy);
        recheck();
        const guarded = task => typeof controller.withDispatchGuard === 'function' ? controller.withDispatchGuard(() => {
          recheck(); transportDispatched = true;
        }, task) : task();
        await guarded(async () => {
          if (!['dlna.status', 'app.list'].includes(action)) { this.#expire(); this.#publish(); }
          let request;
          switch (action) {
            case 'app.list': {
              request = await controller.apps();
              if (!Array.isArray(request?.apps)) fail('APPS_UNAVAILABLE');
              result.apps = request.apps.slice(0, 256).flatMap(app => {
                const id = this.#id(app?.id); if (!id) return [];
                return [{ id, title: this.#text(app.title ?? app.name ?? id, 256), launchAllowed: canLaunchOrdinaryApp(app),
                  ...(typeof app.systemApp === 'boolean' ? { systemApp: app.systemApp } : {}) }];
              });
              result.totalReportedApps = request.apps.length;
              result.truncated = request.apps.length > 256;
              result.confirmed = true; result.verificationScope = 'installed_app_metadata'; break;
            }
            case 'audio.volume.set':
            case 'audio.mute.set': {
              mutationDispatched = true;
              request = action === 'audio.volume.set' ? await controller.setVolume(checked.volume) : await controller.mute(checked.muted);
              result.requestAccepted = accepted(request);
              const name = action === 'audio.volume.set' ? 'volume' : 'mute';
              const expected = action === 'audio.volume.set' ? checked.volume : checked.muted;
              const state = await this.#refresh();
              result.verificationScope = name; result.observed = this.#freshValue(state, name) ?? null;
              result.confirmed = result.requestAccepted !== false && result.observed === expected;
              break;
            }
            case 'app.launch':
            case 'app.content.launch':
              mutationDispatched = true;
              request = action === 'app.launch' ? await controller.launch(checked.id) : await controller.launchContent(checked.id, checked.content);
              result.requestAccepted = accepted(request);
              Object.assign(result, await this.#confirmForeground(controller, request, checked.id));
              await this.#refresh(); break;
            case 'input.select': {
              const before = await this.#refresh();
              const input = this.#freshValue(before, 'inputs')?.find(item => item.id === checked.id);
              recheck(); mutationDispatched = true;
              request = await controller.setInput(checked.id); result.requestAccepted = accepted(request);
              Object.assign(result, await this.#confirmForeground(controller, request, input?.appId));
              result.verificationScope = 'input_foreground';
              if (!input?.appId) result.error = { code: 'INPUT_METADATA_UNAVAILABLE', message: 'The device did not declare an app for this input.' };
              await this.#refresh(); break;
            }
            case 'navigation.key': mutationDispatched = true; request = await controller.key(checked.key); result.verificationScope = 'pointer_transport'; break;
            case 'pointer.move': mutationDispatched = true; request = await controller.move(checked.dx, checked.dy); result.verificationScope = 'pointer_transport'; break;
            case 'pointer.click': mutationDispatched = true; request = await controller.click(); result.verificationScope = 'pointer_transport'; break;
            case 'pointer.scroll': mutationDispatched = true; request = await controller.scroll(checked.dx, checked.dy); result.verificationScope = 'pointer_transport'; break;
            case 'media.control': mutationDispatched = true; request = await controller.media(checked.action); result.verificationScope = 'media_command'; break;
            case 'audio.output.set': mutationDispatched = true; request = await controller.soundOutput(checked.id); break;
            case 'display.set': mutationDispatched = true; request = await controller.screen(checked.on); break;
            case 'power.off': mutationDispatched = true; request = await controller.powerOff(); break;
            case 'power.wake': mutationDispatched = true; request = await controller.wake(this.#config.mac, this.#config.wake ?? {}); result.verificationScope = 'wake_packet'; break;
            case 'text.insert': mutationDispatched = true; request = await controller.typeText(checked.text, { replace: checked.replace ?? false }); result.verificationScope = 'text_request'; break;
            case 'url.open': mutationDispatched = true; request = await controller.openUrl(checked.url); break;
            case 'media.url.play': mutationDispatched = true; request = await controller.playUrl(checked.url, { mimeType: checked.mimeType, title: checked.title ?? '' }); result.titlePlaybackVerified = false; break;
            case 'dlna.status': request = await controller.dlnaStatus(); Object.assign(result, this.#recordDLNA(request)); result.confirmed = typeof result.transportState === 'string'; result.verificationScope = 'dlna_transport'; break;
            case 'dlna.play':
              mutationDispatched = true; request = await controller.dlnaPlay(checked.url, { mimeType: checked.mimeType, title: checked.title ?? '' });
              Object.assign(result, this.#recordDLNA(request)); result.verificationScope = 'dlna_transport';
              if (result.confirmed === true) result.cleanupWarning = await this.#releaseMedia();
              break;
            case 'dlna.control':
              mutationDispatched = true; request = await controller.dlnaMedia(checked.action);
              Object.assign(result, this.#recordDLNA(request)); result.verificationScope = 'dlna_transport';
              if (checked.action === 'stop' && result.confirmed === true && ['STOPPED', 'NO_MEDIA_PRESENT'].includes(result.transportState)) result.cleanupWarning = await this.#releaseMedia();
              break;
            case 'media.file.cast': {
              if (this.#mediaHosts.size >= 2) fail('MEDIA_RECONCILIATION_REQUIRED', 'Stop or reconcile the current media session before casting another file.');
              candidate = await this.#mediaFactory({ tvHost: this.#config.host,
                bindAddress: this.#config.interfaceAddress ?? this.#config.wake?.bindAddress, mediaRoots: this.#config.mediaRoots ?? [] });
              const media = await candidate.serve(checked.filePath, { mimeType: checked.mimeType });
              this.#mediaHosts.add(candidate);
              recheck(); mutationDispatched = true;
              request = await controller.dlnaPlay(media.url, { mimeType: media.mimeType, title: checked.title ?? '' });
              Object.assign(result, this.#recordDLNA(request)); result.verificationScope = 'dlna_transport';
              if (Number.isSafeInteger(media.bytes) && media.bytes >= 0) result.bytes = media.bytes;
              if (typeof media.mimeType === 'string' && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(media.mimeType)) result.mimeType = media.mimeType;
              if (result.confirmed === true) result.cleanupWarning = await this.#releaseMedia(candidate);
              break;
            }
          }
          if (result.requestAccepted === null) result.requestAccepted = accepted(request);
          if (request?.sent === true) result.transportSent = true;
          if (request?.focusConfirmed === true) result.focusConfirmed = true;
          if (request?.insertionConfirmed === false) result.insertionConfirmed = false;
          if (mutationDispatched && !action.startsWith('dlna.') && action !== 'media.file.cast' &&
            !['audio.volume.set', 'audio.mute.set', 'app.launch', 'app.content.launch', 'input.select'].includes(action)) {
            this.#expire(); this.#publish();
          }
        });
      } catch (error) {
        if (candidate && (!mutationDispatched || (authorizationError && !transportDispatched))) { try { await candidate.close(); this.#mediaHosts.delete(candidate); } catch {} }
        if (authorizationError) throw authorizationError;
        result.error = { code: this.#errorCode(error), message: 'The device operation could not be completed or verified.' };
        result.confirmed = false; result.uncertain = mutationDispatched;
        if (typeof error?.payload?.requestAccepted === 'boolean') result.requestAccepted = error.payload.requestAccepted;
        await this.#failure(error);
        // Reconcile once using reads only. Never replay a possibly delivered write.
        try { await this.#refresh(); } catch {}
      }
      result.afterRevision = this.#revision; result.observedAt = new Date().toISOString();
      return freeze(result);
    }, context.signal);
  }

  observe({ screenshot = true, timeoutMs = 25000 } = {}, context = {}) {
    return this.#enqueue(async () => {
      this.#assertDispatch(context);
      if (this.#config.allowTemporaryObserver !== true) fail('OBSERVER_NOT_ENABLED', 'Temporary observation requires explicit local opt-in.');
      const controller = await this.#ensureController();
      this.#assertDispatch(context);
      let observation;
      try {
        observation = await this.#observer(controller, { screenshot, timeoutMs, assertDispatch: () => this.#assertDispatch(context) });
      } catch (error) {
        await this.#failure(error); try { await this.#refresh(); } catch {}
        throw new LGAdapterError(this.#errorCode(error), 'Temporary observation could not be completed.');
      }
      // The observer owns its full cleanup/restoration transaction. Refresh only
      // after it returns, so no queued command can be overwritten by restoration.
      try { await this.#refresh(); } catch {}
      const metadata = {};
      for (const key of ['mode', 'startedAt', 'finishedAt', 'imageReceivedAt', 'verificationScope', 'note']) {
        if (typeof observation.metadata?.[key] === 'string') metadata[key] = this.#text(observation.metadata[key], 512);
      }
      for (const key of ['rootVerified', 'screenshotVerified', 'overlayClosed', 'restored', 'communicationVerified', 'completed', 'cleanupVerified']) {
        if (typeof observation.metadata?.[key] === 'boolean') metadata[key] = observation.metadata[key];
      }
      metadata.titlePlaybackVerified = false;
      metadata.originalAppId = this.#id(observation.metadata?.originalAppId) ?? null;
      const observedDevice = observation.metadata?.device ?? this.#identity;
      if (observedDevice?.vendor === 'LG' && /^[A-Z0-9][A-Z0-9-]{2,63}$/.test(observedDevice.model ?? '') &&
        /^\d{1,3}(?:\.\d{1,3}){2}(?:-\d{1,3})?$/.test(observedDevice.firmware ?? '')) {
        metadata.device = { vendor: 'LG', model: observedDevice.model, firmware: observedDevice.firmware };
      }
      if (observation.metadata?.error) metadata.error = 'The observer reported an incomplete observation.';
      const app = observation.metadata?.sample?.appForeground?.payload;
      const acb = observation.metadata?.sample?.acbForeground?.payload;
      const players = Array.isArray(acb?.acbs) ? acb.acbs.slice(0, 16).map(player => Object.fromEntries([
        ['playerType', this.#text(player.playerType, 48)], ['playStateNow', this.#text(player.playStateNow, 48)],
        ['isFullScreen', typeof player.isFullScreen === 'boolean' ? player.isFullScreen : undefined],
        ['width', Number.isInteger(player.width) && player.width >= 0 && player.width <= 16384 ? player.width : undefined],
        ['height', Number.isInteger(player.height) && player.height >= 0 && player.height <= 16384 ? player.height : undefined],
      ].filter(([, value]) => value !== undefined))) : [];
      metadata.sample = { appId: this.#id(app?.appId) ?? null, playerAppId: this.#id(acb?.appId) ?? null, players };
      if (players.length) { this.#cell('player', { appId: metadata.sample.playerAppId, players }, { source: 'temporary-observer', ttl: 5000 }); this.#publish(); }
      if (metadata.overlayClosed !== true || metadata.restored !== true) this.#phaseTo('degraded');
      // Images go only to the runtime's authenticated frame store. Keep reviewed
      // evidence flags, not callback payloads, TV paths or transport credentials.
      return { ...observation, metadata: freeze(metadata) };
    }, context.signal);
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true; this.#started = false; clearTimeout(this.#pollTimer);
    this.#closePromise = (async () => {
      await this.#tail;
      const cleanupFailed = await this.#releaseMedia();
      await this.#discardController();
      this.#closed = true; this.#expire(); this.#phase = 'closed'; this.#publish(); this.#listeners.clear();
      if (cleanupFailed) throw new LGAdapterError('MEDIA_CLEANUP_FAILED', 'A local media listener could not be closed.');
    })();
    return this.#closePromise;
  }
}
