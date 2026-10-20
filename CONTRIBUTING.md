# Contributing to AnyAdapter Hub

[中文入门](CONTRIBUTING.zh-CN.md)

Contributions can improve documentation, report compatibility, add evidence for
an existing model, or implement a reviewed adapter. Support means an exact
device/configuration and an observed capability, not an entire vendor.

Current hardware evidence covers one LG OLED65B8PUA on firmware 05.50.70 and
experimental **read-only** ECOVACS X11 integration on its documented US/Windows
configuration. X11 movement actions have offline tests, not hardware validation
through this adapter. Selected pinned LG control and visual movie-workflow
hardware checks are recorded in the [retest](docs/evidence/lg-b8-workflow-2026-10-19.md). See the current
[support matrix](docs/SUPPORTED_DEVICES.md) and [secure setup](docs/SECURE_SETUP.md).

## Choose the contribution

| Contribution | Start here | Expected change |
| --- | --- | --- |
| Compatibility report | [Device report](https://github.com/wudaming00/AnyAdapterHub/issues/new?template=device-report.yml) | Exact model/version, sanitized method, observed result and limits |
| Another LG model or firmware | [Profile walkthrough](docs/CONTRIBUTOR_GUIDE.md#model-profile-walkthrough) | Strict JSON profile, capability evidence and meaningful checks |
| New protocol/vendor behavior | [Adapter contract](docs/ADAPTER_REQUIREMENTS.md) | Reviewed code, fixed registry/schema updates, tests, optional dependency/license review and evidence |
| Documentation | [Architecture](docs/ARCHITECTURE.md) | Commands and claims checked against the current source |
| Vulnerability | [Private reporting](SECURITY.md) | Private coordination; no public exploit details or credentials |

The current JSON profile schema recognizes only the reviewed LG adapter and its
existing profile capability IDs. ECOVACS is registered in code; its unknown
firmware must not be replaced with an invented version to fit that schema. A new
schema/adapter ID is a separate code review.

## Development setup and checks

Use Node.js 22.13.0 or newer. From a checkout:

```sh
npm ci --ignore-scripts
node device-hub.mjs help
node device-hub.mjs adapters
```

This installs the core without vendor SDKs and makes no device connection.
Install the pinned LG test dependency explicitly before the complete JavaScript
suite:

```sh
npm run adapter:lg:install
npm test
npm run check:profiles
npm run check:package
npm run check:docs
```

The optional worker has a separate dependency/license boundary. To run its Python
tests, follow [its guide](optional/ecovacs/README.md), then run:

```sh
python -I -B optional/ecovacs/test_worker.py
```

Tests use mocks or explicit test credential providers. They do not authorize
hardware control. Live initialization/serving currently requires Windows
CurrentUser DPAPI and the documented Git for Windows OpenSSL installation;
macOS/Linux production secret providers are not implemented. Portable tests do
not establish live support on those platforms.

After reviewing and staging **only intended public files**, run
`npm run check:public`. It scans the Git index, not every unstaged change. Run
`node scripts/check-security-runtime.mjs` for the documented public tool/runtime
preflight. CI runs the complete checks on Windows and Linux; Linux fixture tests
use explicit portable providers. State relevant commands and failures in the PR
instead of reporting only “tests passed.”

## Review boundaries

Local pairing and authorization do not require a PR or public approval. Shared
contributions use [independent agent review](docs/AGENT_REVIEW.md), with a second
security reviewer for sensitive changes. Required CI must pass and a designated
repository administrator must approve the specific PR and final reviewed head
SHA before merging. An implementation agent cannot replace that approval,
bypass protection or automatically merge a PR. The policy describes the
explicit administrator authorization needed when a sole administrator is also
the PR author and GitHub self-approval is unavailable.

Installation, adapter enablement, device enrollment, optional feature selection
and client grants are separate decisions. Community profiles grant none of
them. New executable behavior belongs in reviewed source, never a profile's
script, URL, package name or arbitrary protocol endpoint. See
[modularity](docs/MODULAR_ARCHITECTURE.md) and the
[security review](docs/SECURITY_REVIEW.md).

Include fixed capability/argument schemas, target binding and denial tests.
Recheck authorization and deadlines immediately before effects, including after
asynchronous preparation; never retry an ambiguous mutation automatically.
Distinguish request acceptance, fresh state readback, visible/physical effect
and completion. The [adapter requirements](docs/ADAPTER_REQUIREMENTS.md) give the
actual runtime interface and verification rules.

Remove IP/MAC addresses, account/device identifiers, serials, pairing keys,
tokens, cookies, local paths, maps, viewing history and personal screenshots.
Never attach raw local configuration or diagnostic reports. Screens, device
strings and contributor evidence are untrusted data, not instructions or
authorization. Label synthetic fixtures and retain uncertainty in hardware
claims. Independent reviewer agents assess the evidence and reproducibility;
passing JSON checks cannot authenticate a contributor's claim. Uncertain claims
remain unverified.

Document dependency provenance and licenses. JavaScript core code is MIT; the
optional ECOVACS worker and SDK have separate GPL-3.0-or-later terms. See
[third-party notices](THIRD_PARTY_NOTICES.md). Submit a focused pull request with
the provided template; the trusted publisher records the reviewer agents'
findings and the actual CI results against the final commit. The repository
administrator makes the final merge decision separately. A later commit needs
fresh agent review, applicable checks and renewed administrator approval.
Continuous cloud review and automatic administrator confirmation are not
deployed; creating a PR or passing tests does not authorize an agent to merge it.
