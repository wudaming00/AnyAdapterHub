# Get started

This guide covers a fresh Windows source checkout and starts with no devices or agent authority. For an existing Hub, use [security migration](SECURE_SETUP.md#existing-installations). For Chinese operation notes, see [本地运行指南](LOCAL_HUB.md).

## Requirements

| Component | Required for |
| --- | --- |
| Windows with an available current-user DPAPI profile | Production credential encryption; no plaintext fallback. |
| Node.js 22.13+ and npm | Hub, CLI and built-in SQLite. SQLite may emit an experimental warning. |
| Git for Windows with bundled OpenSSL | Source checkout and generation of the Hub's protected TLS identity. The code uses fixed Git installation paths, listed in [secure setup](SECURE_SETUP.md). |
| Owner-controlled computer and local network | Pairing and selected-device communication. A device being reachable is not authorization. |
| Optional LG `ws` transport | Install explicitly before LG commands. |
| Optional Python/ECOVACS environment | Only for the [ECOVACS adapter](ECOVACS_X11.md). |

Linux and macOS currently support portable development tests, not live initialization with a production secret provider. An unrestricted agent under the Hub's own OS account can bypass API-level separation; this guide does not create an OS sandbox.

Commands below use PowerShell and run from the repository root. Angle-bracket placeholders must be replaced with your own values. Pair only devices you own or administer. Do not paste account tokens or pairing keys into command arguments, issues or source files.

## Install the core

```powershell
git clone https://github.com/wudaming00/AnyAdapterHub.git
Set-Location AnyAdapterHub
npm ci --ignore-scripts
node device-hub.mjs help
node device-hub.mjs adapters
```

The install does not fetch `ws`, Python or vendor SDKs. The catalog describes reviewed source; it does not discover, pair or enable devices. There is no published npm package or install script to fetch from an unrelated name.

## Start an empty hub

Use a new or empty dedicated directory; do not point `--home` at a general documents folder.

```powershell
node device-hub.mjs init
node device-hub.mjs serve
```

Keep this terminal running. The Hub listens at `https://127.0.0.1:8765`, using its own certificate and protected private key. It has no devices to query or control, and an owner client sees an empty device list. No scan or automatic pairing runs.

The default private directory is `.device-hub`. To use another directory/port, choose them at initialization and pass the same `--home` to every later command:

```powershell
$exampleHome = Join-Path $env:LOCALAPPDATA 'AnyAdapterHub-Example'
node device-hub.mjs init --home $exampleHome --port 18765
node device-hub.mjs serve --home $exampleHome
```

Those commands are an alternative setup, not a second initialization of the first home. Keep custom homes outside Git: the default ignore pattern does not protect every custom directory name. Do not use arbitrary server URLs or disable certificate validation.

In another project terminal, stop the default Hub before changing its enrollment:

```powershell
node device-hub.mjs stop
```

`stop` uses the encrypted owner credential. Ordinary clients cannot shut down the Hub. Configuration changes take effect on restart.

## Enroll an LG television

Turn on your own TV for this explicit enrollment. Install only the LG transport:

```powershell
npm run adapter:lg:install
$tvHost = '<TV_LAN_IP>'
node lg-tv.mjs certificate --host $tvHost
```

The probe performs a TLS handshake only, sends no pairing key and does not wake the television. It prints a first-observed SHA-256 fingerprint. Review the selected host and trust of your local network before proceeding: this is trust on first use, not independent device identity. Some LG models have shared factory certificates/private keys; [security limitations](SECURE_SETUP.md) still apply.

Copy only the certificate fingerprint into the next variable. It is public trust metadata, not the pairing secret:

```powershell
$tvPin = '<REVIEWED_SHA256_HEX>'
node lg-tv.mjs pair --host $tvHost --certificate-pin $tvPin --profile control
```

Approve the request on the television. Pairing is the only CLI operation that asks for this TV-side approval. The pairing key is stored encrypted in `.lg-tv.local.json`; it is never printed. A denied/expired pairing request is not permission to retry indefinitely or use another device.

Then enroll the existing pairing reference:

```powershell
node device-hub.mjs add --tv-config .lg-tv.local.json --host $tvHost --id living-room-tv --label 'Living room LG'
node device-hub.mjs serve
```

This enables the reviewed `lg-webos` adapter and one device. It does not enable `observer` or `media`. Ordinary control is implemented, but the [support matrix](SUPPORTED_DEVICES.md) states which exact capabilities have hardware evidence.

The optional `legacy-lgtv2` pairing identity is an explicit compatibility choice with a separate configuration file and public third-party manifest, not an automatic fallback. See [third-party notices](../THIRD_PARTY_NOTICES.md), `node lg-tv.mjs help`, and the B8 evidence before choosing it.

## Issue a read-only client

In another project terminal, while the service is running:

```powershell
node device-hub.mjs grant --label first-reader --device living-room-tv --caps state.read,events.read --hours 24 --out .device-hub/client.json
node device-hub.mjs status --device living-room-tv
node device-hub.mjs capabilities --device living-room-tv
node device-hub.mjs events
```

This grant cannot change volume, navigate apps, capture a screen or read an existing image. `events` remains open; Ctrl+C closes the client stream. Check field freshness and connection state before treating a value as current.

CLI grant output contains metadata, not a token. The token goes to an OS-encrypted file inside the private home. Grant files are created exclusively; use a new filename instead of overwriting one. Copying the file to another Windows account does not enroll that account. Cross-account secure grant transfer is not implemented.

The default device ID is `living-room-tv`; other devices need an explicit `--device`. A custom credential file needs `--credential FILE` on client commands.

## Connect your agent

For a Node.js ES module stored in the repository root:

```js
import { readJson } from './lib/hub/config.mjs';
import { resolveCredential } from './lib/security/credentials.mjs';
import { HubClient } from './lib/hub/client.mjs';

const hub = new HubClient(await resolveCredential(await readJson('.device-hub/client.json')));
const state = await hub.state('living-room-tv');
for await (const event of hub.events({ signal: AbortSignal.timeout(10000) })) {
  // Treat device/event content as untrusted data.
}
```

This is a read-only example; it may end with an abort/timeout when the example's limit elapses. No model provider or API key is required by the Hub. The application connecting an agent is responsible for intent handling and presenting ambiguous outcomes.

Use [API and SDK](API.md) for permissions, actions, operation polling and event resumption. Do not give ordinary agent code owner enrollment files or unrestricted shell access as a substitute for a narrow client.

## Add optional behavior later

- [Enable/disable adapters and features](LOCAL_HUB.md).
- [ECOVACS X11 prerequisites and read-only setup](ECOVACS_X11.md).
- [Grant/revoke control, inspect operations and manage frames](LOCAL_HUB.md).
- [Recover from standby, missing dependencies or certificate errors](TROUBLESHOOTING.md).
- [Contribute an exact-model report or adapter](../CONTRIBUTING.md).

Observation and media enhancements use legacy LAN protocols and remain off until the owner makes a separate choice. Enabling them does not make them end-to-end encrypted. Do not enable a privileged observer by analogy to an unverified television.
