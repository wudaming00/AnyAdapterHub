#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { HubStore } from './lib/hub/store.mjs';
import { HubRuntime, tokenHash } from './lib/hub/runtime.mjs';
import { HubServer } from './lib/hub/server.mjs';
import { HubClient } from './lib/hub/client.mjs';
import { initializeHub, addHubDevice, loadHubConfig, protectHubHome, readJson, writePrivateJson, setAdapterEnabled, setDeviceFeatures } from './lib/hub/config.mjs';
import { createAdapter, adapterMetadata } from './lib/hub/adapters.mjs';
import { resolveCredential } from './lib/security/credentials.mjs';
import { openHubIdentity } from './lib/security/hub-identity.mjs';
import { ACTIONS, READ_CAPABILITIES } from './lib/hub/policy.mjs';

const HELP = `AnyAdapter Hub local device hub
  node device-hub.mjs init --tv-config FILE --host PRIVATE_IP [--id living-room-tv] [--port 8765]
  node device-hub.mjs init --ecovacs-config FILE [--id vacuum] [--port 8765]
  node device-hub.mjs add --ecovacs-config FILE [--id vacuum] [--home .device-hub]
  node device-hub.mjs serve [--home .device-hub]
  node device-hub.mjs init [--home .device-hub]  (empty core, no adapters)
  node device-hub.mjs adapters
  node device-hub.mjs enable|disable --adapter lg-webos|ecovacs-x11
  node device-hub.mjs features --device ID --features observer,media  (empty string disables both)
  node device-hub.mjs migrate-security [--tv-config FILE] [--legacy-tv-config FILE]
  node device-hub.mjs stop [--home .device-hub]
  node device-hub.mjs status|capabilities [--device living-room-tv] [--credential FILE]
  node device-hub.mjs call --action ACTION --args JSON [--key IDEMPOTENCY_KEY] [--device ID]
  node device-hub.mjs observe [--device ID] [--out captures/current.jpg]
  node device-hub.mjs movie-start --title TITLE --year YEAR --key REQUEST_ID --device ID --credential FILE
  node device-hub.mjs movie-observe|movie-resume|movie-status --key REQUEST_ID --device ID --credential FILE
  node device-hub.mjs movie-step --key REQUEST_ID --device ID --credential FILE --decision JSON
  node device-hub.mjs events [--after 0]
  node device-hub.mjs grant --label NAME --caps state.read,events.read --out FILE [--hours 24]
  node device-hub.mjs grants|revoke --grant-id ID

All client commands default to .device-hub/client.json. Grant management uses owner.json.
Grant --caps all is an explicit owner choice; tokens use OS-encrypted files, never printed.
Movie workflows require a scoped grant, persist encrypted progress and never replay ambiguous writes.
init/add import references to owner-enrolled local configuration; they never silently pair devices.
add requires a restart before the running hub can use its new device registry.
serve uses pinned HTTPS on 127.0.0.1 only. It does not install OS startup tasks.
`;
function parse(argv) {
  const [command = 'help', ...rest] = argv; const options = {};
  const allowed = ['home', 'tv-config', 'legacy-tv-config', 'ecovacs-config', 'host', 'id', 'label', 'port', 'credential', 'device', 'action', 'args', 'key', 'out', 'after', 'caps', 'hours', 'grant-id', 'adapter', 'features', 'title', 'year', 'decision'];
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || !allowed.includes(rest[i].slice(2)) || rest[i + 1] === undefined || Object.hasOwn(options, rest[i].slice(2))) throw new Error('Invalid arguments.');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, options };
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command === 'help' || command === '--help') { process.stdout.write(HELP); return; }
  const home = path.resolve(options.home ?? '.device-hub');
  if (command === 'adapters') { process.stdout.write(JSON.stringify(adapterMetadata(), null, 2) + '\n'); return; }
  if (['movie-start', 'movie-observe', 'movie-resume', 'movie-status', 'movie-step'].includes(command)) {
    if (!options.device || !options.key || !options.credential) throw new Error('Movie commands require an exact device, stable request key and scoped credential file.');
    if (command === 'movie-start' && (!options.title || !/^\d{4}$/.test(options.year ?? ''))) throw new Error('Movie title and four-digit year required.');
    if (command === 'movie-step' && !options.decision) throw new Error('A bounded visual decision is required.');
    const { withMovieWorkflow } = await import('./lib/hub/movie-journal.mjs');
    const result = await withMovieWorkflow({ home, credentialPath: options.credential, deviceId: options.device, requestId: options.key,
      ...(command === 'movie-start' ? { create: { title: options.title, year: Number(options.year) } } : {}) }, async workflow => {
      switch (command) {
        case 'movie-start': return workflow.prepare();
        case 'movie-observe': return workflow.observe();
        case 'movie-resume': return workflow.resume();
        case 'movie-step': return workflow.step(JSON.parse(options.decision));
        default: return workflow.status();
      }
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return;
  }
  if (['enable', 'disable'].includes(command)) { process.stdout.write(JSON.stringify(await setAdapterEnabled(home, options.adapter, command === 'enable')) + '\n'); return; }
  if (command === 'features') { if (options.features === undefined || !options.device) throw new Error('Device and features required.'); process.stdout.write(JSON.stringify(await setDeviceFeatures(home, options.device, options.features ? options.features.split(',') : [])) + '\n'); return; }
  if (command === 'migrate-security') {
    const { migrateSecurity } = await import('./lib/security/migrate.mjs');
    process.stdout.write(JSON.stringify(await migrateSecurity({ home, tvConfigPaths: [options['tv-config'], options['legacy-tv-config']].filter(Boolean) })) + '\n'); return;
  }
  if (command === 'init' || command === 'add') {
    const enroll = command === 'init' ? initializeHub : addHubDevice;
    process.stdout.write(JSON.stringify(await enroll({ home, tvConfigPath: options['tv-config'], ecovacsConfigPath: options['ecovacs-config'], host: options.host,
      id: options.id, label: options.label, features: options.features ? options.features.split(',') : [], port: options.port === undefined ? undefined : Number(options.port) })) + '\n'); return;
  }
  if (command === 'serve') {
    const config = await loadHubConfig(home);
    const owner = await resolveCredential(await readJson(path.join(home, 'owner.json')));
    const identity = await openHubIdentity(await readJson(path.join(home, 'identity.json')));
    if (owner.url !== `https://127.0.0.1:${config.port}` || owner.certificatePin !== identity.certificatePin) throw new Error('Owner credential and hub TLS identity must match.');
    const store = new HubStore({ filePath: path.join(home, 'state.sqlite') });
    const devices = [];
    for (const device of config.devices) devices.push({ ...device, adapter: await createAdapter(device) });
    const runtime = new HubRuntime({ store, ownerTokenHash: tokenHash(owner.token), devices });
    let server;
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; runtime.beginClose(); await server.close(); await runtime.close(); };
    server = new HubServer({ runtime, onShutdown: stop, tls: { key: identity.key, cert: identity.cert } });
    try { const address = await server.listen({ port: config.port });
      // Reserve the loopback port before recovery. Start synchronously before
      // another await so requests cannot race startup recovery of queued work.
      const starting = runtime.start();
      await writePrivateJson(path.join(home, 'process.json'), { pid: process.pid, startedAt: new Date().toISOString(), ...address }, { exclusive: false });
      process.stdout.write(JSON.stringify({ event: 'hub.listening', ...address }) + '\n');
      process.once('SIGINT', () => stop().catch(() => { process.exitCode = 1; }));
      process.once('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
      await starting;
    } catch (error) { await stop(); throw error; }
    return;
  }
  const ownerCommand = ['grant', 'grants', 'revoke', 'stop'].includes(command);
  if (ownerCommand) await protectHubHome(home);
  const credential = await resolveCredential(await readJson(options.credential ?? path.join(home, ownerCommand ? 'owner.json' : 'client.json')));
  const client = new HubClient(credential); const deviceId = options.device ?? 'living-room-tv';
  let result;
  switch (command) {
    case 'stop': result = await client.shutdown(); break;
    case 'status': result = await client.state(deviceId); break;
    case 'capabilities': result = await client.capabilities(deviceId); break;
    case 'call': result = await client.execute(deviceId, options.action, JSON.parse(options.args ?? '{}'), { idempotencyKey: options.key }); break;
    case 'observe': {
      result = await client.execute(deviceId, 'screen.observe');
      if (options.out && result.result?.frame) {
        await writeFile(path.resolve(options.out), await client.frame(result.result.frame.id), { flag: 'wx', mode: 0o600 });
        result.localImage = path.resolve(options.out);
      }
      break;
    }
    case 'events': for await (const event of client.events({ afterId: Number(options.after ?? 0) })) process.stdout.write(JSON.stringify(event) + '\n'); return;
    case 'grant': {
      if (!options.out || !options.caps || !options.label) throw new Error('Grant label, capabilities and private output file are required.');
      const destination = path.resolve(options.out);
      if (path.dirname(destination) !== home) throw new Error('Grant output must be directly inside the private hub directory.');
      const hours = Number(options.hours ?? 24);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) throw new Error('Grant duration must be at most 30 days.');
      const available = options.caps === 'all' ? await client.capabilities(deviceId) : null;
      const issued = await client.issueGrant({ label: options.label, deviceIds: [deviceId],
        capabilities: available ? [...available.read, ...Object.keys(available.actions)] : options.caps.split(','),
        expiresAt: new Date(Date.now() + hours * 3600000).toISOString() });
      // Default destination is inside the already protected hub home. External files require their own private parent ACL.
      try { await writePrivateJson(destination, { url: credential.url, certificate: credential.certificate, certificatePin: credential.certificatePin, token: issued.token, grantId: issued.grant.id }); }
      catch (error) {
        try { await client.revokeGrant(issued.grant.id); }
        catch { error.orphanGrantId = issued.grant.id; }
        throw error;
      }
      result = issued.grant; break;
    }
    case 'grants': result = await client.grants(); break;
    case 'revoke': result = await client.revokeGrant(options['grant-id']); break;
    default: throw new Error('Unknown command.');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Device hub request failed${/^[A-Z_]{2,64}$/.test(error.code ?? '') ? ' (' + error.code + ')' : ''}. Use help and inspect the private local configuration.\n`);
    if (/^[a-f0-9-]{36}$/.test(error.orphanGrantId ?? '')) process.stderr.write(`Credential save and compensation failed; revoke the unsaved grant with --grant-id ${error.orphanGrantId}.\n`);
    process.exitCode = 1;
  });
}
