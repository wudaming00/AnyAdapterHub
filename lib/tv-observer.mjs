import http from 'node:http';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isPrivateIPv4 } from '../discover.mjs';
import { receiveProbeImage } from './probe-image.mjs';
import { validateDeviceProfile, assertProfileCompatible } from './device-profile.mjs';

export const OBSERVER_APP = 'com.webos.app.dangbei-overlay';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ROOT = new URL('../privileged-probe/', import.meta.url);
const MAX_JSON = 256 * 1024;

async function routeAddress(host) {
  const socket = dgram.createSocket('udp4');
  try {
    return await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(9, host, () => resolve(socket.address().address));
    });
  } finally { socket.close(); }
}

function scrub(value, token, depth = 0) {
  if (depth > 12) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => scrub(item, token, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/token|cookie|password|secret|authorization|sourceFile|responseString|url/i.test(key)).slice(0, 100).map(([key, item]) => [key, scrub(item, token, depth + 1)]));
  if (typeof value === 'string') return value.split(token).join('[redacted]').replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted-url]').slice(0, 4096);
  return value;
}

// Exported to test hostile callback traffic without contacting a television.
export function observationHandler({ host, token, runId, assets, state }) {
  return async (request, response) => {
    try {
      if (request.socket.remoteAddress?.replace(/^::ffff:/, '') !== host) { response.writeHead(403); response.end(); return; }
      const url = new URL(request.url, 'http://local');
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      const route = url.pathname.slice(prefix.length);
      const asset = assets.get(route);
      if (asset && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : asset.body); return;
      }
      if (!['report', 'image', 'done'].includes(route) || request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const maximum = route === 'image' ? 10 * 1024 * 1024 + 64 * 1024 : MAX_JSON;
      if (Number(request.headers['content-length']) > maximum) { response.writeHead(413); response.end(); return; }
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > maximum) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (route === 'image') {
        if ((request.headers['x-lg-agent-run-id'] ?? url.searchParams.get('runId')) !== runId || state.image) { response.writeHead(400); response.end(); return; }
        state.image = receiveProbeImage(bytes, request.headers['content-type']);
        state.imageReceivedAt = new Date().toISOString();
      } else {
        const payload = JSON.parse(bytes.toString('utf8'));
        if (!payload || payload.runId !== runId || Array.isArray(payload)) { response.writeHead(400); response.end(); return; }
        const clean = scrub(payload, token);
        if (route === 'done') state.done = { receivedAt: new Date().toISOString(), ...clean };
        else if (payload.type === 'bridge-ready') state.ready = true;
        else if (payload.type === 'sample' && !state.sample) state.sample = { receivedAt: new Date().toISOString(), ...clean };
        else { response.writeHead(400); response.end(); return; }
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end('{"ok":true}');
    } catch (error) {
      state.errors.push(scrub(error.message, token));
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  };
}

/** One observation transaction, with no TV listener or persistent installation.
 * Internal entry only: MCP separately requires the user's saved explicit opt-in.
 * Ordinary TV launch must not expose the privileged overlay to arbitrary URLs.
 */
export async function observeTV(controller, { timeoutMs = 25000, screenshot = true, assertDispatch } = {}, deps = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 45000 || typeof screenshot !== 'boolean') throw new Error('Invalid observation limits.');
  if (!isPrivateIPv4(controller.host)) throw new Error('Observation requires a selected private IPv4 TV.');
  const computer = await (deps.routeAddress ?? routeAddress)(controller.host);
  if (!isPrivateIPv4(computer) || computer === controller.host) throw new Error('Cannot select the TV-facing private network interface.');
  const runId = randomBytes(12).toString('hex');
  const token = randomBytes(24).toString('hex');
  const state = { errors: [] };
  const assets = new Map();
  const server = (deps.serverFactory ?? (handler => http.createServer(handler)))(observationHandler({ host: controller.host, token, runId, assets, state }));
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.maxConnections = 8;
  const metadata = { mode: 'temporary-luna-observer', startedAt: new Date().toISOString(), rootVerified: false,
    screenshotVerified: false, originalAppId: null, overlayClosed: false, restored: false,
    verificationScope: 'foreground_and_system_player_state', titlePlaybackVerified: false,
    note: 'A playing player may be a homepage preview; no title, account or Disney application memory is inferred.' };
  let entered = false;
  let listening = false;
  let authorizationError;
  try {
    const profile = validateDeviceProfile(await fs.readFile(new URL('../profiles/lg-oled65b8pua-webos4.json', import.meta.url), 'utf8'));
    metadata.device = await controller.identity();
    assertProfileCompatible(profile, metadata.device);
    const [template, cleanup] = await Promise.all([
      fs.readFile(new URL('bridge-observe.html', ROOT), 'utf8'), fs.readFile(new URL('capture-cleanup.js', ROOT)),
    ]);
    if (template.split('__LG_AGENT_CONFIG__').length !== 2) throw new Error('Invalid bundled observer template.');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, computer, resolve); });
    listening = true;
    const callbackOrigin = `http://${computer}:${server.address().port}`;
    const config = { runId, token, callbackOrigin, durationMs: timeoutMs - 4000, intervalMs: 1000, sampleLimit: 1, screenshot };
    assets.set('assets/loader.html', { type: 'text/html; charset=utf-8', body: Buffer.from(template.replace('__LG_AGENT_CONFIG__', JSON.stringify(config))) });
    assets.set('assets/capture-cleanup.js', { type: 'application/javascript', body: cleanup });
    assets.set('assets/cleanup-seed.bin', { type: 'application/octet-stream', body: Buffer.from([0]) });
    const status = await controller.status();
    metadata.originalAppId = status.foreground?.payload?.appId;
    if (!metadata.originalAppId || metadata.originalAppId === OBSERVER_APP) throw new Error('Cannot safely identify the original application.');
    const app = (await controller.apps()).apps?.find(item => item.id === OBSERVER_APP);
    if (!app) throw new Error('This TV does not have the reviewed observation component.');
    // Only a fixed diagnostic context; generic public tv_launch rejects it.
    try { assertDispatch?.(); } catch (error) { authorizationError = error; throw error; }
    entered = true;
    await controller.launchObserver(`${callbackOrigin}/${token}/assets/loader.html`);
    const deadline = Date.now() + timeoutMs;
    while (!state.done && Date.now() < deadline) await (deps.pause ?? pause)(100);
    if (!state.done) metadata.error = 'Observer completion timed out; partial results only.';
    metadata.communicationVerified = state.ready === true && Boolean(state.sample);
    metadata.sample = state.sample ?? null;
    metadata.completed = Boolean(state.done);
    metadata.imageReceivedAt = state.imageReceivedAt ?? null;
    metadata.screenshotVerified = Boolean(state.image);
    metadata.cleanup = state.sample?.cleanup ?? null;
    metadata.cleanupVerified = state.sample?.cleanup?.absenceVerified === true;
    metadata.residualPaths = screenshot && !metadata.cleanupVerified ? [`/media/internal/downloads/lg-agent-probe-${runId}.jpg`] : [];
    metadata.errors = state.errors;
  } catch (error) { metadata.error = scrub(error.message, token); }
  finally {
    if (entered) {
      try { await controller.closeApp(OBSERVER_APP); metadata.overlayClosed = true; }
      catch (error) { metadata.closeError = scrub(error.message, token); }
      if (metadata.originalAppId) {
        try {
          let observed = await controller.waitForApp(metadata.originalAppId, { timeoutMs: 1500, pollMs: 150 });
          if (!observed.confirmed) throw new Error('Original app not yet confirmed.');
          metadata.restored = true;
        } catch {
          try {
            await controller.launch(metadata.originalAppId);
            const observed = await controller.waitForApp(metadata.originalAppId, { timeoutMs: 5000, pollMs: 200 });
            metadata.restored = observed.confirmed === true;
          } catch (error) { metadata.restoreError = scrub(error.message, token); }
        }
      }
    }
    if (listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    metadata.finishedAt = new Date().toISOString();
  }
  if (authorizationError) throw authorizationError;
  return { ...(state.image ? { image: state.image, mimeType: 'image/jpeg' } : {}), metadata };
}
