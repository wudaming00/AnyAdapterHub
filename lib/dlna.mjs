import { checkedLocalUrl, isPrivateIPv4 } from '../discover.mjs';
import { discoverSelectedAVTransport } from './dlna-discovery.mjs';
import { localHttp, soapOutcome } from '../inspect-public.mjs';

// SOAP encodingStyle and DIDL protocolInfo follow LG's Connect SDK:
// https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/master/src/com/connectsdk/service/DLNAService.java
// The B8 probe also confirmed that Play can take over six seconds before replying.
const INPUTS = Object.freeze({
  GetTransportInfo: ['InstanceID'],
  SetAVTransportURI: ['InstanceID', 'CurrentURI', 'CurrentURIMetaData'],
  Play: ['InstanceID', 'Speed'], Pause: ['InstanceID'], Stop: ['InstanceID'],
});
const MEDIA = Object.freeze({
  play: { action: 'Play', args: { InstanceID: 0, Speed: '1' }, states: ['PLAYING'] },
  pause: { action: 'Pause', args: { InstanceID: 0 }, states: ['PAUSED_PLAYBACK'] },
  stop: { action: 'Stop', args: { InstanceID: 0 }, states: ['STOPPED', 'NO_MEDIA_PRESENT'] },
});
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const clean = value => String(value).replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[media URL omitted]').slice(0, 500);
const field = (body, name) => decode(body.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([^<]*)<\\/(?:[\\w.-]+:)?${name}>`))?.[1] ?? '').trim();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class DLNAError extends Error {
  constructor(message, code = 'DLNA_ERROR', payload = {}) {
    super(clean(message));
    this.name = 'DLNAError';
    this.code = code;
    this.payload = payload;
    if (payload.upnpError) this.upnpError = payload.upnpError;
    if (payload.uncertain !== undefined) this.uncertain = payload.uncertain;
  }
}
function invalid(message) { throw new DLNAError(message, 'INVALID_ARGUMENT'); }
function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
function mediaURL(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u001f]/.test(value)) invalid('Media URL must be a nonempty HTTP(S) URL.');
  let url;
  try { url = new URL(value); } catch { invalid('Media URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('Media URL must use HTTP(S) without URL credentials.');
  return url.href;
}
function metadata(url, { mimeType, title = 'Media' } = {}) {
  if (typeof mimeType !== 'string' || mimeType.length > 128 || !/^(?:video|audio|image)\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
    invalid('An explicit video, audio or image MIME type is required.');
  }
  if (typeof title !== 'string' || title.length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(title)) invalid('Media title must be at most 2048 characters without XML control characters.');
  const kind = mimeType.split('/')[0];
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${xml(title)}</dc:title><upnp:class>object.item.${kind}Item</upnp:class><res protocolInfo="http-get:*:${xml(mimeType)}:DLNA.ORG_OP=01">${xml(url)}</res></item></DIDL-Lite>`;
}

export class DLNAClient {
  #service;
  #connected = false;
  #connecting;
  #closed = false;
  #discover;
  #http;
  #sleep;
  #now;
  #discoveryAbort;

  constructor({ host, interfaceAddress, service, discoverFn = discoverSelectedAVTransport, localHttpFn = localHttp,
    timeoutMs = 15000, pollMs = 250, discoveryDurationMs = 4500,
    sleepFn = sleep, nowFn = () => performance.now() } = {}) {
    if (!isPrivateIPv4(host)) invalid('Select a private LAN IPv4 TV address.');
    if (interfaceAddress !== undefined && !isPrivateIPv4(interfaceAddress)) invalid('Discovery interface must be a private IPv4 address.');
    this.host = host;
    this.interfaceAddress = interfaceAddress;
    this.timeoutMs = integer(timeoutMs, 'DLNA request timeout', 1, 120000);
    this.pollMs = integer(pollMs, 'DLNA state poll interval', 1, 5000);
    this.discoveryDurationMs = integer(discoveryDurationMs, 'Discovery duration', 1, 30000);
    for (const fn of [discoverFn, localHttpFn, sleepFn, nowFn]) if (typeof fn !== 'function') invalid('DLNA dependencies must be functions.');
    this.#service = service;
    this.#discover = discoverFn;
    this.#http = localHttpFn;
    this.#sleep = sleepFn;
    this.#now = nowFn;
  }

  #assertOpen() {
    if (this.#closed) throw new DLNAError('DLNA client is closed.', 'CLIENT_CLOSED');
  }
  #assertConnected() {
    this.#assertOpen();
    if (!this.#connected) throw new DLNAError('Connect the DLNA client before sending commands.', 'NOT_CONNECTED');
  }
  #validateService(service) {
    if (!service || !/^urn:schemas-upnp-org:service:AVTransport:[1-9]\d*$/.test(service.serviceType ?? '')) {
      throw new DLNAError('No advertised AVTransport service for the selected TV.', 'SERVICE_NOT_FOUND');
    }
    let url;
    try { url = checkedLocalUrl(service.controlURL, this.host); }
    catch { throw new DLNAError('AVTransport control URL must stay on the selected literal TV host.', 'INVALID_SERVICE_URL'); }
    if (url.protocol !== 'http:' || url.hash) throw new DLNAError('AVTransport requires an HTTP control URL without a fragment.', 'INVALID_SERVICE_URL');
    if (!Array.isArray(service.actions)) throw new DLNAError('AVTransport has no advertised action schema.', 'INVALID_SERVICE_SCHEMA');
    return { serviceType: service.serviceType, controlURL: url.href, actions: structuredClone(service.actions) };
  }
  #schema(action) {
    const expected = INPUTS[action];
    if (!expected) throw new DLNAError('DLNA action is outside the control allowlist.', 'UNSUPPORTED_ACTION');
    const schema = this.#service.actions.find(item => item?.name === action);
    const inputs = Array.isArray(schema?.arguments) ? schema.arguments.filter(item => item?.direction === 'in') : undefined;
    if (!inputs || inputs.length !== expected.length || new Set(inputs.map(item => item.name)).size !== expected.length ||
      inputs.some(item => !expected.includes(item.name))) {
      throw new DLNAError(`TV did not advertise the expected ${action} input schema.`, 'INVALID_SERVICE_SCHEMA', { action });
    }
    return inputs;
  }

  async connect() {
    this.#assertOpen();
    if (this.#connected) return { connected: true, host: this.host };
    if (!this.#connecting) this.#connecting = (async () => {
      let service = this.#service;
      if (!service) {
        let report;
        const abort = new AbortController(); this.#discoveryAbort = abort;
        try { report = await this.#discover({ host: this.host, interfaceAddress: this.interfaceAddress, durationMs: this.discoveryDurationMs, signal: abort.signal }); }
        catch { this.#assertOpen(); throw new DLNAError('Cannot discover the selected TV AVTransport service.', 'DISCOVERY_FAILED'); }
        finally { if (this.#discoveryAbort === abort) this.#discoveryAbort = undefined; }
        this.#assertOpen();
        const candidates = (report?.devices ?? []).filter(device => device.address === this.host)
          .flatMap(device => device.description?.services ?? []);
        service = candidates.find(item => /^urn:schemas-upnp-org:service:AVTransport:[1-9]\d*$/.test(item.serviceType ?? ''));
      }
      this.#service = this.#validateService(service);
      this.#schema('GetTransportInfo');
      this.#assertOpen();
      this.#connected = true;
      return { connected: true, host: this.host };
    })();
    try { return await this.#connecting; }
    finally { this.#connecting = undefined; }
  }

  close() { this.#closed = true; this.#connected = false; this.#discoveryAbort?.abort(); }

  async #soap(action, args, { timeoutMs = this.timeoutMs, mutation = false, assertDispatch } = {}) {
    this.#assertConnected();
    const inputs = this.#schema(action);
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${xml(this.#service.serviceType)}">${inputs.map(item => `<${item.name}>${xml(args[item.name])}</${item.name}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
    if (mutation) assertDispatch?.();
    let response;
    try {
      response = await this.#http(this.#service.controlURL, { method: 'POST', body, expectedHost: this.host, timeoutMs, headers: {
        'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${this.#service.serviceType}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      } });
    } catch (error) {
      const timedOut = /timeout|timed out/i.test(error?.message ?? '') || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR'].includes(error?.code);
      throw new DLNAError(`DLNA ${action} ${timedOut ? 'timed out' : 'transport failed'}${mutation ? '; the TV state may have changed. Do not blindly retry.' : '.'}`,
        timedOut ? 'DLNA_TIMEOUT' : 'DLNA_TRANSPORT_ERROR', { action, uncertain: mutation,
          ...(mutation ? { requestAccepted: null, confirmed: false, playbackVerified: false } : {}) });
    }
    if (this.#closed) throw new DLNAError(`DLNA client closed during ${action}${mutation ? '; the TV state may have changed.' : '.'}`,
      'CLIENT_CLOSED', { action, uncertain: mutation });
    if (typeof response?.body !== 'string' || !Number.isInteger(response.status)) {
      throw new DLNAError(`DLNA ${action} returned an invalid response.`, 'DLNA_PROTOCOL_ERROR', { action, uncertain: mutation });
    }
    const outcome = soapOutcome(action, response);
    if (!outcome.success) {
      const description = outcome.description ? clean(decode(outcome.description)) : undefined;
      throw new DLNAError(`DLNA ${action} failed${outcome.upnpError ? ` with UPnP ${outcome.upnpError}${description ? `: ${description}` : ''}` : ` with HTTP ${response.status}`}.`,
        outcome.upnpError ? 'DLNA_SOAP_FAULT' : 'DLNA_HTTP_ERROR', { action, httpStatus: response.status,
          ...(outcome.upnpError ? { upnpError: outcome.upnpError, description } : {}),
          uncertain: mutation && !outcome.upnpError,
          ...(mutation ? { requestAccepted: outcome.upnpError ? false : null, confirmed: false, playbackVerified: false } : {}) });
    }
    return response.body;
  }

  async #readStatus(timeoutMs = this.timeoutMs) {
    const body = await this.#soap('GetTransportInfo', { InstanceID: 0 }, { timeoutMs });
    const transportState = field(body, 'CurrentTransportState');
    const transportStatus = field(body, 'CurrentTransportStatus');
    const currentSpeed = field(body, 'CurrentSpeed');
    if (!/^[A-Z_]{1,64}$/.test(transportState) || !/^[A-Z_]{1,64}$/.test(transportStatus) || !/^-?\d+(?:\/\d+|\.\d+)?$/.test(currentSpeed)) {
      throw new DLNAError('DLNA transport status response is incomplete or malformed.', 'DLNA_PROTOCOL_ERROR');
    }
    return { transportState, transportStatus, currentSpeed, capturedAt: new Date().toISOString() };
  }
  status() { return this.#readStatus(); }

  async #waitForState(states, action) {
    const start = this.#now();
    const deadline = start + this.timeoutMs;
    let observed;
    let lastError;
    while (this.#now() < deadline) {
      this.#assertOpen();
      try {
        observed = await this.#readStatus(Math.max(1, Math.floor(deadline - this.#now())));
        if (states.includes(observed.transportState) && observed.transportStatus === 'OK') {
          return { requestAccepted: true, confirmed: true, transportConfirmed: true,
            playbackVerified: observed.transportState === 'PLAYING', contentVerified: false,
            verificationScope: 'DLNA transport state', ...observed, elapsedMs: Math.round(this.#now() - start) };
        }
      } catch (error) {
        if (['CLIENT_CLOSED', 'NOT_CONNECTED', 'INVALID_SERVICE_SCHEMA'].includes(error.code)) throw error;
        lastError = { code: error.code, message: error.message, ...(error.upnpError ? { upnpError: error.upnpError } : {}) };
      }
      const delay = Math.min(this.pollMs, deadline - this.#now());
      if (delay > 0) await this.#sleep(delay);
    }
    throw new DLNAError(`DLNA ${action} was accepted, but its transport state was not confirmed before timeout; the TV state may have changed.`,
      'DLNA_STATE_TIMEOUT', { action, requestAccepted: true, confirmed: false, transportConfirmed: false,
        playbackVerified: false, uncertain: true, expectedStates: states,
        transportState: observed?.transportState ?? null, lastError });
  }

  async play(value, options = {}) {
    this.#assertConnected();
    const url = mediaURL(value);
    const didl = metadata(url, options);
    for (const action of ['SetAVTransportURI', 'Play', 'GetTransportInfo']) this.#schema(action);
    await this.#soap('SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl }, { mutation: true, assertDispatch: options.assertDispatch });
    try {
      await this.#soap('Play', { InstanceID: 0, Speed: '1' }, { mutation: true, assertDispatch: options.assertDispatch });
      return { ...await this.#waitForState(['PLAYING'], 'Play'), mediaUriSet: true };
    } catch (error) {
      if (error instanceof DLNAError) error.payload = { ...error.payload, mediaUriSet: true,
        partialChange: true, failedAction: error.code === 'DLNA_STATE_TIMEOUT' ? 'ConfirmPlay' : (error.payload.action ?? 'Play') };
      throw error;
    }
  }
  async media(action, { assertDispatch } = {}) {
    this.#assertConnected();
    if (!Object.hasOwn(MEDIA, action)) invalid('DLNA media action must be play, pause or stop.');
    const operation = MEDIA[action];
    this.#schema(operation.action); this.#schema('GetTransportInfo');
    await this.#soap(operation.action, operation.args, { mutation: true, assertDispatch });
    return this.#waitForState(operation.states, operation.action);
  }
}
