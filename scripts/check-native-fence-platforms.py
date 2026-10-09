"""Compile actual recovery sources for iOS/macOS; inspect filesystem API imports.

No device, account, Keychain, microphone, signing or installed app is accessed.
This checks target selection, not an executed iOS recovery or App Store acceptance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    out = parser.parse_args().output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parents[1]
    root = repo / "apps/capture/native-plugins/cosmas-native-auth"
    auth = [
        root / "Sources/CosmasNativeAuth" / f"{name}.swift"
        for name in (
            "DesktopAuthProtocol",
            "KeychainAccessBlock",
            "NativeAuthAwait",
            "NativeCaptureStartGate",
            "NativeClerkConfiguration",
            "NativeTokenPolicy",
            "NativeWorkspaceAuth",
        )
    ]
    bridge = [
        root / "Bridge" / f"{name}.swift"
        for name in (
            "NativeProviderConnection",
            "ProviderNativeTransport",
            "NativeSourceStartOwner",
            "NativeSourceProofJournal",
            "NativeSourceRecovery",
            "NativeCaptureProcessFence",
        )
    ]
    for name in ("NativeSourceRecovery.swift", "NativeCaptureProcessFence.swift"):
        if (root / "Bridge" / name).read_bytes() != (
            repo / "scripts/standalone-provider" / name
        ).read_bytes():
            raise ValueError(f"Desktop and mobile source copy differs: {name}")
    inputs = {
        str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in auth + bridge
    }
    results: list[dict[str, object]] = []

    def run(name: str, command: list[str]) -> str:
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        log = out / f"{name}.log"
        log.write_text(result.stdout + result.stderr)
        results.append(
            {
                "name": name,
                "command": command,
                "exit_code": result.returncode,
                "log_sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
            }
        )
        receipt = {"source_sha256": inputs, "results": results, "device_execution": False}
        (out / "CHECKS.json").write_text(json.dumps(receipt, indent=2) + "\n")
        if result.returncode:
            raise SystemExit(f"Platform compilation failed: {log}")
        return result.stdout

    symbols: dict[str, list[str]] = {}
    for platform, sdk, target in (
        ("ios", "iphoneos", "arm64-apple-ios17.0"),
        ("macos", "macosx", "arm64-apple-macos14.0"),
    ):
        directory = out / platform
        directory.mkdir()
        sdk_path = run(platform + "-sdk", ["xcrun", "--sdk", sdk, "--show-sdk-path"]).strip()
        # Preserve unused internal declarations so optimization cannot hide a
        # mistakenly included platform implementation from the import check.
        flags = [
            "xcrun",
            "swiftc",
            "-swift-version",
            "6",
            "-parse-as-library",
            "-Onone",
            "-sdk",
            sdk_path,
            "-target",
            target,
            "-module-cache-path",
            str(out / "cache"),
        ]
        run(
            platform + "-auth",
            flags
            + [
                "-emit-module",
                "-module-name",
                "CosmasNativeAuth",
                "-emit-module-path",
                str(directory / "CosmasNativeAuth.swiftmodule"),
                *map(str, auth),
            ],
        )
        artifact = directory / "NativeRecovery.o"
        run(
            platform + "-recovery",
            flags
            + [
                "-emit-object",
                "-whole-module-optimization",
                "-module-name",
                "NativeRecovery",
                "-I",
                str(directory),
                "-o",
                str(artifact),
                *map(str, bridge),
            ],
        )
        undefined = run(platform + "-imports", ["nm", "-u", str(artifact)])
        symbols[platform] = sorted(set(re.findall(r"\b_([fl]?stat(?:at)?)(?:\$\w+)?\b", undefined)))
        if platform == "ios" and symbols[platform]:
            raise SystemExit("iOS recovery still imports desktop file metadata APIs")
        if platform == "macos" and not {"fstat", "fstatat"}.issubset(symbols[platform]):
            raise SystemExit("Desktop filesystem fence unexpectedly absent")
    receipt = {
        "source_sha256": inputs,
        "results": results,
        "device_execution": False,
        "filesystem_imports": symbols,
        "desktop_mobile_source_copies_equal": True,
        "success": True,
    }
    (out / "CHECKS.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"success": True, "filesystem_imports": symbols, "output": str(out)}))


if __name__ == "__main__":
    main()
