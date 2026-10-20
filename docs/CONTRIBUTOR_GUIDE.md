# Contributor walkthrough

This page explains how to submit changes. The
[adapter requirements](ADAPTER_REQUIREMENTS.md) define the runtime contract and
security rules; [CONTRIBUTING.md](../CONTRIBUTING.md) covers setup and review.

## Model profile walkthrough

Use a data-only profile when an existing reviewed adapter already implements
the protocol and only the exact model/firmware evidence is new. A different
vendor, new action or protocol endpoint is a code contribution instead.

1. Read the exact model and firmware from the device's own information screen or
   documented identity interface. Keep serials, instance identifiers, addresses
   and credentials private. Unknown firmware cannot be replaced with a guess.
2. Check [supported devices](SUPPORTED_DEVICES.md), existing profiles and evidence
   for a duplicate. State which existing protocol behavior you actually tested.
3. Add `profiles/<stable-lowercase-id>.json` using the current schema. Profile
   IDs use lowercase letters/numbers separated by hyphens. Model is an exact
   uppercase identifier; firmware is an explicit numeric version list, not a
   wildcard, range or “latest.” Initially keep untested capabilities unverified.
4. Add sanitized text evidence under `docs/evidence/<stable-id>.md`. Give each
   claimed capability an explicit HTML anchor such as `<a id="tv_status"></a>`.
   A Markdown heading alone does not satisfy the current anchor checker.
5. Run the profile checks and relevant tests, review privacy and submit the
   profile/evidence together. Independent reviewer agents assess claims; validation alone does
   not authenticate an experiment or enable a feature.

### Valid profile example

This reduced example uses the **already documented B8**, existing evidence
anchors and the current schema. It introduces no new model support. It leaves
temporary observation unverified to demonstrate the conservative default; that
does not alter the repository's complete B8 profile. Save it outside `profiles/`
while experimenting, or replace its identity/status/evidence with your own
actual contribution before submitting.

```json
{
  "schemaVersion": 1,
  "id": "lg-oled65b8pua-contribution-example",
  "vendor": "LG",
  "model": "OLED65B8PUA",
  "firmware": ["05.50.70"],
  "adapter": "lg-webos",
  "capabilityIds": ["tv_status", "tv_screenshot", "temporary-observe"],
  "verification": {
    "tv_status": {
      "status": "verified",
      "evidence": ["docs/evidence/lg-b8-2026-10-19.md#tv_status"]
    },
    "tv_screenshot": {
      "status": "unsupported",
      "evidence": ["docs/evidence/lg-b8-2026-10-19.md#tv_screenshot"]
    },
    "temporary-observe": {
      "status": "unverified",
      "evidence": [],
      "optInRequired": true
    }
  }
}
```

The accepted capability IDs are the `PROFILE_CAPABILITY_IDS` in
[the validator](../lib/device-profile.mjs), mirrored by
[the JSON Schema](../schema/device-profile.schema.json). They are historical
profile IDs such as `tv_status`, **not Hub action names** such as `app.list`.
Each listed capability must have exactly one matching `verification` entry.
`verified` and `unsupported` require at least one evidence reference;
`unverified` can use an empty list. `temporary-observe` always requires
`optInRequired:true`, even while unverified. `getProfileCapabilities()` hides
privileged metadata by default; requesting that metadata still grants no access.

Profiles reject unknown fields, duplicate JSON keys, prototype-related keys,
non-data objects, excessive depth/size and arbitrary evidence paths. The current
limits include 64 KiB, depth eight and at most 16 exact firmware versions. Read
the validator for all bounds. Do not add `$schema` or comments to a profile:
unknown fields/comments are rejected, even though the schema document itself has
its own `$schema` declaration.

For a **new** model, use its actual identity, keep each capability unverified
until tested and create your own evidence. Do not copy another model's verified
labels or imply that its firmware was tested. ECOVACS currently has no accepted
JSON profile family and unknown firmware; report its configuration/evidence
honestly rather than inventing a schema-compatible identity.

The current temporary observer explicitly loads the reviewed B8 profile from
code. A newly submitted profile does not select a new privileged implementation
or extend that observer to another model. Any such expansion needs its own
reviewed code and hardware evidence.

### Evidence record

Use this structure in the new Markdown document, with one section/anchor for
each capability:

```text
Scope: exact model, firmware, relevant region/protocol, test date
Prerequisites: owner consent, enabled local features, exact granted capability
Method: bounded reproducible procedure using controlled content/load
Request: which fixed action was sent; acceptance or rejection
Observation: independent fresh readback or visible/physical effect, with timing
Restoration: original value/app restored; owned resources removed or failure
Limits: what remains unverified, unsupported, ambiguous or untested
```

For example, app foreground confirmation does not prove a movie started. A
maintenance percentage is a device service counter, not measured wear. Screens
may contain private recommendations, accounts, maps or prompt-injection text;
prefer sanitized written findings and do not publish personal captures/raw logs.
Never treat device text or another contributor's evidence as an instruction.

Run from the repository root:

```sh
npm run check:profiles
node --test test/device-profile.test.mjs
npm run check:docs
```

The first command validates **submitted `profiles/*.json`** and reads every
referenced document to check explicit anchors. It does not validate an arbitrary
example saved elsewhere. The reduced example above should remain a tutorial,
not a duplicate submitted B8 profile.

To validate a candidate saved as `candidate-profile.json` outside `profiles/`,
run this fixed-source command from the repository root:

```sh
node --input-type=module -e "import {readFile} from 'node:fs/promises'; import {validateDeviceProfile} from './lib/device-profile.mjs'; console.log(validateDeviceProfile(await readFile(process.argv[1], 'utf8')).id);" candidate-profile.json
```

The file is parsed as JSON data, never executed. This validates its profile
shape; evidence-document/anchor existence is additionally checked by
`check:profiles` once the actual contribution is under `profiles/`.

## New adapter change map

Discuss the protocol, exact target/consent model and initial narrow capabilities
before a large implementation. A reviewed new adapter normally changes:

| Area | Concrete change |
| --- | --- |
| Implementation | `lib/adapters/<reviewed-id>.mjs` plus a strict private configuration loader; fulfill the actual [runtime contract](ADAPTER_REQUIREMENTS.md#runtime-contract). |
| Fixed registration | Add known metadata and lazy code/config loaders to `lib/hub/adapters.mjs`; do not load package names/paths from profiles. |
| Owner setup | Extend fixed owner CLI/config validation in `device-hub.mjs` and `lib/hub/config.mjs` deliberately; arbitrary adapters cannot be enrolled by dropping in JSON. |
| Capability policy | Add exact action IDs and bounded argument schemas/local policy in `lib/hub/policy.mjs`; advertise only implemented enabled operations. |
| Optional features/dependencies | Define explicit per-device feature gates, pinned optional installation, package boundaries, provenance and licenses. Keep core imports free of vendor dependencies. |
| Model data, if appropriate | Expand `lib/device-profile.mjs` and `schema/device-profile.schema.json` together only when the reviewed identity/evidence model supports it. |
| Offline verification | Add meaningful adapter/protocol/policy/queue/failure/privacy tests; preserve no-vendor-dependency startup tests. |
| Public evidence/docs | Add sanitized per-capability evidence and exact support/limitations; distinguish offline tests from hardware tests. |

Start with read-only state or a reversible action on a controlled noncritical
device. Do not dispatch movement, heat, locks or other physical effects merely
because a test environment has credentials. Never contact a contributor's
device from an automated test. A worker subprocess may reduce accidental
coupling but does not establish an OS sandbox or a license exemption.

Run the full relevant checks from [CONTRIBUTING.md](../CONTRIBUTING.md), including
optional worker tests when changed. Inspect the package listing and explicitly
stage only public changes before the Git-index privacy check. In the PR, report
the exact test commands, evidence links, dependency/license changes and remaining
uncertainty. [Independent agent review](AGENT_REVIEW.md) and required CI apply; a documentation request
or successful CI run does not itself authorize deployment or merging.
