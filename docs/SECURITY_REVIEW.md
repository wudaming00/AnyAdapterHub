# Security review and release checks

Review date: **2026-10-19**. Scope: the AnyAdapter Hub local HTTPS service, encrypted credentials, optional LG webOS adapter/temporary observer, persistence and API policy, plus the optional ECOVACS integration boundary. The historical CodeQL findings below identify the scanned revisions separately. This is an implementation self-review with offline regressions. It is not an independent penetration test, vendor endorsement, formal proof or guarantee against unauthorized household control. See [SECURITY.md](../SECURITY.md) for the public policy and private reporting process.

Code controls and deployment assumptions are separated below. Exact hardware evidence belongs in [Supported devices](SUPPORTED_DEVICES.md); a passing fixture does not establish hardware compatibility.

## Assets and trust boundaries

Protected assets include device operation, household presence/state, screens/account content, local media, pairing/cloud credentials, owner authority, operation history and the ability to stop or revoke a client.

Consider a remote attacker who places malicious content in front of an agent; a webpage contacting localhost; a scoped client submitting hostile JSON or queuing work; a contributor supplying misleading profiles; a hostile device/LAN peer supplying protocol strings; accidental cross-household/account selection; and stale or ambiguous state.

The owner, reviewed Hub/adapter code, OS account and configured interpreter are trusted. Profiles are data. Screens and responses are data. An agent with only a scoped token has narrower authority than the owner. An agent with owner file access or local code execution does not have that isolation. Dependencies and administrators can bypass application policy. Device/cloud protocols have separate identity/confidentiality limits.

```text
Owner setup -> private config/credentials -> reviewed adapter -> selected device
                          |
Scoped agent -> loopback API -> grant + schema + queue -> pre-write check
                          |
               redacted state / operation evidence
                          |
              separately authorized expiring frames

Community profile -> strict data validation -> compatibility information only
Device screen/text -> untrusted observations -> never a source of authority
```

## Methodology: establish authority before interpreting intent

1. **Identify one household target.** The owner selects a device and opaque local ID. LG uses an existing approved pairing and fixed local host; wake uses a configured MAC. Observation additionally checks the exact reviewed model/firmware. ECOVACS checks its selected-device fingerprint, cloud device ID, supported class and US region. Discovery, brand matching or status access is not authorization. Reconnect must not silently substitute another device.
2. **Constrain the client.** Keep owner credentials out of the agent. Grant exact device/action pairs with explicit expiry. Separate state, app inventory, capture and frame reading. No prompt, profile or device response can enlarge the fixed capability registry or satisfy a local privileged opt-in.
3. **Validate intent as data.** Reject unknown fields/actions, prototype-related keys, malformed identifiers, out-of-range values, arbitrary endpoints/launch parameters and unapproved file/URL destinations. Do not provide generic shell, Luna, HTTP or vendor-service passthrough.
4. **Serialize and recheck at the effect boundary.** The device queue includes polling, control and observation; a late restore must not overwrite the next action. Recheck grant, revocation and deadline after asynchronous preparation and immediately before writes, including each mutation in multi-step playback. Queue admission is not permanent authority.
5. **Observe and preserve uncertainty.** Record fresh readback, source, expiry and verification scope. Acceptance, a pointer frame or a connection does not prove a visible/physical result. Do not repeat ambiguous writes. Restart cancels queued work and marks interrupted running work `unknown`; it never replays it.
6. **Finish restricted cleanup.** A started observation owns closing its overlay/listener and restoring the previous app. These cleanup actions continue after initiating-grant expiry. Delete only owned per-run resources and verify absence where supported. Report incomplete cleanup/restoration.

Authorization is capability-based, not a semantic proof of intent. Broad navigation can reach purchases or settings. A vacuum can encounter objects, people or pets. There is no app-independent purchase guard, physical obstacle guarantee or replacement for device safety mechanisms. Use narrow grants and appropriate human supervision.

## Implemented controls and limits

| Threat | Code control | Residual boundary |
| --- | --- | --- |
| Remote network client | Fixed loopback listener, Bearer authentication, no public-bind option | A proxy/tunnel or compromised host defeats deployment assumptions; remote access is unsupported. |
| Malicious webpage or DNS rebinding | Exact Host/Origin checks, JSON content type, no permissive CORS, query-token rejection | Origin is not authentication. Same-user local code may steal credentials. |
| Cross-device/capability escalation | Exact grants, owner-only management, per-adapter action registry, fixed schemas | UI actions remain broad. Upstream pairing/cloud credentials may cover more than the scoped grant. |
| Late revoked/expired work | Queue and pre-write checks; cloud preflight dispatch handshake | Dispatched requests/acknowledgements cannot be recalled; an existing effect can continue. |
| Duplicate or ambiguous writes | Client/key uniqueness and request hash, conflict rejection, no replay/retry | Different keys are different commands. Upstream devices are not transactional; partial effects cannot be undone by idempotency. |
| Cross-client disclosure | Requester ownership for operation lookup, device-scoped reads, sanitized errors/state, separate frames | `screen.read` permits retained frames for its device. The screen itself can contain private content. |
| Malicious profile/evidence | Strict bounded parser/schema, exact identities, fixed capability references, no scripts/endpoints | Evidence can be fabricated or mistaken; executable adapters/dependencies are trusted code. |
| Callback substitution | Fixed bridge calls/routes, random per-run token, exact TV source, time/byte limits, owned cleanup | Optional HTTP callback/media legs remain unencrypted. Pinned LG WSS still has initial-trust and factory-shared-key limitations. |
| File exfiltration by casting | Explicit roots, realpath/type checks, same validated file handle, source/token route | OS/filesystem integrity is assumed; intentional exports are outside frame retention. |
| Prompt injection | Device-output projections; outputs cannot define grants, commands or destinations | The Hub cannot guarantee model reasoning; a client can misuse authority already granted to it. |
| Resource exhaustion | Bounded bodies/headers/concurrency, queues, callbacks, frames and journal | No sustained rate limit or lifetime operation database quota; authorized flooding can exhaust disk. |

## Finding fixed before initial publication

### LG checks preceded asynchronous controller preparation

The adapter checked the grant before invoking a controller method, but launch first awaited app metadata, text waited for focus, pointer input waited for a WebSocket handshake, DLNA discovered/connected or completed a prior playback step, and wake waited for UDP binding. Revocation/expiry during these intervals could otherwise precede a device write.

The fix scopes a trusted dispatch guard to one execution with `AsyncLocalStorage`. SSAP mutations and pointer sends repeat it at the write boundary. DLNA checks each SOAP mutation, including `Play` after `SetAVTransportURI`; wake checks after bind and before sending. Readback remains available for reconciliation. The guard is not a JSON argument or connection-wide mutable permission. Observation checks after preflight immediately before its fixed overlay launch; restoration remains outside that initiating guard.

[security-dispatch.test.mjs](../test/security-dispatch.test.mjs) covers revocation during app lookup, keyboard focus, pointer handshake and DLNA discovery; expiry during app lookup; revocation between DLNA writes; wake binding; guard lifetime; observer preflight denial and cleanup after partial launch; and an immutable LG-only action registry. Its 12 regressions passed during this review using synthetic protocols/callbacks and no television or vacuum.

Operation states remain conservative: a failure after dispatch checks can be `unknown`, even if a later check prevents a particular write. A partial multi-step effect is never described as rolled back.

## Privacy and operational assumptions

The Hub directory is new/empty at initialization or must have a valid existing Hub marker. Links/junctions and unexpected immediate children are rejected. POSIX ownership/modes and Windows current-user+SYSTEM DACLs are checked. Initialization rolls back only its newly created files. These controls do not isolate same-account code or administrators. External credential-file permissions need their own review.

Client tokens are random and persisted as hashes. Hub owner/client files, LG pairing keys and the Hub TLS private key now use Windows CurrentUser DPAPI with purpose binding, in addition to private ACLs. The optional ECOVACS worker retains its own DPAPI enrollment, fixed worker path and separately installed version-pinned SDK. A worker process is not a sandbox against same-user code. Cloud credential refresh is an expected private-file write; it does not authorize another selected device. SQLite state, events and images are not content-encrypted by this credential change; their privacy still relies on the private directory, retention and OS/storage protection.

Images are private content. Retained frames are separate from ordinary events, expire within five minutes and are bounded to five/device and 32 MiB total. Expiry immediately denies reads; logical pruning is periodic. `secure_delete` is not forensic erasure. WAL, backups, image exports and already delivered content need separate retention handling. Never publish household screenshots/maps, account/device identifiers, callback URLs, pairing keys or raw diagnostics.

The journal retains 10,000 events and can have cursor gaps. Operations/idempotency persist for database lifetime. Monitor disk growth; concurrency bounds do not prevent sustained database growth. Safe archival must retain enough deduplication history to prevent replay and is not implemented.

External URLs require exact configured origins. A hostname can change address and a TV can follow redirects; the Hub does not mediate every subsequent fetch. Literal-address rejection is not a general SSRF proof. Use trusted origins and network isolation where required. There has been no independent audit of a hostile LAN or vendor service.

## Validation map

| Area | Offline evidence |
| --- | --- |
| HTTP denial, hostile Host/Origin, scoped grants, cross-client operations, SSE revoke, idempotency | [hub-http.test.mjs](../test/hub-http.test.mjs), [hub-runtime.test.mjs](../test/hub-runtime.test.mjs) |
| Strict schemas, URL origins, media roots, secret projections | [hub-policy.test.mjs](../test/hub-policy.test.mjs), [media-host.test.mjs](../test/media-host.test.mjs) |
| Private initialization, ACLs/modes, links, partial writes | [hub-config.test.mjs](../test/hub-config.test.mjs); OS-specific cases only run on the applicable OS |
| Atomic operation/events, deduplication, recovery, journal/frame bounds | [hub-store.test.mjs](../test/hub-store.test.mjs) |
| Device queue, stale state, reconnect reconciliation, observation projection | [lg-adapter.test.mjs](../test/lg-adapter.test.mjs) |
| Asynchronous effect-boundary revocation/expiry and cleanup | [security-dispatch.test.mjs](../test/security-dispatch.test.mjs) |
| Callback identity, size, teardown and restoration | [tv-observer.test.mjs](../test/tv-observer.test.mjs), [bridge-observe.test.mjs](../test/bridge-observe.test.mjs) |
| Ordinary protocols, pointer/capture target binding, DLNA partial failure | [controller.test.mjs](../test/controller.test.mjs), [ssap.test.mjs](../test/ssap.test.mjs), [dlna.test.mjs](../test/dlna.test.mjs) |
| Profile data and privilege non-escalation | [device-profile.test.mjs](../test/device-profile.test.mjs), `npm run check:profiles` |

This map describes intended test coverage, not every possible attack. No cross-platform penetration test or formal isolation proof was performed. Hardware evidence can predate a code change and covers only its stated devices/capabilities; reread it before relying on it.

## Initial public CodeQL triage

The first public scan of revision `3e3179ca075eeff809efdbdaac331886e8893f36` reported 15 alerts. The following records the assigned transport/filesystem/data-flow findings, rather than claiming that the complete scan is clean. Static findings require path-specific review; an expected application data flow does not cancel a separate weakness on that path. No alert was automatically dismissed as part of this review.

### Certificate validation: historical findings and coordinated hardening

The current security revision replaces these four scattered bypass paths with required LG certificate pin validation before HTTP/SSAP/key transmission, pinned pointer/capture connections, and CA-or-explicit-pin public discovery. [security-tv-tls.test.mjs](../test/security-tv-tls.test.mjs) verifies real loopback TLS and no request/key delivery on mismatches. The centralized self-signed-TV connector deliberately performs its own mandatory pin check before releasing the socket; static analysis may still flag that custom trust boundary and needs manual review. See [secure setup](SECURE_SETUP.md) for TOFU, shared factory-key limitations and legacy observer/media channels. This records source changes and tests; it does not assert GitHub alerts have closed or that real hardware has passed the new transport.

The rescan of `a711484` closed the four original certificate alerts and reports **#16** at the centralized self-signed-TV connector. Its deliberate CA exception remains explicitly recorded rather than dismissed: exact pin checking must complete before the socket reaches HTTP/WebSocket code; the TLS-only first-observation probe is a separate trust step. The rescan also reports **#17**, the expected encrypted-configuration-to-selected-TV pairing-key flow, alongside the previously reviewed filesystem/I/O findings. A successful CodeQL workflow is not a zero-alert result or an independent audit.

Alerts **#4–#7** identify actual certificate-validation bypasses:

| Alert | Path | Exposure |
| --- | --- | --- |
| #4 | `inspect-public.mjs`, WSS preflight | Selected-TV inspection accepts an unverified certificate; returned identity/service metadata can be impersonated. No registration/pairing request is sent on this preflight path. |
| #5 | `discover.mjs`, HTTPS descriptor retrieval | Same-device literal-IP checks and refusal of redirects do not authenticate the descriptor server's certificate. |
| #6 | `lib/ssap.mjs`, secure SSAP connection | The session accepts an unverified TV certificate and can send pairing material and control requests. A LAN middleperson remains a real confidentiality/control risk. |
| #7 | `lib/tv-controller.mjs`, pointer WSS connection | Same literal TV host and fixed pointer framing constrain routing/commands but do not authenticate a WSS peer's certificate. |

Those were **real risks in the scanned revision**. A private IP, paired client key, `secure: true` or encrypted-but-unauthenticated connection is not verified device identity. Optional observer/media paths still use plaintext HTTP and unauthenticated DLNA. The development preview must not be represented as production-secure or safe against a hostile LAN.

That initial scan fix deferred coordinated TLS migration. The current revision supplies it together with DPAPI-protected credentials and pinned Hub HTTPS; it intentionally refuses legacy plaintext control rather than supplying a production downgrade flag. Existing devices may need explicit certificate enrollment before reconnecting. Pinning still cannot prove unique device identity when a vendor shares private keys.

### Filesystem races: narrow hardening and remaining assumptions

Alert **#8**, `lib/hub/config.mjs/readJson`, found an initial `lstat` followed by `open`. The follow-up hardening compares the initial path's device/inode, the opened handle's `fstat` and a post-open `lstat`; it rejects mismatched identities and a current symbolic link before reading any bytes. This supplements POSIX `O_NOFOLLOW`, which is not available through Node on Windows. Reads remain bounded and use that same verified handle.

[security-config-race.test.mjs](../test/security-config-race.test.mjs) deterministically substitutes real temporary fixture files between the initial check/open and between open/final path verification, and checks that both cases fail before a read. The stable-file case passes. Its file-symlink case explicitly skips when the OS account cannot create such a link; that skip is not evidence of symlink behavior on that platform.

This is narrow identity hardening, **not a complete hostile-filesystem proof**. Ancestor directories and concurrent in-place file writes still require trusted local ownership/access control. An adversary who can replace directory components or execute as the owner is outside the currently supplied isolation boundary. Static rescanning may still require manual review of this path.

Alert **#9**, `lib/media-host.mjs`, flags `stat` before `open`. The media host already checks the opened handle's device/inode against the preceding stat and serves all requests from that handle. The regression in [media-host.test.mjs](../test/media-host.test.mjs) replaces the former filename after setup and verifies that requests still return the originally selected file. This addresses replacement after that identity check; it does not justify dismissing every possible race.

In particular, realpath containment and the later stat/open are separate steps. A hostile actor able to replace an ancestor directory between those steps can violate assumptions that a final-component `O_NOFOLLOW` and file inode comparison alone do not prove. Media roots and their directory ancestry must be owner-controlled and not writable by untrusted accounts/processes. The current implementation does not claim race-free containment on an adversarial shared filesystem; no such guarantee or blanket false-positive classification is made here.

### Five reviewed expected I/O flows

Alerts **#10–#14** identify intended file/network transitions with the following constraints. These are reviewed expected flows, not automatic dismissals, and the TLS risks above remain independently applicable.

- **#10/#11, `inspect-public.mjs`:** an explicitly selected CLI discovery JSON contributes descriptor/service data to HTTP/SOAP requests. `checkedLocalUrl` requires a literal RFC1918 address and the exact CLI-selected responding host and rejects credentials/public/other-host destinations. Fetches do not follow redirects. `SAFE_QUERIES` permits fixed read-only methods; SOAP inputs are fixed InstanceID `0`/Channel `Master` defaults and XML-escaped. This is bounded selected-device inspection, not a tool to upload an arbitrary local file to an arbitrary URL.
- **#12/#13, `lib/ssap.mjs`:** owner-selected local configuration supplies port/transport and a saved pairing key for reconnect or explicit pairing. Host/port validation, fixed WS(S) construction and disabled redirects constrain the destination. The optional bundled legacy compatibility manifest is SHA-256 checked by the CLI and shape-checked before registration. Sending a pairing key to its selected TV is expected protocol I/O; failure to authenticate the TLS peer is still a genuine separate risk. Same-user modification of owner configuration is not prevented by these checks.
- **#14, `device-hub.mjs`:** `observe --out` deliberately exports a frame from the authenticated loopback Hub. The output path comes from the local CLI option, is resolved locally and is opened with `wx` and POSIX mode `0600`; the network response supplies image bytes, not its destination filename. Existing files are not overwritten. Windows export-directory ACLs, parent-directory integrity and retention of explicitly exported images remain owner responsibilities; this export is outside Hub frame expiry.

## Common-adapter CodeQL triage (2026-10-20)

PR #6's first scan reported alerts
[#21](https://github.com/wudaming00/AnyAdapterHub/security/code-scanning/21) and
[#22](https://github.com/wudaming00/AnyAdapterHub/security/code-scanning/22) for
SHA-256 in the Shelly client and synthetic server verifier. Independent review
confirmed these are the wire primitives required by
[Shelly authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/)
and [RFC 7616 section 3.4](https://www.rfc-editor.org/rfc/rfc7616.html#section-3.4),
not an application password-storage scheme. HA1 is transient; it is not saved or
sent as the verifier. Production saved credentials use target/purpose-bound
Windows CurrentUser DPAPI. Replacing the protocol primitive with a slow password
KDF would break authentication. Tests verify the Digest response and reject
plaintext passwords or HA1 in its header. Digest still requires verified pinned
TLS; this finding does not endorse SHA-256 for password storage. Any per-alert
false-positive dismissal records this rationale in GitHub; no query/path
exclusion or source suppression is introduced.

Alert [#23](https://github.com/wudaming00/AnyAdapterHub/security/code-scanning/23)
traces a missing-file fixture into `readJson`. Its read-only numeric open flags
cannot create a file; the query modeled an omitted creation mode as insecure.
The reader is additionally hardened to open first with nonblocking/no-follow
flags, verify a regular, single-link handle and its current pathname before
reading, and check the POSIX owner where available. Windows enrolled-home ACL
protection is a separate boundary; each `readJson` call does not verify a Windows
owner SID. The reader specifies a private mode; Node ignores it without file
creation flags. Missing paths, substituted paths, links and POSIX FIFOs have
bounded denial regressions. The missing-file fixture now uses its own unique
temporary directory. These checks preserve the trusted ancestor-directory
assumption and do not defend against a compromised same-user process. A passing
CodeQL workflow alone still does not establish a clean alert check or hardware
security; inspect both the rescan and individual alert outcomes.

## Release and adapter checklist

- Review the actual diff, action registry, device binding, grant/deadline behavior, targets and cleanup ownership. Higher-impact actions need separate review, not reuse of a generic switch/navigation capability.
- Run `npm ci`, `npm test`, profile checks and package/public-source checks. Record the actual revision/results. Test new dispatch paths for denial, delayed revoke/expiry and ambiguous failure; do not infer results for a different OS.
- Review lockfile/dependency changes, optional interpreter/SDK versions, installation steps and licenses. A profile must not select modules, commands or arbitrary URLs. Do not describe a worker as a same-user sandbox.
- Inspect the explicit Git/package file list. Exclude live Hub homes, credentials, personal images, logs, lab captures, private diagnostics and unreviewed exploit material. Secret scanners supplement independent review and cannot prove complete absence. Rotate exposed credentials.
- Verify local listening, Host/Origin rejection and private directory protection in a clean setup. Test a narrow short-lived client grant, denial, revoke/expiry and no replay with fixtures before a harmless owner-supervised device test.
- Confirm one selected household device/region and exact hardware evidence. For a reversible live test, choose a safe target, record baseline, perform one bounded change, read back, restore and verify. Acceptance alone cannot promote another model or room action to verified.
- Verify frame/export handling, owned cleanup and shutdown. Keep an owner stop/revoke path, backups and a disk-growth plan. Revocation cannot replace physical device safety or undo prior effects.
- Keep private security reporting usable and release notes explicit about fixes/limits. Install the intended revision and restart the daemon; a source update does not patch a running process. Do not promise a response SLA or maintenance window that is not supported.
