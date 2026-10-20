# LG B8 pinned control and visual movie workflow

## Scope

Owner-authorized local testing on 2026-10-19 (America/Los_Angeles), Windows,
LG OLED65B8PUA, firmware 05.50.70. These are observations from one enrolled
television. Other models, firmware, providers and operating systems are not
validated by this record. Screens, account/profile details, viewing history,
addresses and credentials are deliberately excluded.

## Observed hardware results

- Existing encrypted pairing was preserved. The television's first TLS identity
  was enrolled through the selected local target, with no independent physical
  identity proof. Subsequent SSAP and pointer connections used the saved pin;
  there was no plaintext control fallback or automatic trust replacement.
- A network wake request was followed by fresh control readiness in the earlier
  authorized test. Wake latency remains installation dependent.
- The final standard `device-hub.mjs serve` process used the saved explicit
  interface directly. The earlier temporary process-wide TLS patch was no
  longer in the execution path. Fresh state, app inventory, Disney+ launch,
  navigation and observation worked through this standard process.
- The owner-requested movie was selected through the actual app search/results
  UI. The attached visual agent checked the exact title and year on details,
  activated the focused Continue control and retained the existing resume point.
- Two separate playback frames showed the requested title and increasing
  elapsed time. Both observations reported a full-screen Disney+ player in
  `playing`. The new workflow recorded `completed` with
  `verificationScope: agent_visual_and_system_player`,
  `agentReportedTitleVerified: true`, `deviceReportedTitleVerified: false`
  and `progressAdvanced: true`.
- Each accepted observation returned a real 1920x1080 JPEG and reported overlay
  closure, application restoration and temporary capture cleanup. The test grant
  was revoked after completion, leaving the movie playing.

## Failure behavior exercised

During development, an overly short freshness bound stopped a later key before
submission. Inspection distinguished dispatched keys from the known unsent
step. The final implementation records known unsent preflight cancellations,
supports fresh observation recovery, and allows at most 60 seconds of capture
age for model reasoning and encrypted checkpoints. A follow-up run completed.
This limit does not provide exclusive screen focus. The frame store separately
retains images for at most five minutes under its existing bounded policy.

The final connection's half-open/read timeout, pointer-only timeout, pin change,
missing source interface, response loss, restart, queued revocation/expiry and
cross-client lookup behavior were tested with offline injected faults. Those
fixtures are not evidence of every physical Wi-Fi outage condition. Possibly
delivered writes are never replayed; response-loss recovery uses a read-only
lookup of the original operation.

## Limits

The visual agent supplied the title/year/progress interpretation. The device
interface still supplies no authenticated movie-title field, and the adapter's
`titlePlaybackVerified` remains false. App foreground and `playing` alone cannot
identify a movie; a homepage preview is insufficient.

The optional observer still uses a model-specific temporary overlay and a legacy
LAN HTTP callback. Pinned control and encrypted journals do not encrypt that
callback. Callback routing still follows its existing LAN route selection;
explicit control-interface binding does not establish every multi-NIC case.
No root access, Disney+ DOM/account extraction, reliable content deep-link
contract, continuous video or actual 4K/HDR playback verification is established.
Login, PIN, purchase or unresolved profile screens require the owner's action.

See [movie workflow](../MOVIE_WORKFLOW.md), [secure setup](../SECURE_SETUP.md)
and [supported devices](../SUPPORTED_DEVICES.md).
