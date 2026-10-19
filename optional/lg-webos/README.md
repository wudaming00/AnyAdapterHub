# Optional LG webOS adapter

From the repository root, explicitly install the pinned WebSocket transport:

```sh
npm run adapter:lg:install
```

The core package declares `ws` as an optional peer. A clean core installation does
not install it. The install command uses a fixed reviewed package version, skips
lifecycle scripts and leaves the project's lockfile unchanged. It does not enable
the adapter, pair a TV, connect to a device or create client grants.

Enable `lg-webos` and enroll a paired TV through the local owner CLI. Each enrolled
TV defaults to basic controls. Explicit per-device features are:

| Feature | Operations made available |
| --- | --- |
| `media` | Native media URL playback, DLNA and local file casting |
| `observer` | Temporary state/screenshot observation on the exact reviewed model and firmware |

`observer` also requires the existing local `allowTemporaryObserver` opt-in.
Separate client capabilities and local URL/media-root policies still apply.
Remote playback keys such as pause remain part of basic controls.

See [modular architecture](../../docs/MODULAR_ARCHITECTURE.md) and the exact
[supported devices](../../docs/SUPPORTED_DEVICES.md). Existing encrypted pairing
material is resolved only by the local OS credential provider; enabling an adapter
does not permit plaintext credential fallback.
