# One shared core, three platform distributions

AnyAdapter uses one shared application core, with Windows, Linux and macOS
distribution targets. “Core” means the Hub's application logic, not an operating
system kernel. The first platform extraction preserves Windows behavior; it does
not ship three installers or enable production secret storage on other systems.

## Shared behavior and platform responsibilities

| Layer | Shared responsibility | Platform responsibility |
| --- | --- | --- |
| Hub core | Device/action grants, dispatch checks, jobs, idempotency, state freshness, events, API and SDK | None of these policies may be bypassed by a launcher or provider |
| Device adapters | Reviewed protocol code, selected targets, capabilities, schemas and verification rules | Declare actual dependency and platform restrictions; do not imply every adapter runs everywhere |
| Credential protection | Secret validation, purpose binding, encrypted-envelope validation and failure semantics | Approved OS-backed protection and its availability checks |
| Private storage and tools | Bounded operations, no secret logs/arguments and explicit errors | Private file permissions, fixed tool resolution and restricted child-process environment |
| User interface, planned | Common setup flow, device cards, permission explanations and visual themes | Narrow trusted host/broker integration; keep credentials out of the renderer |
| Distribution lifecycle, planned | Common versioned core and compatibility contract | Install, update, background service, startup, shutdown and removal for each OS |

The device registry remains fixed and reviewed. Adapter dependencies are
optional: a platform package must not require every vendor SDK. Installing a
package or choosing a theme cannot enroll a device, expand a grant or select an
executable module.

## Current source boundary

- `lib/security/` owns shared secret/envelope validation, Hub identity rules and
  transport trust. Existing Windows ciphertext and purpose binding remain
  compatible; this refactor requires no re-pairing or plaintext migration.
- `lib/platform/windows-dpapi.mjs` implements Windows CurrentUser DPAPI using a
  fixed PowerShell process with private stdin/stdout pipes.
- `lib/platform/private-storage.mjs` handles Windows private DACLs and POSIX
  permission modes. Restricting a file's mode does not provide an encrypted
  credential provider.
- `lib/platform/system-tools.mjs` resolves reviewed fixed tool locations and
  constructs the minimal child environment. Configuration, profiles and model
  output cannot supply executable paths.
- `lib/platform/runtime.mjs` exposes `describePlatform()` as frozen informational
  metadata. Describing another OS does not switch the executing platform, load
  a provider or establish that a required tool is installed.

Portable test providers are explicit test dependencies. Production provider
selection does not accept a replacement module, environment override or
plaintext fallback. Current adapters still run as trusted code with the Hub
process's privileges; this boundary is not an OS sandbox.

## Deployment status

| Target | Production credentials | Distribution status |
| --- | --- | --- |
| Windows | CurrentUser DPAPI implementation; requires the documented runtime/tools | Source preview and CLI; native installer/service lifecycle planned |
| Linux | Production provider not implemented; live initialization fails closed | Shared-core fixture tests run in Linux CI; production distribution planned |
| macOS | Production provider not implemented; live initialization fails closed | Platform target defined; production distribution and native provider planned |

Fixture success proves the tested shared logic and denial behavior, not live
device compatibility or production deployment on that OS. Platform descriptors
are implementation metadata, not runtime readiness or hardware evidence.

The graphical setup flow, login sessions, vendor-account wizard and theme
renderer remain [a proposal](ONBOARDING_UX.md). Until implemented, the
[CLI setup guide](GETTING_STARTED.md) is the working entry point. There is no
mandatory AnyAdapter cloud account in the proposed local flow.

## Requirements for another production platform

A Linux or macOS provider is reviewed source, not a user-supplied plugin. Before
claiming production support, it must:

1. Protect credentials and the Hub TLS key through an approved OS-backed
   boundary, preserving purpose binding and rejection of tampered or mismatched
   envelopes. A master key beside the ciphertext is not an acceptable fallback.
2. Fail closed when protection is unavailable, locked or denied. Tool or provider
   failures must not expose secrets in logs, arguments, environment variables or
   diagnostic output.
3. Verify private storage, tool/process handling, account boundaries and cleanup
   on the actual OS. Explicit fixture injection must remain separate from the
   production path.
4. Define an owner-authorized migration or fresh enrollment. Never transfer
   credentials through plaintext files or silently reinterpret Windows DPAPI
   envelopes as portable credentials.
5. Pass meaningful success, denial, tamper and failure tests plus independent
   technical review and repository-administrator approval. Repeat adapter and
   hardware checks for each claimed platform/device scope.

Native packaging also needs installation/update trust, service identity,
permission-preserving upgrades and safe removal. Adding a platform folder or
passing shared tests alone does not complete those requirements. See
[architecture](ARCHITECTURE.md), [secure setup](SECURE_SETUP.md),
[review policy](AGENT_REVIEW.md) and [roadmap](ROADMAP.md).
