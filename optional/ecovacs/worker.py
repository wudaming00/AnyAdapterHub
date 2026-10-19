# SPDX-License-Identifier: GPL-3.0-or-later
"""Optional, isolated ECOVACS X11 HTTPS bridge. JSON stdin/stdout; no server or MCP.

This helper imports the separately installed GPL-3.0-or-later deebot-client.
It is deliberately version pinned because command classes and retry behavior
are part of the adapter's reviewed safety boundary. No vendor code is bundled.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from datetime import UTC, datetime
from hashlib import sha256
from importlib.metadata import version
import json
import logging
import math
import os
from pathlib import Path
import sys
import uuid

LIMIT = 16 * 1024
CONTROLS = {"vacuum.start", "vacuum.pause", "vacuum.resume", "vacuum.stop", "vacuum.dock"}
ACTIONS = CONTROLS | {"status", "vacuum.details.read"}


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code


def read_message():
    line = sys.stdin.buffer.readline(LIMIT + 1)
    if len(line) > LIMIT or not line.endswith(b"\n"):
        raise BridgeError("INVALID_ARGUMENTS")
    try:
        value = json.loads(line)
    except (ValueError, UnicodeError):
        raise BridgeError("INVALID_ARGUMENTS") from None
    if type(value) is not dict:
        raise BridgeError("INVALID_ARGUMENTS")
    return value


def send(kind, **data):
    sys.stdout.write(json.dumps({"type": kind, **data}, ensure_ascii=True, allow_nan=False) + "\n")
    sys.stdout.flush()


def validate_request(value):
    if set(value) != {"action", "credentialFile", "selectedDeviceSha256"} or value.get("action") not in ACTIONS:
        raise BridgeError("INVALID_ARGUMENTS")
    fingerprint = value.get("selectedDeviceSha256")
    if type(fingerprint) is not str or len(fingerprint) != 64 or any(c not in "0123456789abcdef" for c in fingerprint):
        raise BridgeError("INVALID_ARGUMENTS")
    file = value.get("credentialFile")
    if type(file) is not str or not Path(file).is_absolute() or "\0" in file or file.startswith(("\\\\", "//")):
        raise BridgeError("INVALID_ARGUMENTS")
    return value


def selected_matches(record, fingerprint):
    selected = record.get("selected_device_id")
    return type(selected) is str and bool(selected) and sha256(selected.encode()).hexdigest() == fingerprint


class EncryptedStore:
    def __init__(self, file, fingerprint):
        if os.name != "nt":
            raise BridgeError("WINDOWS_DPAPI_REQUIRED")
        self.file, self.fingerprint = Path(file), fingerprint

    def load(self):
        import win32crypt
        info = self.file.lstat()
        if not self.file.is_file() or self.file.is_symlink() or info.st_nlink != 1 or info.st_size > 1024 * 1024:
            raise BridgeError("CREDENTIALS_UNAVAILABLE")
        try:
            clear = win32crypt.CryptUnprotectData(self.file.read_bytes(), None, None, None, 0)[1]
            record = json.loads(clear)
        except Exception:
            raise BridgeError("CREDENTIALS_UNAVAILABLE") from None
        if type(record) is not dict or record.get("country") != "US" or not record.get("account") or not selected_matches(record, self.fingerprint):
            raise BridgeError("SELECTED_DEVICE_MISMATCH")
        if any(key in record for key in ("password", "password_hash", "code")):
            raise BridgeError("CREDENTIALS_UNAVAILABLE")
        return record

    def save_account(self, account):
        import win32crypt
        # Re-read to avoid restoring an old selection after another owner process changed it.
        record = self.load()
        record["account"] = account
        encrypted = win32crypt.CryptProtectData(json.dumps(record).encode(), "AdaptAny ECOVACS", None, None, None, 1)
        temporary = self.file.with_name("credentials-" + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(encrypted)
            os.replace(temporary, self.file)
        finally:
            temporary.unlink(missing_ok=True)


def configure_dependencies():
    if version("deebot-client") != "18.7.0":
        raise BridgeError("DEPENDENCY_VERSION_UNREVIEWED")
    import deebot_client.authentication as authentication
    # Upstream retries 502 responses; a movement request must be sent at most once.
    # This private worker owns its interpreter, so the guard also covers SDK requests.
    authentication.MAX_RETRIES = 1
    if authentication.MAX_RETRIES != 1:
        raise BridgeError("RETRY_GUARD_UNAVAILABLE")


async def blocked_refresh(_command):
    raise BridgeError("BACKGROUND_COMMAND_DENIED")


def response_body(raw):
    if type(raw) is not dict:
        return {}
    response = raw.get("resp", raw)
    if type(response) is not dict:
        return {}
    return response.get("body", {}) if type(response.get("body", {})) is dict else {}


def code_is(body, number):
    code = body.get("code")
    return type(code) is int and code == number or type(code) is str and code == str(number)


async def status(auth, info):
    from deebot_client.commands.json.battery import GetBattery
    from deebot_client.commands.json.charge_state import GetChargeState
    from deebot_client.commands.json.clean import GetCleanInfo, GetCleanInfoV2
    from deebot_client.commands.json.work_state import GetWorkState
    from deebot_client.event_bus import EventBus
    from deebot_client.events import BatteryEvent, StateEvent, StationEvent
    allowed = {GetBattery, GetChargeState, GetCleanInfo, GetCleanInfoV2, GetWorkState}
    caps = info.static.capabilities
    bus = EventBus(blocked_refresh, caps)
    reached, charging_error, task_state, paused = False, False, "unknown", None
    try:
        commands = list(caps.battery.get) + list(caps.state.get)
        commands.sort(key=lambda command: type(command) is GetChargeState)
        for command in commands:
            if type(command) not in allowed:
                continue
            try:
                async with asyncio.timeout(4):
                    result = await command.execute(auth, info.api, bus)
                reached = reached or result.device_reached
                body = response_body(result.raw_response)
                if type(command) is GetChargeState and (code_is(body, 3) or code_is(body, 5)):
                    charging_error = True
                data = body.get("data")
                if type(command) is GetWorkState and result.device_reached and code_is(body, 0) and type(data) is dict:
                    robot = data.get("robotState", {})
                    reported = robot.get("state") if type(robot) is dict else None
                    task_state = reported if reported in ("idle", "cleaning") else "unknown"
                    raw_paused = data.get("paused")
                    paused = raw_paused if type(raw_paused) is bool else bool(raw_paused) if type(raw_paused) is int and raw_paused in (0, 1) else None
            except TimeoutError:
                pass
        battery, state, station = bus.get_last_event(BatteryEvent), bus.get_last_event(StateEvent), bus.get_last_event(StationEvent)
        return {"reachable": reached, "battery_percent": battery.value if battery else None,
                "state": "error" if charging_error else state.state.name.lower() if state else "unknown",
                "task_state": task_state, "task_paused": paused,
                "station_state": station.state.name.lower() if station else "unknown"}
    finally:
        await bus.teardown()


def permit_action(action, before):
    if not before.get("reachable") or before.get("state") in {"unknown", "error"}:
        raise BridgeError("PREFLIGHT_STATE_UNAVAILABLE")
    if action == "vacuum.start" and (before["state"] not in {"idle", "docked"} or before.get("task_state") == "cleaning"):
        raise BridgeError("PREFLIGHT_STATE_CONFLICT")
    if action == "vacuum.resume" and before["state"] != "paused" and before.get("task_paused") is not True:
        raise BridgeError("PREFLIGHT_STATE_CONFLICT")
    if action == "vacuum.pause" and before["state"] != "cleaning" and before.get("task_state") != "cleaning":
        raise BridgeError("PREFLIGHT_STATE_CONFLICT")


def verify(action, accepted, after):
    expected = {"vacuum.start": {"cleaning"}, "vacuum.resume": {"cleaning"}, "vacuum.pause": {"paused"},
                "vacuum.stop": {"idle", "docked"}, "vacuum.dock": {"returning", "docked"}}[action]
    verified = accepted and after["reachable"] and after["state"] in expected
    at_station = (accepted and action in {"vacuum.start", "vacuum.resume"} and after["reachable"]
                  and after["task_state"] == "cleaning" and after["task_paused"] is False
                  and after["station_state"] in {"washing_mop", "emptying_dustbin", "drying_mop"})
    return verified, "verified" if verified else "task_active_at_station" if at_station else "awaiting_state_change" if accepted else "rejected_or_unknown"


async def control(auth, info, action, store):
    from deebot_client.commands.json.charge import Charge
    from deebot_client.commands.json.clean import Clean, CleanV2
    from deebot_client.event_bus import EventBus
    from deebot_client.models import CleanAction
    before = await status(auth, info)
    permit_action(action, before)
    caps = info.static.capabilities
    command = caps.charge.execute() if action == "vacuum.dock" else caps.clean.action.command(CleanAction(action.removeprefix("vacuum.")))
    if type(command) not in {Charge, Clean, CleanV2}:
        raise BridgeError("COMMAND_UNREVIEWED")
    # The owner can change device selection while cloud preflight is pending.
    store.load()
    send("ready")
    dispatch = await asyncio.to_thread(read_message)
    if set(dispatch) != {"dispatch", "deadlineAt"} or dispatch.get("dispatch") is not True:
        raise BridgeError("DISPATCH_DENIED")
    try:
        deadline = datetime.fromisoformat(dispatch["deadlineAt"].replace("Z", "+00:00"))
        if deadline.tzinfo is None or deadline <= datetime.now(UTC):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise BridgeError("DEADLINE_EXCEEDED") from None
    store.load()
    bus = EventBus(blocked_refresh, caps)
    try:
        async with asyncio.timeout(20):
            result = await command.execute(auth, info.api, bus)
        body = response_body(result.raw_response)
        accepted = result.device_reached and code_is(body, 0)
        already_docked = action == "vacuum.dock" and result.device_reached and code_is(body, 30007)
    finally:
        await bus.teardown()
    try:
        after = await status(auth, info)
    except Exception:
        return {"accepted": bool(accepted), "state_verified": False, "uncertain": True, "verification_status": "awaiting_state_change"}
    if already_docked and after["reachable"] and after["state"] == "docked":
        accepted = True
    verified, verification = verify(action, accepted, after)
    return {"accepted": bool(accepted), "state_verified": bool(verified), "verification_status": verification,
            "uncertain": not result.device_reached, "status": after}


async def details(auth, info):
    from deebot_client.commands.json.auto_empty import GetAutoEmpty
    from deebot_client.commands.json.carpet import GetCarpetAutoFanBoost
    from deebot_client.commands.json.child_lock import GetChildLock
    from deebot_client.commands.json.clean_count import GetCleanCount
    from deebot_client.commands.json.continuous_cleaning import GetContinuousCleaning
    from deebot_client.commands.json.efficiency import GetEfficiencyMode
    from deebot_client.commands.json.fan_speed import GetFanSpeed
    from deebot_client.commands.json.life_span import GetLifeSpan
    from deebot_client.commands.json.volume import GetVolume
    from deebot_client.commands.json.water_info import GetWaterInfo
    from deebot_client.commands.json.work_mode import GetWorkMode
    from deebot_client.event_bus import EventBus
    from deebot_client.events import LifeSpan
    settings, maintenance, successful_reads = {}, [], 0
    definitions = [("fanSpeed", GetFanSpeed, "FanSpeedEvent", "speed"), ("workMode", GetWorkMode, "WorkModeEvent", "mode"),
        ("waterAmount", GetWaterInfo, "WaterCustomAmountEvent", "value"), ("volume", GetVolume, "VolumeEvent", "volume"),
        ("childLock", GetChildLock, "ChildLockEvent", "enabled"), ("autoEmpty", GetAutoEmpty, "AutoEmptyEvent", "enabled"),
        ("continuousCleaning", GetContinuousCleaning, "ContinuousCleaningEvent", "enabled"),
        ("carpetBoost", GetCarpetAutoFanBoost, "CarpetAutoFanBoostEvent", "enabled"), ("cleanCount", GetCleanCount, "CleanCountEvent", "count")]
    allowed = {definition[1] for definition in definitions} | {GetLifeSpan, GetEfficiencyMode}
    class SettingsBus(EventBus):
        def notify(self, event, *, debounce_time=0):
            for key, _, event_name, field in definitions:
                if type(event).__name__ == event_name:
                    value = getattr(event, field, None)
                    if hasattr(value, "name"):
                        value = value.name
                    if type(value) in (int, bool) or type(value) is float and math.isfinite(value) or type(value) is str and value.isupper() and value.replace("_", "").isalpha():
                        settings[key] = value
            return super().notify(event, debounce_time=debounce_time)
    caps = info.static.capabilities
    bus = SettingsBus(blocked_refresh, caps)
    candidates = [caps.fan_speed, caps.clean.work_mode, caps.water.amount if caps.water else None, caps.life_span,
        caps.station.auto_empty if caps.station else None, caps.settings.volume, caps.settings.child_lock,
        caps.clean.continuous, caps.settings.carpet_auto_fan_boost, caps.clean.count, caps.settings.efficiency_mode]
    try:
        for capability in candidates:
            if capability is None:
                continue
            for command in capability.get:
                if type(command) not in allowed:
                    continue
                if type(command) is GetLifeSpan:
                    command = GetLifeSpan([])
                try:
                    async with asyncio.timeout(4):
                        result = await command.execute(auth, info.api, bus)
                    body = response_body(result.raw_response)
                    data = body.get("data")
                    if not result.device_reached or not code_is(body, 0):
                        continue
                    successful_reads += 1
                    if type(command) is GetLifeSpan and type(data) is list:
                        for row in data[:32]:
                            if type(row) is not dict:
                                continue
                            raw_type = row.get("type")
                            try:
                                component = LifeSpan(raw_type).name
                            except (ValueError, TypeError):
                                component = "UNKNOWN"
                            left, total = row.get("left"), row.get("total")
                            try:
                                valid = type(left) in (int, str) and type(total) in (int, str) and 0 <= int(left) <= int(total) and int(total) > 0
                            except ValueError:
                                valid = False
                            bagless = raw_type == "dustBag"
                            maintenance.append({"component": component, "remainingPercent": round(int(left) / int(total) * 100, 2) if valid and not bagless else None,
                                "counterStatus": "not_applicable" if bagless else "unknown" if not valid else "counter_due" if int(left) == 0 else "counter_remaining"})
                    elif type(command) is GetEfficiencyMode and type(data) is dict and data.get("support") in (0, 1, False, True, "0", "1"):
                        settings["efficiencySupported"] = str(data["support"]) in ("1", "True")
                except TimeoutError:
                    pass
        return {"settings": settings, "maintenance": maintenance, "successfulReads": successful_reads}
    finally:
        await bus.teardown()


async def run(request):
    import aiohttp
    from deebot_client.api_client import ApiClient
    from deebot_client.authentication import Authenticator, create_rest_config
    from deebot_client.models import AccountCredentials
    store = EncryptedStore(request["credentialFile"], request["selectedDeviceSha256"])
    record = store.load()
    async with aiohttp.ClientSession() as session:
        config = create_rest_config(session, device_id=record["device_id"], alpha_2_country="US")
        auth = Authenticator(config, "", "", account_credentials=AccountCredentials(**record["account"]))
        async def save_account(credentials):
            store.save_account(asdict(credentials))
        auth.subscribe_account_credentials(save_account)
        try:
            await auth.authenticate()
            found = await ApiClient(auth).get_devices()
            selected = [info for info in found.mqtt if info.api.get("did") == record["selected_device_id"]]
            if len(selected) != 1 or selected[0].api.get("class") != "huhcip" or selected[0].static.capabilities.device_type.value != "vacuum":
                raise BridgeError("SELECTED_DEVICE_UNSUPPORTED")
            info = selected[0]
            if request["action"] == "status":
                return {"status": await status(auth, info)}
            if request["action"] == "vacuum.details.read":
                return {"details": await details(auth, info)}
            return await control(auth, info, request["action"], store)
        finally:
            await auth.teardown()


def main():
    # Silence SDK authentication URLs, user IDs, device IDs and response bodies.
    logging.disable(logging.CRITICAL)
    try:
        request = validate_request(read_message())
        configure_dependencies()
        async def bounded():
            async with asyncio.timeout(100):
                return await run(request)
        send("result", value=asyncio.run(bounded()))
        return 0
    except BridgeError as error:
        send("error", code=error.code)
    except Exception:
        send("error", code="CLOUD_OPERATION_FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
