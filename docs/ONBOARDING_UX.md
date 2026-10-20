# Simple setup and interface proposal / 简洁接入界面方案

**Design proposal, not a shipped interface.** The preview currently has a local
CLI, pinned Node SDK and JSON/SSE API. It has no graphical sign-in, browser
session, vendor-login wizard, discovery UI or theme renderer. The
[getting-started guide](GETTING_STARTED.md) remains the working setup procedure.

## Product decisions

- Do not require an AnyAdapter cloud account for local device use. Start with a
  household administrator and trusted local unlock; optional remote accounts
  are a separate future capability.
- Keep household sign-in, vendor-account authorization and agent permissions
  separate. Connecting a vendor account does not grant an agent access to every
  device on that account.
- Provide one common connection wizard and capability-based device cards.
  Adapters declare reviewed connection requirements; users should not build
  forms or edit JSON to enroll an ordinary supported device.
- Provide light, dark and high-contrast visual themes. Keep appearance separate
  from device identity, authentication and authority.
- Give AI an actionable [handbook](AI_ADAPTER_GUIDE.md) and automatic
  [repository entry point](../AGENTS.md). AI can prepare an adapter and tests;
  owners authorize local devices and project administrators approve shared code.

## First successful connection

```mermaid
flowchart LR
    A[Open local hub] --> B[Unlock household administrator]
    B --> C[Add device or vendor account]
    C --> D[Confirm selected device and local pairing]
    D --> E[Choose agent permissions]
    E --> F[Read status and finish]
```

This is a target interaction, not a set of new API endpoints. Permission,
pairing, certificate or provider failures must remain visible rather than be
skipped to achieve a fixed number of screens.

| Screen | Main interaction | Keep out of the ordinary flow |
| --- | --- | --- |
| Welcome / household unlock | Open this installation and establish or unlock the local administrator | Mandatory cloud registration, copying owner tokens, disabling certificate warnings |
| Add device | Choose a reviewed connector; show discovered candidates only when that connector implements discovery; offer a manual address alternative | Arbitrary network scans, plugin install scripts, unimplemented vendor-login choices |
| Connect account or pair | Explain the actual connector flow; let the owner authorize in the official provider UI or on the device where supported | Passwords in AI chat, embedded credential collection presented as an official login |
| Confirm device | Identify the selected device/account region and distinguish duplicates; request explicit first trust where needed | Automatically enrolling an entire vendor account or silently accepting a changed certificate |
| Permissions / finish | Show natural-language rights, device scope, duration and an easy revoke control; finish with a read-only status check | Default full control, hidden screenshots/maps access, test movement or automatic wake |

LG should explain the television's local pairing prompt. ECOVACS should expose
only its implemented account/region and selected-device flow. The current worker
requires existing encrypted enrollment; a general account wizard still needs
implementation. Do not imply either vendor supports OAuth or device-code login
unless that exact integration has been verified.

Offer only necessary choices initially: household/device name, required
connection/consent and permissions. Put installation paths, ports, retention and
protocol diagnostics in advanced settings. Show an actionable reason and retry
or cancel path when authorization expires, a device is offline or first trust
cannot be established. Preserve safe progress without persisting passwords or
repeating an ambiguous action.

## Trust boundary for the interface

Prefer a shared local UI delivered with a trusted launcher/host. A narrow local
broker should hold OS-protected credentials, validate the Hub certificate/pin
and expose bounded setup operations and short-lived UI sessions. This is a
proposed component; it is not supplied by the existing JSON API.

An ordinary browser cannot use the current Node client's custom TLS trust or
decrypt Windows DPAPI. Do not turn a copied owner token, certificate bypass,
JavaScript-accessible credential or unrestricted native bridge into a shortcut.
Pure-browser hosting needs an explicit certificate-trust and session design;
desktop hosting needs a restricted renderer/IPC design. Neither is automatically
secure because it runs on localhost.

Before UI implementation is considered ready, provide:

1. A locally authorized, single-use initial setup bootstrap with expiry and
   replay protection; the first network visitor must not become administrator.
2. Administrator unlock, logout, expiry, revocation and step-up consent for
   credential/enrollment/permission changes. No UI session may expose the
   long-lived owner bearer token.
3. Same-origin session and CSRF defenses, exact origin/host validation, bounded
   bodies and restrictive content policy. Use an appropriate protected cookie
   or restricted IPC contract; neither is a universal API or shell proxy.
4. Typed, reviewed setup jobs with explicit states, cancellation/expiry and
   target binding. No arbitrary module, URL, executable or vendor command input.
5. Credentials delivered directly to the trusted broker and OS vault. Use an
   external official authorization flow where available. Keep account passwords,
   OTPs, codes, cookies, refresh tokens and pairing keys out of model context,
   theme state, analytics and browser storage. Bind each authorization to its
   local transaction and reviewed provider origin; validate state, exact redirect
   targets and PKCE where applicable. Expire device codes and never accept
   authorization links or codes supplied by unrelated device content.
6. An explicit enrollment commit and controlled configuration reload/restart.
   Current CLI changes require restart; a UI cannot imply immediate hot loading.

For native OAuth integrations, an external authorization user agent is the
standard pattern in [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252).
[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) defines a device-code flow for
providers that actually support it. Browser session identifiers should not be
stored in local storage; see the
[OWASP HTML5 guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html).

## Visual themes and device templates

Start with three first-party themes: light, dark and high contrast. A theme may
choose bounded, schema-validated colors, typography scale, spacing and corner
radius. Do not accept arbitrary HTML, JavaScript, CSS, external URLs, filesystem
paths, module names or executable expressions. Themes do not define permissions,
network destinations, tools or authentication flows. The strict token schema and
renderer are future work; a theme file is not currently loaded by the Hub.

Separately provide reviewed device-card layouts for a television, vacuum and
future light/plug. Layouts select familiar presentation for existing granted
capabilities; they do not add capabilities. If brightness or a camera view is
not implemented and granted, its control is absent rather than simulated.

Display permissions as understandable choices such as “read status”, “control
playback” and “view screen”. Show expiry and revoke. Distinguish “request
accepted”, “effect confirmed”, “status unknown” and “offline” with text as well
as appearance. Uncertainty and denied access must survive theme changes.

Scene/automation templates are a third, later concern. They can cause effects
and require explicit device binding and permission review; they are not visual
themes and must not be enabled by selecting an appearance preset.

## Delivery order and acceptance

1. **Now:** maintain the real CLI/API guides, AI handbook and this interface
   proposal. Do not advertise account/UI support that does not exist.
2. **First UI:** implement local trust/session/setup boundaries, then connect
   one LG with the shared wizard, read status, issue/revoke a narrow client
   grant and demonstrate recovery without token handling by the user.
3. **Next:** implement the reviewed ECOVACS account enrollment flow; reuse the
   wizard shell and per-device permission page without general vendor RPC.
4. **Then:** add the three theme presets and capability-based layouts, followed
   by compatible connector descriptors and independently reviewed adapters.

Verify a fresh install and an existing household, wrong region/device,
cancelled pairing, unavailable provider, changed certificate, expired/revoked
session, denied permissions and optional dependencies being absent. Defaults
must not cause household effects or publish secrets. Submit implementation as a
reviewed change with CI and [administrator approval](AGENT_REVIEW.md), not as an
unrestricted AI-generated plugin or a promise made by the design document.
