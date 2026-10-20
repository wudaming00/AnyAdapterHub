# Local API and Node client

This reference describes the implemented API in [`server.mjs`](../lib/hub/server.mjs),
[`runtime.mjs`](../lib/hub/runtime.mjs) and [`client.mjs`](../lib/hub/client.mjs).
It is a local HTTPS service, independent of MCP. See [setup](GETTING_STARTED.md)
and [security setup](SECURE_SETUP.md) before provisioning a client.

## Connection and authentication

The production server binds `127.0.0.1`; the default origin is
`https://127.0.0.1:8765`. TLS 1.2 or newer is required. Each credential contains the
public certificate and its lowercase 64-character SHA-256 DER fingerprint.
The Node client verifies the certificate, loopback IP identity and exact pin
before sending an HTTP authorization header. Do not replace that verification
with an insecure TLS flag.

Every API route except `GET /health` requires `Authorization: Bearer <token>`.
Tokens never belong in URLs, command arguments, application logs or source files.
Production credential files hold an OS-encrypted token; use `resolveCredential`
locally to obtain the in-memory `HubClient` input. The owner credential can issue
and revoke grants and stop the service. A client grant names exact devices and
capabilities; it does not inherit owner rights.

The server also checks the HTTP `Host` header and, when present, `Origin`. These
must describe the local service. Upgrade requests and foreign origins are
rejected. Browser `EventSource` cannot supply the required bearer header by
itself; use the SDK or a client that supports authenticated SSE.

JSON request bodies must be objects, at most 64 KiB, with content type
`application/json` (optionally `charset=utf-8`). Compressed bodies and unknown
request fields are rejected. Route identifiers use the local opaque device,
operation, frame or grant ID, not a vendor account ID or an IP address.

## Routes

| Method and path | Required authority | Successful response |
| --- | --- | --- |
| `GET /health` | None; host/origin checks still apply | `200` with `{ "status": "ok", "apiVersion": 1 }`, or `503` with status `starting-or-stopping` |
| `GET /v1/devices` | `state.read` for each returned device | `200`, `{ "devices": [...] }`; inaccessible devices are omitted |
| `GET /v1/devices/{id}/state` | `state.read` on that device | `200`, cached state snapshot |
| `GET /v1/devices/{id}/capabilities` | `state.read` on that device | `200`, `{ "deviceId", "actions", "read" }` |
| `POST /v1/devices/{id}/actions` | The exact action capability | `202` for a new operation; `200` for an existing idempotent submission |
| `GET /v1/operations/{id}` | Submitting client or owner, plus the operation's device/action authority | `200`, public operation record |
| `GET /v1/frames/{id}` | `screen.read` on the frame's device | `200`, raw `image/jpeg` bytes |
| `GET /v1/events` | `events.read` for at least one device | `200`, authenticated SSE stream |
| `POST /v1/grants` | Owner | `201`, `{ "grant": {...}, "token": ... }` |
| `GET /v1/grants` | Owner | `200`, `{ "grants": [...] }` |
| `POST /v1/grants/{id}/revoke` | Owner; body `{}` | `200`, revoked grant metadata |
| `POST /v1/shutdown` | Owner; body `{}`; shutdown callback enabled | `202`, `{ "accepted": true }` |

An empty core returns `{ "devices": [] }` to an authenticated owner. API health
means the service is ready; it does not mean a device is online. The state route
reads the cached snapshot and does not force a device query.

Capabilities contain JSON Schema descriptions under `actions[actionId]` with
`description` and `inputSchema`, and an array of read capability IDs under `read`.
They are the intersection of the adapter's enabled features and the caller's
grant. A profile or grant cannot add an action to an adapter that lacks it.

### Registered action arguments

This is the global reviewed registry, not a promise that every enrolled device
supports every entry. Fetch the target's capabilities for the exact JSON Schema
and the caller's current subset. Every argument object rejects unknown keys.

| Action | Arguments |
| --- | --- |
| `audio.volume.set` | `volume`: integer 0–100 |
| `audio.mute.set` | `muted`: boolean |
| `app.list` | `{}` |
| `app.launch` | `id`: ordinary app ID |
| `app.content.launch` | `id`: app ID; `content`: provider ID or approved HTTP(S) URL |
| `navigation.key` | `key`: exact remote-key enum from the advertised schema |
| `pointer.move` | `dx`, `dy`: integers −10000–10000 |
| `pointer.click` | `{}` |
| `pointer.scroll` | `dx`, `dy`: integers −1000–1000 |
| `media.control` | `action`: `play`, `pause`, `stop`, `rewind`, `fastForward` |
| `input.select`, `audio.output.set` | `id`: reported input/output ID |
| `display.set` | `on`: boolean |
| `power.off`, `power.wake` | `{}`; wake uses owner configuration |
| `text.insert` | `text`: 1–4096 characters; optional `replace`: boolean, default false |
| `url.open` | `url`: approved HTTP(S) URL |
| `media.url.play`, `dlna.play` | `url`, `mimeType`; optional `title` up to 512 characters |
| `dlna.control` | `action`: `play`, `pause`, `stop` |
| `dlna.status` | `{}` |
| `media.file.cast` | `filePath`: approved absolute local media file; optional matching `mimeType`, `title` |
| `screen.observe` | Optional `screenshot`: boolean, default true; optional `timeoutMs`: integer 5000–25000, default 25000 |
| `vacuum.start`, `vacuum.pause`, `vacuum.resume`, `vacuum.stop`, `vacuum.dock`, `vacuum.details.read` | `{}` |

App/input/output/provider IDs use the reviewed opaque ID format, up to 128
characters. URLs are at most 4096 characters and require the owner's exact origin
allowlist. File casting requires configured media roots, supported extensions,
matching MIME and a real-path check by the media host. Navigation enums and these
IDs never become arbitrary SSAP endpoints or vendor command names.

## Action submissions and operation records

The action body has these fields:

| Field | Contract |
| --- | --- |
| `action` | Exact action ID advertised for the device |
| `args` | Action-specific object; defaults to `{}`; additional properties are forbidden |
| `idempotencyKey` | Required for raw HTTP: 1–128 characters from `A–Z`, `a–z`, digits, `.`, `_`, `:`, `-` |
| `timeoutMs` | Optional integer, 100–120000; default 30000 |

The response is `{ "operation": {...}, "created": true|false }`. A `202` means
the hub recorded the request, not that the device performed it. Poll the operation
route or observe device evidence before reporting an outcome.

Public operation records contain `id`, `clientId`, `deviceId`, `action`, `state`,
`deadlineAt`, `createdAt`, `updatedAt`, `startedAt`, `finishedAt`, `result` and
`error`. The last four execution fields may initially be `null`. Submitted
arguments, the idempotency key and the internal request hash are omitted from
public responses. Results are adapter-specific and privacy-filtered.

| Operation state | Meaning |
| --- | --- |
| `queued` | Persisted, waiting for its device queue |
| `running` | Execution began; this alone does not prove device dispatch or success |
| `confirmed` | Adapter evidence satisfied that action's stated verification scope |
| `unconfirmed` | No sufficient confirmation; acceptance alone is not proof |
| `failed` | A rejection or failure was recorded |
| `expired` | Deadline elapsed before dispatch |
| `cancelled` | Stopped before dispatch, for example by revocation, expiry or hub shutdown |
| `unknown` | Dispatch may have occurred but its effect cannot safely be determined |

The terminal states are all states other than `queued` and `running`. A failed
operation is still returned by `GET /v1/operations/{id}` with HTTP `200`; inspect
its `state`, `result` and `error` rather than treating HTTP success as device
success. `confirmed` describes the verification scope, not a general task
completion promise. For example, a vacuum returning toward its dock can confirm
a dock command while `taskComplete` remains false.

Operations serialize per device, including the adapter's polls/observations.
The hub rechecks current permission and deadline immediately before dispatch.
`timeoutMs` sets a dispatch deadline; it is not a guarantee that an already
dispatched physical action has been cancelled at that time.

### Idempotency and restart behavior

Keys are scoped to the authenticated client identity. Reusing the same key for
the same validated device/action/arguments/timeout returns the existing operation
without another device effect. Changing any of those values under the same key
returns `409 IDEMPOTENCY_CONFLICT`. Object key ordering does not create a different
request; validation applies defaults before the request is hashed.

Operation/idempotency records have no automatic age-based TTL in the current
store. They survive restarts and are not removed with the event journal. Keep a
stable key when reconciling a lost submission response. A new key represents a
new request and can repeat an effect. The SDK never automatically resubmits a
device action.

On restart, persisted `queued` operations become `cancelled`; persisted `running`
operations become `unknown`, with `HUB_RESTARTED` evidence. Neither is replayed.
There is currently no HTTP operation cancellation, retry, listing or deletion
endpoint.

## State, evidence freshness and images

Snapshots identify the `deviceId` and include `assembledAt`, `connection.phase`
and a `fields` object. Adapters may also include a revision. Before a first
snapshot, the state response has `assembledAt: null`, phase `unknown` and empty
fields. Each populated field carries `value`, `observedAt`, `expiresAt`, `source`
and `verification`. State responses add a computed `stale` flag for each field.

Check each field's expiry, not just the snapshot timestamp or connection phase.
Missing, expired or unknown evidence is not a successful read of the current
device state. Current adapter TTLs are:

| Evidence | TTL |
| --- | --- |
| Ordinary LG fields | 15 seconds |
| LG input inventory | 60 seconds |
| LG temporary-observer player state | 5 seconds |
| ECOVACS projected vacuum state | 90 seconds |

Capturing a screen requires `screen.observe`; reading the resulting image
requires the separate `screen.read` permission. Capture also requires the owner
to enable the LG `observer` feature, set local `allowTemporaryObserver: true`,
and use the exact compatible profile. An observation operation's `result.frame` is metadata containing `id`,
`deviceId`, `operationId`, `mimeType`, `byteLength`, `createdAt`, `expiresAt`.
Use its ID with the frame route; image bytes do not appear in JSON or SSE.

Frames expire after five minutes and may be evicted earlier: at most five per
device, 10 MiB each, 32 MiB total. Expired or evicted frames return `404`.
`screen.read` can read an existing frame for its device when its ID is known;
it does not grant capture permission. Frame storage has no forensic-erasure
guarantee; see [security limitations](../SECURITY.md).

## Grants

`POST /v1/grants` accepts exactly `label`, `deviceIds`, `capabilities` and
`expiresAt`:

| Field | Rules |
| --- | --- |
| `label` | Nonempty printable label, at most 128 characters |
| `deviceIds` | 1–64 unique enrolled local IDs |
| `capabilities` | Nonempty unique list of exact registered read/action IDs; no wildcards |
| `expiresAt` | Future ISO timestamp with an explicit timezone; normalized to UTC |

Read IDs are `state.read`, `events.read`, `screen.read`. `app.list` and
`vacuum.details.read` are action capabilities even though they only read data.
Grant creation checks that each requested action belongs to at least one named
device; dispatch independently checks support on the actual target device.

Grant metadata contains `id`, `label`, `deviceIds`, `capabilities`, `expiresAt`,
`createdAt`, `revokedAt`. The issued token is returned only by the creation
response. Listing/revocation returns neither tokens nor token hashes. Save the
issued token through the encrypted provisioning workflow; losing it requires a
new grant, not a token-recovery request. The CLI restricts grant duration to 30
days; the raw API currently requires a future timestamp without that CLI cap.

Revocation and expiry apply to new requests and pre-dispatch checks. They do not
undo an action already sent to a device. A non-owner cannot inspect another
client's operation result, even when both clients can control that device.

## Server-sent events

Use `GET /v1/events?after=N` or the `Last-Event-ID` header. A supplied header takes
precedence over the query cursor. Cursors are nonnegative safe integers expressed
as 1–15 decimal digits. Unknown or duplicate query parameters are rejected.

The stream returns `200`, not an informational `1xx` status. Headers are flushed
immediately even if no event exists yet. Each record has this framing:

```text
id: <global-event-number>
event: <event-type>
data: <one JSON event object>

```

JSON events contain `id`, `type`, `deviceId`, `operationId`, `data`, `at`.
Current device-scoped types are `device.state`, `operation.created`,
`operation.updated` and `operation.recovered`. Operation events carry state
transitions rather than submitted arguments/results. The endpoint filters events
by authorized device; grant audit records without a device ID are not delivered
through this stream.

The hub checks access throughout delivery, including during backpressure. A
revoked/expired stream closes; after headers have been sent it does not turn into
a JSON error response. The server checks for events every 500 ms and sends
`: heartbeat` comments about every 15 seconds when needed. Backpressure that does
not drain within three seconds closes the stream.

Only the newest 10000 events are retained globally. Older cursors can have gaps
without an explicit reset response; gaps can also arise naturally from device
filtering. Re-read state and check its freshness after reconnecting. The SDK does
not automatically reconnect or replay commands. Event snapshots retain their
original expiry metadata; compute freshness at consumption time rather than
expecting a continually updated `stale` flag in journal data.

## Node SDK

This inert helper accepts a local encrypted credential path supplied by the
owner. It does not print or return the decrypted token:

```js
import { readJson } from './lib/hub/config.mjs';
import { resolveCredential } from './lib/security/credentials.mjs';
import { HubClient } from './lib/hub/client.mjs';

export async function connectClient(credentialFile) {
  return new HubClient(await resolveCredential(await readJson(credentialFile)));
}
```

The imports above are repository-root-relative module specifiers for an example
placed at the repository root. Main methods are:

| Method | Returns / behavior |
| --- | --- |
| `devices()`, `state(deviceId)`, `capabilities(deviceId)` | Corresponding JSON response |
| `submit(deviceId, action, args, { idempotencyKey, timeoutMs })` | Submission response; SDK supplies a random UUID key when omitted |
| `operation(id)` | Public operation record |
| `execute(deviceId, action, args, options)` | Submits once, polls every 150 ms; returns the latest record after `waitMs` (default 40000) or a terminal state |
| `frame(id)` | Image `Buffer` |
| `issueGrant(body)`, `grants()`, `revokeGrant(id)` | Owner provisioning endpoints |
| `shutdown()` | Owner shutdown request |
| `events({ afterId, signal })` | Async iterator of JSON SSE events; `afterId` defaults to zero |

`execute` accepts `idempotencyKey`, `timeoutMs` and `waitMs`; exhausting its local
wait can return a still-queued/running operation. Keep its ID and poll instead of
issuing another action. Ordinary SDK HTTP requests have a ten-second deadline.
SSE has a ten-second response-header deadline and stays open until closed,
aborted or disconnected. Pass an `AbortSignal` to control stream lifetime.

## Errors and limits

HTTP errors use `{ "error": { "code": "...", "message": "..." } }`. Messages
are deliberately generic and do not reflect vendor responses, URLs or secrets.

| HTTP status | Typical codes |
| --- | --- |
| `400` | `INVALID_ARGUMENTS`, `INVALID_GRANT`, `UNKNOWN_ACTION`, other validation/store/device codes not separately mapped |
| `401` | `UNAUTHORIZED` |
| `403` | `ACCESS_DENIED`, `GRANT_REVOKED`, `GRANT_EXPIRED`, `LOCAL_POLICY_DENIED` |
| `404` | `NOT_FOUND` |
| `409` | `IDEMPOTENCY_CONFLICT` |
| `429` | `BUSY` |
| `503` | `HUB_STARTING`, `HUB_CLOSING`; health uses its own status body |

An unknown route is checked after authentication. Unknown operation IDs and
another client's operation IDs both return `404`. TLS failures occur before an
HTTP response; the SDK reports a generic TLS connection error instead of a JSON
API code. SSE denial exposes `status` on the SDK error; ordinary API errors also
carry `code` and `status`.

Current resource bounds are 64 connections, 32 active request handlers, eight
SSE streams and 16 pending hub operations per device. HTTP headers are capped at
8 KiB; TLS/header deadlines are five seconds and request timeout is ten seconds.
The SDK caps collected response bodies at 34 MiB and pending SSE text at 1 MiB.
These bounds do not replace device permissions, OS protection or review of an
adapter's own limits.
