import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { checkedLocalUrl, isPrivateIPv4 } from './discover.mjs';
import { createPinnedTVAgent } from './lib/security/tv-tls.mjs';

const SAFE_QUERIES = {
  'ConnectionManager': ['GetProtocolInfo', 'GetCurrentConnectionIDs'],
  'AVTransport': ['GetTransportInfo', 'GetPositionInfo', 'GetMediaInfo', 'GetCurrentTransportActions'],
  'RenderingControl': ['GetVolume', 'GetMute'],
};
const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function sanitizeResponse(response) {
  const headers = {};
  for (const key of ['content-type', 'application-url', 'server']) {
    if (response.headers[key]) headers[key] = response.headers[key];
  }
  return { status: response.status, headers, body: response.body
    .replace(/<(?:(?:[\w.-]+):)?additionalData\b[^>]*>[\s\S]*?<\/(?:(?:[\w.-]+):)?additionalData>/gi, '<additionalData>[omitted]</additionalData>')
    .replace(/<((?:[\w.-]+:)?(?:CurrentURI|NextURI|TrackURI|CurrentURIMetaData|NextURIMetaData|TrackMetaData))\b[^>]*>[\s\S]*?<\/\1>/gi,
      '<$1>[omitted media location/metadata]</$1>') };
}

export function localHttp(urlValue, { method = 'GET', body, headers = {}, expectedHost, timeoutMs = 3500 } = {}) {
  const url = checkedLocalUrl(urlValue, expectedHost);
  if (url.protocol !== 'http:') throw new Error('Public descriptor inspection currently uses HTTP');
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, timeout: timeoutMs }, response => {
      const parts = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) request.destroy(new Error('Response too large'));
        else parts.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(parts).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('HTTP timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function readSoap(service, action, expectedHost) {
  const family = service.serviceType.split(':').at(-2);
  if (!SAFE_QUERIES[family]?.includes(action)) throw new Error('This probe only permits selected read-only SOAP queries');
  if (!isPrivateIPv4(expectedHost)) throw new Error('A selected private TV host is required');
  const schema = service.actions.find(a => a.name === action);
  if (!schema) throw new Error('Action was not advertised by this TV');
  const input = schema.arguments.filter(a => a.direction === 'in');
  const args = input.map(arg => {
    const value = arg.name === 'InstanceID' ? '0' : arg.name === 'Channel' ? 'Master' : undefined;
    if (value === undefined) throw new Error(`No safe default for ${arg.name}`);
    return `<${arg.name}>${escapeXml(value)}</${arg.name}>`;
  }).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${escapeXml(service.serviceType)}">${args}</u:${action}></s:Body></s:Envelope>`;
  return localHttp(service.controlURL, { method: 'POST', body, expectedHost, headers: {
    'Content-Type': 'text/xml; charset="utf-8"',
    SOAPAction: `"${service.serviceType}#${action}"`,
    'Content-Length': Buffer.byteLength(body),
  } });
}

export function soapOutcome(action, response) {
  const errorCode = response.body.match(/<(?:[\w.-]+:)?errorCode\b[^>]*>([^<]*)<\//i)?.[1];
  const errorDescription = response.body.match(/<(?:[\w.-]+:)?errorDescription\b[^>]*>([^<]*)<\//i)?.[1];
  const hasFault = /<(?:[\w.-]+:)?Fault\b/i.test(response.body);
  const hasActionResponse = new RegExp(`<(?:[\\w.-]+:)?${action}Response\\b`).test(response.body);
  return { success: response.status === 200 && !hasFault && hasActionResponse,
    ...(errorCode ? { upnpError: errorCode, description: errorDescription } : {}),
    ...(!hasFault && !hasActionResponse ? { unexpectedResponse: true } : {}) };
}

function preflight(host, secure, { certificatePin } = {}) {
  if (!isPrivateIPv4(host)) throw new Error('TV must have a private LAN IPv4 address');
  return new Promise(resolve => {
    const result = { url: `${secure ? 'wss' : 'ws'}://${host}:${secure ? 3001 : 3000}`, messages: [],
      note: 'No register/pairing request was sent.' };
    const agent = secure && certificatePin !== undefined ? createPinnedTVAgent({ host, certificatePin, timeoutMs: 3000 }) : undefined;
    const socket = new WebSocket(result.url, { ...(agent ? { agent } : {}), handshakeTimeout: 3000, followRedirects: false, maxPayload: 256 * 1024 });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      agent?.destroy();
      resolve(result);
    };
    const timer = setTimeout(finish, 4000);
    socket.on('open', () => {
      result.connected = true;
      socket.send(JSON.stringify({ id: 'hello_1', type: 'hello', payload: {} }));
      socket.send(JSON.stringify({ id: 'system_1', type: 'request', uri: 'ssap://system/getSystemInfo', payload: {} }));
      socket.send(JSON.stringify({ id: 'services_1', type: 'request', uri: 'ssap://api/getServiceList', payload: {} }));
      socket.send(JSON.stringify({ id: 'software_1', type: 'request', uri: 'ssap://com.webos.service.update/getCurrentSWInformation', payload: {} }));
    });
    socket.on('message', raw => {
      try { result.messages.push(JSON.parse(raw.toString())); }
      catch { result.messages.push({ invalidJson: true }); }
      if (result.messages.length >= 4) finish();
    });
    socket.on('error', error => { result.error = error.message; finish(); });
    socket.on('close', finish);
  });
}

export async function inspectPublic(discovery, host, { certificatePin } = {}) {
  if (!isPrivateIPv4(host)) throw new Error('TV must have a private LAN IPv4 address');
  const devices = discovery.devices.filter(d => d.address === host);
  if (!devices.length) throw new Error('TV was not present in discovery report');
  const report = { generatedAt: new Date().toISOString(), host, mode: 'read-only-public-inspection',
    soap: [], dial: [], websocket: [],
    note: 'Only advertised SOAP Get* queries, DIAL GETs, WebSocket hello and unauthenticated system/service/software queries. No register, playback, input, or setting changes.' };
  for (const device of devices) for (const service of device.description?.services ?? []) {
    const family = service.serviceType.split(':').at(-2);
    if (SAFE_QUERIES[family] && !Array.isArray(service.actions)) {
      report.soap.push({ family, status: 'schema-unavailable', error: service.schemaError ?? 'No parsed method schema; no SOAP query sent' });
      continue;
    }
    for (const action of SAFE_QUERIES[family] ?? []) {
      if (!service.actions.some(a => a.name === action)) continue;
      try {
        const response = sanitizeResponse(await readSoap(service, action, host));
        report.soap.push({ family, action, outcome: soapOutcome(action, response), response });
      }
      catch (error) { report.soap.push({ family, action, error: error.message }); }
    }
    if (service.serviceType.includes('dial-multiscreen')) {
      try {
        const descriptor = await localHttp(device.headers.location, { expectedHost: host });
        const appUrl = descriptor.headers['application-url'];
        report.dial.push({ descriptor: device.headers.location, applicationUrl: appUrl, status: descriptor.status });
        if (appUrl) {
          checkedLocalUrl(appUrl, host);
          for (const app of ['YouTube', 'Netflix', 'DisneyPlus']) {
            const response = await localHttp(new URL(app, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).href, { expectedHost: host });
            report.dial.push({ app, response: sanitizeResponse(response) });
          }
        }
      } catch (error) { report.dial.push({ error: error.message }); }
    }
  }
  report.websocket = await Promise.all([preflight(host, false), preflight(host, true, { certificatePin })]);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const get = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const host = get('--host');
  if (!host) throw new Error('Usage: node inspect-public.mjs --host TV_IP [--certificate-pin SHA256] [--discovery reports/discovery.json] [--out reports/public.json]');
  const discovery = JSON.parse(await fs.readFile(get('--discovery') ?? 'reports/discovery.json', 'utf8'));
  const report = await inspectPublic(discovery, host, { certificatePin: get('--certificate-pin') });
  const out = get('--out') ?? 'reports/public.json';
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.resolve(out), host,
    soap: report.soap.map(s => ({ family: s.family, action: s.action, status: s.response?.status ?? s.status, outcome: s.outcome, error: s.error })),
    dial: report.dial.map(d => ({ app: d.app, applicationUrl: d.applicationUrl, status: d.status ?? d.response?.status, body: d.response?.body, error: d.error })),
    websocket: report.websocket }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
