# Third-party material

`third_party/lgtv2-pairing.json` is pinned public compatibility data from
[hobbyquaker/lgtv2](https://github.com/hobbyquaker/lgtv2/tree/80ef796846730cb4331f33be38221de7485afc55).
The original MIT notice is retained in `third_party/lgtv2-LICENSE.txt`; provenance,
revision and integrity hash are retained in `third_party/provenance.json` and
verified by the pairing loader. It is not a credential issued to AnyAdapter Hub.

`ws` is separately licensed by its upstream authors; its notice is installed
with the pinned dependency. No SlopBro autoroot payload or persistence installer
is included in the runtime package. Local lab reference downloads and diagnostic
scripts are excluded from packaging; any separately distributed third-party lab
source retains its own license and is not relicensed by this project's MIT license.

## Optional MQTT transport

The `mqtt-tls` adapter optionally imports **MQTT.js 5.16.1**, published as
[`mqtt`](https://www.npmjs.com/package/mqtt/v/5.16.1) by the
[MQTT.js project](https://github.com/mqttjs/MQTT.js). The fixed source version is
[v5.16.1](https://github.com/mqttjs/MQTT.js/releases/tag/v5.16.1), under the
[MIT license](https://github.com/mqttjs/MQTT.js/blob/v5.16.1/LICENSE.md). Its notice
credits the MQTT.js contributors and Adam Rudd. The upstream license and
transitive dependency notices accompany the separately installed package;
redistributors must preserve applicable notices.

The root declares this exact version as an **optional peer**, not a mandatory
core dependency. Only an owner's explicit `npm run adapter:mqtt:install` choice
installs it with lifecycle scripts disabled. Empty-core startup and disabled
MQTT registrations do not import the SDK. No broker credentials, SDK source or
`node_modules` are bundled in the public package. MQTT.js is a community
implementation of the MQTT standard, not a hardware-vendor SDK or a compatibility
endorsement for every MQTT publisher. The Home Assistant HTTPS adapter uses Node
built-ins and its documented REST API without a new vendor SDK dependency.

## Optional ECOVACS bridge

The JavaScript hub and adapter are MIT licensed. The separately executed
`optional/ecovacs/worker.py` is GPL-3.0-or-later and imports the separately
installed [deebot-client 18.7.0](https://github.com/DeebotUniverse/client.py/tree/18.7.0),
which is also GPL-3.0-or-later. Its complete license and provenance are included
under `optional/ecovacs/`. No SDK source, wheels, account enrollment, tokens,
device identifiers or Python environment are bundled.

The optional Windows DPAPI dependency is
[pywin32](https://github.com/mhammond/pywin32), installed separately with its
upstream license. Optional component notices are not replaced by the root MIT
license. A distributor combining these components must review the licenses for
their distribution; subprocess separation is not a blanket license exemption.
