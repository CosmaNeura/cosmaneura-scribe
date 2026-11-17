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
            run(
                "mac-account-self-delete-build",
                common
                + [
                    "-O",
                    "-parse-as-library",
                    "-L",
                    str(target),
                    *libraries,
                    "-Xlinker",
                    "-rpath",
                    "-Xlinker",
                    str(target),
                    "-o",
                    account_self_delete,
                    str(REPO / "scripts/standalone-provider/check-account-self-delete.swift"),
                ],
            )
            run("mac-account-self-delete-checks", [account_self_delete])
            # Both native deleteAccount handlers must share the contract resolve path
            # and fence the origin before minting a Clerk token / building the request.
            for relative in (
                "apps/capture/native-plugins/cosmas-native-auth/Bridge/CosmasWorkspaceAuthPlugin.swift",
                "scripts/standalone-provider/DesktopProviderMain.swift",
            ):
                text = (REPO / relative).read_text(encoding="utf-8")
                if "AccountSelfDeleteContract.resolve(" not in text:
                    raise SystemExit(f"missing AccountSelfDeleteContract.resolve in {relative}")
                # Scope the origin-before-token order check to the deleteAccount
                # handler only — other methods also call auth.token earlier.
                marker = 'func deleteAccount' if "func deleteAccount" in text else 'case "deleteAccount"'
                handler_at = text.find(marker)
                if handler_at < 0:
                    raise SystemExit(f"missing deleteAccount handler in {relative}")
                handler = text[handler_at:]
                origin_idx = handler.find(
                    "AccountSelfDeleteContract.accountDeleteURL("
                )
                token_idx = handler.find("auth.token(")
                request_idx = handler.find(
                    "AccountSelfDeleteContract.makeAuthorizedAccountDeleteRequest("
                )
                if origin_idx < 0 or token_idx < 0 or request_idx < 0:
                    raise SystemExit(
                        "missing origin-before-token deleteAccount "
                        f"wiring in {relative}"
                    )
                if not (origin_idx < token_idx < request_idx):
                    raise SystemExit(
                        "deleteAccount must fence origin before token "
                        f"before request in {relative}"
                    )
            results.append(
                {
                    "name": "native-deleteAccount-handlers-wire-contract",
                    "command": ["source-fence", "AccountSelfDeleteContract.resolve"],
                    "exit_code": 0,
                    "log": "",
                    "sha256": hashlib.sha256(b"AccountSelfDeleteContract.resolve").hexdigest(),
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
            print("native-deleteAccount-handlers-wire-contract: 0", flush=True)
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
