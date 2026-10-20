# openHAB selected Item reader

The `openhab` adapter reads exactly one owner-enrolled Item through the official
REST API. It exposes no actions or optional control feature. It never sends
commands, updates Item state, invokes rules or scripts, lists Items, follows
links, or reads group members.

## Enrollment and transport

The trusted local owner flow supplies an exact HTTPS `origin`, a valid enrolled
leaf `certificate` and SHA-256 `certificatePin`, exact `itemName`, supported
`itemType`, optional bounded `timeoutMs`, and an openHAB API `token`.
The Item name is an ASCII identifier and cannot supply a path, query or pattern.
The certificate must match the origin's hostname or IP; TLS validation and the
leaf pin are required before the Authorization header can be sent. Redirects
and plaintext fallback are refused.

openHAB's documented API-token contract uses HTTP Basic authentication with the
API token as the username and an empty password. This adapter uses precisely
that header format. It does not substitute an account password or guess Bearer
authentication. Keep tokens out of chat, command arguments, environment
variables, browser storage and logs. Production storage uses Windows CurrentUser
DPAPI bound to the origin, pin, Item name and Item type. An upstream token may
authorize more than one Item; the adapter's endpoint restriction is narrower.

## Normalized state

Every response must match both the selected name and type. Supported types are
`Switch`, `Dimmer`, `Number`, and the fixed Number dimensions Temperature,
Power, Energy, ElectricPotential, ElectricCurrent, Illuminance, Frequency and
Dimensionless. Labels, identifiers, links, metadata, tags and free text are
discarded. Groups, images, strings, locations and arbitrary dimensions are not
accepted.

| Item type | Accepted state / normalized field |
| --- | --- |
| Switch | ON/OFF to boolean `power` |
| Dimmer | Explicit numeric 0–100 to `brightnessPercent`; ON/OFF cannot establish a percentage |
| Number | Bounded unitless numeric `number` |
| Number:Temperature | °C, °F or K to `temperatureC` |
| Number:Power | W, kW or mW to `powerWatts` |
| Number:Energy | kWh, Wh or J to `energyKwh` |
| Number:ElectricPotential | V, mV or kV to `voltageV` |
| Number:ElectricCurrent | A or mA to `currentAmps` |
| Number:Illuminance | lx to `illuminanceLux` |
| Number:Frequency | Hz or kHz to `frequencyHz` |
| Number:Dimensionless | one, percent or ppm to numeric `ratio` |

Unknown units are rejected rather than inferred. Nonfinite and out-of-range
values are rejected. NULL and UNDEF report `available:false` and expire previous
measurement evidence. Fields expire after 15 seconds, with source
`openhab-https` and verification `hub-reported-selected-item`. A recent REST
response does not establish the age of an upstream sensor sample, device
connectivity, a physical effect, or a completed task. Item state can also reflect
openHAB rules, persistence, virtual Items or predicted state.

Construction and listener registration are inert. Polling starts explicitly,
does not overlap and respects a minimum five-second interval. Requests and
payloads are bounded; closing aborts pending work and suppresses late events.

## Verification and sources

`node --test test/openhab.test.mjs` runs synthetic configuration, privacy,
normalization, timeout/close and loopback TLS fixtures. No household openHAB
server or physical device is used; actual installations remain unverified.

Official references: [API tokens](https://www.openhab.org/docs/configuration/apitokens.html),
[REST API authentication](https://www.openhab.org/docs/configuration/restdocs),
[Item types and states](https://www.openhab.org/docs/concepts/items),
[Item identifiers](https://www.openhab.org/docs/configuration/items),
[units of measurement](https://www.openhab.org/docs/concepts/units-of-measurement.html).
