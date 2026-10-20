# Optional ECOVACS worker

This directory is an optional Python subprocess component, licensed under
GPL-3.0-or-later (see `LICENSE` and the SPDX identifier in `worker.py`). It imports
the separately installed community `deebot-client` package. No SDK code, Python
environment, credentials, device IDs, floor plans or map images are bundled.

The Node hub and its JavaScript adapter do not import Python or depend on MCP.
They exchange a small fixed JSON protocol with this helper over private child
process pipes. This explicit component boundary is documented rather than a
claim that process separation automatically determines all licensing questions.
Redistributors must preserve the applicable licenses and source obligations.

This bridge currently supports only a US ECOVACS HOME **DEEBOT X11
OmniCyclone** (cloud class `huhcip`) on **Windows**, under the original enrollment
user. Python **3.14 or newer** is required by the reviewed SDK. It depends on
ECOVACS cloud availability; it does not provide an offline local robot protocol.

Install the optional dependencies into an owner managed virtual environment.
Replace this inert directory placeholder with an owner-selected absolute local
path before running the example:

```powershell
$ECOVACS_VENV = '<ABSOLUTE_LOCAL_VENV_DIRECTORY>'
py -3.14 -m venv $ECOVACS_VENV
& "$ECOVACS_VENV\Scripts\python.exe" -m pip install -r optional/ecovacs/requirements.txt
```

The direct requirements are `deebot-client==18.7.0` and `pywin32==312` on Windows.
Transitive dependencies are resolved by
pip; this is not a reproducible dependency lock. Review/pin their resolved graph
before a production deployment. The reviewed `deebot-client` version is 18.7.0;
the worker fails closed on another version. The worker disables the SDK's HTTP
502 retries to prevent a movement request being repeated automatically.

Installation does not enroll an account or robot. There is no general enrollment
wizard in this revision. An owner must already have a compatible Windows
CurrentUser DPAPI-encrypted ECOVACS enrollment containing an explicit selected
device. Keep the adapter disabled when that prerequisite is unavailable. Do not
export tokens/passwords, select the only discovered robot, or put household
enrollment material into a public model profile.

The private owner JSON configuration references an absolute Python executable,
the existing encrypted enrollment file and the exact selected-device SHA-256
fingerprint. It contains metadata; it is not itself the account's encrypted
record. The worker only accepts the fixed actions and empty arguments exposed
by the JavaScript adapter. The Node process invokes the absolute executable with
`-I -B -u`, a fixed script path, no shell and a fixed environment allowlist.
Requests and results use bounded private stdin/stdout pipes; no MCP server or
network listener is started.

Run the pure safety tests without logging into an account or contacting a robot:

```powershell
& "$ECOVACS_VENV\Scripts\python.exe" -I -B -m unittest discover -s optional/ecovacs -p test_worker.py -v
```

The current hardware evidence covers normalized status and read-only
settings/service-counter queries through both worker and hub. Movement commands
are implemented but have not been physically verified through this bridge.
Other regions, models, maps, room commands, cameras and setting writes are
unsupported. Keep the adapter experimental and give agents only the required
device/capabilities; a read-only grant does not need any movement permission.

See [`docs/ECOVACS_X11.md`](../../docs/ECOVACS_X11.md) for the supported hardware,
configuration contract, evidence limits and safety boundary.
