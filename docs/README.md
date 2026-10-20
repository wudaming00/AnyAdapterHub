# Documentation / 文档目录

AnyAdapter Hub is a source-distributed development preview. Read the setup and security pages for the revision you are running. Hardware evidence is scoped to the exact model, firmware, capability and transport that was tested.

## Install and operate / 安装与使用

| Need | Guide |
| --- | --- |
| Project overview / 项目介绍 | [English README](../README.md), [中文 README](../README.zh-CN.md) |
| First setup, empty core, LG pairing, read-only grant | [Get started](GETTING_STARTED.md) |
| Proposed sign-in, device connection and themes | [Simple onboarding design](ONBOARDING_UX.md) |
| Windows encryption, certificate trust and existing-install migration | [Secure setup](SECURE_SETUP.md) |
| Start/stop, adapters, feature selection, grants, frames and recovery | [运行与维护 / Local Hub](LOCAL_HUB.md) |
| API routes, schemas, SDK, events and error semantics | [API and SDK](API.md) |
| One-request Disney+ playback with an attached visual agent | [Movie workflow](MOVIE_WORKFLOW.md) |
| Missing dependencies, denied access, standby and certificate failures | [Troubleshooting](TROUBLESHOOTING.md) |
| Exact hardware/firmware and verification limits | [Supported devices](SUPPORTED_DEVICES.md) |
| Experimental HTTPS light and MQTT numeric sensor enrollment | [Popular adapters](POPULAR_ADAPTERS.md) |
| Hue, Shelly, cloud sensors, HA sensors, openHAB and Plex | [Common integrations](COMMON_ADAPTERS.md) |
| Optional ECOVACS cloud worker and existing enrollment prerequisite | [ECOVACS X11](ECOVACS_X11.md) |
| Optional component installation | [LG transport](../optional/lg-webos/README.md), [ECOVACS worker](../optional/ecovacs/README.md) |

Live production secret storage is currently Windows-only. Portable fixture tests use explicitly injected test providers; they do not enable live deployment on Linux or macOS. Core startup installs and connects no household device by itself.

## Understand and contribute / 架构与贡献

| Need | Guide |
| --- | --- |
| Components, data flow and actual adapter/runtime contract | [Architecture](ARCHITECTURE.md) |
| One shared core, Windows/Linux/macOS boundaries and release targets | [Platform architecture](PLATFORM_ARCHITECTURE.md) |
| Install → enable → enroll → features → grants | [Modular architecture](MODULAR_ARCHITECTURE.md) |
| Development, tests and contribution review | [Contributing](../CONTRIBUTING.md) |
| Local owner consent and independent reviewer agents | [Agent review policy](AGENT_REVIEW.md) |
| Step-by-step profile and adapter contribution | [Contributor guide](CONTRIBUTOR_GUIDE.md) |
| Instructions and workflows for AI coding agents | [AI adapter handbook](AI_ADAPTER_GUIDE.md), [AGENTS.md](../AGENTS.md) |
| Add a protocol adapter or exact-model report | [Adapter requirements](ADAPTER_REQUIREMENTS.md) |
| Security boundaries and private reporting | [Security policy](../SECURITY.md) |
| Threat review, negative tests and remaining findings | [Security review](SECURITY_REVIEW.md) |
| Planned integrations and acceptance criteria | [Roadmap](ROADMAP.md) |
| 50 researched integration candidates and priorities | [Device candidate catalog](DEVICE_ROADMAP.md) |
| Review, release and maintenance checklist | [Maintaining](MAINTAINING.md) |
| Source changes and known limits | [Changelog](../CHANGELOG.md) |
| Existing ecosystem and positioning | [Related projects](RELATED_PROJECTS.md) |
| Core and optional component licenses/provenance | [License](../LICENSE), [third-party notices](../THIRD_PARTY_NOTICES.md) |

Security problems belong in [private vulnerability reports](https://github.com/wudaming00/AnyAdapterHub/security/advisories/new), not public device reports. Do not attach credentials, encrypted enrollment files, maps, personal screenshots or unredacted diagnostics.

## Hardware evidence / 实测证据

- [LG OLED65B8PUA, firmware 05.50.70](evidence/lg-b8-2026-10-19.md).
- [Historical LG Hub control and observation checks](evidence/local-hub-2026-10-19.md).
- [Pinned LG control and visual movie-workflow retest](evidence/lg-b8-workflow-2026-10-19.md).
- [ECOVACS X11 read-only Hub checks](evidence/ecovacs-x11-2026-10-19.md).

Earlier LG records predate pinned transport; the linked retest establishes first enrollment and selected pinned controls on the exact B8. It does not validate every action or another model. A `playing` state is not title verification, and a device ACK is not completion.
