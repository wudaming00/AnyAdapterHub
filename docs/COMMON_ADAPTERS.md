# Common household integrations / 常见设备接入

The fixed source catalog now contains **13 adapter entries**, including the
existing LG, ECOVACS, HA light and MQTT adapters. This iteration adds nine
experimental entries. Hardware evidence remains limited to the exact LG and
ECOVACS scopes in [supported devices](SUPPORTED_DEVICES.md). Offline software
tests, public API contracts and SDK availability do not verify a household model.

## Implemented scope

| Adapter ID | Selected target and implemented behavior | Guide |
| --- | --- | --- |
| `philips-hue` | One CLIP v2 light UUID, power/brightness readback; default read-only, explicit `control`/`dimming` and exact grants for setters | [Hue](HUE.md) |
| `shelly-gen2` | One authenticated HTTPS Gen2+ ordinary-load switch component, output and optional metering; optional explicit `switch.power.set` | [Shelly](SHELLY.md) |
| `switchbot` | One documented environmental meter type; temperature, humidity, battery and supported CO2, read-only | [Cloud sensors](CLOUD_SENSORS.md) |
| `lg-thinq` | One supported purifier/dehumidifier/AC profile; explicitly readable humidity, filter percentage or Celsius temperature; no appliance control | [Cloud sensors](CLOUD_SENSORS.md) |
| `home-assistant-sensor` | One `sensor.*` or `binary_sensor.*` entity with a fixed measurement/class/unit contract, read-only | Sensor contract below |
| `openhab` | One selected typed Item, finite state/units only, read-only; no Item commands, scripts or configuration | [openHAB](OPENHAB.md) |
| `plex` | One pinned HTTPS server's public identity/status; no token, account/library access, history or playback control | [Plex](PLEX.md) |
| `awair` | One supported selected Awair device's latest numeric environment data and reported sample time, read-only | [Air sensors](AIR_SENSORS.md) |
| `purpleair` | One public registered sensor; selected particulate/housing readings and reported sample time, read-only | [Air sensors](AIR_SENSORS.md) |

All nine use Node built-ins and existing reviewed shared code; they add no vendor
package to core installation. Existing `ws`/MQTT and ECOVACS dependencies remain
explicitly optional. There is no executable community plugin loader or OS sandbox.

Each entity/component/server is enrolled separately. An HA/openHAB account or
cloud token cannot turn this into a whole-account command endpoint. Names,
profiles, device responses and themes never supply executable modules, URLs or
permissions. Existing vendor automations and physical load identity are outside
the adapter's verification scope.

## Owner enrollment

Use the existing initialized private Hub home. For a new installation only,
follow [getting started](GETTING_STARTED.md). Do not initialize over an existing
home. Prepare the target metadata locally; never paste live target files or
credentials into a model, issue or public report.

| Adapter | Target JSON metadata, besides optional `timeoutMs` (100–15000) | Hidden prompts |
| --- | --- | --- |
| Hue | `origin`, `certificateFile`, `certificatePin`, `lightId`; optional owner-verified `bridgeId` | Application key |
| Shelly | `origin`, `certificateFile`, `certificatePin`, `expectedDeviceId`, `componentId`, `loadClass` (`ordinary-light`/`ordinary-plug`) | Admin password; username is fixed `admin` |
| SwitchBot | `vendorDeviceId`, documented `deviceType` | Token and signing secret |
| ThinQ | `vendorDeviceId`, supported `deviceType`, `countryCode`; optional stable v4 UUID `clientId` | Token and the owner's application API key |
| HA sensor | `origin`, `certificateFile`, `certificatePin`, `entityId`, `measurement` | HA token |
| openHAB | `origin`, `certificateFile`, `certificatePin`, `itemName`, supported `itemType` | API token |
| Plex | `origin`, `certificateFile`, `certificatePin`, `machineIdentifier` | None: the implemented endpoint is public |
| Awair | Positive integer `vendorDeviceId`, supported `deviceType` | Token |
| PurpleAir | Positive integer public `vendorDeviceId` | Read API key |

Consult each linked guide for exact enums, account eligibility and units. A
missing ThinQ `clientId` is generated once and persisted in its local config.
No shared vendor application key is copied into source. General OAuth login,
refresh-token management and browser account wizards are not implemented.

`certificateFile` is an ordinary PEM leaf certificate, resolved relative to the
metadata file. Its DER SHA-256 `certificatePin` is 64 lowercase hex characters.
Verify identity through the owner's trusted administration process. Certificate
acquisition, first trust, pairing and private resource ID discovery are not
performed automatically. Local services use pinned HTTPS with normal hostname
verification. Hue's optional exact bridge ID identifies the enrolled certificate
over an IP connection; it does not disable certificate chain, identity or pin
verification. See its guide before using this option.

Cloud integrations have no configurable origin or trust override: only fixed
reviewed vendor HTTPS hosts/routes/headers, with system CA and hostname checks
before authenticated application bytes. They do not use a manually enrolled
leaf pin, since public vendor leaf certificates rotate. Existing local pinning
is unchanged. Neither path permits redirects, plaintext HTTP or disabled TLS
verification. Unsafe `DEBUG`/`NODE_DEBUG`/`NODE_DEBUG_NATIVE` configurations fail
before requests can leak authentication through native/library diagnostics.

For the owner-selected adapter, run in an interactive local terminal (synthetic
filenames and device IDs below):

```powershell
node scripts/enroll-integration.mjs --adapter philips-hue --target hue-target.local.json --home .device-hub --out hue.local.json
node device-hub.mjs add --adapter philips-hue --config .device-hub/hue.local.json --id study-light --home .device-hub
```

Replace the adapter and metadata/output filenames with the matching row above.
The helper rejects authentication values in metadata/flags and piped credential
input. It uses hidden local prompts, purpose-bound Windows CurrentUser DPAPI and
exclusive private output. Plex saves public target metadata under the same
private ACL, with no credential or secret-store operation of its own. This does
not change the Hub's Windows-only production enrollment requirement.

Enrollment makes no vendor/device network request, enables no adapter and grants
no client authority. The subsequent explicit `add` enables that reviewed adapter.
Restart the Hub through the owner's existing procedure to start enabled reads.
Do not restart a shared live Hub merely to test source changes. Then issue a
short-lived grant for the exact opaque ID:

```powershell
node device-hub.mjs grant --device study-light --label reader --caps state.read,events.read --hours 24 --out .device-hub/study-reader.json --home .device-hub
```

For optional Hue/Shelly setters, the owner separately selects features and action
grants. Hue supports `control` or `control,dimming`; Shelly supports `control`.
No other new entry accepts a control feature. The agent must discover the
selected device's capability intersection rather than guessing an action.

## HA sensor measurement contract

The owner selects one measurement and entity. The adapter checks the exact
entity ID, device class and units; it does not interpret arbitrary text, change
units or execute templates/services. Numeric parser bounds are not calibration,
health thresholds or an indication that the physical sensor is trustworthy.

| Measurement | HA domain / device class | Unit and accepted values |
| --- | --- | --- |
| `temperatureC` | sensor / temperature | °C, -100–150 |
| `humidityPercent` | sensor / humidity | %, 0–100 |
| `co2Ppm` | sensor / carbon_dioxide | ppm, 0–100000 |
| `illuminanceLux` | sensor / illuminance | lx, 0–1000000 |
| `powerWatts` | sensor / power | W, -10000000–10000000 |
| `energyKwh` | sensor / energy | kWh, 0–1000000000000 |
| `batteryPercent` | sensor / battery | %, 0–100 |
| `contactOpen` | binary_sensor / door, window or opening | on=true / off=false |
| `motionDetected` | binary_sensor / motion | on=true / off=false |
| `occupied` | binary_sensor / occupancy | on=true / off=false |
| `moistureDetected` | binary_sensor / moisture | on=true / off=false |

Contracts come from HA's [sensor](https://www.home-assistant.io/integrations/sensor/)
and [binary sensor](https://www.home-assistant.io/integrations/binary_sensor/)
documentation. Receipt fields expire after 15 seconds and say what HA reported;
they do not establish device sampling age or physical detection. `unknown`,
`unavailable`, invalid source data and failed reads cannot renew prior readings.
Occupancy/contact observations still require explicit selected-device access.

## Remaining candidates

The [50-entry roadmap](DEVICE_ROADMAP.md) retains separate implementation and
hardware status. Other candidates need a reviewed OAuth/application flow,
additional controller/worker infrastructure, a secure credential/transport
contract, platform eligibility or model-specific protocol work. In particular,
MQTT transport does not implement Tasmota or Zigbee2MQTT vendor JSON contracts;
HA sensor support does not claim direct model compatibility for bridged brands.
No write capability is added for locks, doors, cooking, HVAC or cameras.
