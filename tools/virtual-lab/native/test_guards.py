"""Safety checks use only disposable plist/JSON fixtures; no audio or Appium session."""
import copy
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

    def test_record_click_cannot_start_session_before_state_wait(self):
        self.config["flow"]["record"] = [{"action": "click"}]
        with patch.object(lab, "Driver", side_effect=AssertionError("must not create session")):
            with self.assertRaises((ValueError, KeyError)): lab.run(self.config)

    def test_unverified_physical_route_cannot_start_session(self):
        receipt = Path(self.config["audio"]["scribeRouteReceipt"])
        data = json.loads(receipt.read_text()); data["inputKind"] = "physical"; receipt.write_text(json.dumps(data))
        with patch.object(lab, "Driver", side_effect=AssertionError("must not create session")):
            with self.assertRaises(ValueError): lab.run(self.config)

    def test_empty_journey_phases_cannot_report_success(self):
        for phase in ("finish", "save", "reopen"):
            self.config["flow"] = {"finish": [{}], "save": [{}], "reopen": [{}], phase: []}
            with patch.object(lab, "Driver", side_effect=AssertionError("must not create session")):
                with self.assertRaises(ValueError): lab.run(self.config)


if __name__ == "__main__": unittest.main()
