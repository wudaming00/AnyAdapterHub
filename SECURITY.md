# Security policy

AdaptAny can operate household devices and, when separately authorized, read a television's screen. Treat control and observation credentials as access to your home. This early project has not received an independent security audit or certification. Passing tests and publishing source do not establish a security guarantee.

The implementation review, regression tests, remaining risks and release checklist are in [Security review](docs/SECURITY_REVIEW.md). New adapters must meet [Adapter requirements](docs/ADAPTER_REQUIREMENTS.md).

## Deployment boundary

Run the Hub on a computer, OS account and local network you trust. Its HTTP API binds to `127.0.0.1`; it is not designed for public exposure or arbitrary LAN clients. A reverse proxy, tunnel, port forward, permissive CORS or broader bind address requires a separate authentication and transport review.

The Hub protects its API against clients with narrower grants. It does **not** sandbox code running as the same OS user. An agent that can read owner files, execute local code or change the Hub can bypass API permissions. Use separate OS accounts or a suitable process/container boundary for an untrusted agent. That isolation is a deployment responsibility, not an isolation facility supplied by AdaptAny.

Only operate devices you own or are authorized to manage. Discovery and reachability do not establish ownership. Setup must deliberately bind a local opaque device ID to one selected device, region/account where applicable, and owner-approved credentials. Never select the first discovered device as a fallback.

## Enforced API controls

- HTTP checks an exact loopback Host, any supplied Origin and a Bearer credential. Tokens are not accepted in query strings. Grant management and shutdown require the separate owner credential.
- Grants name exact device IDs and capabilities and have explicit expiry. Revocation/expiry are checked during event delivery and before queued dispatch. LG repeats checks immediately before writes following asynchronous app lookup, keyboard focus and connection setup, and before each DLNA playback step.
- Requests use fixed action IDs and bounded schemas. Community profiles cannot supply code, network destinations, raw protocol methods, file access or additional authority. Ordinary LG app launch rejects privileged or unclassified overlays.
- Each device has a serial queue. Mutations require client-scoped idempotency keys; conflicting reuse is rejected. After restart, interrupted queued operations are cancelled and running operations become `unknown`. Ambiguous writes are not replayed or automatically retried.
- Ordinary state, app inventory, temporary capture and saved-frame access require different capabilities. Images do not enter ordinary state/events. Read-only state access does not imply app listing, capture, images or control.

Revocation cannot undo a dispatched action, recover a disclosed image or retract bytes already delivered. A started observation continues its restricted cleanup so the Hub can close its own overlay and restore the previous app. A dispatch deadline cannot cancel an effect already accepted by a device or cloud service.

## Permissions that need special care

Navigation, pointer input, text entry, URL access, casting and vacuum movement are consequential permissions. A permitted key/click can interact with purchases, accounts or settings inside the current app. AdaptAny does not understand every app's UI and has no app-independent purchase, parental-control or setting-confirmation policy. Do not give broad UI permissions to an untrusted agent assuming every permitted sequence is safe.

Screens, webpages, subtitles, app metadata, room names, device strings and contributed evidence can contain prompt injection. Treat them as untrusted data. They cannot authorize tool calls, grant capabilities, disclose secrets or change dispatch targets. Keep policy and owner approval outside model-generated text. `playing` may describe a homepage preview; foreground/transport checks do not prove a particular title is playing or a cleaning task is complete.

## Network and device identity limits

Some LG protocols use HTTP or WebSocket without authenticated encryption. Current LG WSS and pointer-WSS accept the TV's self-signed certificate without certificate pinning. DLNA is unauthenticated. Local IP matching, pairing material, selected-device fingerprints and per-run tokens reduce accidental substitution; they do not provide cryptographic protection against every LAN impersonation or middleperson attack. DHCP reuse or a compromised router/device can violate this boundary.

Temporary LG observation is off until explicitly enabled in local owner configuration. It checks the exact reviewed model/firmware and uses a fixed bundled bridge, random per-run token, exact TV source IP, fixed routes and bounded time/data. It exposes no arbitrary Luna, shell, rooting or firmware-flashing tool. It closes the overlay/listener, restores the app and reports whether owned capture cleanup was verified. Source-IP filtering and a token sent over HTTP are not authenticated encryption. Do not use this model-specific channel as a permanent general management service.

External URLs must match exact owner-configured `allowedUrlOrigins`; default is deny. Excluded literal addresses, credentials and unapproved origins are rejected. These checks do not prove a hostname's DNS result or redirects subsequently followed by the TV. Use trusted origins; device-side DNS/redirect containment remains unresolved.

## Credentials, files and image privacy

The dedicated Hub home uses POSIX owner-only modes or a verified Windows DACL limited to the current user and SYSTEM. Initialization requires a new/empty dedicated directory; existing non-Hub directories, links/junctions and unsuitable file ownership are rejected. Scoped client credentials are stored as hashes in SQLite. Owner/client CLI files and LG pairing configuration still contain plaintext secrets protected by OS access control. External pairing files are not migrated or protected by Hub initialization. No OS keychain integration is provided for these LG/Hub secrets.

The optional ECOVACS adapter uses a separately configured encrypted credential file and isolated, version-pinned Python helper. Its selected device and US account region are checked; only reviewed commands are exposed. An upstream account can cover more devices than one client grant; vendor/cloud trust remains necessary. This is not an offline local-control protocol. See adapter documentation for prerequisites and hardware-validation limits.

Local media sharing is off until `mediaRoots` are configured. The host checks real paths, types and directory boundaries and serves the same validated open file handle. Same-user unrestricted filesystem/code access is outside this boundary. Do not put credential/configuration directories in media roots.

Frames expire within five minutes, with at most five per device and 32 MiB globally. Expired frames are immediately unreadable through the API; logical pruning runs every 30 seconds. `screen.read` permits retained frames for that device, rather than only one requester's captures. Exported images are outside this retention policy. SQLite `secure_delete` does not guarantee forensic erasure of WAL, backups, crash remnants or storage media.

The journal retains 10,000 events; cursors can have gaps. Operation/idempotency records remain for the database lifetime to prevent replay. There is no automatic archival, lifetime database quota or sustained client rate limit. Monitor disk use. Deleting deduplication history does not make resubmitting an old command safe. Keep logs, exports, credentials and household maps out of Git and public diagnostics.

## Community code and dependencies

Profiles are validated data; adapter code, JavaScript dependencies, interpreters and optional SDKs execute with the Hub user's authority. They are **not sandboxed plugins**. Review code, dependency changes, installation hooks, destinations and privilege expansion before enabling them. Use the lockfile and reviewed optional versions. Contributor evidence does not itself prove ownership, authenticity or compatibility.

Locks, alarms, cameras, heaters and critical loads need separate safety/privacy review and distinct capabilities. Existing TV, vacuum or generic switch permissions must not silently expand to those classes.

## Reporting vulnerabilities

Use GitHub's **Report a vulnerability** option if private vulnerability reporting is enabled. Otherwise ask a maintainer to establish a private channel before sending details. Do not disclose an active vulnerability, bearer token, pairing key, account record, raw household diagnostic or personal screenshot in a public issue.

Include the affected revision/component, model/firmware where relevant, sanitized minimal reproduction and impact. Prefer synthetic data. There is no promised response SLA, bounty or supported security-maintenance window. A source fix does not update an already running installation; install the patched revision and restart.
