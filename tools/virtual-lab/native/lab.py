#!/usr/bin/env python3
"""Bounded native preflight and Appium runner. Never drives an unowned app/device."""
import argparse
import hashlib
import json
import os
import platform
import plistlib
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


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
    if target["role"] not in ("owned-macos-guest", "owned-ios-simulator"):
        raise ValueError("native execution requires an owned guest or simulator")
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
    elif execute and marker.get("interactiveSessionUnlocked") is not True:
        raise ValueError("Mac guest requires a prepared unlocked interactive session")
    app = within(config["app"]["path"], root / "apps")
    info = plistlib.loads((app / "Contents/Info.plist" if target["role"] == "owned-macos-guest"
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
        if config["target"]["role"] == "owned-macos-guest":
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
        if config["target"]["role"] == "owned-macos-guest":
            checks["unlockedSession"] = {"ok": inventory.get("sessionLocked") is False}
        checks["Appium"] = {"ok": request(config["appiumUrl"].rstrip("/") + "/status").get("value", {}).get("ready") is True}
    except (ValueError, KeyError, OSError, RuntimeError):
        checks.setdefault("ownedTarget", {"ok": False})
        checks["nativePreflight"] = {"ok": False}
    return {"kind": "native-preflight", "nativeRecordingTestRun": False,
            "ready": all(c.get("ok", True) for c in checks.values()), "checks": checks}


class Driver:
    def __init__(self, config):
        self.base = config["appiumUrl"].rstrip("/")
        caps = dict(config["capabilities"])
        caps["appium:bundleId"] = config["app"]["bundleId"]
        caps.update({"appium:app": config["app"]["path"]} if config["target"]["role"] == "owned-ios-simulator"
                    else {"appium:appPath": config["app"]["path"]})
        if config["target"]["role"] == "owned-ios-simulator":
            caps["appium:udid"] = config["target"]["udid"]
        result = request(self.base + "/session", "POST", {"capabilities": {"alwaysMatch": caps}}, timeout=120)
        self.session = result.get("sessionId") or result.get("value", {}).get("sessionId")
        if not self.session:
            raise RuntimeError("Appium did not create a session")

    def call(self, path, method="POST", body=None):
        return request(self.base + "/session/" + self.session + path, method, body).get("value")

    def element(self, locator, timeout=20):
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 120:
            raise ValueError("UI wait must be bounded")
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                value = self.call("/element", body=locator)
                return value["element-6066-11e4-a52e-4f735466cecf"]
            except (RuntimeError, KeyError):
                time.sleep(0.25)
        raise RuntimeError("expected synthetic UI state was not reached")

    def step(self, step):
        element = self.element(step["locator"], step.get("timeout", 20))
        path = "/element/" + element
        action = step["action"]
        if action == "click":
            self.call(path + "/click", body={})
        elif action == "type":
            text = os.environ[step["env"]] if "env" in step else step["text"]
            self.call(path + "/value", body={"text": text})
        elif action == "assertText":
            if step["contains"] not in self.call(path + "/text", "GET"):
                raise RuntimeError("synthetic text assertion failed")
        elif action != "wait":
            raise ValueError("unsupported UI action")


def run(config):
    root = owned(config, execute=True)
    route = read_json(within(config["audio"]["scribeRouteReceipt"], root))
    if not (route.get("verified") is True and route.get("observedIn") == "scribe-native-preparation"
            and route.get("inputKind") == "virtual" and route.get("uid") == config["audio"]["uid"]
            and route.get("bundleId") == config["app"]["bundleId"]
            and str(route.get("build")) == str(config["app"]["build"])):
        raise ValueError("Scribe's selected virtual microphone is not verified")
    if config["target"]["role"] == "owned-ios-simulator":
        sim_route = read_json(within(config["audio"]["simulatorRouteReceipt"], root))
        if not (sim_route.get("verified") is True and sim_route.get("observedIn") == "simulator-sound-input"
                and sim_route.get("uid") == config["audio"]["uid"] and sim_route.get("udid") == config["target"]["udid"]):
            raise ValueError("owned simulator input route is not verified")
    flow = config["flow"]
    if any(not flow.get(phase) for phase in ("finish", "save", "reopen")):
        raise ValueError("finish, save and reopen phases must be nonempty")
    if (flow.get("syntheticOnly") is not True or not flow.get("record")
            or flow["record"][-1] != {"action": "wait", "locator": flow["recordingStateLocator"]}):
        raise ValueError("flow must confirm actual Recording before playback")
    if not flow.get("save") or flow["save"][-1] != {"action": "wait", "locator": flow["savedStateLocator"]}:
        raise ValueError("save phase must confirm saved state before relaunch")
    if (flow["finish"][-1] != {"action": "wait", "locator": flow["finishedStateLocator"]}
            or not any(step.get("action") == "assertText" for step in flow["reopen"])):
        raise ValueError("finish and reopen require actual state/text assertions")
    if config["capabilities"].get("appium:noReset") is not True:
        raise ValueError("app state must be retained during session cleanup")
    keep = "appium:skipAppKill" if config["target"]["role"] == "owned-macos-guest" else "appium:shouldTerminateApp"
    if config["capabilities"].get(keep) is not (keep == "appium:skipAppKill"):
        raise ValueError("automatic app termination must be disabled")
    preflight = doctor(config)
    if not preflight["ready"]:
        raise RuntimeError("native preflight is not ready")
    wav = within(config["audio"]["wav"], root)
    if wav.stat().st_size > 64 * 1024 * 1024 or hashlib.sha256(wav.read_bytes()).hexdigest() != config["audio"]["sha256"]:
        raise ValueError("synthetic WAV hash does not match")
    driver = Driver(config)
    events, player = [], None
    start = time.monotonic()
    try:
        for phase in ("prepare", "consent", "record"):
            for step in config["flow"][phase]:
                driver.step(step)
            events.append({"phase": phase, "elapsedSeconds": round(time.monotonic() - start, 3)})
        executable = within(config["audio"]["executable"], root)
        player = subprocess.Popen([str(executable), "play", config["configPath"]],
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        for step in config["flow"].get("duringRecording", []):
            if step["action"] == "background":
                seconds = step.get("seconds", 5)
                if not isinstance(seconds, (int, float)) or not 0 <= seconds <= 30:
                    raise ValueError("background interval must be bounded")
                method = "mobile: backgroundApp" if config["target"]["role"] == "owned-ios-simulator" else "macos: activateApp"
                args = {"seconds": seconds} if method.startswith("mobile") else {"bundleId": step["bundleId"]}
                driver.call("/execute/sync", body={"script": method, "args": [args]})
                if method.startswith("macos"):
                    time.sleep(seconds)
                    driver.call("/execute/sync", body={"script": method, "args": [{"bundleId": config["app"]["nativeUiBundleId"]}]})
            else:
                driver.step(step)
        output, _ = player.communicate(timeout=650)
        if player.returncode or not json.loads(output).get("completed"):
            raise RuntimeError("virtual audio playback failed")
        for phase in ("finish", "save", "reopen"):
            for step in config["flow"][phase]:
                if phase == "reopen" and step["action"] == "relaunch":
                    prefix = "mobile" if config["target"]["role"] == "owned-ios-simulator" else "macos"
                    for verb in ("terminateApp", "launchApp"):
                        driver.call("/execute/sync", body={"script": prefix + ": " + verb,
                                    "args": [{"bundleId": config["app"]["bundleId"]}]})
                else:
                    driver.step(step)
            events.append({"phase": phase, "elapsedSeconds": round(time.monotonic() - start, 3)})
        return {"kind": "native-appium-journey", "uiAssertionsPassed": True, "events": events,
                "nativePCMProof": "not-collected-by-this-runner", "savedAudioPlaybackProof": "not-collected-by-this-runner",
                "coreIntegrationProof": "requires-Core-runner", "appBuild": config["app"]["build"]}
    finally:
        if player and player.poll() is None:
            player.terminate()
            try:
                player.wait(timeout=3)
            except subprocess.TimeoutExpired:
                player.kill()
                player.wait(timeout=3)
        # Keep AUT alive on failure: no recording-in-progress app kill by cleanup.
        driver.call("", "DELETE")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("doctor", "run", "probe"))
    parser.add_argument("config")
    parser.add_argument("--output")
    args = parser.parse_args()
    config = read_json(args.config)
    config["configPath"] = str(Path(args.config).resolve())
    try:
        if args.mode == "doctor":
            result = doctor(config)
        elif args.mode == "run":
            result = run(config)
        else:
            root = owned(config, execute=True)
            executable = str(within(config["audio"]["executable"], root))
            player = subprocess.Popen([executable, "play", config["configPath"]], stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
            try:
                time.sleep(0.25)
                result = command([executable, "probe", config["configPath"]], 15)
                result = json.loads(result["stdout"]) if result["ok"] else {"routePassed": False}
            finally:
                if player.poll() is None:
                    player.terminate()
                    try:
                        player.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        player.kill(); player.wait(timeout=3)
        if args.output:
            Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        return 0 if result.get("ready", result.get("routePassed", result.get("uiAssertionsPassed", False))) else 2
    except (ValueError, KeyError, OSError, RuntimeError, subprocess.TimeoutExpired):
        print(json.dumps({"kind": "native-lab-failure", "passed": False,
                          "reason": "precondition-or-bounded-execution-failed", "nativeRecordingTestRun": False}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
