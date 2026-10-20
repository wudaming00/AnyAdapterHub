# Plex server identity (experimental)

This adapter reads the public identity of one owner-selected Plex Media Server
through one pinned HTTPS origin. No hardware or installed PMS version has been
verified; tests use synthetic responses and loopback HTTPS servers.

The [official PMS API reference](https://developer.plex.tv/pms/#tag/General/operation/getIdentity)
documents `GET /identity`, its JSON `MediaContainer` response and authorization
`None`. The [API information](https://developer.plex.tv/pms/#section/API-Info)
explains that JSON must be explicitly requested. This adapter sends
`Accept: application/json` and deliberately collects, stores and sends **no
Plex token**, cookie or client identifier. This public endpoint does not prove
token validity, account ownership, access to a library or playback capability.

The configuration accepts exactly `origin`, `certificate`, `certificatePin`,
`machineIdentifier` and optional `timeoutMs`. The origin must be canonical HTTPS
with no route, query, fragment or credentials; timeout is 100–15000 ms, default
8000. The existing secure local file handling protects the owner metadata.
`protectPlexConfig` validates and freezes it; it does not encrypt or request a
credential provider because this path has no authentication secret.

TLS 1.2 or later, ordinary certificate name/chain verification and the explicitly
enrolled leaf SHA-256 pin are all required before HTTP is sent. The
[official secure connections guidance](https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/)
describes Plex secure server connections. The owner must choose a name which
matches their enrolled certificate, such as an applicable `plex.direct` origin;
there is no HTTP downgrade, automatic trust, alternate certificate name or
redirect following. Enrollment does not discover, pair or claim a server.

Only `/identity` is requested. The reply must identify the exact enrolled
`machineIdentifier`, have `size:1`, and report a boolean `claimed` flag. State
projects `fields.server.value` with `available`, `claimed` and `version` only.
`available` means a matching identity was read; `claimed` is the server's own
claim status. Version is returned only for a bounded four-part numeric version
with an optional alphanumeric suffix; other version text becomes `null`.
Server identifiers, addresses, labels and arbitrary response fields do not
enter state or events.

The field source is `plex-https`, verification is
`server-reported-selected-identity`, and expiry is 30 seconds after the read
began. Polls and explicit reads share one bounded queue; polling runs no faster
than once every 10 seconds. Failed reads retain the earlier evidence expiry;
closing aborts active work and prevents late results. Unsafe `DEBUG`,
`NODE_DEBUG` or `NODE_DEBUG_NATIVE` settings prevent transport use; clear them
without printing their values.

The adapter advertises no actions or optional control features. It never reads
libraries, media metadata, history, sessions, clients, accounts, remote-access
configuration or images; it cannot cast or control playback. Installing it adds
no mandatory SDK dependency and grants no household authority.
