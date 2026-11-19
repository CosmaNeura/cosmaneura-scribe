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
                "AccountSelfDeleteContract",
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
        "CosmaneuraRecordingActivity",
        sorted((PLUGINS / "ios-pcm-capture/Sources/CosmaneuraRecordingActivity").glob("*.swift")),
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
        "ProviderNativeTimingJournal",
        "ProviderNativeTransport",
        "NativeProviderRecordingService",
        "NativeSourceStartOwner",
        "NativeSourceProofJournal",
        "NativeSourceRecovery",
        "NativeCaptureProcessFence",
        "NativeProviderRecordingRun",
        "NativeProviderRecordingHost",
        "NativeProviderRecordingBridge",
        "NativeProviderPassageSelection",
    ]
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--platform", choices=["mac", "ios", "both"], default="both")
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

    for platform in ["mac", "ios"] if args.platform == "both" else [args.platform]:
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
            # Build the real native queue core without its unrelated Capacitor
            # wrapper; its production package retains Swift 5 language mode.
            queue_sources = sorted(
                (PLUGINS / "secure-queue/ios/Sources/CosmaneuraSecureQueue").glob("*.swift")
            )
            queue_flags = [flag for flag in bridge_flags]
            queue_flags[queue_flags.index("-swift-version") + 1] = "5"
            run(
                "ios-native-queue-module",
                queue_flags
                + [
                    "-emit-module",
                    "-module-name",
                    "CosmaneuraSecureQueue",
                    "-emit-module-path",
                    str(target / "CosmaneuraSecureQueue.swiftmodule"),
                    *[
                        str(path)
                        for path in queue_sources
                        if path.name != "SecureQueuePlugin.swift"
                    ],
                ],
            )
            run(
                "ios-run-typecheck",
                bridge_flags
                + [
                    "-typecheck",
                    *map(str, BRIDGE),
                    str(AUTH / "Bridge/NativeProviderPassage.swift"),
                    str(AUTH / "Bridge/NativeProviderRecordingFactory.swift"),
                ],
            )
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
                    str(REPO / "scripts/standalone-provider/check-native-passage-selection.swift"),
                ],
            )
            run("mac-run-checks", [executable])
            account_self_delete = str(target / "account-self-delete-checks")
            run("mac-account-self-delete-build", common + [
                "-O", "-parse-as-library", "-L", str(target), *libraries,
                "-Xlinker", "-rpath", "-Xlinker", str(target), "-o", account_self_delete,
                str(REPO / "scripts/standalone-provider/check-account-self-delete.swift"),
            ])
            run("mac-account-self-delete-checks", [account_self_delete])
            # Fence: recording refuse / origin before token before request.
            contract = (REPO / "apps/capture/native-plugins/cosmas-native-auth/Sources"
                        / "CosmasNativeAuth/AccountSelfDeleteContract.swift").read_text()
            attempt = contract[contract.find("public static func attempt("):]
            order = (("accountDeleteURL(origin:", "mintToken()"),
                     ("mintToken()", "makeAuthorizedAccountDeleteRequest("),
                     ("makeAuthorizedAccountDeleteRequest(", "resolve(origin:"))
            for earlier, later in order:
                a, b = attempt.find(earlier), attempt.find(later)
                if a < 0 or b < 0 or not (a < b):
                    raise SystemExit("AccountSelfDeleteContract.attempt order broken")
            if "holdsOrOpeningRecording" not in attempt.split("mintToken()", 1)[0]:
                raise SystemExit("attempt must refuse recording before mintToken")
            for relative in ("apps/capture/native-plugins/cosmas-native-auth/Bridge/"
                             "CosmasWorkspaceAuthPlugin.swift",
                             "scripts/standalone-provider/DesktopProviderMain.swift"):
                text = (REPO / relative).read_text()
                marker = ("func deleteAccount" if "func deleteAccount" in text
                          else 'case "deleteAccount"')
                handler = text[text.find(marker):]
                token_idx = handler.find("auth.token(")
                if token_idx < 0:
                    raise SystemExit(f"missing auth.token in deleteAccount of {relative}")
                if relative.endswith("CosmasWorkspaceAuthPlugin.swift"):
                    if "AccountSelfDeleteContract.attempt(" not in handler:
                        raise SystemExit(f"iOS deleteAccount must call attempt in {relative}")
                    held = handler.find("recordingBridge.holdsOrOpeningRecording")
                    if not (0 <= held < token_idx):
                        raise SystemExit(f"iOS must refuse recording before token in {relative}")
                    continue
                o = handler.find("AccountSelfDeleteContract.accountDeleteURL(")
                r = handler.find("AccountSelfDeleteContract.makeAuthorizedAccountDeleteRequest(")
                if o < 0 or r < 0 or not (o < token_idx < r):
                    raise SystemExit(f"deleteAccount order broken in {relative}")
            binding_executable = str(target / "binding-checks")
            run(
                "mac-binding-build",
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
                    binding_executable,
                    *[
                        str(AUTH / "Bridge" / name)
                        for name in (
                            "NativeProviderConnection.swift",
                            "ProviderNativeTransport.swift",
                            "ProviderNativeTimingJournal.swift",
                            "NativeProviderRecordingService.swift",
                            "NativeSourceStartOwner.swift",
                            "NativeSourceProofJournal.swift",
                            "NativeSourceRecovery.swift",
                            "NativeCaptureProcessFence.swift",
                        )
                    ],
                    str(REPO / "scripts/standalone-provider/check-native-provider.swift"),
                    str(REPO / "scripts/standalone-provider/check-native-recording-binding.swift"),
                ],
            )
            run("mac-binding-checks", [binding_executable])


if __name__ == "__main__":
    main()
