# Supported devices

AnyAdapter Hub aims to give agents a consistent way to control devices and observe results. Support is established for an **exact model, firmware and capability**, not an entire brand. This page describes the repository as of 2026-10-20; roadmap entries are not implemented integrations.

## Current compatibility

| Device | Firmware / scope | Status |
| --- | --- | --- |
| **LG OLED65B8PUA** | **05.50.70**; device reports webOS release 4.4.3 | One physical television validated. See the capability limits below. |
| Other LG webOS televisions, including other B8 sizes or regional variants | No reviewed exact model/firmware profile | Unverified. Similar protocols do not establish compatibility; the temporary observer must not be enabled by family resemblance. |
| **ECOVACS DEEBOT X11 OmniCyclone** | US ECOVACS HOME, cloud class `huhcip`; firmware unknown; Windows current-user DPAPI enrollment | Experimental optional adapter. State and details were read on hardware through the Hub; movement controls have only offline tests. |
| Experimental **Home Assistant HTTPS light** | One enrolled HTTPS origin, certificate and `light.*` entity; optional control/dimming features | Implemented experimental software scope; no physical light, vendor, HA installation or firmware has been hardware verified here. |
| Experimental **MQTT/TLS numeric sensor** | One enrolled local TLS broker, exact topic and fixed measurement; optional MQTT.js installation | Implemented read-only MQTT 5 scope; no broker/device combination or publisher-specific hardware protocol has been hardware verified here. |
| Experimental **Hue / Shelly Gen2+** | Selected HTTPS light or ordinary-load relay; exact identity, trust and feature/grant gates | Software fixtures only. See [common integrations](COMMON_ADAPTERS.md), [Hue](HUE.md) and [Shelly](SHELLY.md); no additional household hardware evidence. |
| Experimental **SwitchBot / ThinQ / Awair / PurpleAir** | Explicit supported types, one enrolled device, fixed read-only vendor API projections | Software fixtures only; account eligibility, quotas and sample-time limits apply. [Cloud](CLOUD_SENSORS.md) and [air sensor](AIR_SENSORS.md) guides. |
| Experimental **HA sensor / openHAB / Plex** | One typed HA entity, typed openHAB Item or public Plex server identity | Software fixtures only. No arbitrary services, Item commands, library access or playback. [Common integrations](COMMON_ADAPTERS.md). |
| Other manufacturers and protocols below | No hardware validation in this repository | Roadmap only. |

The reviewed LG profile is [lg-oled65b8pua-webos4.json](../profiles/lg-oled65b8pua-webos4.json). Its `verified`, `unverified` and `unsupported` labels describe test evidence; they do not grant a client permission to operate the device.

**Transport scope:** the earlier records predate mandatory pinned TLS. The
[pinned-control and movie-workflow retest](evidence/lg-b8-workflow-2026-10-19.md)
covers completed first enrollment, pinned SSAP/pointer control, selected app
navigation and temporary observation on this B8. Ordinary capture downloads
still have offline TLS evidence only. Standby does not justify plaintext fallback. Live Hub
credential storage currently requires Windows CurrentUser DPAPI; Linux/macOS test
results do not establish live platform support. See [secure setup](SECURE_SETUP.md).

## LG OLED65B8PUA: what was verified

Evidence is recorded in the [device tests](evidence/lg-b8-2026-10-19.md) and [local Hub tests](evidence/local-hub-2026-10-19.md). Some tests exercised the underlying controller or MCP path; the Hub HTTP path was separately checked for state, mute, observation, authorization, idempotency and event delivery. This is not a claim that every Hub action was exercised on hardware.

| Area | Observed result | Boundary |
| --- | --- | --- |
| State and app inventory | Foreground app, volume, mute, power, input metadata and current audio output were read. | Foreground app is not the app's internal page. App inventory requires its own `app.list` permission. |
| Ordinary controls | App launch, selected remote keys, volume/mute changes, input selection, power off and network wake were tested. Changed settings were restored where applicable. | Not every key or app was tested. Wake timing depends on standby/network behavior. |
| Browser | A controlled page loaded and reported that load to the test receiver. | Does not establish unrestricted browser automation or successful text injection. |
| DLNA and local media | A controlled H.264 720p video reached `PLAYING`; pause, resume and stop were read back. A selected local file was cast. | Does not establish 4K/HDR, every codec, protected streaming services or arbitrary file access. Local files require configured `mediaRoots`. |
| Temporary observation | Real 1920×1080 JPEG frames, system foreground state and ACB player state were returned; action/observation tests showed UI changes. | Special opt-in path described below; not ordinary SSAP capture or continuous video. |
| Disney+ movie workflow | Exact movie details, playback title and advancing progress were visually assessed through the checkpointed workflow, alongside full-screen `playing`. | Attached visual agent required; no vendor-authenticated title or generic deep-link guarantee. See the [retest](evidence/lg-b8-workflow-2026-10-19.md). |

Text entry, pointer move/click/scroll, generic app media controls, audio-output changes, picture toggling, native URL playback and content deep links remain partially or wholly unverified. In particular, the tested Moana deep link did not establish direct title playback. See the individual evidence entries before relying on any of these features.

### Screenshot and playback limits

Ordinary SSAP screenshots failed on this firmware. The historically working observer temporarily uses a model-specific privileged system overlay and fixed internal service calls. It requires an exact reviewed identity, the Hub's `observer` feature, the owner's explicit local `allowTemporaryObserver` setting and the appropriate client grant. `screen.observe` and `screen.read` are separate permissions. Its legacy HTTP callback is not end-to-end encrypted; the feature defaults off. Ordinary capture downloads now require pinned HTTPS and refuse an HTTP image URL.

Successful observations included closing the overlay, restoring the original application and checking that the owned temporary capture was deleted. This mechanism **does not establish Linux root access**, replace the OS or provide Disney+ DOM, account internals or a trustworthy title field. ACB `playing` can describe a homepage preview; `titlePlaybackVerified` remains false. Observation is a bounded transaction taking seconds, not a low-latency screen stream. Cleanup failures must remain visible to the caller.

### Setup and compatibility checks

Use a television you own or are authorized to operate, an existing owner-approved local pairing and a trusted local network. Keep the pairing configuration private. The Hub does not automatically pair, install firmware or enable developer access. Network wake needs the television's relevant standby/network settings and must be tested on that installation.

Follow [local Hub setup](LOCAL_HUB.md), then grant only the required device/actions. Read [security limitations](../SECURITY.md), including current local transport and credential-storage limits, before enabling the temporary observer. A firmware change invalidates the exact observation compatibility claim until reviewed and retested; do not copy this profile to another model and mark it verified.

## ECOVACS X11: experimental cloud adapter

The [X11 adapter guide](ECOVACS_X11.md) documents the optional Windows worker, owner enrollment and permission model. This integration depends on ECOVACS cloud availability and a pre-existing enrollment encrypted for the current Windows user; a general login/enrollment flow is not included. Other ECOVACS models or regions are rejected. Firmware compatibility has not been established.

The [read-only hardware evidence](evidence/ecovacs-x11-2026-10-19.md) covers the new worker and Hub path, not just an earlier external connector:

- A scoped client obtained fresh normalized device state through the Hub.
- `vacuum.details.read` completed 11 read-only queries, projecting ten setting fields and 14 maintenance service-counter entries.
- The read-only grant was denied `vacuum.start` before dispatch and denied access to the LG device. No cleaning or other movement command was issued in this validation.

`vacuum.start`, `vacuum.pause`, `vacuum.resume`, `vacuum.stop` and `vacuum.dock` are implemented with offline policy/worker tests, but **have not been tested on hardware through this adapter**. They remain experimental. A currently active robot task is not evidence that AnyAdapter Hub started it. Command acceptance, observed state and task completion must remain separate.

The adapter binds one owner-selected device and exposes no room cleaning, maps, floor plans, camera or station-service control. Maintenance values are counters, not measured wear; the bagless X11's dust-bag counter is not applicable. Review the guide's optional GPL-3.0-or-later worker/dependency notices and private configuration requirements before enabling it. Vacuum grants are separate from TV grants.

## Experimental HTTPS light and MQTT sensor adapters

The [owner setup guide](POPULAR_ADAPTERS.md) describes masked credential
enrollment, explicit dependency installation, encrypted configuration references,
features and grants. These software paths do not add new hardware evidence.

| Adapter | Implemented scope | Evidence limit |
| --- | --- | --- |
| `home-assistant` | Selected light state; read-only by default. `control` and the exact grant enable `light.power.set`; `dimming` plus `control` and its grant enable `light.brightness.set` (0–100). Fixed HTTPS REST routes, exact entity and enrolled certificate. | Readback confirms only HA's reported entity state. It does not prove physical light output or make every device behind HA supported. No arbitrary service, script, template, switch, HVAC or camera access. |
| `mqtt-tls` | MQTT 5 subscription to one exact topic over pinned TLS, username/password held in DPAPI storage; bounded scalar measurements, no writes. | Retained messages are rejected; receipt age is not sensor sampling age. Broker authentication does not independently authenticate the publishing device. Tasmota/Zigbee2MQTT/ESPHome discovery or payload protocols are not implemented. |

Both remain unverified on household hardware. A test fixture or successful
broker/HA connection must not be recorded as exact device compatibility.
Changed trust, unsupported TLS or missing credentials fail closed rather than
enabling legacy plaintext paths.

## Proposed next integrations

These are implementation directions based on documented interfaces, **not a supported-device list or delivery commitment**. Exact hardware, firmware, authorization and result verification are still required.

| Priority | Integration | Initial scope and rationale |
| --- | --- | --- |
| 1 | Philips Hue Bridge and selected lights | Local light state, explicit on/off and bounded brightness. Hue documents local resource control and a physical bridge-button authorization step. Start with one lamp, not whole-home scenes. [Official API introduction](https://developers.meethue.com/develop/get-started-2/). |
| 1 | Shelly Gen2+ switches/plugs | Local `Switch.GetStatus` and explicit `Switch.Set`; begin with a lamp or other noncritical load. Shelly documents JSON-RPC commands, responses and notifications. Do not expose its general RPC, scripting, reset or network-configuration methods. [RPC protocol](https://shelly-api-docs.shelly.cloud/gen2/General/RPCProtocol/), [Switch component](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/). |
| 2 | Wider Home Assistant bridge | The implemented experimental path above covers one HTTPS light. Additional switch/sensor domains or WebSocket behavior need their own bounded schema and review; the HA credential may have broader rights than the Hub client. [REST API](https://developers.home-assistant.io/docs/api/rest/), [WebSocket API](https://developers.home-assistant.io/docs/api/websocket/). |
| 2 | Matter, initially through Home Assistant | Reuse an existing controller's owner-approved commissioning; start with lights, plugs and read-only sensors. Matter support does not make every feature of every device available. Thread devices need suitable border-router infrastructure; local IPv6/mDNS matters. Native AnyAdapter Hub commissioning is not implemented. [Home Assistant Matter guide](https://www.home-assistant.io/integrations/matter/). |
| 3 | Android TV / Fire TV through ADB | Selected keys, app launch and limited state/observation on an explicitly authorized device. Debug access is broad, so expose fixed reviewed actions rather than an agent shell. Compatibility and protected-screen behavior need per-device tests. [Android ADB documentation](https://developer.android.com/tools/adb), [Home Assistant ADB integration](https://www.home-assistant.io/integrations/androidtv/). |

Fans, air purifiers and read-only appliance telemetry are reasonable later candidates. Heating, motorized movement and other consequential actions need device-specific limits. Locks, alarms, cameras, cooking appliances and critical electrical loads are outside the initial lights/plugs scope; adding them requires a separate capability and privacy/safety review.

The [50-integration candidate catalog](DEVICE_ROADMAP.md) records official versus
community sources, encrypted-transport constraints and proposed bounded scopes.
It is a planning catalog, not a list of 50 supported brands or devices.

To add evidence or an adapter, follow [adapter requirements](ADAPTER_REQUIREMENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
