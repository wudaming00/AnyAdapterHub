# Philips Hue selected light (experimental)

This adapter implements one owner-selected Hue CLIP v2 `light` UUID on one
enrolled HTTPS origin. All evidence currently consists of offline fixtures,
including a synthetic loopback HTTPS bridge. No bridge, bulb model or firmware
has been hardware verified.

## Contract and evidence

The [official Hue v2 guide](https://developers.meethue.com/develop/hue-api-v2/getting-started/)
and [API reference](https://developers.meethue.com/develop/hue-api-v2/api-reference/)
require a Hue developer login; this implementation did not log in or claim to
inspect their current complete contract. The public
[official starting guide](https://developers.meethue.com/develop/get-started-2/)
describes GET/PUT semantics, and the
[official developer news](https://developers.meethue.com/) describes nested
`on`, `dimming.brightness`, `min_dim_level`, retained state while off, and the
2025 removal of HTTP support.

The detailed v2 schema reference is the community OpenHue maintainers' own
[OpenAPI source](https://github.com/openhue/openhue-api/tree/1ffc817857abf456d5ff2ae50400ef768dbce28e),
not a vendor SDK or an assertion of vendor endorsement. Relevant source includes
the [single-light GET/PUT contract](https://github.com/openhue/openhue-api/blob/1ffc817857abf456d5ff2ae50400ef768dbce28e/src/light/light_%7BlightId%7D.yaml),
[light state](https://github.com/openhue/openhue-api/blob/1ffc817857abf456d5ff2ae50400ef768dbce28e/src/light/schemas/LightGet.yaml),
[brightness semantics](https://github.com/openhue/openhue-api/blob/1ffc817857abf456d5ff2ae50400ef768dbce28e/src/common/Brightness.yaml),
[response envelope](https://github.com/openhue/openhue-api/blob/1ffc817857abf456d5ff2ae50400ef768dbce28e/src/common/ApiResponse.yaml)
and [header authentication](https://github.com/openhue/openhue-api/blob/1ffc817857abf456d5ff2ae50400ef768dbce28e/src/main.yaml).
The adapter is hand-written without generated client code or a new dependency.
The community maintainer's
[bridge certificate verifier](https://github.com/cB-Sigma/hue/blob/1a5b262a40d32319309bbf529425bfe5cf764777/tls.go)
also documents bridge-ID certificate names. This adapter preserves normal TLS
verification, an explicit enrolled leaf and its pin rather than copying that
library's configurable verification callbacks.

## Bounded behavior

The only route is `/clip/v2/resource/light/<enrolled UUID>`, with `GET` for
state and `PUT` for the two existing light setters. The application key is sent
only in the `hue-application-key` header after verified TLS. No discovery,
pairing, group, scene, color, firmware, plug, automation or entertainment
operation is implemented.

Default features are empty (read-only). `control` advertises
`light.power.set`; adding `dimming` also advertises `light.brightness.set`.
Dimming requires control and every write still needs the exact client grant.
Before writing, the fresh selected resource must report normal mode and an
explicit known lighting archetype. A `plug`, missing/unknown archetype or
streaming mode cannot authorize these light setters. Reported archetype is
bridge evidence, not an independent physical classification.

Positive brightness values require a reported numeric brightness and
`min_dim_level`; requests below that minimum are denied. Hub brightness `0`
sends `on:false`, because writing Hue brightness zero requests the minimum
dim level. Positive values send `on:true` plus the requested brightness.
An off resource's stored brightness remains its reported value.

`fields.light` projects only `available`, `power`, `brightness`,
`supportsBrightness`, `minimumBrightness` and `controlAvailable`. Here
`available` means the selected resource was returned by the bridge; it does not
prove bulb connectivity. Metadata, names, UUIDs, endpoints and keys are omitted.
Fields expire 15 seconds after the read began, with source
`philips-hue-https` and verification `bridge-reported-selected-resource`.
Polling is serialized with actions and runs no faster than every five seconds.
Failed refreshes retain the earlier field expiry.

Both `errors` and `data` are checked; a selected GET needs exactly one matching
`id`/`type`, and a PUT acknowledgment needs one matching `rid`/`rtype` with no
errors. Confirmation additionally requires a fresh selected GET whose power
matches, and whose positive brightness is within 0.5 percentage points of the
request. This tolerance accounts for reported numeric precision and is an
adapter policy. Confirmation scope is
`philips_hue_bridge_reported_selected_light_state`;
`physicalEffectVerified` remains false. A lost/invalid write response or failed
readback stays uncertain and is never automatically replayed.

## Enrollment and trust

The reviewed configuration functions accept exactly `origin`, `certificate`,
`certificatePin`, `lightId`, `applicationKey` and optional `timeoutMs`/`bridgeId`.
`origin` is a canonical HTTPS origin with no route, query or credentials;
`lightId` is one lowercase UUID. Timeout is 100–15000 ms, default 8000.
`protectPhilipsHueConfig` encrypts the application key using production Windows
CurrentUser DPAPI with a purpose bound to the exact origin, leaf SHA-256 pin,
light UUID and, when supplied, explicit bridge ID. `loadPhilipsHueConfig` accepts only the encrypted envelope; there is
no plaintext fallback.

Use the owner-side masked enrollment flow documented by the installed Hub;
never place an application key in target JSON, arguments, environment values,
logs or model messages. This adapter performs no pairing or automatic trust.
Enrollment, adapter enablement, feature selection and client grants remain
separate owner decisions.

The supplied leaf certificate must remain valid and match its enrolled SHA-256
pin; TLS 1.2 or later is required. Without `bridgeId`, its name must match the
origin hostname. For certificates naming a Hue bridge ID instead of its LAN IP,
the owner may explicitly enroll exactly 16 lowercase hexadecimal characters as
`bridgeId`. The origin must then be a literal private/local IP. The certificate
must match that name with wildcards disabled; TLS uses it for SNI and ordinary
server identity verification while connecting only to the enrolled IP/port.
The name is never discovered or inferred automatically. Removing or changing it
cannot decrypt the existing key. There is no arbitrary server-name, `insecure`
or HTTP fallback. Pin changes require explicit owner trust review. Clear unsafe `DEBUG`, `NODE_DEBUG` and
`NODE_DEBUG_NATIVE` configuration before starting; do not print their values.
