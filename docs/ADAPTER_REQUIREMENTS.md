# Adapter requirements

An adapter turns one reviewed device protocol into bounded actions and observable
state. A model profile is descriptive data; protocol behavior is trusted code.
Neither proves ownership, compatibility or client authorization by itself.
These requirements guide review, not a claim of independent certification.

Read the [architecture](ARCHITECTURE.md),
[contribution walkthrough](CONTRIBUTOR_GUIDE.md) and
[security methodology](SECURITY_REVIEW.md) alongside this contract. Runtime
behavior is defined by [runtime.mjs](../lib/hub/runtime.mjs),
[policy.mjs](../lib/hub/policy.mjs) and the reviewed implementations.

## Runtime contract

There is no general plugin loader. Some fixed adapters share a trusted internal
lifecycle helper; this does not create a contributor-defined extension mechanism.
The fixed registry
constructs the adapter for an owner-enrolled opaque device ID and private
configuration. Constructors must not discover, pair, connect or dispatch work.
Production callers use `createAdapter({adapterName,id,config,features})` from
[the registry](../lib/hub/adapters.mjs); profiles cannot provide import paths.

| Member | Runtime use and required behavior |
| --- | --- |
| `supportedActions: readonly string[]` | Explicit, unique IDs from `ACTIONS`, restricted to this adapter and its enabled features. `[]` describes an adapter with no action capabilities, such as a read-only sensor. Contributors must supply the list; do not rely on the runtime's legacy all-actions fallback. |
| `subscribe(onEvent) => cancel` | Register a local state listener synchronously and return an unsubscribe function. Do not start an upstream connection as a side effect of listener registration. |
| `start({pollMs}) => Promise<unknown>` | Begin bounded, non-overlapping state refresh. The runtime supplies its requested interval; respect stricter vendor limits. Publish projected state and retain expiry on failure. |
| `execute({action,args}, context) => Promise<result>` | Execute one fixed non-observation action through the shared device queue, with strict arguments, dispatch authorization, readback and conservative results. |
| `observe(args, context) => Promise<observation>` | Required **only** when advertising `screen.observe`; use the observation contract below. |
| `close() => Promise<void>` | Stop polls, reject new work, await active work/cleanup, unsubscribe and release owned resources. |

`adapterId` is useful descriptive metadata. `identity()` (LG) and `snapshot()`
(where implemented) are implementation utilities; the Hub does not call them
as required generic methods. ECOVACS publishes state through `start()` and `subscribe()` and
does not implement `observe()`. `readonlyActions` metadata does not replace an
exact Hub grant; an action such as `app.list` still needs its own capability.

### State events

Publish `{type:'device.state', deviceId, data:snapshot}` only for the enrolled
device. The current snapshot shape is:

```js
{
  deviceId: 'fixture-device',
  revision: 1,
  assembledAt: '2026-10-19T12:00:00.000Z',
  connection: { phase: 'online' },
  fields: {
    volume: {
      value: 15,
      observedAt: '2026-10-19T12:00:00.000Z',
      expiresAt: '2026-10-19T12:00:15.000Z',
      source: 'ssap',
      verification: 'device-reported'
    }
  }
}
```

This is a synthetic data example, not current household state. Project fixed
allowlisted fields and bounded values. Never include host/MAC addresses, pairing
keys, cloud IDs, URLs, filesystem paths, tokens, raw vendor objects or image
bytes. The runtime adds `stale` when clients read a snapshot. Online transport,
event delivery and field freshness are different claims. Do not reuse expired
data to confirm a new mutation.

### Dispatch context and results

The current context is `{deadlineAt, assertDispatch}`. The latter rechecks the
client's grant, revocation and deadline and conservatively records that dispatch
may begin. Call it **inside the device queue**, after awaited connection,
identity/cloud preflight or preparation, immediately before device work can be
sent. Repeat it before subsequent writes in a multi-step operation. It throws
on denial: do not catch the error and continue dispatching. Some existing
implementations also accept a cancellation signal locally; the Hub currently
passes only the two fields above.

`assertDispatch` must complete synchronously and return `undefined` on success.
Promises, thenables and other return values are not approval. Reject them before
marking/sending an effect, without evaluating a returned `.then` getter. Observe
a returned native promise's rejection to avoid an unhandled background error.

Return a sanitized object with `requestAccepted` (boolean or null), `confirmed`
and a precise `verificationScope` where relevant. Use `uncertain:true` for a
possibly sent effect whose result cannot be determined. The runtime maps it to
`unknown`; an ACK alone remains `unconfirmed`. A negative request/error can be
`failed`. An exception after dispatch may also produce `unknown`.

Prefer explicit setters. Verify an effect through fresh readback within a
bounded deadline. Foreground app ID is not an app-internal page; player state is
not a movie title; a vacuum reporting an active task is not proof of task
completion. Never automatically replay a mutation after timeout, disconnect,
partial failure or restart. Fresh reads may reconcile the outcome. Document
protocol/SDK retry behavior as well as JavaScript retries.

### Optional observation

Return `{image?:Buffer, mimeType?:'image/jpeg', metadata}`. The runtime stores
bytes separately; do not inline them into state, events or JSON result metadata.
For the current temporary observer, confirmation requires
`communicationVerified`, `completed`, `overlayClosed` and `restored` all true.
If a screenshot was requested, a real image plus `screenshotVerified` and
`cleanupVerified` are also required. Preserve false/missing flags; do not replace
them with success because a call returned an ACK.

This confirmation contract currently describes the reviewed B8 transaction.
Adding a different capture mechanism may require a separate reviewed runtime
contract rather than pretending that it used or closed an overlay. Check exact
identity/firmware before model-specific behavior, require local feature and
opt-in gates, and bound callbacks, duration, bytes and destinations. Cleanup
must target only owned resources; verify absence where supported. An already
started transaction still owns cleanup/restoration after grant expiry. Report
incomplete cleanup and do not let its late restoration race another command.

## Ownership, targets and credentials

Owner setup must deliberately select one device through authorized pairing,
commissioning or account consent. Discovery and LAN reachability are not
authorization. Reconnect must not choose the first discovered/account device.
Bind region, expected identity and relevant trust material; expose only an
opaque Hub ID. A routing IP or source-IP check alone does not authenticate a
physical device.

Keep upstream credentials server-side. Use the encrypted credential interface;
no JSON/env switch may enable a plaintext fallback. Production currently
supports Windows CurrentUser DPAPI only. Tests may explicitly inject a portable
test provider through private code interfaces. Use authenticated transport and
certificate verification before sending credentials, with disclosed first-trust
and vendor-identity limitations. See [secure setup](SECURE_SETUP.md).

## Capability and feature boundaries

Installation, enablement, enrollment, feature selection and client grants must
remain separate. Register exact actions and strict bounded schemas in Hub
policy, and advertise only the implemented local feature subset. Separate
state, app inventory, capture and saved-image read access. Upstream credentials
may be broader than a scoped client; the adapter must enforce the narrow scope.

Do not expose generic shell, HTTP/RPC/MQTT/Luna/ADB passthrough, arbitrary launch
parameters, arbitrary services or executable community scripts. In LG, ordinary
app launch must not reach the privileged observer overlay. Future Home Assistant
expansions or ADB integrations need fixed entity/action/command allowlists;
mentioning them in a profile cannot implement or authorize them. The experimental
`home-assistant` path covers one enrolled HTTPS light. The separate
`home-assistant-sensor` path reads one selected entity with a fixed measurement
contract. Neither exposes arbitrary HA services, switches, sensor contracts,
scripts or templates.

The experimental `home-assistant` adapter advertises no actions by default.
Its `control` feature adds `light.power.set` with `{on:boolean}`; `dimming`
requires `control` and adds `light.brightness.set` with an integer 0–100. Each
action still needs its own device-scoped grant. Read back the same entity and
report the `home_assistant_reported_selected_entity_state` verification scope;
`physicalEffectVerified` stays false. Certificate validation/pinning and the
post-preparation dispatch check must precede HTTP credential/action bytes.

The experimental `mqtt-tls` adapter has `supportedActions:[]` and no publish
method exposed through the Hub. It binds one literal private/local broker,
port, certificate pin, exact topic and fixed numeric measurement. MQTT 5 receipt
TTL is broker evidence rather than sensor sampling time; reject retained,
foreign-topic, malformed and out-of-range payloads without freshening evidence.
Supporting MQTT transport does not establish direct hardware support for
Tasmota, Zigbee2MQTT or another publisher. Their message contracts and device
evidence require separate work. See [the enrollment and limits](POPULAR_ADAPTERS.md).

For media, validate approved real paths and serve the same checked open handle.
Bound listeners to the selected target and lifetime. Network fetch/callback code
must constrain destinations, redirects, DNS behavior, payload sizes and timeouts.
Device strings, screens and evidence are untrusted data, including possible
prompt-injection text; they cannot authorize actions.

Reviewed adapters share the process's privileges. Lazy loading is not a sandbox,
and a subprocess is not automatically an OS-enforced isolation boundary. New
device classes such as locks, cameras, heat or other consequential loads need a
separate capability/privacy review; a generic light/switch grant must not expand
to them silently.

## Profiles, evidence and review

Profiles must pass both the [schema](../schema/device-profile.schema.json) and
[runtime validator](../lib/device-profile.mjs). They accept exact identity and
firmware, known capability IDs and repository evidence references only. They
cannot register code, dependencies, operational paths, credentials, destinations
or permissions. The current schema is LG-only; expanding it is reviewed code
work. `temporary-observe` must retain `optInRequired:true`, which records a
requirement rather than satisfying it. The current observer explicitly selects
the reviewed B8 profile in code; adding another JSON file cannot enable that
privileged path for another model.

For each verified or unsupported capability, provide exact configuration, date,
safe procedure, request acceptance, readback/effect, restoration and limitations.
Unknown firmware stays unknown. Label fixture results and do not present them
as hardware tests. Sanitized written evidence can be mistaken or fabricated:
independent reviewer agents must assess reproducibility and leave uncertain
claims unverified under the [agent review policy](AGENT_REVIEW.md).
Never ask a contributor to disclose credentials, maps or personal images to
strengthen evidence.

Offline tests must cover unknown/extra arguments, denied/expired/revoked grants,
cross-device substitution, queue delays, stale readback, reconnect, ambiguous
effects, bounded hostile payloads, secret/path/URL leakage and cleanup failure.
Optional dependencies need fixed versions, provenance, license notices and
explicit installation; core startup must still work with them absent. See the
[source-change checklist](CONTRIBUTOR_GUIDE.md#new-adapter-change-map) for files
and check commands. No approved profile or successful test automatically enables
a device in an owner's home.
