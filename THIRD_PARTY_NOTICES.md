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
