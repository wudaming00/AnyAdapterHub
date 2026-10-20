# Shelly Gen2+ selected switch adapter

This adapter uses Shelly's official local RPC API over owner-enrolled HTTPS.
It supports one explicitly selected `Switch` component on a Gen2, Gen3 or Gen4
device reporting firmware 2.0.0 or later. Compatibility remains unverified until
an exact device, firmware and capability has corresponding hardware evidence.

The default is read-only: selected output state and optional power, voltage,
current, frequency and accumulated energy. The explicit `control` feature adds
only `switch.power.set` with `{on:boolean}`. The owner must classify the selected
load as `ordinary-light` or `ordinary-plug`; this declaration does not technically
identify the attached appliance. Do not enroll locks, doors, heating, cooking,
medical equipment or other critical loads. Switching can also trigger existing
device automations; the adapter does not inspect or change those automations.

## Local prerequisites

Shelly documents inbound HTTPS starting with firmware 2.0.0. Factory devices
shipped with that firmware can have Shelly PKI certificates; devices upgraded
from earlier firmware do not acquire a factory certificate automatically.
The owner must provision suitable HTTPS trust through Shelly's trusted local
tools before enrolling this adapter. A certificate must contain the exact
private/local literal IP in its subject alternative names, remain valid and
match the enrolled SHA-256 leaf pin. There is no HTTP fallback, automatic
certificate replacement, device discovery or certificate-install RPC here.

The encrypted configuration binds `origin`, `certificate`, `certificatePin`,
`expectedDeviceId`, `componentId` (0–15), `loadClass` and an optional bounded
`timeoutMs`. Credentials use username `admin` and the owner's device password.
Production protection uses Windows CurrentUser DPAPI, bound to the origin,
certificate pin, exact device ID, component and load declaration. Passwords must
enter through the trusted local enrollment flow, never chat, command arguments,
environment variables or browser storage. No Shelly cloud account is needed.

## Transport, authority and evidence

Only POST `/rpc` frames for `Shelly.GetDeviceInfo`, `Switch.GetStatus` and the
optional `Switch.Set` are constructed. Each refresh checks the enrolled device
ID, generation, firmware, switch profile and enabled authentication. SHA-256
HTTP Digest accepts only a bounded challenge whose realm matches the enrolled
device. The nonce counter increases monotonically; only reads may retry once
after a challenge. Authentication rejection disables further automatic work
until the adapter is recreated with corrected local credentials.

Writes require a fresh authenticated selected-component preflight, then repeat
deadline, grant, identity, nonce and freshness checks after TLS preparation at
the final dispatch boundary. A mutation is sent at most once. Lost responses,
authentication errors after dispatch and missing readback remain uncertain;
the adapter does not replay the effect.

Reported fields expire after 15 seconds and expose no IP, device ID, component
ID, name, Digest challenge, password or raw RPC objects. `confirmed` means fresh
device-reported output matched the requested boolean. It does not prove that a
connected appliance operated, that electricity flowed, or that a task finished.
Metering fields are optional device reports, not calibrated measurements or
evidence of the attached load's safety. Constructors and subscriptions are inert;
polling is bounded and non-overlapping, and close aborts outstanding requests.

No generic RPC, scripts, configuration changes, toggles, schedules, counters,
webhooks, discovery, wake, certificate changes or firmware updates are exposed.

## Verification

Run `node --test test/shelly-gen2.test.mjs` for synthetic offline and loopback TLS
fixtures. These check encrypted configuration binding, Digest authentication,
target substitution, strict arguments, grant revocation, stale preflight,
uncertain writes, polling, cleanup and sanitized state. They contact no household
device and do not establish hardware support.

Official references: [authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/),
[HTTPS certificates](https://shelly-api-docs.shelly.cloud/gen2/General/CustomHTTPSCertificates/),
[RPC channels](https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/),
[switch API](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/),
[device identity](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly/).
