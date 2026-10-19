# Optional adapters and features

AnyAdapter Hub separates five owner decisions:

| Decision | What it changes | What it does not grant |
| --- | --- | --- |
| Install | Makes a reviewed dependency available locally | Device access or client permissions |
| Enable | Selects an adapter for the hub configuration | Automatic discovery, pairing or enrollment |
| Enroll | Binds a local device ID to owner supplied configuration and credentials | Access to other devices on the LAN or cloud account |
| Select features | Makes optional operations available for that enrolled device | Client authorization to invoke them |
| Grant | Allows specified client capabilities on specified enrolled devices until expiry or revocation | Unlisted actions, devices or features |

An empty initialization enables no adapters and enrolls no devices. Explicit
owner enrollment may also enable its selected adapter; that is an intentional
local setup action. Registry changes take effect after restarting the hub.

## Core and distribution boundary

The core provides pinned local HTTPS, SSE events, grants, capability policy,
jobs, freshness-aware state, persistence and the client SDK. It imports no vendor
transport at startup. A fixed registry lazily imports reviewed `lg-webos` or
`ecovacs-x11` source only when an enabled enrolled device needs that adapter.

The distribution includes reviewed adapter source and documentation so that
owners can inspect it. Third-party vendor dependencies remain optional. A clean
`npm ci --ignore-scripts` does not install the LG `ws` transport or a Python SDK.
The metadata catalog is available without either dependency:

```sh
node device-hub.mjs adapters
npm run adapter:lg:install
```

The second command explicitly installs the pinned LG transport with lifecycle
scripts disabled. It does not enable or contact a device. ECOVACS uses its
separate [optional Python worker](../optional/ecovacs/README.md); Python package
installation and its license obligations are separate from core installation.
The full CI matrix explicitly installs both tested vendor dependencies.

## Per-device feature boundary

LG enrollment defaults to basic controls. Basic controls include state, app
inventory, navigation, volume, input selection, power and playback remote keys.
They do not include casting or temporary observation.

| Explicit LG feature | Additional operations | Additional boundaries |
| --- | --- | --- |
| `media` | Media URL playback, DLNA status/control and local file casting | Approved URL origins, media roots, target binding and a bounded media listener |
| `observer` | Temporary state and screen observation | Local `allowTemporaryObserver` opt-in, exact reviewed compatibility, capture/read grants, cleanup and restoration verification |

For example, local enrollment can select `--features observer,media`; omitting
the option selects neither feature. Feature selection is stored per enrolled
device. An already issued broad client grant cannot bypass a disabled feature.
The LG adapter checks this boundary before connecting or dispatching an effect.

The owner can also change an existing enrollment independently of its adapter:

```sh
node device-hub.mjs features --device living-room-tv --features observer,media
node device-hub.mjs disable --adapter lg-webos
node device-hub.mjs enable --adapter lg-webos
```

Disabling an adapter preserves its enrollment and selected features. Enabling it
does not select additional features. Restart the hub after these changes.

Temporary observation is a bounded transaction, not a persistent TV agent,
screen stream, Linux root session or access to Disney+ internals. Frame data is
kept separate from ordinary state and expires under the hub's retention limits.
The exact compatibility and evidence remain in [supported devices](SUPPORTED_DEVICES.md).

## Credentials and trusted code

Live initialization requires an OS credential provider and a protected TLS
identity. Windows CurrentUser DPAPI is implemented. Linux and macOS currently
require a reviewed provider before live initialization; there is no plaintext
fallback. Portable tests inject a separate in-process test provider explicitly.
Enabling an adapter never weakens these credential checks.

Community JSON profiles describe model compatibility and reviewed evidence.
They cannot add package names, scripts, module paths, arbitrary service calls,
credentials or authorization. Adding a new protocol or vendor requires a code
reviewed registry entry, bounded adapter implementation and evidence. Prefer
shared protocol adapters with model profiles over a separate executable plugin
for every model.

Lazy loading reduces startup work and accidental execution. It is not an OS
security sandbox: a loaded JavaScript adapter shares the hub process's rights.
The Python worker is a subprocess with fixed executable/script arguments and a
bounded protocol, but it is not claimed to be a hardened container. Stronger
worker isolation is future work and must define credentials, network targets,
filesystem access, resource limits and termination behavior explicitly.
