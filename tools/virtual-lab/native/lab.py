#!/usr/bin/env python3
"""Read-only native preflight. Mutating journeys use the resumable coordinator."""
import argparse
import hashlib
import json
import platform
import plistlib
import re
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAC_ROLES = ("owned-macos-guest", "owned-macos-lab")


def hardware_uuid_sha256():
    result = command(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
    match = re.search(r'"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"', result["stdout"])
    if not result["ok"] or not match:
        raise ValueError("hardware identity is unavailable")
    return hashlib.sha256(match.group(1).lower().encode()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def within(path, root):
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(Path(root).resolve()):
        raise ValueError("path escapes owned lab root")
    return resolved


def command(argv, timeout=8):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return {"ok": result.returncode == 0, "stdout": result.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired):
        return {"ok": False, "stdout": ""}


def request(url, method="GET", body=None, timeout=12):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = json.load(response)
    except (OSError, urllib.error.HTTPError, ValueError):
        raise RuntimeError("Appium transport failed") from None
    if isinstance(result.get("value"), dict) and result["value"].get("error"):
        raise RuntimeError("Appium command failed")
    return result


def owned(config, execute=False):
    target = config["target"]
    if target["role"] not in (*MAC_ROLES, "owned-ios-simulator"):
        raise ValueError("native execution requires an owned Mac lab, guest or simulator")
    if target["hostname"] != socket.gethostname():
        raise ValueError("target hostname does not match this machine")
    root = Path(target["root"]).resolve()
    marker = read_json(within(target["marker"], root))
    if marker.get("purpose") != "scribe-synthetic-virtual-lab" or marker.get("hostname") != target["hostname"]:
        raise ValueError("owned target marker does not match")
    if marker.get("role") != target["role"]:
        raise ValueError("owned target role does not match")
    if target["role"] == "owned-ios-simulator":
        if not target.get("udid") or marker.get("udid") != target["udid"]:
            raise ValueError("owned simulator UUID does not match")
    else:
        hardware = hardware_uuid_sha256()
        control = target.get("controlHostHardwareUUIDSHA256")
        if not isinstance(control, str) or not re.fullmatch(r"[0-9a-f]{64}", control) or hardware == control:
            raise ValueError("independent Mac must differ from the control host")
        if marker.get("hardwareUUIDSHA256") != hardware:
            raise ValueError("owned Mac hardware marker does not match")
        if execute and marker.get("interactiveSessionUnlocked") is not True:
            raise ValueError("Mac lab requires a prepared unlocked interactive session")
    app = within(config["app"]["path"], root / "apps")
    info = plistlib.loads((app / "Contents/Info.plist" if target["role"] in MAC_ROLES
                          else app / "Info.plist").read_bytes())
    for key, expected in (("CFBundleIdentifier", "bundleId"), ("CFBundleVersion", "build")):
        if str(info.get(key)) != str(config["app"][expected]):
            raise ValueError("owned app identity does not match config")
    if target["role"] == "owned-ios-simulator" and info.get("DTPlatformName") != "iphonesimulator":
        raise ValueError("device IPA/app is not a simulator build")
    url = urllib.parse.urlparse(config["appiumUrl"])
    if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost") or url.username:
        raise ValueError("Appium must use owned guest loopback")
    if execute:
        receipt = read_json(within(config["consentReceipt"], root))
        if not (receipt.get("syntheticOnly") is True and receipt.get("verified") is True
                and receipt.get("recordId") and receipt.get("source") == "normal-consent-path"
                and receipt.get("scenarioId") == config.get("scenarioId") and config.get("scenarioId")):
            raise ValueError("verified synthetic consent receipt is required")
    return root


def doctor(config):
    checks = {}
    for name, argv in {"macOS": ["sw_vers", "-productVersion"],
                       "xcode": ["xcodebuild", "-version"],
                       "swift": ["xcrun", "swift", "--version"]}.items():
        checks[name] = command(argv)
    checks["python"] = {"ok": True, "stdout": platform.python_version()}
    try:
        root = owned(config)
        checks["ownedTarget"] = {"ok": True}
        if config["target"]["role"] in MAC_ROLES:
            checks["independentHardware"] = {"ok": True, "hardwareUUIDSHA256": hardware_uuid_sha256()}
            result = command(["codesign", "--verify", "--deep", "--strict", config["app"]["path"]])
            checks["signature"] = {"ok": result["ok"]}
        else:
            result = command(["xcrun", "simctl", "list", "devices", "available", "--json"])
            devices = json.loads(result["stdout"]).get("devices", {}) if result["ok"] else {}
            checks["ownedSimulator"] = {"ok": any(d.get("udid") == config["target"]["udid"]
                                                   for group in devices.values() for d in group)}
        executable = within(config["audio"]["executable"], root)
        result = command([str(executable), "inventory", config["configPath"]])
        inventory = json.loads(result["stdout"]) if result["ok"] else {}
        checks["virtualInput"] = {"ok": any(d.get("uid") == config["audio"]["uid"]
                                               for d in inventory.get("devices", []))}
        checks["audioInventory"] = inventory
        if config["target"]["role"] in MAC_ROLES:
            checks["unlockedSession"] = {"ok": inventory.get("sessionLocked") is False}
        checks["Appium"] = {"ok": request(config["appiumUrl"].rstrip("/") + "/status").get("value", {}).get("ready") is True}
    except (ValueError, KeyError, OSError, RuntimeError):
        checks.setdefault("ownedTarget", {"ok": False})
        checks["nativePreflight"] = {"ok": False}
    return {"kind": "native-preflight", "nativeRecordingTestRun": False,
            "ready": all(c.get("ok", True) for c in checks.values()), "checks": checks}



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("doctor", "run", "probe"))
    parser.add_argument("config")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.mode != "doctor":
        print(json.dumps({"kind": "native-lab-failure", "passed": False,
                          "reason": "legacy_mutating_runner_retired_use_coordinator",
                          "entryPoint": "tools/virtual-lab/lab.sh run scenario.json native.json output",
                          "nativeRecordingTestRun": False}))
        return 2
    config = read_json(args.config)
    config["configPath"] = str(Path(args.config).resolve())
    try:
        result = doctor(config)
        if args.output:
            Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        return 0 if result.get("ready") is True else 2
    except (ValueError, KeyError, OSError, RuntimeError, subprocess.TimeoutExpired):
        print(json.dumps({"kind": "native-lab-failure", "passed": False,
                          "reason": "precondition-or-bounded-execution-failed", "nativeRecordingTestRun": False}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
