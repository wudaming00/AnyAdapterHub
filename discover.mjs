import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGETS = [
  'urn:lge-com:service:webos-second-screen:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'ssdp:all',
];

export function isPrivateIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const p = ip.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168);
}

export function parseSsdp(packet, sender) {
  const lines = packet.toString('utf8').split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200\b/.test(lines.shift() ?? '')) return null;
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { address: sender.address, headers };
}

function discoverOn(address, durationMs) {
  return new Promise(resolve => {
    const responses = [];
    const socket = dgram.createSocket('udp4');
    let timer;
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve({ address, responses, ...(error ? { error: error.message } : {}) });
    };
    socket.on('error', finish);
    socket.on('message', (packet, sender) => {
      const parsed = parseSsdp(packet, sender);
      if (parsed && isPrivateIPv4(sender.address)) responses.push(parsed);
    });
    socket.bind(0, address, () => {
      try {
        socket.setMulticastInterface(address);
        socket.setMulticastTTL(2);
        for (const target of TARGETS) {
          const query = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`);
          socket.send(query, 1900, '239.255.255.250');
        }
        timer = setTimeout(() => finish(), durationMs);
      } catch (error) { finish(error); }
    });
  });
}

export function checkedLocalUrl(value, expectedHost) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !isPrivateIPv4(url.hostname)
      || (expectedHost && url.hostname !== expectedHost) || url.username || url.password) {
    throw new Error('Descriptor URL must point to the responding device on the private LAN');
  }
  return url;
}

export function getLocalText(value, expectedHost) {
  const url = checkedLocalUrl(value, expectedHost);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      timeout: 3000,
      ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}; redirects are not followed`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(new Error('Descriptor too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('HTTP timeout')));
    request.on('error', reject);
  });
}

function xmlInner(xml, tag) {
  return xml.match(new RegExp(`<(?:(?:[\\w.-]+):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}>`, 'i'))?.[1] ?? '';
}

function xmlText(xml, tag) {
  const value = xmlInner(xml, tag);
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

export function parseDescription(xml, location) {
  if (!/<(?:[\w.-]+:)?root\b/i.test(xml) || !/<(?:[\w.-]+:)?device\b/i.test(xml)) throw new Error('Unsupported device description XML');
  const declaredBase = xmlText(xml, 'URLBase');
  const base = declaredBase ? new URL(declaredBase, location).href : location;
  const services = [...xml.matchAll(/<(?:[\w.-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?service>/gi)].map(([, block]) => {
    const service = {};
    for (const field of ['serviceType', 'serviceId', 'SCPDURL', 'controlURL', 'eventSubURL']) {
      const value = xmlText(block, field);
      service[field] = value && /URL$/.test(field) ? new URL(value, base).href : value;
    }
    return service;
  });
  return {
    friendlyName: xmlText(xml, 'friendlyName'),
    manufacturer: xmlText(xml, 'manufacturer'),
    modelName: xmlText(xml, 'modelName'),
    modelNumber: xmlText(xml, 'modelNumber'),
    deviceType: xmlText(xml, 'deviceType'),
    services,
  };
}

export function parseScpd(xml) {
  if (!/<(?:[\w.-]+:)?scpd\b/i.test(xml)) throw new Error('Unsupported SCPD XML; no method inference made');
  const actionList = xmlInner(xml, 'actionList');
  return [...actionList.matchAll(/<(?:[\w.-]+:)?action\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?action>/gi)].map(([, block]) => ({
    name: xmlText(block, 'name'),
    arguments: [...block.matchAll(/<(?:[\w.-]+:)?argument\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?argument>/gi)].map(([, arg]) => ({
      name: xmlText(arg, 'name'),
      direction: xmlText(arg, 'direction'),
      relatedStateVariable: xmlText(arg, 'relatedStateVariable'),
    })),
  }));
}

export function parseStateVariables(xml) {
  const table = xmlInner(xml, 'serviceStateTable');
  return [...table.matchAll(/<(?:[\w.-]+:)?stateVariable\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?stateVariable>/gi)].map(([, block]) => ({
    name: xmlText(block, 'name'),
    dataType: xmlText(block, 'dataType'),
    allowedValues: [...block.matchAll(/<(?:[\w.-]+:)?allowedValue\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?allowedValue>/gi)].map(([, value]) => value.trim()),
    ...(xmlText(block, 'allowedValueRange') ? { range: {
      minimum: xmlText(block, 'minimum'), maximum: xmlText(block, 'maximum'), step: xmlText(block, 'step'),
    } } : {}),
  }));
}

async function inspectDescriptor(response) {
  const location = response.headers.location;
  if (!location) return response;
  try {
    const xml = await getLocalText(location, response.address);
    const description = parseDescription(xml, location);
    for (const service of description.services) {
      if (!service.SCPDURL) continue;
      try {
        const scpd = await getLocalText(service.SCPDURL, response.address);
        service.actions = parseScpd(scpd);
        service.stateVariables = parseStateVariables(scpd);
      } catch (error) { service.schemaError = error.message; }
    }
    return { ...response, description };
  } catch (error) { return { ...response, descriptorError: error.message }; }
}

export function testPort(host, port, timeout = 700) {
  if (!isPrivateIPv4(host)) throw new Error('Only a private LAN IPv4 address is accepted');
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = status => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, status });
    };
    socket.setTimeout(timeout, () => finish('timeout'));
    socket.on('connect', () => finish('open'));
    socket.on('error', error => finish(error.code === 'ECONNREFUSED' ? 'closed' : error.code ?? 'error'));
  });
}

export async function discover({ durationMs = 4500, interfaceAddress, host } = {}) {
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    addresses.filter(a => a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address))
      .map(a => ({ name, address: a.address, netmask: a.netmask })));
  const chosen = interfaceAddress ? interfaces.filter(i => i.address === interfaceAddress) : interfaces;
  if (!chosen.length) throw new Error('No matching private IPv4 network interface');
  const scans = await Promise.all(chosen.map(i => discoverOn(i.address, durationMs)));
  const unique = new Map();
  for (const scan of scans) for (const response of scan.responses) {
    unique.set(`${response.address}|${response.headers.location ?? response.headers.usn}`, response);
  }
  const devices = await Promise.all([...unique.values()].map(inspectDescriptor));
  const lgHosts = [...new Set(devices.filter(d => /LG|webos|OLED|lge-com/i.test(
    [d.description?.manufacturer, d.description?.friendlyName, d.description?.modelName, d.headers.st, d.headers.server].join(' ')))
    .map(d => d.address))];
  if (host && !lgHosts.includes(host)) lgHosts.push(host);
  const ports = await Promise.all(lgHosts.map(async address => ({
    address,
    results: await Promise.all([3000, 3001, 8008, 8009, 8060, 8080, 9922, 22].map(p => testPort(address, p))),
  })));
  return {
    generatedAt: new Date().toISOString(),
    mode: 'read-only-discovery',
    note: 'An open port is not proof of a particular API. No pairing, SOAP action, control command, or exploit was sent.',
    interfaces,
    discovery: scans.map(({ address, error, responses }) => ({ address, responseCount: responses.length, ...(error ? { error } : {}) })),
    devices,
    ports,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = key => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : undefined; };
  if (args.includes('--help')) {
    console.log('node discover.mjs [--interface LAN_IP] [--host TV_IP] [--out reports/discovery.json]');
    return;
  }
  const report = await discover({ interfaceAddress: option('--interface'), host: option('--host') });
  const out = option('--out') ?? 'reports/discovery.json';
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.resolve(out), interfaces: report.interfaces, discovery: report.discovery,
    devices: report.devices.map(d => ({ address: d.address, name: d.description?.friendlyName,
      manufacturer: d.description?.manufacturer, model: d.description?.modelName,
      location: d.headers.location, services: d.description?.services.map(s => ({ type: s.serviceType, actionCount: s.actions?.length })) })),
    ports: report.ports }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
