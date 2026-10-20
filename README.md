# AnyAdapter Hub

A local device hub for agents. **AnyAdapter** connects reviewed device adapters to a common permission and feedback layer, independently of an agent framework. Collie and other agents can use the HTTPS API or JavaScript SDK; MCP is a legacy optional interface.

[中文](README.zh-CN.md) · [Documentation](docs/README.md) · [Get started](docs/GETTING_STARTED.md) · [Supported devices](docs/SUPPORTED_DEVICES.md) · [50 integration candidates](docs/DEVICE_ROADMAP.md) · [Contribute](CONTRIBUTING.md)

**Development preview.** Live enrollment currently requires Windows, Node.js 22.13+ and Git for Windows with its bundled OpenSSL. Credentials use Windows CurrentUser DPAPI; clients use pinned loopback HTTPS. Linux and macOS lack a production secret provider and fail closed. Cross-platform CI is not a live-platform support claim. No independent security audit or npm release has been completed.

The [platform architecture](docs/PLATFORM_ARCHITECTURE.md) uses one shared core
with Windows, Linux and macOS distribution targets. OS-specific security code is
isolated in a platform layer; native packages and a common graphical interface
remain planned.

## What it does

- Runs a local HTTPS hub with per-device state, freshness timestamps and SSE events.
- Grants exact device/action permissions with expiry, revocation and a check immediately before device dispatch.
- Records operation IDs and idempotency keys. Uncertain writes are not automatically replayed after reconnect or restart.
- Keeps device adapters and their dependencies optional. Community model profiles are validated data; they cannot install code or authorize a device.
- Separates ordinary state, screen capture and permission to read retained frames.
- Provides a [checkpointed Disney+ movie workflow](docs/MOVIE_WORKFLOW.md) for an attached visual agent, with encrypted progress and frame-bound decisions.

The core can start with no devices. Installing an adapter does not enroll a household device or grant an agent control.

## Current support

| Adapter | Evidence and limits |
| --- | --- |
| LG OLED65B8PUA, firmware `05.50.70`, webOS release `4.4.3` | Selected pinned control and visual-agent movie playback were [retested on hardware](docs/evidence/lg-b8-workflow-2026-10-19.md), including first certificate enrollment. Earlier records cover selected media controls. Other models/firmware remain unverified. |
| Optional B8 observer | Historical 1920×1080 JPEG and system-player feedback. Exact model/firmware, local opt-in and separate grants are required. Legacy LAN callbacks remain unencrypted; the feature defaults off. It does not expose Disney+ DOM or prove a movie title is playing. |
| Optional ECOVACS DEEBOT X11 OmniCyclone | US ECOVACS HOME, Windows, existing encrypted enrollment. Hub state/details reads were hardware verified; movement actions have offline tests only. Firmware is unknown. |
| Experimental `home-assistant` | One owner-selected HTTPS `light.*` entity. Read-only by default; explicit `control` and `dimming` features plus client grants gate the two setters. State confirmation means HA reported that entity's state, not a verified physical effect. No hardware compatibility is established. |
| Experimental `mqtt-tls` | One pinned local TLS broker, exact topic and fixed numeric measurement. Read-only MQTT 5 subscription; retained messages are rejected. Receipt freshness does not establish sensor sampling age or direct support for Tasmota, Zigbee2MQTT or another device protocol. No hardware compatibility is established. |

See [the capability matrix](docs/SUPPORTED_DEVICES.md) and its linked evidence. A shared protocol, passing test or contributed report does not establish support for another device.

The [experimental HTTPS light and MQTT sensor guide](docs/POPULAR_ADAPTERS.md)
describes owner-only masked credential enrollment, fixed targets and narrow
grants. Home Assistant needs no vendor SDK; MQTT.js is an explicitly installed
optional dependency. The [50-entry catalog](docs/DEVICE_ROADMAP.md) separates
these implemented experimental scopes from later candidates and deferred
interfaces.

The fixed source catalog now has **13 adapter entries**. Nine additional
experimental integrations cover Hue lights, Shelly ordinary-load switches,
SwitchBot, ThinQ, HA sensors, openHAB, Plex identity, Awair and public PurpleAir
sensors. [Common integrations](docs/COMMON_ADAPTERS.md) lists exact behavior,
owner enrollment, credentials and limits. Most are read-only; this is source
support with offline fixtures, not hardware verification for those brands.

## Start the core

From a new Windows PowerShell checkout:

```powershell
git clone https://github.com/wudaming00/AnyAdapterHub.git
Set-Location AnyAdapterHub
npm ci --ignore-scripts
node device-hub.mjs adapters
node device-hub.mjs init
node device-hub.mjs serve
```

This creates a protected `.device-hub` directory and serves `https://127.0.0.1:8765` with no adapters or devices enabled. It installs no TV transport, Python SDK or OS startup task. Keep this terminal open. In another project terminal, `node device-hub.mjs stop` stops the Hub.

An existing installation must use [security migration](docs/SECURE_SETUP.md#existing-installations), not repeat initialization. For TV pairing, read-only grants and first status, follow [Get started](docs/GETTING_STARTED.md). The full test suite is a contributor workflow; it is not an installation prerequisite and explicitly installs optional test dependencies.

## Connect an agent

First enroll a device and issue a narrow grant using [the setup guide](docs/GETTING_STARTED.md#issue-a-read-only-client). A Node.js ES module stored in the repository root can then use:

```js
import { readJson } from './lib/hub/config.mjs';
import { resolveCredential } from './lib/security/credentials.mjs';
import { HubClient } from './lib/hub/client.mjs';

const credential = await resolveCredential(await readJson('.device-hub/client.json'));
const hub = new HubClient(credential);
const state = await hub.state('living-room-tv');
// Check field timestamps/stale flags before planning an action.
```

The encrypted client file is bound to the Windows user that created it. Never hand an agent `owner.json`, pairing keys or unrestricted shell access under the Hub account. This prototype does not provide cross-account enrollment or an OS sandbox. See [API and SDK](docs/API.md), [operations](docs/LOCAL_HUB.md) and [security](SECURITY.md).

## Optional by design

| Owner choice | Effect |
| --- | --- |
| Install | Makes a reviewed dependency available, such as `npm run adapter:lg:install` or the separately chosen `npm run adapter:mqtt:install`. |
| Enable | Selects a reviewed adapter for loading. |
| Enroll | Binds one local device ID to an owner-selected device configuration. Explicit enrollment also enables its adapter. |
| Select features | Enables optional operations, such as LG `observer`/`media` or HA `control`/`dimming`, on that device. MQTT has no action feature. |
| Grant | Allows specified client capabilities on specified devices for a bounded lifetime. |

Configuration changes require a restart. Features default off. A client grant cannot override a disabled feature, change the selected device or install a new adapter. [Modular architecture](docs/MODULAR_ARCHITECTURE.md) explains the boundaries.

## Security and contributions

Do not expose the Hub to the internet. DPAPI protects copied credential files from routine decryption by another account; it does not stop an attacker already running as the owner or administrator. SQLite state/images are not encrypted by the credential change. LG pinning has first-trust and possible factory-shared-key limits; optional observer/media protocols still have legacy unencrypted LAN legs.

Use [private vulnerability reporting](https://github.com/wudaming00/AnyAdapterHub/security/advisories/new) for security issues. Public reports must exclude credentials, household identifiers, maps, personal screenshots and raw diagnostics.

Contribute a sanitized exact-model report, a data-only profile for an already reviewed protocol, or a separately reviewed adapter. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and [adapter requirements](docs/ADAPTER_REQUIREMENTS.md). The [roadmap](docs/ROADMAP.md) distinguishes implemented work from proposed integrations.

The core is MIT licensed. The optional ECOVACS Python worker is GPL-3.0-or-later; separately installed dependencies retain their own licenses. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
