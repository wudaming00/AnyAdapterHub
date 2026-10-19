# Roadmap

AnyAdapter Hub is a development preview of a local device control and observation layer for agents. The goal is to make permissions, targets and outcomes understandable across devices, while keeping the Hub independent of an agent framework.

This is an ordered engineering plan, not a delivery schedule or compatibility promise. [Supported devices](SUPPORTED_DEVICES.md) is the source of truth for hardware evidence. A public repository, passing CI or an available upstream API does not make an integration production-ready.

## 1. Publish a reviewable foundation

Deliver a reproducible source checkout, documented local startup, scoped client grants, model-level evidence and an explicit license/provenance inventory. Keep private configurations, credentials, household media and experimental root/persistence payloads outside the public source and runtime package. npm publication remains a separate decision.

Release criteria:

- A clean checkout installs with lifecycle scripts disabled and passes the documented tests, profile/evidence validation, package-boundary checks and staged-source review on the supported platforms.
- Public links resolve, the support matrix matches the evidence and current package contents, and separately licensed components retain their notices.
- Automated security/dependency analysis runs on the public repository; findings are reviewed, not described as an independent audit or proof of security.
- Setup and security documentation accurately explain local credential access, weak device transport authentication, frame retention and the limits of running an agent under the same OS account.

## 2. Make the validated LG path dependable

Keep ordinary local control separate from the experimental B8 observer. Improve behavior around standby, reconnection, stale state and interrupted observation before broadening the model list.

Release criteria:

- The exact reviewed B8 model/firmware remains explicit. New models or firmware require their own evidence; observation fails closed when its reviewed identity does not match.
- Controls, polls and observation use the same per-device queue. Tests cover grant revocation while queued, deadlines, ambiguous device writes and restart recovery without replay.
- State fields retain observation time, expiry and verification scope. Transport ACKs are never promoted to a confirmed physical or app effect without adequate evidence.
- Temporary observation has separate local opt-in, capture/read grants, bounded lifetime and storage, and visible restoration/cleanup results. It is not advertised as root access, continuous video or access to provider internals.
- Reversible hardware tests read back the requested effect and restore the previous state where appropriate. Unsupported deep links, unverified controls and title-identification limits stay documented.

## 3. Complete experimental vacuum-adapter validation

The optional Windows adapter for the US ECOVACS HOME DEEBOT X11 OmniCyclone, cloud class `huhcip`, is implemented. Fresh state and read-only details have now been verified on hardware through the Hub, together with rejection of movement and cross-device access by the read-only grant. Firmware is unknown. See the [adapter guide](ECOVACS_X11.md) and [evidence](evidence/ecovacs-x11-2026-10-19.md).

The five movement actions have offline tests but no hardware validation through the new adapter. The next milestone is to establish their individual behavior when an owner authorizes a suitable hardware test, improve enrollment, and keep dependency/provenance review explicit. Do not inherit a movement claim from a separate MCP connector, an already running robot task or a test fixture.

Release criteria:

- Private owner enrollment binds account region and one selected device; reconnects cannot silently substitute another vacuum.
- Credentials and any external worker stay behind the adapter boundary. Optional dependencies, licenses and setup requirements are documented; no missing component is automatically downloaded or executed by a model profile.
- Hardware evidence distinguishes command acceptance, current device state and completion. Room cleaning remains unverified until tested against the selected device's room mapping.
- Maps, room labels and identifiers receive privacy review; only necessary data is exposed. Maintenance counters are labeled as counters, not measured component wear.
- Unknown or timed-out outcomes remain unknown, with no automatic repeated cleaning or movement command.

## 4. Prove the adapter contract on local lights and plugs

Use a documented local light protocol and a documented local switch protocol to test whether the abstraction works beyond TVs. The proposed interfaces and official documentation are listed in [Supported devices](SUPPORTED_DEVICES.md#proposed-next-integrations); these entries are not implemented support.

Begin with a single lamp and an identified noncritical plug load. Expose explicit setters and readback, not generic vendor RPC or whole-home scenes. Each addition needs exact hardware/firmware evidence, target binding, bounded parameters and tests for denied access, stale state and disconnects.

After that, evaluate an allowlisted Home Assistant bridge and access to already commissioned Matter devices. Reuse owner-controlled enrollment; do not import every entity or expose arbitrary service calls. Native Matter commissioning and unrestricted Android debugging are outside this milestone.

## 5. Grow through evidence, not automatic trust

Make model reports and adapter reviews straightforward for contributors. Keep pure JSON compatibility data separate from executable protocol code. Validate evidence references and schemas, then apply human review: a well-formed claim may still be wrong or fabricated.

Before expanding a release's support list, require a reproducible sanitized hardware report, negative tests, compatible license notices and documented verification limits. A merged profile must not enable permissions or install code in a user's home. Firmware changes and regressions can narrow support again.

Higher-impact devices such as locks, alarms, cameras, valves and cooking appliances require a separate threat/capability review. Existing light, switch or read permissions must not silently expand to them. The preview does not include automatic firmware replacement, universal root/shell access or arbitrary community-script execution.

See [adapter requirements](ADAPTER_REQUIREMENTS.md), [security](../SECURITY.md) and [contribution guidelines](../CONTRIBUTING.md) for the acceptance boundaries used across these milestones.
