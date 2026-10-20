# Troubleshooting

Start with [getting started](GETTING_STARTED.md), [secure setup](SECURE_SETUP.md)
and the [API contract](API.md). The server binds only loopback. Do not solve a
connection or certificate error by disabling TLS verification, exposing the port
to the LAN, printing a token or copying another household's configuration.

## Runtime and optional installation

| Symptom | Check and recovery |
| --- | --- |
| `node:sqlite` is missing | Use the declared Node.js version, 22.13 or newer. The hub uses Node's built-in SQLite; installing an unrelated SQLite npm package does not add that built-in module. |
| `ExperimentalWarning` mentions SQLite | Node may label this built-in experimental. The warning alone is not a failed check; inspect the command's exit status and actual errors. |
| `ADAPTER_DEPENDENCY_MISSING`, or missing package `ws` | LG is optional. Run `npm run adapter:lg:install` to install the reviewed `ws@8.22.0`, then enable the adapter and restart. Core-only installation does not require `ws`. |
| Adapter is installed but its devices are absent | Installation, enabling and enrollment are separate. Inspect `node device-hub.mjs adapters` and the owner's local configuration. Enable the selected adapter with `enable --adapter`, then restart. A disabled adapter's private configuration is not loaded. |
| Screen/media action is absent from capabilities | Check the owner's feature selection as well as the client grant. `observer` and `media` are independent opt-ins; a grant does not turn them on. Observation additionally needs local `allowTemporaryObserver: true`. |
| Linux/macOS initialization cannot protect secrets | Production secret storage currently supports Windows CurrentUser DPAPI only. Portable tests use an explicitly injected test provider; that is not a production fallback. |

## Windows OpenSSL and DPAPI

Run `node scripts/check-security-runtime.mjs` for fixed tool-version/option
metadata and a non-secret ephemeral DPAPI self-test. It does not print a token,
private key, encrypted secret or process stderr.

The identity issuer checks fixed Git OpenSSL locations rather than searching the
current directory or `PATH`. Install Git for Windows in a supported system
location if `HUB_IDENTITY_UNSUPPORTED` is reported. Do not point the hub at an
executable supplied by a community model profile. Fixed configuration is passed
to OpenSSL stdin; native Windows `NUL` and MSYS path handling differ, which is why
the issuer does not depend on a `NUL` configuration file.

`HUB_IDENTITY_OPTION_UNSUPPORTED`, `HUB_IDENTITY_CONFIG_FAILED`,
`HUB_IDENTITY_PROCESS_EXIT` and `HUB_IDENTITY_TIMEOUT` are static failure
categories. The issuer never includes raw diagnostic text or key material in the
error. Confirm the supported runtime installation rather than adding private-key
temporary files or bypassing certificate checks.

A fresh Windows profile, PowerShell/.NET startup or a busy host can make the first
DPAPI operation slow. Each DPAPI subprocess has a bounded 45-second deadline.
Only that deadline reports the fixed `SECRET_STORE_TIMEOUT` code. Other process
errors are generic and cannot supply their own timeout code or diagnostic text.
`SECRET_STORE_FAILED` can cover a wrong Windows user, an unavailable profile,
tampered ciphertext or the wrong purpose. Do not reset or overwrite credentials
to hide either failure. Run under the original Windows user and review the
encrypted enrollment/migration path.

The startup preflight uses only a fixed non-secret ephemeral value and purpose.
It runs at most two complete protect/unprotect attempts, retrying **only**
`SECRET_STORE_TIMEOUT`. It records each phase, attempt, elapsed time and static
code, including the first timeout; no ciphertext, bytes or process stderr are
printed. It reserves a fixed 185-second total budget and will not begin another
45-second operation unless the full bound fits. Exhausted retries, budget
exhaustion, mismatched results and every other provider failure still exit with
an error. A successful second attempt proves that non-secret roundtrip only.
Real credential encryption/decryption has **no automatic retry**; its per-call
45-second deadline, CurrentUser scope, purpose binding and fail-closed behavior
remain unchanged. A recovered self-test does not guarantee future calls will
succeed or justify weakening credential/transport trust.

`ENCRYPTED_CREDENTIAL_REQUIRED` means plaintext, malformed or obsolete credential
material was rejected. Stop the hub and follow the explicit migration procedure;
ordinary startup does not silently adopt plaintext or an old host-only key
envelope. Hub tokens bind to origin and certificate pin. Current TV key envelopes
bind to host and pin, with a separate context for pending TLS enrollment.

## Migration and startup

`HUB_MUST_BE_STOPPED` means something is listening on the configured local port,
or the offline check could not establish a refused connection. Stop the intended
hub first, check the selected port and rerun migration. Do not kill an unrelated
process simply to make this check pass.

Migration stages and verifies encrypted replacements before replacing files.
An interruption can leave a mixture of old and upgraded files; rerun the
explicit migration under the same Windows user to finish. It does not create a
plaintext backup. Keep the private directory intact and do not remove individual
credential files or the identity as a repair shortcut.

Private-home errors can indicate links, hard links, an unrelated populated
directory, owner mismatch, overly broad permissions or a failed ACL operation.
Use a dedicated hub directory. Review the path before changing permissions;
do not run initialization over a project directory or a shared home folder.

## Device unavailable or certificate mismatch

For LG, the hub does not automatically wake an off television merely to read
state, pair or enroll a certificate. A sleeping/offline TV can leave fields
unknown or stale. Check network/standby behavior through the owner's normal
controls and inspect field expiry before treating cached data as current.

`pending-tv-tls-enrollment` means a key was encrypted while the TV's TLS identity
could not be observed. It is not a usable certificate pin. Complete the owner's
explicit enrollment/migration when the intended TV is reachable. Runtime will
not replace it with plain WS/HTTP.

`TLS_PIN_REQUIRED` or `TLS_PIN_MISMATCH` must stop device communication. Check
that the selected device/address is correct and whether hardware, firmware or
certificate identity changed. A first TLS observation is TOFU, not independent
proof of identity. Do not replace a stored pin solely because a connection is
failing; use the owner's reviewed enrollment process.

For ECOVACS, confirm [the exact US X11 prerequisites](ECOVACS_X11.md): Python
3.14+, the pinned SDK, original-user DPAPI enrollment and the exact selected
device fingerprint. `SELECTED_DEVICE_MISMATCH` is not a request to choose the
only discovered robot. `DEPENDENCY_VERSION_UNREVIEWED` requires the reviewed
version or a reviewed adapter update. Cloud/network failure leaves evidence
unknown/stale; it does not authorize replaying a movement command.

## Authorization and action results

| Result | Interpretation |
| --- | --- |
| `401 UNAUTHORIZED` | Missing, malformed or unknown bearer credential. Use the encrypted credential intended for this hub. |
| `403 ACCESS_DENIED` | The grant lacks the exact device/capability, or owner-only authority is required. A local Host/Origin check can also cause 403. |
| `403 GRANT_EXPIRED` / `GRANT_REVOKED` | Have the owner issue a new, narrowly scoped grant. Restoring a copied old credential does not reverse server-side revocation. |
| `403 LOCAL_POLICY_DENIED` | The local owner policy did not permit the operation, such as an unapproved URL origin, media root or observation opt-in. A broader client token alone does not change that policy. |
| `409 IDEMPOTENCY_CONFLICT` | The key already represents a different validated request. Reconcile the original operation before deliberately creating a new request. |
| `429 BUSY` | A queue or transport/stream limit was reached. Avoid bursts and duplicate submissions. |
| HTTP `200` with operation `failed` / `unknown` / `unconfirmed` | The API returned the operation record; it did not claim successful device action. Inspect verification evidence and current state. |

If an SDK `execute` call returns `queued` or `running`, its local wait ended before
the operation finished. Keep the operation ID and poll. A lost network response
does not prove that dispatch failed; never generate a new key and blindly repeat
a physical action. After a hub restart, queued work is cancelled and running
work is unknown; neither is replayed.

## SSE, images and observation

An SSE connection returning `200` with no immediate event can be healthy. The hub
flushes headers even when the journal is empty; it does not use an informational
`1xx` response to signal readiness. There are periodic heartbeat comments.
Keep an `AbortSignal` for stream shutdown, and reconnect explicitly with the last
received event ID when appropriate. Re-read state after reconnecting because
the event journal is bounded and old cursors can have gaps.

SSE closes after revocation/expiry, stalled backpressure, shutdown or a transport
failure. An error after stream headers cannot become a JSON error body. A grant
with only `state.read` cannot open the event stream; it needs `events.read`.

Frame `404` commonly means the five-minute TTL or a storage cap evicted the image.
Capture and image reading have separate permissions. Enabling screen observation
also requires the exact reviewed device/profile and owner feature selection.
An LG foreground app ID or ACB `playing` state does not prove a selected Disney+
title is playing. See [supported-device limits](SUPPORTED_DEVICES.md).
