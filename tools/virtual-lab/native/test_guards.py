"""Safety checks use only disposable plist/JSON fixtures; no audio or Appium session."""
import copy
import contextlib
import io
import json
import plistlib
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import lab


class Guards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        app = root / "apps/Scribe.app"; app.mkdir(parents=True)
        (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "test.scribe", "CFBundleVersion": "80", "DTPlatformName": "iphonesimulator"}))
        marker = {"purpose": "scribe-synthetic-virtual-lab", "hostname": socket.gethostname(), "role": "owned-ios-simulator", "udid": "unit-test-only"}
        (root / "target.json").write_text(json.dumps(marker))
        (root / "consent.json").write_text(json.dumps({"source": "normal-consent-path", "recordId": "unit-test-only", "scenarioId": "unit-test-only", "verified": True, "syntheticOnly": True}))
        self.config = {"target": {**marker, "root": str(root), "marker": str(root / "target.json")}, "app": {"path": str(app), "bundleId": "test.scribe", "build": "80"}, "scenarioId": "unit-test-only", "consentReceipt": str(root / "consent.json"), "appiumUrl": "http://127.0.0.1:4723"}
        (root / "scribe-route.json").write_text(json.dumps({"verified": True, "observedIn": "scribe-native-preparation", "inputKind": "virtual", "uid": "unit-test-only", "bundleId": "test.scribe", "build": "80"}))
        (root / "sim-route.json").write_text(json.dumps({"verified": True, "observedIn": "simulator-sound-input", "uid": "unit-test-only", "udid": "unit-test-only"}))
        self.config["audio"] = {"uid": "unit-test-only", "scribeRouteReceipt": str(root / "scribe-route.json"), "simulatorRouteReceipt": str(root / "sim-route.json")}
        locator = {"using": "accessibility id", "value": "unit-test-only"}; wait = {"action": "wait", "locator": locator}
        self.config["flow"] = {"syntheticOnly": True, "recordingStateLocator": locator, "savedStateLocator": locator, "finishedStateLocator": locator, "record": [wait], "finish": [wait], "save": [wait], "reopen": [{"action": "assertText", "locator": locator, "contains": "unit-test-only"}]}

    def test_owned_simulator_metadata(self):
        self.assertEqual(lab.owned(self.config, execute=True), Path(self.temp.name).resolve())

    def test_owned_remote_mac_requires_distinct_hardware_and_actual_marker(self):
        root = Path(self.temp.name)
        info = root / "apps/Scribe.app/Info.plist"
        contents = info.parent / "Contents"; contents.mkdir()
        info.rename(contents / "Info.plist")
        self.config["target"].update(role="owned-macos-lab", controlHostHardwareUUIDSHA256="a" * 64)
        marker = json.loads((root / "target.json").read_text())
        marker.update(role="owned-macos-lab", hardwareUUIDSHA256="b" * 64, interactiveSessionUnlocked=True)
        (root / "target.json").write_text(json.dumps(marker))
        with patch.object(lab, "hardware_uuid_sha256", return_value="b" * 64):
            self.assertEqual(lab.owned(self.config, execute=True), root.resolve())
        with patch.object(lab, "hardware_uuid_sha256", return_value="a" * 64):
            with self.assertRaises(ValueError): lab.owned(self.config)
        with patch.object(lab, "hardware_uuid_sha256", return_value="c" * 64):
            with self.assertRaises(ValueError): lab.owned(self.config)

    def test_rejects_unowned_target(self):
        self.config["target"]["udid"] = "different-device"
        with self.assertRaises(ValueError): lab.owned(self.config)

    def test_rejects_path_escape_including_symlink(self):
        link = Path(self.temp.name) / "apps/escape"; link.symlink_to("/Applications")
        with self.assertRaises(ValueError): lab.within(link / "Scribe.app", Path(self.temp.name) / "apps")

    def test_rejects_device_build(self):
        info = Path(self.config["app"]["path"]) / "Info.plist"
        data = plistlib.loads(info.read_bytes()); data["DTPlatformName"] = "iphoneos"; info.write_bytes(plistlib.dumps(data))
        with self.assertRaises(ValueError): lab.owned(self.config)

    def test_rejects_cross_scenario_consent(self):
        self.config["scenarioId"] = "another-scenario"
        with self.assertRaises(ValueError): lab.owned(self.config, execute=True)

    def test_rejects_remote_or_credential_url(self):
        for url in ("http://remote:4723", "http://secret@127.0.0.1:4723", "https://localhost:4723"):
            config = copy.deepcopy(self.config); config["appiumUrl"] = url
            with self.assertRaises(ValueError): lab.owned(config)

    def test_retired_mutating_modes_do_not_read_config_or_start_processes(self):
        for mode in ("run", "probe"):
            with patch("sys.argv", ["lab.py", mode, "/nonexistent/config.json"]), \
                    patch.object(lab, "read_json", side_effect=AssertionError("must not inspect config")), \
                    patch.object(lab.subprocess, "run", side_effect=AssertionError("must not execute")), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(lab.main(), 2)
            receipt = json.loads(output.getvalue())
            self.assertEqual(receipt["reason"], "legacy_mutating_runner_retired_use_coordinator")
            self.assertFalse(receipt["nativeRecordingTestRun"])


if __name__ == "__main__": unittest.main()
