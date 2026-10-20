# Experimental cloud sensor adapters

These adapters read one owner-selected device through fixed vendor HTTPS APIs.
They have **offline fixture evidence only**; no household model or firmware has
been verified. Their `supportedActions` lists are empty. A successful response
does not prove a current physical measurement or an appliance's actual effect.

Both use Node built-ins and the reviewed fixed-origin HTTPS transport. No vendor
SDK is installed. System certificate trust, hostname checks and TLS 1.2 or newer
remain required. The adapter cannot select a custom origin, follow a redirect,
disable TLS verification or place authentication values in a URL. Unsafe debug
environments are rejected by that transport before sending authenticated bytes.

## SwitchBot environmental meters

The `switchbot` adapter uses the official
[SwitchBot v1.1 API](https://github.com/OpenWonderLabs/SwitchBotAPI#authentication).
It signs each request with HMAC-SHA256 over the Open Token, millisecond timestamp
and a random UUID, encoded as base64. Only one fixed device-status GET is used;
there is no device-list, command, scene, IR or webhook operation.

| Owner-selected API device type | Projected values when supplied |
| --- | --- |
| [`Meter`](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/sensors/meter.md) | Celsius temperature, humidity percentage, reported battery percentage |
| [`MeterPlus`](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/sensors/meter-plus.md) | Celsius temperature, humidity percentage, reported battery percentage |
| [`MeterPro`](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/sensors/meter-pro.md) | Celsius temperature, humidity percentage, reported battery percentage |
| [`MeterPro(CO2)`](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/sensors/meter-pro-co2.md) | The preceding values and CO2 ppm |
| [`WoIOSensor`](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/sensors/outdoor-meter.md) | Celsius temperature, humidity percentage, reported battery percentage |

The selected hardware ID must be twelve uppercase hexadecimal characters.
Returned device ID and type must match enrollment exactly. Locks, cameras,
contact/motion sensors, Bots, plugs and actuators are outside this adapter.

SwitchBot documents the public API for personal use and a 10,000-call daily
account limit; commercial or large-scale use requires consulting the vendor.
Cloud access must already be available through the owner's SwitchBot setup.
See the vendor's [usage limits and prerequisites](https://github.com/OpenWonderLabs/SwitchBotAPI#api-usage).
Five-minute refresh throttling is per enrolled adapter; it does not coordinate
the vendor account's quota across other devices, processes or applications.

## LG ThinQ selected environmental resources

The `lg-thinq` adapter follows the
[official LG ThinQ Connect REST contracts](https://github.com/thinq-connect/jsthinqconnect/blob/main/src/ThinQAPI.ts).
It requests only the selected device's profile and state. It does not enumerate
the account, register a cloud client, subscribe to MQTT/events, read energy
history or send control commands.

| Declared appliance type | Fixed numeric resource projection |
| --- | --- |
| [`DEVICE_AIR_PURIFIER`](https://github.com/thinq-connect/jsthinqconnect/blob/main/src/devices/AirPurifier.ts) | `airQualitySensor.humidity` and `filterInfo.filterRemainPercent`, when present |
| [`DEVICE_DEHUMIDIFIER`](https://github.com/thinq-connect/jsthinqconnect/blob/main/src/devices/Dehumidifier.ts) | `humidity.currentHumidity`, when present |
| [`DEVICE_AIR_CONDITIONER`](https://github.com/thinq-connect/jsthinqconnect/blob/main/src/devices/AirConditioner.ts) | `temperature.currentTemperatureC`, when present |

Every projected property must also have an explicit readable range declaration
in the returned profile. Multi-zone arrays, missing declarations and unsupported
units/resources fail closed. The adapter does not infer Fahrenheit conversions,
operating modes, arbitrary strings or model compatibility. Filter percentage is
a vendor-reported maintenance value, not measured physical filter wear.

Owner-selected country codes use a small fixed subset of the official
[country-to-region map](https://github.com/thinq-connect/jsthinqconnect/blob/main/src/CountryPreset.ts):

| Country codes | Fixed production origin |
| --- | --- |
| US, CA | `https://api-aic.lgthinq.com` |
| KR, JP, AU, NZ, SG | `https://api-kic.lgthinq.com` |
| GB, DE, FR, IT | `https://api-eic.lgthinq.com` |

The device ID is a canonical lowercase UUID. A separate stable UUIDv4 client ID
is generated once during trusted owner enrollment and retained; message IDs are
random per request. The owner must obtain a ThinQ Personal Access Token and an
appropriate application API key using LG's developer setup. No shared key from
another application or upstream sample is embedded in this project. Developer
access and model availability remain vendor prerequisites.

## Enrollment, authority and privacy

Follow the [trusted masked enrollment flow](POPULAR_ADAPTERS.md). The metadata
file must contain no authentication values. Trusted local code validates the
metadata, prompts without echo and seals credentials using Windows CurrentUser
DPAPI. Neither raw authentication headers nor account/device identifiers enter
Hub events or public operation results. Never paste tokens or secrets into an
agent prompt, command arguments, environment variables or diagnostics.

For trusted library integrations, the owner-side configuration APIs are:

| Adapter | Clear input fields in trusted process memory | Protection/loading functions |
| --- | --- | --- |
| SwitchBot | `vendorDeviceId`, `deviceType`, optional `timeoutMs`, `token`, `secret` | `protectSwitchBotConfig`, `loadSwitchBotConfig` |
| LG ThinQ | `vendorDeviceId`, `deviceType`, `countryCode`, stable `clientId`, optional `timeoutMs`, `token`, `apiKey` | `protectLGThinQConfig`, `loadLGThinQConfig` |

Saved configurations contain `credentialSecret` in place of clear credentials.
The encryption purpose binds the exact fixed origin, region/country, device and
declared device type; LG also binds its client identity. Retargeting encrypted
metadata fails decryption. The production secret store has no plaintext or
portable-test-provider fallback. JavaScript strings cannot be promised complete
immediate erasure from process memory.

Enabling an adapter, enrolling a device and granting a client permission remain
separate owner decisions. Use only `state.read`/`events.read` grants for these
read-only adapters. They share trusted process privileges with the Hub and are
not an OS sandbox.

## Freshness, throttling and verification

Snapshots expose only finite bounded numeric values under `fields.environment`,
with source `switchbot` or the selected `lg-thinq-*` region and verification
`cloud-reported-selected-device`. Vendor text, names, raw attributes, request
IDs, appliance IDs and authentication material are excluded.

Observation time begins at the local read attempt and expires after five
minutes. This records a cloud read, not the sensor's sample time: cloud caching
or a disconnected physical appliance can still affect the upstream report.
Repeated manual refreshes and background polls share a five-minute per-adapter
attempt limit. A failed read expires prior evidence without freshening it.
After failure, subsequent reads may return expired cached evidence until the
next allowed attempt. There is no automatic immediate retry.

Requests have a bounded timeout, queues are limited and close aborts the current
request. Late completions cannot publish new observations or send a subsequent
ThinQ request after closure. These checks do not establish hardware support;
owners can contribute sanitized exact-model observations through the normal
[evidence and review process](AI_ADAPTER_GUIDE.md).
