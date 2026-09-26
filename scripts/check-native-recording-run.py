#!/usr/bin/env python3
"""Compile the actual native run/source/gate and exercise offline synthetic races."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLUGINS = REPO / "apps/capture/native-plugins"
AUTH = PLUGINS / "cosmas-native-auth"
MODULES = [
    (
        "CosmasNativeAuth",
        [
            AUTH / "Sources/CosmasNativeAuth" / f"{name}.swift"
            for name in [
                "DesktopAuthProtocol",
                "KeychainAccessBlock",
                "NativeAuthAwait",
                "NativeCaptureStartGate",
                "NativeClerkConfiguration",
                "NativeTokenPolicy",
                "NativeWorkspaceAuth",
            ]
        ],
    ),
    (
        "CosmaneuraNativeRecording",
        sorted((PLUGINS / "native-recording/Sources/CosmaneuraNativeRecording").glob("*.swift")),
    ),
    (
        "CosmaneuraIOSPCMCore",
        sorted((PLUGINS / "ios-pcm-capture/Sources/CosmaneuraIOSPCMCore").glob("*.swift")),
    ),
    (
        "CosmaneuraIOSAVFoundationDriver",
        sorted(
            (PLUGINS / "ios-pcm-capture/Sources/CosmaneuraIOSAVFoundationDriver").glob("*.swift")
        ),
    ),
    (
        "CosmaneuraNativeRecordingPCM",
        sorted((PLUGINS / "native-recording/Sources/CosmaneuraNativeRecordingPCM").glob("*.swift")),
    ),
]
BRIDGE = [
    AUTH / "Bridge" / f"{name}.swift"
    for name in [
        "NativeProviderConnection",
        "ProviderNativeTransport",
        "NativeSourceStartOwner",
        "NativeSourceProofJournal",
        "NativeSourceRecovery",
        "NativeCaptureProcessFence",
        "NativeProviderRecordingRun",
        "NativeProviderRecordingHost",
    ]
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    results: list[dict[str, object]] = []

    def run(name: str, command: list[str]) -> None:
        log = out / f"{name}.log"
        with log.open("w") as stream:
            result = subprocess.run(
                command, cwd=REPO, stdout=stream, stderr=subprocess.STDOUT, check=False
            )
        results.append(
            {
                "name": name,
                "command": command,
                "exit_code": result.returncode,
                "log": str(log),
                "sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
            }
        )
        (out / "CHECKS.json").write_text(
            json.dumps(
                {
                    "commit": subprocess.check_output(
                        ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
                    ).strip(),
                    "synthetic_only": True,
                    "ambient_audio": False,
                    "results": results,
                },
                indent=2,
            )
            + "\n"
        )
        print(f"{name}: {result.returncode}", flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)

    for platform in ["mac", "ios"]:
        target = out / platform
        target.mkdir()
        common = [
            "xcrun",
            "swiftc",
            "-swift-version",
            "6",
            "-warnings-as-errors",
            "-module-cache-path",
            str(target / "cache"),
            "-I",
            str(target),
        ]
        if platform == "ios":
            sdk = subprocess.check_output(
                ["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True
            ).strip()
            common += ["-target", "arm64-apple-ios17.0", "-sdk", sdk]
        libraries: list[str] = []
        for name, sources in MODULES:
            command = common + [
                "-emit-module",
                "-module-name",
                name,
                "-emit-module-path",
                str(target / f"{name}.swiftmodule"),
            ]
            if platform == "mac":
                command += [
                    "-O",
                    "-enable-testing",
                    "-emit-library",
                    "-o",
                    str(target / f"lib{name}.dylib"),
                    "-L",
                    str(target),
                    *libraries,
                ]
            if platform == "ios" and name == "CosmaneuraIOSAVFoundationDriver":
                # Existing AVAudioSession permission APIs are SDK-deprecated.
                command.remove("-warnings-as-errors")
            run(f"{platform}-{name}", command + list(map(str, sources)))
            libraries.append(f"-l{name}")
        # Retained SecItem noninteractive policy emits an SDK deprecation warning.
        bridge_flags = [flag for flag in common if flag != "-warnings-as-errors"]
        if platform == "ios":
            run("ios-run-typecheck", bridge_flags + ["-typecheck", *map(str, BRIDGE)])
        else:
            executable = str(target / "run-checks")
            run(
                "mac-run-build",
                bridge_flags
                + [
                    "-O",
                    "-parse-as-library",
                    "-D",
                    "NATIVE_BINDING_CHECKS",
                    "-L",
                    str(target),
                    *libraries,
                    "-Xlinker",
                    "-rpath",
                    "-Xlinker",
                    str(target),
                    "-o",
                    executable,
                    *map(str, BRIDGE),
                    str(REPO / "scripts/standalone-provider/check-native-provider.swift"),
                    str(REPO / "scripts/standalone-provider/check-native-recording-run.swift"),
                    str(REPO / "scripts/standalone-provider/check-native-recording-host.swift"),
                ],
            )
            run("mac-run-checks", [executable])


if __name__ == "__main__":
    main()
