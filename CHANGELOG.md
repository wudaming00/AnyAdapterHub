# Changelog

This file records source changes. There is no published npm package or tagged release implied by a section below. The package currently identifies itself as version 0.2.0 and remains private.

## Unreleased

### Local hub and permissions

- Independent loopback HTTPS API and JavaScript SDK, authenticated SSE, per-device state freshness and operation records.
- Exact device/capability grants with expiry, revocation, owner-only management and a dispatch-time permission/deadline check.
- Persistent idempotency and conservative restart recovery: queued work is cancelled, interrupted running work becomes unknown, and ambiguous device writes are not automatically replayed.
- Read-only exact-client/device operation lookup by original idempotency key for lost-response recovery.
- Checkpointed Disney+ visual-agent workflow, scoped frame-bound decisions, encrypted viewing progress and bounded local CLI coordination.
- Empty-core startup without an enrolled device or vendor dependency.

### Adapters and optional features

- Nine additional experimental fixed adapters: Hue, Shelly, SwitchBot, ThinQ, HA sensors, openHAB, Plex public identity, Awair and public PurpleAir sensors. No new mandatory dependencies or hardware claims.
- Fixed per-vendor HTTPS route/header policies, source-time bounds for air data, selected ordinary-load switch capability, and optional owner-bound Hue bridge certificate identity.
- Read-only defaults and masked purpose-bound credential enrollment across new adapters; Plex public identity deliberately collects no token.
- Synchronous dispatch authorization now rejects asynchronous/non-void callbacks without executing thenable getters or sending a mutation.

- Fixed reviewed registry with lazy LG/ECOVACS loading; no profile-supplied package or module execution.
- Explicitly installed LG WebSocket transport and separately installed ECOVACS worker dependencies.
- LG basic controls separated from opt-in observation/media enhancements.
- Exact-model JSON profiles, sanitized evidence and conservative capability status.
- Experimental Windows/US ECOVACS X11 state/details integration; movement has offline tests only.
- Experimental Home Assistant HTTPS selected-light adapter, read-only defaults and separately gated explicit power/brightness setters.
- Optional MQTT.js 5.16.1 TLS adapter for one exact numeric sensor subscription; no publish capability or vendor payload passthrough.
- Owner-only masked terminal enrollment for both integrations, purpose-bound encrypted credentials and fixed certificate identity. Neither new adapter has household hardware evidence.

### Credential and transport changes

- Preserve exact filesystem identities in private configuration, enrolled certificate, media-file and rollback checks, including production journal cleanup.
- Windows CurrentUser DPAPI for Hub tokens, LG pairing keys and the Hub TLS private key; unsupported production providers fail closed.
- Hub HTTPS with exact certificate trust, LG WSS/pointer/capture pin checks before secret/application traffic, and no automatic plaintext control downgrade.
- Explicit rerunnable security migration, offline-TV pending enrollment and stop-before-migration checks.
- Native/MSYS Git for Windows OpenSSL compatibility using fixed non-secret stdin configuration and RAM-only private-key output.
- Bounded process diagnostics, cold DPAPI startup and SSE/TLS resource limits.
- Explicit saved LG source-interface binding, one bounded read reconnect and pointer-only timeout recovery without mutation replay.
- Shared secret-envelope validation separated from Windows DPAPI, private file permissions and fixed system-tool resolution; frozen platform metadata does not enable unimplemented providers.

### Selected LG DLNA discovery

- A `DLNAClient` with a selected host ignores other SSDP senders before parsing and fetches only that host's description and AVTransport schema. Description, base and used service URLs stay on the selected literal host; redirects and unrelated port probes are refused. The explicit general discovery scanner keeps its existing broader behavior.
- One connected client reuses its validated service for status and supported fixed media actions. A new client still waits for the full 4.5-second SSDP response window; this change adds no cache between clients or persistent MCP controller.
- SSDP requests remain multicast and unauthenticated. Legacy HTTP description, schema and SOAP traffic remains unencrypted and unauthenticated; source-address and URL checks do not prove a unique device identity.
- The selected interface is bound for SSDP and discovery description/schema HTTP requests. This change does not extend interface binding to SOAP or the hosted media connection.
- These are source changes, not evidence that an existing MCP process was redeployed or its media host released. Closing a DLNA client does not send Stop or close a media host owned by another process; those outcomes require separate verification.

### LG session control and local media cleanup

- MCP reuses one controller in memory while reloading/decrypting the protected local configuration for every tool. Changes to credentials, identity or local policy invalidate the session and owned resources; failed cleanup prevents a replacement session. This is process lifetime reuse, not an OS startup service or a plaintext credential cache.
- `tv_keyboard_state` returns immediate metadata by default. An explicit `waitMs` (0–30000) waits outside the effect queue; stdio keeps accepting bounded requests so navigation can produce real focus events. Effects remain serialized. EOF drains accepted work; broken output cancels pending dispatch and still closes owned resources.
- Focus needs an actual boolean event, observed foreground, current generation and at most 1500 ms of age. Navigation, foreground changes and disconnects invalidate it. `text.insert` and `tv_type_text` fail immediately when focus is unknown rather than waiting and later inserting; known unsent Hub focus denials do not trigger a blocking status recovery. Dispatch authorization must finish synchronously before effects.
- MCP `tv_apps` returns at most 256 IDs/titles. The Hub retains its existing bounded privacy-filtered `app.list`; neither projection replaces full internal metadata used for ordinary-app launch policy.
- New independently granted Hub `text.focus.read` reads immediate focus metadata; optional media capability `media.host.release` and MCP `tv_release_media` close only listeners owned by that running instance, without TV discovery or a Stop request. They cannot release another process's listener or verify television playback. Existing grants are not expanded.
- Listener cleanup has a bounded server-close wait, shares one close attempt and preserves failure on repeated calls. MCP retains failed resources for reconciliation and caps outstanding media hosts at two. Cleanup failure is not reported as success.

### Bounded LG navigation sequences

- Separately granted `navigation.sequence` validates 1–12 fixed navigation keys before sending and executes them as one queued Hub operation. Sends stay serial, with per-key final authority/deadline checks and a fixed 250 ms interval; partial effects are not atomic or automatically replayed.
- Movie workflow key decisions use one checkpointed sequence operation rather than one operation per key. An absolute `notAfter` derived from the original observation bounds visual freshness even when HTTP delivery is delayed. Profile selection and playback-control revelation retain their single-key restrictions; Play remains separate.
- Transport progress remains distinct from UI confirmation. Ambiguous or interrupted batches require observation and original-operation reconciliation, without resending a prefix or suffix. Existing grants are not expanded.
- Ordinary navigation clears cached text focus while retaining valid IME subscriptions, avoiding a gap on TVs that report only later field changes. Typing remains blocked during an unsettled pointer send; only a real boolean event within its original freshness bound can authorize insertion. Failed sends, app changes and explicit launches invalidate the context.
- An incomplete focus-change notification retires the previous field rather than preserving an old true focus. This repairs event handling; it does not establish keyboard compatibility for a particular retail app.

### Documentation and checks

- English/Chinese project and contribution entry points, setup/operations guides, API/SDK reference, troubleshooting, architecture and adapter contribution walkthrough.
- One shared core and three platform distribution targets documented separately from current Windows-only production support and planned native packaging/UI.
- Private vulnerability reporting and public issue/PR templates with evidence and privacy prompts.
- Local documentation link/anchor validation, model/evidence checks, package/source privacy checks and Windows/Linux CI with security analysis.

### Known limits

Live secret storage is Windows-only. Same-user/admin compromise is outside API grant isolation; reviewed adapters are trusted code, not OS-sandboxed plugins. LG initial trust and factory-shared certificates do not prove one unique TV. Legacy observer/DLNA/media LAN legs remain unencrypted and optional. Selected pinned control and visual workflow were retested on the documented B8; other devices/actions remain unverified. The ECOVACS enrollment wizard, other device adapters and Linux/macOS production secret providers are not implemented.

See the [support matrix](docs/SUPPORTED_DEVICES.md), [security policy](SECURITY.md) and [roadmap](docs/ROADMAP.md) for the current boundaries.
