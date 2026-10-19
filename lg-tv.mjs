#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import {
  SSAPClient, SSAPError, AUDIT_PERMISSIONS, CONTROL_PERMISSIONS, EXTENDED_PERMISSIONS,
  SCREENSHOT_ENDPOINT, auditTV, downloadCapture, redact, validateLocalHost,
} from './lib/ssap.mjs';
import { TVController, wakeTV, SCREENSHOT_OPTIONS } from './lib/tv-controller.mjs';
import { resolveTVKey, protectTVKey } from './lib/security/credentials.mjs';
import { writeSecureJson } from './lib/hub/config.mjs';
import { probeTVIdentityCertificate } from './lib/security/tv-tls.mjs';

const HELP = `LG webOS local interface probe (Node.js 22+)

  node lg-tv.mjs pair --host IP [--secure] [--port 3000|3001] [--profile audit|control|extended|legacy-lgtv2]
  node lg-tv.mjs certificate --host IP  (TLS-only, prints unverified first-observed fingerprint)
  node lg-tv.mjs audit --host IP [--out reports/tv-audit.json] [--include-pointer]
  node lg-tv.mjs screenshot --host IP --output reports/tv-capture.jpg
  node lg-tv.mjs status|apps|keyboard --host IP
  node lg-tv.mjs launch --host IP --id APP_ID [--params JSON] [--content-id ID]
  node lg-tv.mjs close --host IP --id APP_ID
  node lg-tv.mjs content --host IP --id APP_ID --content-id ID
  node lg-tv.mjs open --host IP --url https://example.com
  node lg-tv.mjs play-url --host IP --url http://computer/video.mp4 --mime video/mp4 [--title TITLE] [--loop]
  node lg-tv.mjs dlna-status --host IP
  node lg-tv.mjs dlna-play --host IP --url http://computer/video.mp4 --mime video/mp4 [--title TITLE]
  node lg-tv.mjs dlna-media --host IP --action play|pause|stop
  node lg-tv.mjs text --host IP --text "search words" [--replace]
  node lg-tv.mjs key --host IP --name HOME
  node lg-tv.mjs move|scroll --host IP --dx 0 --dy 100
  node lg-tv.mjs click|play|pause|stop|rewind|fastforward --host IP
  node lg-tv.mjs volume --host IP --value 20
  node lg-tv.mjs mute|screen --host IP --state on|off
  node lg-tv.mjs input|sound --host IP --id HDMI_1
  node lg-tv.mjs off --host IP
  node lg-tv.mjs wake --host IP [--mac AA:BB:CC:DD:EE:FF] [--broadcast IP] [--bind-address IP]

Common flags: --config FILE (default .lg-tv.local.json), --timeout-ms 8000
Pair only: --pairing-timeout-ms 60000
Control: --webos-major 4 (default from saved metadata, otherwise 4)

pair is the only command that requests a TV pairing prompt. Default audit profile
requests only READ_* grants. A later explicit --profile control pairing requests
app launching, keyboard/mouse, media, volume, input and power permissions.
extended requests additional ordinary remote grants from Home Assistant's unsigned
manifest, excluding test and firmware-update grants. Existing keys survive a failed
pairing attempt; saved device metadata is preserved on success.
legacy-lgtv2 is an explicit third-party compatibility profile using lgtv2's pinned
public LG test-app manifest (LG Remote App / com.lge.test). It is not a signature
issued to this program. It defaults to a separate .lg-tv.legacy.local.json key file;
ordinary profiles remain unsigned. There is no automatic fallback or retry.

audit uses a saved key only and sends a fixed read-query allowlist. A missing key
stops locally before connecting. --include-pointer only obtains the pointer URL;
it never opens that socket or sends input. There is no automatic retry or pairing.

screenshot is a separate, explicit capture. The returned image URL must be on the
same literal local TV host; redirects and non-image responses are refused.
Local pairing keys are never printed. Keep .lg-tv.local.json private.
Control methods use ordinary TV endpoints only; factory/service/calibration APIs
and service-menu buttons are excluded. Remote-input send success is not proof
that an app acted on the command. content expands the installed app's declared
$CONTENTID template; launch sends the explicit params/contentId you supply.
`;

const LEGACY_PROVENANCE = Object.freeze({
  profile: 'legacy-lgtv2', repository: 'https://github.com/hobbyquaker/lgtv2',
  revision: '80ef796846730cb4331f33be38221de7485afc55',
  source: 'https://raw.githubusercontent.com/hobbyquaker/lgtv2/80ef796846730cb4331f33be38221de7485afc55/pairing.json',
  path: 'third_party/lgtv2-pairing.json',
  sha256: '2159d4e54dc38e3626a95f496a2e6c2f071b541bd07e2e0657c8acbbcdd9d9e8',
  license: 'MIT', identity: 'com.lge.test', displayName: 'LG Remote App',
  note: 'Public upstream compatibility identity; not a signature issued to this app.',
});

export async function loadLegacyManifest() {
  let bytes;
  try { bytes = await readFile(fileURLToPath(new URL(`./${LEGACY_PROVENANCE.path}`, import.meta.url))); }
  catch { throw new SSAPError('Pinned legacy manifest is missing. Restore the third_party fixture and license.', 'LEGACY_MANIFEST_MISSING'); }
  if (createHash('sha256').update(bytes).digest('hex') !== LEGACY_PROVENANCE.sha256) {
    throw new SSAPError('Pinned legacy manifest failed its integrity check.', 'LEGACY_MANIFEST_CHANGED');
  }
  let original;
  try { original = JSON.parse(bytes.toString('utf8')); } catch { throw new SSAPError('Pinned legacy manifest is invalid JSON.', 'INVALID_MANIFEST'); }
  return { manifest: original.manifest, metadata: { ...LEGACY_PROVENANCE } };
}

function parseArgs(args) {
  const [command = 'help', ...rest] = args;
  const options = {};
  const booleans = new Set(['secure', 'include-pointer', 'help', 'replace', 'loop']);
  const values = new Set(['host', 'port', 'profile', 'out', 'output', 'config', 'timeout-ms', 'pairing-timeout-ms',
    'id', 'params', 'content-id', 'url', 'text', 'name', 'dx', 'dy', 'value', 'state', 'mac', 'broadcast', 'bind-address', 'webos-major', 'wake-port',
    'mime', 'title', 'description', 'icon', 'action', 'certificate-pin']);
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    if (!option.startsWith('--')) throw new SSAPError('Unexpected positional argument.', 'USAGE');
    const name = option.slice(2);
    if (booleans.has(name)) options[name] = true;
    else if (values.has(name) && rest[index + 1] && !rest[index + 1].startsWith('--')) options[name] = rest[++index];
    else throw new SSAPError(`Unknown option or missing value: --${name}`, 'USAGE');
  }
  return { command, options };
}

async function loadConfig(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, devices: {} };
    throw new SSAPError('Cannot read local pairing configuration.', 'CONFIG_READ_FAILED');
  }
  let config;
  try { config = JSON.parse(text); } catch {
    throw new SSAPError('Local pairing configuration is invalid JSON; repair it before continuing.', 'CONFIG_INVALID');
  }
  if (config?.schemaVersion !== 1 || !config.devices || typeof config.devices !== 'object' || Array.isArray(config.devices)) {
    throw new SSAPError('Unsupported local pairing configuration format.', 'CONFIG_INVALID');
  }
  return config;
}

async function saveConfig(file, config) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeSecureJson(temporary, config);
    await rename(temporary, file);
  } catch {
    throw new SSAPError('Cannot save local pairing key. Check the configuration path and file permissions.', 'KEY_SAVE_FAILED');
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function main(args = process.argv.slice(2), { stdout = console.log, stderr = console.error,
  baseDirectory = process.cwd(), clientFactory = (options) => new SSAPClient(options),
  controllerFactory = (options) => new TVController(options),
  resolveKey = resolveTVKey, protectKey = protectTVKey,
} = {}) {
  let client;
  let controller;
  let secrets = [];
  try {
    const { command, options } = parseArgs(args);
    if (command === 'help' || options.help || command === '--help') { stdout(HELP); return 0; }
    if (command === 'certificate') {
      if (Object.keys(options).some(key => !['host', 'timeout-ms'].includes(key))) throw new SSAPError('Invalid certificate probe options.', 'USAGE');
      stdout(JSON.stringify(await probeTVIdentityCertificate({ host: validateLocalHost(options.host), timeoutMs: Number(options['timeout-ms'] ?? 8000) }), null, 2)); return 0;
    }
    const controlOptions = {
      status: [], apps: [], keyboard: [], launch: ['id', 'params', 'content-id'], close: ['id'], content: ['id', 'content-id'],
      open: ['url'], text: ['text', 'replace'], key: ['name'], move: ['dx', 'dy'], click: [], scroll: ['dx', 'dy'],
      'play-url': ['url', 'mime', 'title', 'description', 'icon', 'loop'],
      'dlna-status': [], 'dlna-play': ['url', 'mime', 'title'], 'dlna-media': ['action'],
      play: [], pause: [], stop: [], rewind: [], fastforward: [], volume: ['value'], mute: ['state'],
      input: ['id'], sound: ['id'], screen: ['state'], off: [], wake: ['mac', 'broadcast', 'bind-address', 'wake-port'],
    };
    const isControl = Object.hasOwn(controlOptions, command);
    if (!['pair', 'audit', 'screenshot'].includes(command) && !isControl) throw new SSAPError('Unknown command. Use help for examples.', 'USAGE');
    const validForCommand = isControl ? new Set(['host', 'secure', 'port', 'config', 'timeout-ms', 'webos-major', ...controlOptions[command]]) : {
      pair: new Set(['host', 'secure', 'port', 'profile', 'config', 'timeout-ms', 'pairing-timeout-ms', 'certificate-pin']),
      audit: new Set(['host', 'secure', 'port', 'config', 'timeout-ms', 'out', 'include-pointer']),
      screenshot: new Set(['host', 'secure', 'port', 'config', 'timeout-ms', 'output']),
    }[command];
    if (Object.keys(options).some((key) => !validForCommand.has(key))) throw new SSAPError('An option does not apply to this command.', 'USAGE');
    const host = validateLocalHost(options.host);
    const legacyRequested = command === 'pair' && options.profile === 'legacy-lgtv2';
    const configFile = path.resolve(baseDirectory, options.config ?? (legacyRequested ? '.lg-tv.legacy.local.json' : '.lg-tv.local.json'));
    const config = await loadConfig(configFile);
    if (resolveKey === resolveTVKey && Object.values(config.devices).some(item => Object.hasOwn(item ?? {}, 'clientKey'))) {
      throw new SSAPError('Plaintext pairing records require the explicit local security migration before use.', 'ENCRYPTED_CREDENTIAL_REQUIRED');
    }
    secrets = Object.values(config.devices).map((item) => item?.clientKey).filter((key) => typeof key === 'string');
    const record = Object.hasOwn(config.devices, host) ? config.devices[host] : undefined;
    const saved = record ? { ...record, clientKey: await resolveKey(record, host) } : undefined;
    if (saved?.clientKey) secrets.push(saved.clientKey);
    if (saved && (!saved.clientKey || !Array.isArray(saved.permissions))) throw new SSAPError('Saved TV pairing record is invalid.', 'CONFIG_INVALID');
    const profile = command === 'pair' ? (options.profile ?? 'audit') : (saved?.profile ?? 'audit');
    if (!['audit', 'control', 'extended', 'legacy-lgtv2'].includes(profile)) throw new SSAPError('Choose audit, control, extended or legacy-lgtv2.', 'USAGE');
    const legacyProfile = profile === 'legacy-lgtv2';
    const ownConfigFile = path.resolve(baseDirectory, '.lg-tv.local.json');
    if (legacyProfile && path.normalize(configFile).toLowerCase() === path.normalize(ownConfigFile).toLowerCase()) {
      throw new SSAPError('Legacy compatibility keys require a separate config file; the own-app key file will not be replaced.', 'CONFIG_PROFILE_MISMATCH');
    }
    if (command === 'pair' && Object.values(config.devices).some((device) => (device?.profile === 'legacy-lgtv2') !== legacyProfile)) {
      throw new SSAPError('Keep legacy and own-app pairing profiles in separate configuration files.', 'CONFIG_PROFILE_MISMATCH');
    }
    let registrationManifest;
    let registrationManifestMetadata;
    let inheritedMetadata = {};
    if (legacyProfile) {
      if (command === 'pair') {
        ({ manifest: registrationManifest, metadata: registrationManifestMetadata } = await loadLegacyManifest());
        const own = await loadConfig(ownConfigFile);
        const original = own.devices[host];
        if (original) {
          // Preserve network/device preferences, never copy the other app's key or grants.
          inheritedMetadata = Object.fromEntries(['webOSMajor', 'mac', 'wake'].filter((name) => Object.hasOwn(original, name)).map((name) => [name, original[name]]));
        }
        stderr('Legacy compatibility profile: the TV may display LG Remote App (com.lge.test), a public third-party test identity. A separate key file is used.');
      } else {
        registrationManifest = saved?.registrationManifest;
        registrationManifestMetadata = saved?.registrationManifestMetadata;
        if (!registrationManifest) throw new SSAPError('Legacy config has no saved public manifest. Explicitly pair that profile again.', 'CONFIG_INVALID');
      }
    }
    const requestedPermissions = legacyProfile ? registrationManifest.permissions :
      { audit: AUDIT_PERMISSIONS, control: CONTROL_PERMISSIONS, extended: EXTENDED_PERMISSIONS }[profile];
    // A change of profile is an explicit new pairing request, not a silent grant escalation.
    const reuseKey = command !== 'pair' || (saved?.profile === profile && (!legacyProfile ||
      saved.registrationManifestMetadata?.sha256 === registrationManifestMetadata.sha256));
    const port = options.port === undefined ? undefined : Number(options.port);
    const secure = options.secure || (port !== undefined ? port === 3001 : saved?.secure ?? true);
    const effectivePort = port ?? (options.secure ? 3001 : saved?.port);
    const certificatePin = options['certificate-pin'] ?? saved?.certificatePin;
    if (saved && options['certificate-pin'] !== undefined && options['certificate-pin'].replaceAll(':', '').toLowerCase() !== saved.certificatePin?.replaceAll(':', '').toLowerCase()) {
      throw new SSAPError('A stored key cannot be sent with a replacement certificate pin. Review certificate enrollment separately.', 'TLS_PIN_CHANGED');
    }
    if (!['pair', 'wake'].includes(command) && !saved) throw new SSAPError('No saved pairing key for this TV. Run pair first; no connection was made.', 'PAIRING_REQUIRED');
    if (command === 'screenshot' && !options.output) throw new SSAPError('Screenshot requires --output FILE.', 'USAGE');
    if (command === 'wake') {
      const result = await wakeTV(options.mac ?? saved?.mac, {
        broadcast: options.broadcast ?? saved?.wake?.broadcast ?? '255.255.255.255',
        bindAddress: options['bind-address'] ?? saved?.wake?.bindAddress,
        port: Number(options['wake-port'] ?? 9),
      });
      stdout(JSON.stringify(result, null, 2));
      return 0;
    }
    if (isControl) {
      const required = { launch: ['id'], close: ['id'], content: ['id', 'content-id'], open: ['url'], 'play-url': ['url', 'mime'],
        'dlna-play': ['url', 'mime'], 'dlna-media': ['action'], text: ['text'], key: ['name'],
        move: ['dx', 'dy'], scroll: ['dx', 'dy'], volume: ['value'], mute: ['state'], input: ['id'], sound: ['id'], screen: ['state'] }[command] ?? [];
      if (required.some((name) => options[name] === undefined)) throw new SSAPError(`Command requires ${required.map((name) => `--${name}`).join(', ')}.`, 'USAGE');
      if (['mute', 'screen'].includes(command) && !['on', 'off'].includes(options.state)) throw new SSAPError('--state must be on or off.', 'USAGE');
      let params = {};
      if (options.params !== undefined) {
        try { params = JSON.parse(options.params); } catch { throw new SSAPError('--params must be valid JSON.', 'USAGE'); }
      }
      controller = controllerFactory({ host, port: effectivePort, secure, certificatePin, clientKey: saved.clientKey,
        permissions: saved.permissions, registrationManifest, timeoutMs: Number(options['timeout-ms'] ?? 8000),
        webOSMajor: Number(options['webos-major'] ?? saved.webOSMajor ?? 4),
        wake: saved.wake, dlnaTimeoutMs: Number(options['timeout-ms'] ?? 15000),
      });
      if (!command.startsWith('dlna-')) await controller.connect();
      const actions = {
        status: () => controller.status(), apps: () => controller.apps(), keyboard: () => controller.keyboardState(),
        launch: () => controller.launch(options.id, params, options['content-id']),
        close: () => controller.closeApp(options.id),
        content: () => controller.launchContent(options.id, options['content-id']),
        open: () => controller.openUrl(options.url), text: () => controller.typeText(options.text, { replace: options.replace === true }),
        'play-url': () => controller.playUrl(options.url, { mimeType: options.mime, title: options.title ?? '',
          description: options.description ?? '', iconSrc: options.icon ?? '', loop: options.loop === true }),
        'dlna-status': () => controller.dlnaStatus(),
        'dlna-play': () => controller.dlnaPlay(options.url, { mimeType: options.mime, title: options.title ?? '' }),
        'dlna-media': () => controller.dlnaMedia(options.action),
        key: () => controller.key(options.name), move: () => controller.move(Number(options.dx), Number(options.dy)),
        click: () => controller.click(), scroll: () => controller.scroll(Number(options.dx), Number(options.dy)),
        play: () => controller.media('play'), pause: () => controller.media('pause'), stop: () => controller.media('stop'),
        rewind: () => controller.media('rewind'), fastforward: () => controller.media('fastForward'),
        volume: () => controller.setVolume(Number(options.value)), mute: () => controller.mute(options.state === 'on'),
        input: () => controller.setInput(options.id), sound: () => controller.soundOutput(options.id),
        screen: () => controller.screen(options.state === 'on'), off: () => controller.powerOff(),
      };
      stdout(JSON.stringify(controller.sanitize(await actions[command]()), null, 2));
      return 0;
    }
    client = clientFactory({ host, port: effectivePort, secure, certificatePin,
      clientKey: reuseKey ? saved?.clientKey : undefined,
      permissions: command === 'pair' ? requestedPermissions : saved.permissions,
      registrationManifest,
      timeoutMs: Number(options['timeout-ms'] ?? 8000),
      pairingTimeoutMs: Number(options['pairing-timeout-ms'] ?? 60000),
      onPairing: () => stderr('请在电视弹出的连接请求中选择允许。此次连接不会发送遥控或播放命令。'),
      onClientKey: command === 'pair' ? async (key) => {
        secrets.push(key);
        config.devices[host] = await protectKey({ ...inheritedMetadata, ...saved, clientKey: key, permissions: [...requestedPermissions], profile,
          registrationManifest, registrationManifestMetadata,
          port: client.port, secure: client.secure, certificatePin, pairedAt: new Date().toISOString() }, host);
        await saveConfig(configFile, config);
      } : undefined,
    });
    await client.connect({ allowPairing: command === 'pair' });
    if (command === 'pair') {
      // Some TVs confirm an already registered key without returning it again.
      if (!Object.hasOwn(config.devices, host)) throw new SSAPError('Pairing completed without a savable key.', 'KEY_SAVE_FAILED');
      stdout(`Paired with ${host}:${client.port} (${profile} profile). Key saved privately in ${configFile}.`);
      return 0;
    }
    if (command === 'audit') {
      const report = await auditTV(client, { includePointer: options['include-pointer'] === true });
      const output = path.resolve(options.out ?? `reports/tv-audit-${Date.now()}.json`);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      const passed = report.results.filter((item) => item.status === 'ok').length;
      stdout(`Audit saved: ${output}\n${passed}/${report.results.length} read queries succeeded; inspect individual errors for permission/firmware limitations.`);
      return 0;
    }
    const capture = await client.request(SCREENSHOT_ENDPOINT, { ...SCREENSHOT_OPTIONS });
    const { data, contentType, bytes } = await downloadCapture(capture.imageUri, host, {
      timeoutMs: client.timeoutMs, certificatePin,
    });
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, data, { mode: 0o600, flag: 'wx' });
    stdout(`Screenshot saved: ${output} (${bytes} bytes; ${contentType}).`);
    return 0;
  } catch (error) {
    const message = client ? client.sanitize(error.message) : controller ? controller.sanitize(error.message) : redact(error.message, secrets);
    stderr(`${error.code ?? 'ERROR'}: ${message}`);
    return 1;
  } finally { controller?.close(); client?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
