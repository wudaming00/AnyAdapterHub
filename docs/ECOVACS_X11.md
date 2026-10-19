# ECOVACS X11 adapter

Status: **experimental, cloud dependent, Windows only**. This adapter is an
optional second device implementation. It does not extend an LG grant to a
vacuum, and it does not expose the ECOVACS account's other devices.

## Supported hardware and evidence

| Scope | Evidence | Claim |
| --- | --- | --- |
| US ECOVACS HOME DEEBOT X11 OmniCyclone, cloud device class `huhcip` | New optional worker read normalized status and 11 read-only setting/maintenance queries on reference hardware | Read-only worker verified; firmware unknown |
| New AdaptAny JavaScript adapter and local hub | A scoped HubClient read fresh state and normalized settings/counters; movement and cross-device requests were denied | Read-only hub verified; no movement verification |
| Pause, resume, stop, return while moving | Not independently verified on the physical robot through this bridge | Experimental commands; never describe ACK as completed movement |
| Other ECOVACS models, X1 OMNI, other regions or brands | Not verified | Rejected by this adapter |

The account may contain other robots. The worker requires the exact selected
device ID's SHA-256 fingerprint and exact model class before every operation.
It never selects the only available device as a fallback. Firmware compatibility
has not been established; no firmware version is inferred from the model.

## Exposed capabilities

| Capability | Behavior |
| --- | --- |
| `state.read` / `events.read` | Normalized battery, reachability, robot state, cleaning task state, paused flag and station state |
| `vacuum.details.read` | Read-only normalized settings and maintenance service counters |
| `vacuum.start` | Start whole-home automatic cleaning after fresh state preflight |
| `vacuum.pause` | Pause an active cleaning task after state preflight |
| `vacuum.resume` | Resume a paused task after state preflight |
| `vacuum.stop` | Stop the current task after state preflight |
| `vacuum.dock` | Request return to the station after state preflight |

All six action schemas take an empty object. Agent callers cannot supply device
IDs, cloud regions, URLs, command names, room IDs or vendor command parameters.
Settings modification, room cleaning, map/floor-plan export, room names, camera,
patrol, station service controls, firmware operations and account discovery are
not exposed. Cleaning/setting names are never used to construct commands.

Maintenance values are service counters, not measured physical wear. The X11 is
bagless; its upstream `dustBag` counter is marked not applicable. A zero counter
does not prove a broken component. Unsupported or unreadable fields remain
unknown, and station washing is distinguished from a moving cleaning robot.

## Owner configuration

This revision reuses a previously enrolled Windows-current-user DPAPI encrypted
ECOVACS record. A general login/enrollment interface is not included yet. A clean
installation without such a record must leave this optional adapter disabled.
Do not copy an account token, password or another household's enrollment into a
community device profile. Model profiles contain capabilities and evidence,
never an instance's authentication material.

Install the optional dependencies following
[`optional/ecovacs/README.md`](../optional/ecovacs/README.md). Store this config
outside the repository in a private owner controlled file:

```json
{
  "pythonPath": "C:\\private\\adaptany-ecovacs-venv\\Scripts\\python.exe",
  "credentialFile": "C:\\private\\ecovacs\\credentials.bin",
  "selectedDeviceSha256": "<64 lowercase hexadecimal characters from the enrolled selected device ID>"
}
```

`selectedDeviceSha256` is an instance binding, not a secret or a pairing proof.
It must be obtained from the selected device in the owner's encrypted local
enrollment; arbitrary cloud IDs are not accepted as API arguments. An owner
changing devices must explicitly update their local selection and binding.

Add the adapter to an existing local hub:

```powershell
node device-hub.mjs add --ecovacs-config C:\private\ecovacs.local.json
```

Restart the hub to load the changed registry. The owner then issues a separate
grant for the vacuum's opaque hub ID and only the needed capabilities. Use
`state.read,events.read,vacuum.details.read` for a read-only agent. Movement
requires its exact `vacuum.*` capability. The owner token remains local.

## Safety method and remaining limits

1. **Bind one robot.** The selected encrypted device ID must match the owner
   pinned SHA-256 value, account region must be US, model class must be `huhcip`,
   and the discovered device type must be a vacuum. Missing selection fails.
2. **Read before moving.** The worker queries allowlisted status commands first.
   Unknown/error/offline state blocks movement. Start rejects an already active
   task; resume requires pause, and pause requires an active cleaning task.
3. **Recheck authorization at dispatch.** After cloud preflight the worker emits
   `ready`. The hub rechecks grant/revocation/deadline in its shared device queue
   before sending the one-use dispatch message. The worker checks the deadline
   and rechecks the local device binding before its single movement call.
4. **Do not repeat uncertain writes.** The isolated SDK is pinned to 18.7.0 and
   its HTTP 502 retry count is forced to one. A timeout or lost reply after
   dispatch is unknown; neither the adapter nor hub retries the command.
5. **Observe rather than assume.** The worker reads state after the request.
   `accepted`, `state_verified`, and `verification_status` have separate meanings.
   `task_active_at_station` means station service has started, not completed
   cleaning. Every movement result keeps `taskComplete: false`.
6. **Minimize exposure.** The child process uses fixed executable/script arguments
   with no shell and a minimal system/user/temp/locale environment; unrelated API
   tokens, proxy settings and Python environment overrides are not inherited.
   Requests enter stdin; results are size/time bounded. Raw SDK
   logs, account identifiers, device identifiers, cloud endpoints and response
   objects are not returned in hub state. No public network listener is added.

The trusted local owner controls the Python executable, worker source and config.
This is not a sandbox against a compromised operating system or administrator.
The component relies on ECOVACS cloud authentication, TLS and availability; it
does not make the vacuum work offline. DPAPI enrollment works only under the
original Windows user. Review resolved Python dependencies before deployment.
The adapter has not received an independent security audit or physical movement
validation through the new bridge. Its read-only worker evidence does not validate
movement or other models. Keep it experimental until those checks pass.

## Upstream and license

The separately installed community SDK is
[`DeebotUniverse/client.py` 18.7.0](https://github.com/DeebotUniverse/client.py/tree/18.7.0),
licensed GPL-3.0-or-later. The optional worker is provided under the same license
with a [license copy](../optional/ecovacs/LICENSE) and
[provenance record](../optional/ecovacs/provenance.json). The Node hub remains
separately licensed; this documentation does not replace a redistribution review.
This integration is not an official ECOVACS API or an ECOVACS endorsement.
