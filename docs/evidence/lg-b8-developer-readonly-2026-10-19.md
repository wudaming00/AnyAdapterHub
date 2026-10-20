# LG B8 Developer Mode read-only diagnostic

## Scope

Owner-authorized local diagnostics on 2026-10-19 (America/Los_Angeles), Windows,
against one selected television. Historical identity baseline: OLED65B8PUA,
firmware 05.50.70. Identity was not freshly reread in this run.
Other devices, firmware and platforms are not validated by this record.

This summarizes ignored local diagnostic helpers. The public adapter does not
expose SSH, root access or a semantic Disney+ API. Addresses, credentials,
fingerprints, account details, private local paths and raw payloads are omitted.

## Connection and credential handling

<a id="developer_ssh_readonly"></a>

The owner explicitly approved the observed first SSH host-key fingerprint;
this was first-use trust, not independent physical identity attestation.
Read-only authentication succeeded, and the local broker saved the credential
using Windows CurrentUser DPAPI, bound to the selected target and SSH identity.
A saved-credential reconnect verified the pin and succeeded without Key Server
retrieval, OCR or credential-entry UI. SSH connection closure was confirmed.

The reviewed broker excluded secrets from command arguments and diagnostic
logs and kept decrypted key material within its local execution boundary.
DPAPI does not protect against code running as the same OS user or an admin.
These statements concern this diagnostic, not all earlier user communications.

LG documents development access through
[ares-setup-device](https://webostv.developer.lge.com/develop/tools/cli-dev-guide#ares-setup-device)
and [ares-novacom](https://webostv.developer.lge.com/develop/tools/cli-dev-guide#ares-novacom).
These interfaces do not establish access to every retail app's files or state.

## Fresh observations

<a id="disney_static_files_unavailable"></a>

- Live SSAP metadata reported Disney+ 24.5.8, type `web`, `main: index.html`,
  `inspectable: false`, retail installation layout and the declared template
  `contentTarget: $CONTENTID`. No in-app search or voice-intent routing metadata
  was advertised in the inspected fields; private implementations remain unknown.
- SSH port 9922 was reachable and authenticated; inspector ports 9998 and 9999
  timed out. Timeouts do not establish permanent unavailability.
- SFTP checked only `appinfo.json` and `index.html` under the two fixed roots
  below. All four files returned not found.
- Following the official CLI [`streamGet` implementation](https://github.com/webos-tools/cli/blob/main/lib/base/novacom.js), the
  reviewed local helper issued fixed `/bin/cat` commands for the two retail files.
  Both returned not found, not denied.

| Checked installation root | Result |
| --- | --- |
| `/media/cryptofs/apps/usr/palm/applications/com.disney.disneyplus-prod/` | Both fixed files not found. |
| `/media/developer/apps/usr/palm/applications/com.disney.disneyplus-prod/` | Both fixed files not found. |

These results are consistent with Developer Mode jail mount isolation. They do
not prove this B8's mount table, Disney+'s absence or a requirement for root.
No bootstrap contents were obtained or filesystem enumeration performed.

## Effects and limits

No TV writes, root exploit, installation, jail-config access, permission change
or system change occurred. The protected local credential record was retained.
No screenshot was requested because the Developer Mode screen exposes credentials.
No movie selection, app internal state, DOM access or requested-title playback
was verified. Connection success and app metadata do not prove content playback;
this record makes no playback-latency claim. Earlier visual results remain in the
[workflow retest](lg-b8-workflow-2026-10-19.md). This diagnostic adds no public
capability, client grant or [verified device support](../SUPPORTED_DEVICES.md).
