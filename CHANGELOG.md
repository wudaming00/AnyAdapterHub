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

- Fixed reviewed registry with lazy LG/ECOVACS loading; no profile-supplied package or module execution.
- Explicitly installed LG WebSocket transport and separately installed ECOVACS worker dependencies.
- LG basic controls separated from opt-in observation/media enhancements.
- Exact-model JSON profiles, sanitized evidence and conservative capability status.
- Experimental Windows/US ECOVACS X11 state/details integration; movement has offline tests only.

### Credential and transport changes

- Windows CurrentUser DPAPI for Hub tokens, LG pairing keys and the Hub TLS private key; unsupported production providers fail closed.
- Hub HTTPS with exact certificate trust, LG WSS/pointer/capture pin checks before secret/application traffic, and no automatic plaintext control downgrade.
- Explicit rerunnable security migration, offline-TV pending enrollment and stop-before-migration checks.
- Native/MSYS Git for Windows OpenSSL compatibility using fixed non-secret stdin configuration and RAM-only private-key output.
- Bounded process diagnostics, cold DPAPI startup and SSE/TLS resource limits.
- Explicit saved LG source-interface binding, one bounded read reconnect and pointer-only timeout recovery without mutation replay.
- Shared secret-envelope validation separated from Windows DPAPI, private file permissions and fixed system-tool resolution; frozen platform metadata does not enable unimplemented providers.

### Documentation and checks

- English/Chinese project and contribution entry points, setup/operations guides, API/SDK reference, troubleshooting, architecture and adapter contribution walkthrough.
- One shared core and three platform distribution targets documented separately from current Windows-only production support and planned native packaging/UI.
- Private vulnerability reporting and public issue/PR templates with evidence and privacy prompts.
- Local documentation link/anchor validation, model/evidence checks, package/source privacy checks and Windows/Linux CI with security analysis.

### Known limits

Live secret storage is Windows-only. Same-user/admin compromise is outside API grant isolation; reviewed adapters are trusted code, not OS-sandboxed plugins. LG initial trust and factory-shared certificates do not prove one unique TV. Legacy observer/DLNA/media LAN legs remain unencrypted and optional. Selected pinned control and visual workflow were retested on the documented B8; other devices/actions remain unverified. The ECOVACS enrollment wizard, other device adapters and Linux/macOS production secret providers are not implemented.

See the [support matrix](docs/SUPPORTED_DEVICES.md), [security policy](SECURITY.md) and [roadmap](docs/ROADMAP.md) for the current boundaries.
