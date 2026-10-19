# Adapter requirements

An AdaptAny adapter turns a known device protocol into bounded capabilities with observable results. Adding a model profile is a data contribution; adding protocol behavior is a code contribution. Neither establishes ownership, grants permissions or proves hardware support by itself.

These are contribution and review requirements, not a claim that the project has passed an independent security audit. See [SECURITY.md](../SECURITY.md) for the current deployment limits.

## Profiles are data, not executable extensions

Community profiles must pass the [profile schema](../schema/device-profile.schema.json) and [runtime validator](../lib/device-profile.mjs). They may contain exact identity/firmware values, registered adapter/capability IDs and reviewed evidence references.

They must not contain scripts, commands, templates that execute code, dependencies, network destinations, arbitrary protocol endpoints, operational filesystem paths or credentials. Evidence references are repository-relative document IDs, not paths to a contributor's private files. Unknown fields, duplicate keys, prototype-related keys and oversized/deep data must be rejected. Firmware wildcards and ranges are not evidence of compatibility.

A profile cannot register a new adapter, add capabilities, loosen a parameter schema or enable privileged behavior. `optInRequired: true` for temporary observation is mandatory; it records a requirement and does not satisfy it. New adapter IDs and capability definitions require a separate reviewed code change.

## Evidence and support claims

For every claimed capability, record the exact model, firmware, region/protocol where relevant, date, test setup, request, observed result and limitations. Use `verified`, `unverified` or `unsupported` at the capability level. Keep transport acceptance, device-reported state and externally observed effect distinct.

An app launch ACK does not prove the app opened. A vacuum accepting a command does not prove it cleaned a room. An old cached value cannot confirm a new change. A player reporting `playing` does not identify a movie. State exactly which observation supports the claim.

Use controlled content and redact IP/MAC addresses, serials, credentials, callback tokens, account details, household maps and personal screenshots. Synthetic fixtures must be labeled synthetic; offline tests cannot be presented as hardware tests. A contributor-written evidence file can be mistaken or fabricated: schema validation does not authenticate it. Reviewers must inspect the test method, consistency and limitations, request reproducible sanitized evidence where necessary and leave uncertain claims unverified. Do not ask contributors to publish secrets to strengthen a claim.

## Ownership and target binding

Setup must be performed by the device owner or an authorized operator. Discovery or LAN reachability is not authorization. Use the vendor's physical confirmation, pairing, commissioning or account-consent flow where available, and document what it grants.

Bind local configuration to one deliberately selected device, its expected identity and relevant trust material. Account integrations must also bind region and selected device; a reconnect must not silently select the first discovered device or another account's device. Keep sensitive identifiers in private local configuration and expose an opaque Hub device ID to clients.

Check identity before model-specific privileged behavior. On mismatch, replacement, changed trust material or unsupported firmware, fail closed for that behavior and require owner review. An IP address is a routing hint, not proof of identity. Use authenticated transport and certificate verification when supported; disclose weaker protocols rather than claiming a pairing key or source-IP check prevents every LAN impersonation attack.

## Reviewed code and capability boundaries

The independent Hub adapter interface is `identity()`, `snapshot()`, `execute()`, `observe()`, `subscribe()`, `start()` and `close()`. It must not depend on a particular agent or MCP client. See [architecture](ARCHITECTURE.md) and the [LG implementation](../lib/adapters/lg-webos.mjs).

Review the following boundaries explicitly:

- **Fixed actions:** register narrowly defined action IDs and strict bounded argument schemas. No generic shell, raw HTTP/RPC/MQTT/Luna/ADB passthrough, arbitrary app launch parameters or dynamic endpoint selection by a community profile.
- **Separate authority:** device ID, action, client grant, expiry and revocation remain Hub policy decisions. Call the supplied dispatch authorization check from inside the shared device queue immediately before work can affect the device. Public app launch must not become a path into a privileged system application.
- **Read scope:** app inventory, ordinary state, observation and saved-image access can disclose different information. Request separate capabilities; a read-only grant must not imply app inventory, capture, frame access or control.
- **Protocol credentials:** keep credentials server-side, out of arguments, state, events, job results and logs. Document the scope of upstream credentials; an integration must enforce the client's narrower scope even when an upstream token controls many devices.
- **Explicit exceptional access:** isolate temporary privileged bridges, debugging and firmware-dependent behavior behind local opt-in. Limit their calls, destinations, duration and data size. Do not trigger an exploit because a model happens to match or download contributor-supplied scripts.

For Home Assistant, allowlist exact entities and reviewed actions rather than forwarding arbitrary services or templates. For ADB, construct fixed commands without shell interpolation. For smart plugs, default tests must use an identified noncritical load; a generic switch grant must not silently become authority over a heater, lock or other consequential device.

## Results, freshness and failure handling

All polls, controls and observation for a device share one bounded queue. Honor request deadlines and revocation after queuing. Stop background work and await active cleanup on close; cap polling, reconnect attempts, callback payloads and retained resources.

Snapshots must carry per-field observation time, expiry, source and verification scope. Distinguish transport connection, device state and stale cached state. Event delivery does not establish live device telemetry. Reconnects must obtain fresh state rather than reusing expired values as confirmation.

Use explicit setters where possible. Confirm effects through independent readback or observation within a defined deadline; report unconfirmed or unknown when the evidence is insufficient. Do not automatically retry a mutation after an ambiguous disconnect, timeout or partial multi-step failure. Reconcile with a fresh read instead. Hub idempotency prevents duplicate dispatch by a client key; it does not make an upstream device transactional, undo an action or justify replay after restart.

Images go to the separately authorized bounded frame store, not ordinary state/events. Treat screens, media metadata, device strings and evidence as untrusted data, including prompt-injection text. They cannot authorize new actions. Local media access must enforce approved real paths and serve the same validated open file handle; URL and callback access need fixed approved destinations and redirect/DNS threat analysis. These are security boundaries, not extension points for arbitrary file or network access.

Temporary resources require precise ownership, bounded lifetime and observable cleanup. Delete only this operation's resources, verify removal where the protocol permits it, close temporary overlays/listeners and report restoration or cleanup failure. A deletion ACK is not proof of absence.

## Review and validation before merging

Provide meaningful offline tests for denied/expired/revoked grants, cross-device substitution, strict argument rejection, stale or misleading readback, reconnect failure, ambiguous mutation results and cleanup failure. Test secret/URL/path leakage and bounded hostile payloads. Media or callback code additionally needs path substitution, destination checks, size limits and timeout cases.

Run `npm test` and the repository's profile/evidence checks. Add separately labeled hardware evidence for each capability promoted to verified, including readback and restoration for reversible test changes. A successful fixture suite or approved profile never auto-enables a device in a user's home.

Maintainers must review code, dependencies, target binding, evidence and capability policy before accepting a new adapter. New higher-impact device classes need their own review; existing light/switch permissions must not silently expand to them. Update [SUPPORTED_DEVICES.md](SUPPORTED_DEVICES.md) with exact support and known gaps. Report vulnerabilities privately through the process in [SECURITY.md](../SECURITY.md).
