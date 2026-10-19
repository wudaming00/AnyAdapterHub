"""Pure safety checks: these tests perform no login, discovery or device requests."""
import importlib.util
from pathlib import Path
import unittest
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("anyadapter_ecovacs_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerSafetyTests(unittest.TestCase):
    def test_selection_never_falls_back_to_another_account_device(self):
        fingerprint = sha256(b"selected-private-id").hexdigest()
        self.assertTrue(worker.selected_matches({"selected_device_id": "selected-private-id"}, fingerprint))
        for record in ({}, {"selected_device_id": None}, {"selected_device_id": "another-device"}):
            self.assertFalse(worker.selected_matches(record, fingerprint))

    def test_exact_request_has_no_device_selection_endpoint_or_arbitrary_command(self):
        valid = {"action": "status", "credentialFile": str(Path(__file__).resolve()), "selectedDeviceSha256": "a" * 64}
        self.assertEqual(worker.validate_request(valid), valid)
        for field, value in (("deviceId", "other"), ("url", "https://attacker"), ("args", {})):
            with self.assertRaises(worker.BridgeError):
                worker.validate_request({**valid, field: value})
        for action in ("select", "login", "map", "camera", "vacuum.room.clean", "vacuum.settings.set"):
            with self.assertRaises(worker.BridgeError):
                worker.validate_request({**valid, "action": action})

    def test_preflight_rejects_unknown_error_unreachable_and_duplicate_start(self):
        good = {"reachable": True, "state": "docked", "task_state": "idle", "task_paused": False}
        worker.permit_action("vacuum.start", good)
        for before in ({**good, "reachable": False}, {**good, "state": "unknown"}, {**good, "state": "error"},
                       {**good, "state": "cleaning"}, {**good, "task_state": "cleaning"}):
            with self.assertRaises(worker.BridgeError):
                worker.permit_action("vacuum.start", before)
        with self.assertRaises(worker.BridgeError):
            worker.permit_action("vacuum.resume", good)

    def test_acceptance_and_station_work_are_not_task_completion(self):
        after = {"reachable": True, "state": "docked", "task_state": "cleaning", "task_paused": False, "station_state": "washing_mop"}
        self.assertEqual(worker.verify("vacuum.start", True, after), (False, "task_active_at_station"))
        self.assertEqual(worker.verify("vacuum.start", False, {**after, "state": "cleaning"}), (False, "rejected_or_unknown"))
        self.assertEqual(worker.verify("vacuum.start", True, {**after, "state": "cleaning"}), (True, "verified"))

    def test_dependency_retry_guard_disables_upstream_502_replay(self):
        worker.configure_dependencies()
        import deebot_client.authentication as authentication
        self.assertEqual(authentication.MAX_RETRIES, 1)


class SDKDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_502_does_not_send_a_second_sdk_post(self):
        worker.configure_dependencies()
        import aiohttp
        import deebot_client.authentication as authentication
        calls = []
        class FailedResponse:
            async def __aenter__(self):
                raise aiohttp.ClientResponseError(SimpleNamespace(real_url="https://invalid.example"), (), status=502)
            async def __aexit__(self, *_):
                return False
        class Session:
            def post(self, *args, **kwargs):
                calls.append((args, kwargs))
                return FailedResponse()
        config = SimpleNamespace(country="US", device_id="test-local-client", portal_url="https://invalid.example/", session=Session())
        client = authentication._AuthClient(config, "", "")
        with patch.object(authentication.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(Exception):
                await client.post("test-path", {"cmdName": "clean"})
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
