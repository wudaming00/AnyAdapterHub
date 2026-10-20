import dgram from 'node:dgram';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { types } from 'node:util';
import { checkedLocalUrl, isPrivateIPv4, parseDescription, parseScpd } from '../discover.mjs';

const MAX_XML = 2 * 1024 * 1024, MAX_LOCATIONS = 4;
const AV_TRANSPORT = /^urn:schemas-upnp-org:service:AVTransport:[1-9]\d{0,3}$/;
const INPUTS = Object.freeze({ GetTransportInfo: ['InstanceID'], SetAVTransportURI: ['InstanceID', 'CurrentURI', 'CurrentURIMetaData'],
  Play: ['InstanceID', 'Speed'], Pause: ['InstanceID'], Stop: ['InstanceID'] });
const TARGETS = ['urn:lge-com:service:webos-second-screen:1', 'urn:schemas-upnp-org:device:MediaRenderer:1', 'ssdp:all'];
export class SelectedDLNADiscoveryError extends Error {
  constructor(code = 'SELECTED_DISCOVERY_FAILED') { super('The selected TV AVTransport service could not be discovered.'); this.name = 'SelectedDLNADiscoveryError'; this.code = code; }
}
const fail = code => { throw new SelectedDLNADiscoveryError(code); };
function record(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('INVALID_DISCOVERY_OPTIONS');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).some(key => !allowed.includes(key) || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) fail('INVALID_DISCOVERY_OPTIONS');
  return value;
}
function checkSignal(signal) {
  if (signal === undefined) return;
  if (!signal || types.isProxy(signal)) fail('INVALID_DISCOVERY_OPTIONS');
  try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal); } catch { fail('INVALID_DISCOVERY_OPTIONS'); }
}
function selectedURL(value, host) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) fail('INVALID_SELECTED_URL');
  let url;
  try { url = checkedLocalUrl(value, host); } catch { fail('INVALID_SELECTED_URL'); }
  if (url.search || url.hash) fail('INVALID_SELECTED_URL');
  return url;
}
function locationFrom(packet, sender, host) {
  // Do not parse, retain, inspect or probe another responding household device.
  if (sender?.address !== host || !Buffer.isBuffer(packet) || packet.length > 8192) return;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(packet); } catch { return; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/.test(text)) return;
  const lines = text.split(/\r?\n/), headers = Object.create(null);
  if (!/^HTTP\/1\.[01] 200(?: |$)/.test(lines.shift() ?? '')) return;
  for (const line of lines) {
    if (!line) break;
    const colon = line.indexOf(':'); if (colon <= 0) return;
    const rawName = line.slice(0, colon);
    // RFC 9110 section 5.6.2 tchar; UPnP and DLNA extension names can contain dots.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName)) return;
    const name = rawName.toLowerCase(); if (Object.hasOwn(headers, name)) return;
    headers[name] = line.slice(colon + 1).trim();
  }
  try { return selectedURL(headers.location, host).href; } catch { return; }
}

function collectSelected(address, { host, durationMs, signal }, socketFactory) {
  return new Promise((resolve, reject) => {
    const locations = new Set(); let socket, timer, done = false, binding = false, cleanupTimer;
    const abort = () => finish(new SelectedDLNADiscoveryError('DISCOVERY_ABORTED'));
    const complete = error => { clearTimeout(cleanupTimer); if (error) reject(error); else resolve([...locations].map(location => ({ location, interfaceAddress: address }))); };
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      cleanupTimer = setTimeout(() => complete(new SelectedDLNADiscoveryError('DISCOVERY_CLEANUP_FAILED')), 500);
      try { socket.close(() => complete(error)); }
      catch { if (!binding) complete(error); /* A pending bind closes in its callback below. */ }
    };
    try {
      socket = socketFactory();
      socket.on('error', () => { binding = false; finish(new SelectedDLNADiscoveryError()); });
      socket.on('message', (packet, sender) => {
        if (done || locations.size >= MAX_LOCATIONS) return;
        const location = locationFrom(packet, sender, host); if (location) locations.add(location);
      });
      timer = setTimeout(() => finish(), durationMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { finish(new SelectedDLNADiscoveryError('DISCOVERY_ABORTED')); return; }
      binding = true;
      socket.bind(0, address, () => {
        binding = false;
        if (done) { try { socket.close(() => complete(new SelectedDLNADiscoveryError('DISCOVERY_ABORTED'))); } catch {} return; }
        try {
          socket.setMulticastInterface(address); socket.setMulticastTTL(2);
          for (const target of TARGETS) socket.send(Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`), 1900, '239.255.255.250');
        } catch { finish(new SelectedDLNADiscoveryError()); }
      });
    } catch { binding = false; finish(new SelectedDLNADiscoveryError()); }
  });
}

function fetchSelectedXML(value, host, localAddress, signal, deadline) {
  const url = selectedURL(value, host), budget = Math.min(3000, Math.floor(deadline - performance.now()));
  if (budget <= 0) return Promise.reject(new SelectedDLNADiscoveryError('DISCOVERY_TIMEOUT'));
  return new Promise((resolve, reject) => {
    let request, response, timer, done = false; const chunks = []; let size = 0;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      response?.destroy(); request?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new SelectedDLNADiscoveryError('DISCOVERY_ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => finish(new SelectedDLNADiscoveryError('DISCOVERY_TIMEOUT')), budget);
    try {
      request = (url.protocol === 'https:' ? https : http).get(url, { agent: false, localAddress, maxHeaderSize: 16384,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}), headers: { Accept: 'application/xml, text/xml', 'Accept-Encoding': 'identity' } }, incoming => {
        if (done) { incoming.destroy(); return; }
        response = incoming;
        if (incoming.statusCode !== 200 || (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity')) { finish(new SelectedDLNADiscoveryError()); return; }
        const length = incoming.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_XML)) { finish(new SelectedDLNADiscoveryError()); return; }
        incoming.on('data', chunk => { if (done) return; size += chunk.length; if (size > MAX_XML) finish(new SelectedDLNADiscoveryError()); else chunks.push(chunk); });
        incoming.once('error', () => finish(new SelectedDLNADiscoveryError()));
        incoming.once('aborted', () => finish(new SelectedDLNADiscoveryError()));
        incoming.once('end', () => {
          if (done) return;
          try { finish(null, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
          catch { finish(new SelectedDLNADiscoveryError()); }
        });
      });
      request.once('error', () => finish(new SelectedDLNADiscoveryError()));
    } catch { finish(new SelectedDLNADiscoveryError()); }
  });
}

function selectedActions(xml) {
  const result = [], seen = new Set();
  for (const action of parseScpd(xml)) {
    if (!Object.hasOwn(INPUTS, action.name)) continue;
    const inputs = action.arguments.filter(argument => argument.direction === 'in'), expected = INPUTS[action.name];
    if (seen.has(action.name) || inputs.length !== expected.length || new Set(inputs.map(input => input.name)).size !== expected.length || inputs.some(input => !expected.includes(input.name))) fail('INVALID_SELECTED_SCHEMA');
    seen.add(action.name); result.push({ name: action.name, arguments: inputs.map(input => ({ name: input.name, direction: 'in', relatedStateVariable: input.name })) });
  }
  if (!seen.has('GetTransportInfo')) fail('INVALID_SELECTED_SCHEMA');
  return result;
}

/** Selected legacy DLNA only: SSDP discovery is multicast; off-target replies are ignored before parsing. */
export async function discoverSelectedAVTransport(options = {}, dependencies = {}) {
  const { host, interfaceAddress, durationMs = 4500, signal: ownerSignal } = record(options, ['host', 'interfaceAddress', 'durationMs', 'signal']);
  const { socketFactory = () => dgram.createSocket('udp4'), networkInterfaces = () => os.networkInterfaces() } = record(dependencies, ['socketFactory', 'networkInterfaces']);
  if (!isPrivateIPv4(host) || (interfaceAddress !== undefined && !isPrivateIPv4(interfaceAddress)) || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 30000 || typeof socketFactory !== 'function' || typeof networkInterfaces !== 'function') fail('INVALID_DISCOVERY_OPTIONS');
  checkSignal(ownerSignal); if (ownerSignal?.aborted) fail('DISCOVERY_ABORTED');
  const addresses = [...new Set(Object.values(networkInterfaces()).flat().filter(row => row.family === 'IPv4' && !row.internal && isPrivateIPv4(row.address) && (interfaceAddress === undefined || row.address === interfaceAddress)).map(row => row.address))];
  if (!addresses.length || addresses.length > 32) fail('INVALID_DISCOVERY_INTERFACE');
  const abort = new AbortController(), signal = abort.signal, cancel = () => abort.abort();
  ownerSignal?.addEventListener('abort', cancel, { once: true });
  try {
    const settled = await Promise.allSettled(addresses.map(address => collectSelected(address, { host, durationMs, signal }, socketFactory).catch(error => { abort.abort(); throw error; })));
    if (settled.some(result => result.status === 'rejected' && result.reason?.code === 'DISCOVERY_CLEANUP_FAILED')) fail('DISCOVERY_CLEANUP_FAILED');
    if (ownerSignal?.aborted) fail('DISCOVERY_ABORTED');
    if (settled.some(result => result.status === 'rejected')) fail();
    const locations = [...new Map(settled.flatMap(result => result.value).map(entry => [entry.location, entry])).values()].slice(0, MAX_LOCATIONS), deadline = performance.now() + 6000;
    for (const { location, interfaceAddress: localAddress } of locations) {
      try {
        const description = parseDescription(await fetchSelectedXML(location, host, localAddress, signal, deadline), location, host);
        const candidates = description.services.filter(service => AV_TRANSPORT.test(service.serviceType)).slice(0, MAX_LOCATIONS);
        for (const service of candidates) {
          for (const field of ['controlURL', 'SCPDURL', 'eventSubURL']) if (service[field]) selectedURL(service[field], host);
          if (!service.SCPDURL || selectedURL(service.controlURL, host).protocol !== 'http:') fail('INVALID_SELECTED_URL');
          const actions = selectedActions(await fetchSelectedXML(service.SCPDURL, host, localAddress, signal, deadline));
          if (signal.aborted) fail('DISCOVERY_ABORTED');
          return { devices: [{ address: host, description: { services: [{ serviceType: service.serviceType, controlURL: selectedURL(service.controlURL, host).href, actions }] } }] };
        }
      } catch { if (signal.aborted) fail('DISCOVERY_ABORTED'); }
    }
    fail();
  } finally {
    ownerSignal?.removeEventListener('abort', cancel); abort.abort();
  }
}
