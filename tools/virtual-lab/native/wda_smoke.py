#!/usr/bin/env python3
"""Fixed Settings-only control probe. Never launches Scribe or a physical device."""
import argparse
import json
import time
from pathlib import Path
from lab import command, read_json, request

parser = argparse.ArgumentParser()
parser.add_argument("marker")
parser.add_argument("--output", required=True)
args = parser.parse_args()
result = {"kind": "owned-simulator-WDA-control", "passed": False,
          "scribeLaunched": False, "microphoneUsed": False, "scribeAcceptance": False}
session = None
url = "http://127.0.0.1:4729"
start = time.monotonic()
try:
    marker = read_json(args.marker)
    if marker.get("scope") != "owned synthetic only" or marker.get("name") != "Scribe Virtual Lab 20261024":
        raise ValueError("unowned simulator")
    udid = marker["udid"]
    listing = command(["xcrun", "simctl", "list", "devices", "available", "--json"])
    devices = json.loads(listing["stdout"])["devices"]
    if not any(d.get("udid") == udid and d.get("name") == marker["name"] for group in devices.values() for d in group):
        raise ValueError("owned simulator is absent")
    caps = {"platformName": "iOS", "appium:automationName": "XCUITest", "appium:udid": udid,
            "appium:platformVersion": marker["runtime"].removeprefix("iOS"), "appium:deviceName": marker["name"],
            "appium:bundleId": "com.apple.Preferences", "appium:noReset": True,
            "appium:shouldTerminateApp": True, "appium:wdaLaunchTimeout": 90000,
            "appium:wdaConnectionTimeout": 30000, "appium:simulatorStartupTimeout": 30000,
            "appium:showXcodeLog": False}
    value = request(url + "/session", "POST", {"capabilities": {"alwaysMatch": caps}}, timeout=150)
    session = value.get("sessionId") or value.get("value", {}).get("sessionId")
    if not session: raise RuntimeError("session missing")
    base = url + "/session/" + session
    state = request(base + "/execute/sync", "POST", {"script": "mobile: queryAppState", "args": [{"bundleId": "com.apple.Preferences"}]}).get("value")
    elements = request(base + "/elements", "POST", {"using": "accessibility id", "value": "Settings"}).get("value")
    result.update({"passed": state == 4 and bool(elements), "settingsForeground": state == 4,
                   "settingsElementFound": bool(elements), "udid": udid})
except (ValueError, KeyError, OSError, RuntimeError):
    result["reason"] = "bounded-WDA-control-failed"
finally:
    if session:
        try: request(url + "/session/" + session, "DELETE")
        except RuntimeError: result["cleanupSessionClosed"] = False
        else: result["cleanupSessionClosed"] = True
    result["elapsedSeconds"] = round(time.monotonic() - start, 3)
    result["passed"] = result["passed"] and result.get("cleanupSessionClosed") is True
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
raise SystemExit(0 if result["passed"] else 2)
