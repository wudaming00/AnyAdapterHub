# Roadmap

AnyAdapter Hub is an independent local device control and observation layer for agents. This page distinguishes implemented preview behavior from the remaining engineering work. It is not a delivery schedule or compatibility promise; [supported devices](SUPPORTED_DEVICES.md) and linked evidence define hardware scope.

## Implemented development foundation

- Loopback pinned HTTPS, Node SDK, authenticated SSE, state freshness and a persistent operation/event store.
- Exact device/action grants, expiry/revocation, dispatch-time checks and idempotency with no automatic replay of ambiguous writes.
- Windows CurrentUser DPAPI credentials and protected TLS identity, explicit migration and LG certificate-pinning rules.
- Optional reviewed adapter registry/dependencies, empty-core startup and separate LG observer/media selection.
- One exact LG profile, historical control/observation hardware evidence, and experimental US/Windows ECOVACS X11 read-only evidence.
- Open-source documentation, contribution/issue templates, profile/evidence/package/privacy checks, documentation link checks and Windows/Linux CI.

This is a source preview. No independent security audit, hardened plugin sandbox, universal device support or published npm release is claimed.

## Next: validate the hardened LG path

The mandatory pinned transport has loopback TLS tests. The documented B8 still needs owner-supervised certificate enrollment and read-only hardware retesting after that change; an off television must not trigger plaintext fallback or automatic wake.

Acceptance criteria:

- Exact reviewed model/firmware and saved trust stay explicit. A changed certificate is not silently accepted; first trust and factory-shared-key limitations remain visible.
- Exercise selected control/readback and standby/reconnection under the hardened connection, not just the earlier controller or HTTP Hub path.
- Keep state timestamps, stale fields, acknowledgments and confirmed outcomes separate.
- Verify restoration and cleanup for any explicitly authorized temporary observation. Its HTTP callback/media limitations remain separate from control-channel TLS.
- Do not promote unverified content deep links or player `playing` state into verified title playback.

## Improve enrollment and credential boundaries

The proposed [onboarding interface](ONBOARDING_UX.md) separates household unlock,
vendor-account connection, device selection and narrow agent grants. Graphical
setup, UI sessions, theme rendering and general vendor-login flows are not yet
implemented. The [AI handbook](AI_ADAPTER_GUIDE.md) describes the current working
CLI/SDK and the contribution process, not a replacement for owner consent.

Windows encryption is implemented. Linux/macOS production secret providers, cross-account secure grant enrollment/transfer, credential/certificate rotation workflows and stronger deployment isolation remain future work.

A new provider must fail closed, bind ciphertext to its purpose, reject tampering and never use a master key stored beside the ciphertext. A worker boundary must define OS identity, network targets, filesystem permissions, resource limits and secret access; a subprocess or lazy import is not a sandbox.

## Finish ECOVACS movement validation

The optional US ECOVACS HOME DEEBOT X11 OmniCyclone adapter has hardware evidence for state and details only. Firmware is unknown. A general login/enrollment wizard is not included.

Before broader support:

- Improve private owner enrollment while preserving one exact account region and selected device.
- Test individual movement actions only when the owner authorizes a suitable physical scenario. Offline tests and an existing robot task do not establish a Hub-issued effect.
- Keep request acceptance, observed state and completion separate, with no automatic retry of ambiguous movement.
- Review cloud dependencies, token handling and licenses. Do not import maps, room identifiers, cameras or settings writes into an existing read grant.

See [the adapter guide](ECOVACS_X11.md) and [read-only evidence](evidence/ecovacs-x11-2026-10-19.md).

## Prove the abstraction on lights and plugs

No light, plug, Home Assistant or Matter adapter is implemented in this revision. Proposed directions and primary-source interface links are in [the support matrix](SUPPORTED_DEVICES.md#proposed-next-integrations).

Begin with one lamp or an identified noncritical plug load: explicit on/off, bounded brightness where appropriate, and fresh readback. Do not expose a general vendor RPC, whole-home scenes, scripts or configuration services.

An eventual Home Assistant bridge should allowlist individual entities/actions. Existing commissioning may help a Matter bridge, but native commissioning is not currently provided. Each path still needs exact enrollment, capabilities, evidence and failure tests.

## Grow a reviewable adapter community

Use [the profile walkthrough](CONTRIBUTOR_GUIDE.md) for existing protocols and [the code contract](ADAPTER_REQUIREMENTS.md) for new executable behavior. Validate evidence links and schemas, then review the claims. Firmware changes and regressions can narrow support.

Locks, alarms, cameras, valves, heating/cooking equipment and critical electrical loads require a separate safety/privacy/capability review. Existing remote-key, vacuum or generic switch authority must not silently expand to those classes. Automatic firmware replacement, universal root/shell access and profile-driven script installation are outside the preview.

Release/review procedures are documented in [maintainer checks](MAINTAINING.md).
