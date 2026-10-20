# Experimental HTTPS light and MQTT sensor adapters

The fixed adapter registry contains two new experimental integrations:
`home-assistant` for **one selected HTTPS light**, and `mqtt-tls` for **one exact
numeric subscription**. Neither has household hardware compatibility evidence.
They do not enable all devices behind Home Assistant or a broker. The
[50-entry candidate catalog](DEVICE_ROADMAP.md) describes later work separately.

Production enrollment uses Windows CurrentUser DPAPI. A portable test provider
is not a production fallback. Owners choose the target and certificate trust,
enter credentials locally, enable any control features and issue separate
client grants. Do not give authentication values or private target files to a
model, put them in command arguments/environment variables, or commit them.

## Dependencies and fixed scope

| Adapter | Dependency | Implemented boundary |
| --- | --- | --- |
| `home-assistant` | Node built-ins; no new vendor SDK | Fixed HTTPS origin, enrolled leaf certificate/pin and one `light.*` entity. Read-only by default. Optional explicit power and brightness setters only. |
| `mqtt-tls` | Optional MQTT.js **5.16.1** | Literal private/local broker address, port, enrolled leaf certificate/pin, exact topic and fixed measurement. MQTT **5**, QoS 0 subscription; no publish/action capability. |

When the owner chooses MQTT, install its pinned optional peer explicitly:

```powershell
npm run adapter:mqtt:install
```

This installation does not enroll a broker, enable an adapter or issue a grant.
Core startup and disabled registrations do not import MQTT.js. Upstream and
license details are in [third-party notices](../THIRD_PARTY_NOTICES.md).

Before starting either new integration, clear `DEBUG`, `NODE_DEBUG` and
`NODE_DEBUG_NATIVE` in the launching terminal. These transports reject unsafe
diagnostic configuration so underlying libraries cannot log authentication
bytes. Do not print the environment values or enable packet/debug logging to
diagnose an enrolled household connection.

## Owner-only masked enrollment

For a new empty installation, first run `node device-hub.mjs init`. Existing
installations must use their existing initialized Hub home; do not initialize
over it. Do not run a live setup step merely to validate code.

Prepare a private metadata JSON file **without authentication values** and an
owner-verified PEM leaf certificate. The helper does not discover a device,
fetch a certificate or automatically establish first trust. Obtain and verify
the certificate and its DER SHA-256 fingerprint through the owner's trusted
administration process. Keep metadata out of public reports: endpoints, entity
IDs and topics can still reveal household information even without a password.

The metadata fields are:

| Adapter | Required fields in the target JSON | Optional fields |
| --- | --- | --- |
| `home-assistant` | `origin`: canonical HTTPS origin only, no path/query/credentials; `entityId`: one `light.*` entity; `certificateFile`: PEM file path; `certificatePin`: 64 lowercase hexadecimal DER SHA-256 fingerprint | `timeoutMs`: integer 100–15000, default 8000 |
| `mqtt-tls` | `host`: literal private/local IP; `port`: integer 1–65535; `certificateFile`: PEM file path; `certificatePin`: fingerprint as above; `topic`: one exact allowed topic; `measurement`: one fixed name from the table below | None |

`certificateFile` is resolved relative to the target JSON file's directory.
Use exactly one ordinary PEM certificate file, not a private key or a chain
bundle. The MQTT certificate must contain the selected IP in its subject
alternative names. TLS validity, identity verification and the enrolled pin
remain required before authentication or protocol request bytes are sent.
Changed or unsupported trust must be reviewed locally, not bypassed or replaced
automatically.

The owner runs the trusted helper in an interactive terminal. These example
filenames and IDs are synthetic; prepare the actual metadata locally first:

```powershell
node scripts/enroll-integration.mjs --adapter home-assistant --target ha-target.local.json --home .device-hub --out ha-light.local.json
```

Or, for the separately selected MQTT integration:

```powershell
node scripts/enroll-integration.mjs --adapter mqtt-tls --target mqtt-target.local.json --home .device-hub --out mqtt-sensor.local.json
```

The helper reads the HA token, or MQTT username/password, through hidden
terminal prompts. Piped input and command-line credentials are not accepted.
`--out` is a new `.local.json` **basename inside the initialized Hub home**;
existing files are not overwritten. It saves an encrypted configuration,
without connecting to HA/broker, enabling the adapter or granting an agent
access. Do not copy the resulting file into a model prompt.

## Register, restart and grant read-only access

Import the encrypted configuration reference for the integration the owner
selected. Registration deliberately enables that adapter but starts no device
connection and grants no client authority:

```powershell
node device-hub.mjs add --adapter home-assistant --config .device-hub/ha-light.local.json --id study-light --home .device-hub
```

For MQTT, use the separate fixed target:

```powershell
node device-hub.mjs add --adapter mqtt-tls --config .device-hub/mqtt-sensor.local.json --id room-temperature --home .device-hub
```

Do not pass `--host` to either new adapter: its target is bound by the enrolled
configuration. Changes to configuration/features require a Hub restart. Start
or restart the Hub with the existing owner-authorized procedure; serving enabled
integrations starts their bounded reads/subscription.

With the Hub running, issue only the permissions needed for the selected opaque
device ID. For example:

```powershell
node device-hub.mjs grant --label light-reader --device study-light --caps state.read,events.read --hours 24 --out .device-hub/study-light-client.json --home .device-hub
node device-hub.mjs capabilities --device study-light --credential .device-hub/study-light-client.json
node device-hub.mjs status --device study-light --credential .device-hub/study-light-client.json
```

Use `room-temperature` and a new sensor-specific grant file for MQTT. A saved
client file contains encrypted authority and is handled by the trusted SDK;
the decrypted token must not be shown to a model. Do not use `--caps all` as a
setup shortcut. Reading state does not force an upstream refresh; inspect each
field's timestamps, `stale`, source and verification scope.

## Optional HA light control

HA always reads the enrolled entity at a fixed REST route. The only setters are:

| Feature and exact capability | Argument | Scope |
| --- | --- | --- |
| `control` plus `light.power.set` grant | `{on:boolean}` | Fixed `light.turn_on` or `light.turn_off` for the enrolled entity |
| `control,dimming` plus `light.brightness.set` grant | `{brightness:integer}` from 0–100 | Fixed brightness setter; 0 uses `turn_off`; brightness requires an advertised supported color mode |

The owner can enable `control` or `control,dimming` with the existing
features command, then restart. For example, an owner choosing both setters can
run `node device-hub.mjs features --device study-light --features control,dimming --home .device-hub`.
The owner must separately issue the exact action grant;
changing features does not expand an existing grant. Select an ordinary lamp,
not a critical load or an entity backed by a consequential actuator.

Reads and setters share a queue. The adapter rechecks authorization/deadline
after preparation, dispatches one explicit setter and reads back the same
entity. The result scope is
`home_assistant_reported_selected_entity_state`; `physicalEffectVerified` is
false. A mismatch stays unconfirmed; an ambiguous possibly sent write stays
unknown and is not automatically replayed. It does not prove physical output,
even if HA returns the requested value. There is no arbitrary entity, service,
script, template, switch, HVAC or camera tool.

## MQTT numeric message contract

The publisher sends a single finite UTF-8 numeric scalar, for example the
synthetic payload `23.5`. JSON objects/arrays, quoted numbers and generic vendor
telemetry objects are not interpreted. Payloads are at most 256 bytes. Topic
segments contain only letters, digits, `_`, `.`, or `-`, separated by `/`, up to
256 bytes; wildcards, empty segments and arbitrary topic selection are rejected.

| Measurement | Accepted numeric range | Unit |
| --- | --- | --- |
| `temperatureC` | -100–150 | °C |
| `humidityPercent` | 0–100 | % |
| `co2Ppm` | 0–100000 | ppm |
| `pm25UgM3` | 0–10000 | µg/m³ |
| `illuminanceLux` | 0–1000000 | lux |
| `powerWatts` | -10000000–10000000 | W |
| `energyKwh` | 0–1000000000000 | kWh |

These are parser bounds, not measurement accuracy, sensor certification or
health/safety thresholds. Configure the broker credential's ACL for only the
selected subscription. The adapter subscribes with retained delivery disabled
and also rejects messages flagged retained or missing the required retain
metadata. It never publishes, invokes vendor commands, discovers devices or
interprets Tasmota/Zigbee2MQTT/ESPHome discovery or payload protocols.

Valid readings have a 60-second **receipt** TTL and `broker-reported`
verification. It does not know the publisher's sampling age or independently
authenticate the physical sensor; a publisher can send an old value as a new
non-retained message. Disconnect expires cached fields, and invalid/foreign
messages cannot renew freshness. Read-only connection retries are bounded;
certificate trust failures must not trigger automatic trust changes.

Neither adapter adds locks, doors, cooking, HVAC writes, robot movement or camera
images/audio. Further protocols, domains and physical effects need their own
[capability design and review](ADAPTER_REQUIREMENTS.md), exact target enrollment,
permissions and hardware evidence.
