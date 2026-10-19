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

Install the optional dependencies into an owner managed virtual environment:

```powershell
py -3.14 -m venv C:\private\adaptany-ecovacs-venv
& C:\private\adaptany-ecovacs-venv\Scripts\python.exe -m pip install -r optional/ecovacs/requirements.txt
```

The two direct dependencies are pinned. Transitive dependencies are resolved by
pip; this is not a reproducible dependency lock. Review/pin their resolved graph
before a production deployment. The reviewed `deebot-client` version is 18.7.0;
the worker fails closed on another version. The worker disables the SDK's HTTP
502 retries to prevent a movement request being repeated automatically.

Run the pure safety tests without logging into an account or contacting a robot:

```powershell
& C:\private\adaptany-ecovacs-venv\Scripts\python.exe -m unittest discover -s optional/ecovacs -p test_worker.py -v
```

See [`docs/ECOVACS_X11.md`](../../docs/ECOVACS_X11.md) for the supported hardware,
configuration contract, evidence limits and safety boundary.
