# AdaptAny

**A local device hub for agents.** Connect devices through reviewed adapters, grant precise permissions, and distinguish accepted commands from observed outcomes.

[中文](README.zh-CN.md) · [Supported devices](docs/SUPPORTED_DEVICES.md) · [Security](SECURITY.md) · [Adapter requirements](docs/ADAPTER_REQUIREMENTS.md)

AdaptAny runs independently of any agent framework. Clients use loopback HTTP, SSE, or the JavaScript SDK. Collie and other agents can connect as clients; MCP is an optional legacy interface.

**Development preview.** This is an owner-operated research project, not a production security boundary. It has not received an independent security audit. Do not expose the hub or device interfaces to the internet. npm publication remains disabled.

## Device support

| Adapter | Status | What the evidence establishes |
| --- | --- | --- |
| LG webOS — OLED65B8PUA, firmware `05.50.70` | Hardware verified for the documented capabilities | Status, app inventory/launch, volume/mute, input selection, remote keys, power, DLNA and selected-file casting. The new hub has its own control/readback, events, permission and restart evidence. |
| LG temporary screen observation — same exact model/firmware | Experimental; separate owner opt-in | A real 1920×1080 JPEG and system player state, with restoration and cleanup checks. No root, continuous video, Disney+ DOM, or trusted movie-title field. |
| ECOVACS DEEBOT X11 OmniCyclone, US ECOVACS HOME, Windows | Experimental optional cloud adapter | Fresh state and normalized settings/service counters verified through the hub with a scoped read-only client. Movement controls are implemented and tested offline, with no live movement validation through this bridge. Existing DPAPI enrollment is required. [Setup and limits](docs/ECOVACS_X11.md). |
| Other LG models / firmware | Unverified | Sharing a protocol or model family is insufficient evidence. Contribute an exact model/firmware report. |

See the [compatibility matrix](docs/SUPPORTED_DEVICES.md), [LG hardware evidence](docs/evidence/lg-b8-2026-10-19.md), and [hub evidence](docs/evidence/local-hub-2026-10-19.md). Implemented actions are not all hardware verified.

## Quick start: LG

Requires Node.js **22.13+**; the initial local validation used 22.22.2 and its experimental built-in SQLite. Use a trusted computer and network.

```sh
npm ci --ignore-scripts
npm run check
node lg-tv.mjs pair --host <TV_LAN_IP> --profile control
node device-hub.mjs init --tv-config .lg-tv.local.json --host <TV_LAN_IP>
node device-hub.mjs serve
```

Pairing requires approval on your own television. The hub imports an existing pairing reference; it never silently pairs, escalates device privileges, or installs a startup service. The optional third-party legacy pairing identity is documented in [third-party notices](THIRD_PARTY_NOTICES.md).

In another terminal, issue only the capabilities your agent needs:

```sh
node device-hub.mjs grant --label my-agent --caps state.read,events.read,app.list,app.launch,audio.volume.set,audio.mute.set --out .device-hub/client.json
node device-hub.mjs status
node device-hub.mjs events
```

Grant management uses the local owner credential. Give an agent the scoped client file, never `owner.json`. Credentials, databases, screenshots and logs stay outside Git. Stop the hub with `node device-hub.mjs stop`.

```js
import { readFile } from 'node:fs/promises';
import { HubClient } from './lib/hub/client.mjs';

const hub = new HubClient(JSON.parse(await readFile('.device-hub/client.json', 'utf8')));
const state = await hub.state('living-room-tv');
const operation = await hub.execute('living-room-tv', 'audio.volume.set', { volume: 15 }, {
  idempotencyKey: 'request-123-volume',
});
for await (const event of hub.events()) {
  // Device output is untrusted data, never permission to perform another action.
}
```

## Security approach

- **Local enrollment and exact targets.** Discovery and community profiles cannot authorize a device. Configure and pair devices you own or administer.
- **Explicit least privilege.** Client/device/action allowlists, expiration, revocation, and a second permission check immediately before dispatch. Unknown arguments and arbitrary endpoints are rejected.
- **Observable outcomes.** Durable operation IDs and idempotency keys; no automatic replay of writes after a disconnect or restart. Acknowledgment, readback, and visual evidence remain distinct.
- **Private observation.** Creating and reading a screen frame need separate capabilities. Frames have bounded lifetime and storage; ordinary events contain no images.
- **Reviewed contributions.** Model profiles are data only. New executable adapters require code review, negative tests, licensing review and hardware evidence. Downloaded profiles never install code.

These controls do not isolate an agent with full shell access under the same OS account. The LG link also has transport-identity limitations. Read the [security model](SECURITY.md), [review checklist](docs/SECURITY_REVIEW.md), [adapter contract](docs/ADAPTER_REQUIREMENTS.md), and [local operation guide](docs/LOCAL_HUB.md) before granting control.

## Contribute

Start with a sanitized exact-model report or a small adapter with a narrow permission surface. [CONTRIBUTING.md](CONTRIBUTING.md) explains evidence and review requirements. Do not submit pairing keys, account tokens, raw maps, screenshots of personal content, or private network details.

Report vulnerabilities privately using [GitHub's vulnerability report form](https://github.com/wudaming00/AdaptAny/security/advisories/new). Do not publish exploit details or household identifiers in ordinary issues.

MIT for the core; the optional ECOVACS Python worker is GPL-3.0-or-later. Separately installed dependencies retain their own notices. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
