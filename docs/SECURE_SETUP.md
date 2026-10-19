# Encrypted credentials and transport

This revision requires protected secrets and pinned HTTPS for the running Hub.
It is a development preview, with no independent security audit. The supplied
production secret provider currently supports Windows CurrentUser DPAPI only.
macOS/Linux live enrollment and serving fail closed until a reviewed OS secret
provider is implemented; portable tests explicitly inject an in-memory provider.
Tests do not establish live support for another OS.

## Storage and communication

- Hub owner/client tokens, LG pairing keys and the Hub TLS private key are stored
  as versioned DPAPI ciphertext. There is no project master key, `.env` key or
  plaintext fallback. Encryption/decryption uses a fixed Windows PowerShell
  executable and private process pipes, never secret command-line arguments.
- The Hub certificate is generated with the fixed trusted Git for Windows
  OpenSSL executable. Private material stays in pipes/memory before DPAPI
  protection. Git/OpenSSL must be installed in the documented default location.
- The Hub binds only `https://127.0.0.1:8765`. A scoped client trusts its exact
  local certificate and checks the SHA-256 certificate pin, validity and hostname
  before sending its Bearer token. Grant hashes remain in SQLite. Device and
  action authorization is still checked before dispatch and during events.
- LG remote control requires WSS on port 3001 and a saved certificate pin. The
  connection checks the peer certificate **before** HTTP Upgrade/SSAP registration
  or pairing-key transmission. Pointer WSS and HTTPS capture use the same pin.
  No automatic WS/HTTP downgrade is available. A capture URL using HTTP is refused.
- Secret ciphertext is bound to its purpose. Hub token purposes include the origin
  and certificate pin; LG key purposes include the exact host and certificate pin,
  or an explicit pending-enrollment marker while the TV is unreachable.

DPAPI protects a copied file from routine decryption under a different OS account.
It cannot protect secrets from code already running as the current user, an
administrator, a compromised Hub/adapter, memory inspection or malicious OS
components. JavaScript/.NET strings cannot be reliably erased. Use separate OS
accounts and OS-enforced process/network restrictions for untrusted agents or
future untrusted adapters; this repository does not supply that sandbox.

## Existing installations

Stop the old daemon before migrating. Keep the existing private directory and
pairing files in place; do not print or upload their contents. Then run:

```sh
node device-hub.mjs migrate-security --tv-config .lg-tv.local.json --legacy-tv-config .lg-tv.legacy.local.json
node device-hub.mjs serve
```

Only specify pairing files that actually exist. The command finds the Hub's
enrolled LG configuration automatically; the extra options include other local
pairings. It encrypts owner/client files (including retained revoked clients),
creates the protected TLS identity, upgrades the registry and encrypts pairing
keys. Each encrypted record is staged and verified before replacement. No
plaintext backup is created. File replacement is per file, not a multi-file
transaction; interrupted migration is rerunnable. Do not serve during migration.

A TLS-only probe sends no pairing key and does not wake a TV. If the TV is off
or unreachable, secrets are still encrypted, but the TV is marked pending TLS
enrollment. It cannot be controlled through an unverified connection. When the
owner next turns it on, rerun migration and restart. A changed existing pin is
not automatically replaced. A certificate rotation needs explicit local review.

Initial pin enrollment trusts the first observation on the selected local
network (TOFU), so it cannot defeat an attacker already present at that moment.
Also, the [lgtv2 maintainers report shared LG certificates and private keys across
2018–2025 models](https://github.com/hobbyquaker/lgtv2#api). A matching factory
certificate therefore does not prove a unique household television. This specific
B8's certificate has not yet been retrieved under the new transport. Keep the
TV on an owner-controlled network; pinning alone is not a hostile-LAN guarantee.

Migration overwrites current configuration files. It does not erase historical
backups, crash dumps, previous exports, filesystem snapshots or SSD remnants.
Lost DPAPI profiles cannot be recovered from these ciphertext files alone;
re-enrollment is needed. Do not copy encrypted client files to another OS user
and expect them to work. Create separately enrolled credentials for that identity.

## New installations and optional features

```sh
npm ci --ignore-scripts
node device-hub.mjs init
node device-hub.mjs adapters
```

The empty core installs no TV WebSocket dependency or ECOVACS Python SDK. To
enroll LG explicitly:

```sh
npm run adapter:lg:install
node lg-tv.mjs certificate --host <TV_LAN_IP>
# Review the first-observed fingerprint on your trusted network.
node lg-tv.mjs pair --host <TV_LAN_IP> --certificate-pin <SHA256_HEX> --profile control
node device-hub.mjs add --tv-config .lg-tv.local.json --host <TV_LAN_IP>
node device-hub.mjs serve
```

`init/add` with a selected device explicitly enables its reviewed adapter.
`enable/disable --adapter NAME` changes whether that adapter loads on restart;
disabled enrolled configurations are not opened. Profiles cannot select arbitrary
packages or modules. Install commands are fixed reviewed operations, never an
agent response to device content.

Enhancements default to off. Local `features --device ID --features observer,media`
is a separate owner operation and requires restart. A client still needs exact
grants, and observation still needs `allowTemporaryObserver`, media files need
`mediaRoots`, and URLs need approved `allowedUrlOrigins`.

Temporary LG observation, DLNA and selected-file hosting still use legacy LAN
protocols (including HTTP callbacks/media). Their source-IP checks and ephemeral
tokens do not encrypt that leg or defeat a hostile LAN. Enabling these opt-in
features does not make them end-to-end encrypted. They remain disabled after
security migration. No Disney+ DOM or trusted content-title feedback is provided.

The reviewed ECOVACS worker retains its existing DPAPI enrollment and normal
vendor HTTPS. It is optional trusted executable code, not an OS sandbox or a
general cloud-token broker for arbitrary community plugins.

## SDK credential loading

```js
import { readJson } from '../lib/hub/config.mjs';
import { resolveCredential } from '../lib/security/credentials.mjs';
import { HubClient } from '../lib/hub/client.mjs';

const hub = new HubClient(await resolveCredential(await readJson('.device-hub/client.json')));
const state = await hub.state('living-room-tv');
```

Decrypt only a scoped client credential. Never give an agent the owner credential,
pairing key or unrestricted shell under the Hub's OS account. Tests have explicit
code-only injected transports/providers; no profile, CLI flag or environment
setting selects a plaintext production fallback.
