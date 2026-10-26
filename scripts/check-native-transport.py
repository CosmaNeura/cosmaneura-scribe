"""Compile actual native auth/transport and run offline checks on macOS."""

import argparse
import json
import plistlib
import subprocess
import time
import uuid
from pathlib import Path
from typing import TypedDict


class CheckResult(TypedDict):
    command: list[str]
    exit_code: int
    log: str


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--lab-network",
        action="store_true",
        help=(
            "Compile the explicit lab proxy flavor and exercise it only with "
            "offline URLProtocol fixtures"
        ),
    )
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[1]
    source = root / "apps/capture/native-plugins/cosmas-native-auth"
    bridge = source / "Bridge"
    standalone = root / "scripts/standalone-provider"
    for shared in ("ProviderNativeTransport.swift", "NativeProviderConnection.swift"):
        if (bridge / shared).read_bytes() != (standalone / shared).read_bytes():
            raise SystemExit(f"native contract copies differ: {shared}")
    common = [
        "xcrun",
        "swiftc",
        "-swift-version",
        "5",
        "-module-cache-path",
        str(output / "module-cache"),
    ]
    if args.lab_network:
        common += ["-D", "SCRIBE_VIRTUAL_LAB_NETWORK"]
    commands = [
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=offline.invalid",
            "-keyout",
            str(output / "fixture.key"),
            "-outform",
            "DER",
            "-out",
            str(output / "fixture.der"),
        ],
        common
        + [
            "-emit-library",
            "-emit-module",
            "-module-name",
            "CosmasNativeAuth",
            "-emit-module-path",
            str(output / "CosmasNativeAuth.swiftmodule"),
            "-o",
            str(output / "libCosmasNativeAuth.dylib"),
        ]
        + [
            str(path)
            for path in sorted((source / "Sources/CosmasNativeAuth").glob("*.swift"))
            if path.name != "ClerkKitWorkspaceDriver.swift"
        ],
    ]
    recording = (
        root / "apps/capture/native-plugins/native-recording/Sources/CosmaneuraNativeRecording"
    )
    commands.append(
        common
        + [
            "-emit-library",
            "-emit-module",
            "-module-name",
            "CosmaneuraNativeRecording",
            "-emit-module-path",
            str(output / "CosmaneuraNativeRecording.swiftmodule"),
            "-o",
            str(output / "libCosmaneuraNativeRecording.dylib"),
        ]
        + [str(path) for path in sorted(recording.glob("*.swift"))]
    )
    names = (
        ("transport",) if args.lab_network else ("transport", "provider", "desktop-initial-window")
    )
    lab_resources: dict[str, Path] = {}
    for name in names:
        executable = output / name
        if args.lab_network:
            # Executed directly as a CLI fixture, never opened, installed or
            # launched through an application/UI service. Every request is
            # intercepted by URLProtocol before DNS/TLS or proxy connection.
            contents = output / "OfflineNetworkFixture.app" / "Contents"
            (contents / "MacOS").mkdir(parents=True)
            (contents / "Resources").mkdir()
            executable = contents / "MacOS" / name
            (contents / "Info.plist").write_bytes(
                plistlib.dumps(
                    {
                        "CFBundleIdentifier": "com.cosmaneura.scribe.lab.offline-network-test",
                        "CFBundleExecutable": name,
                        "CFBundlePackageType": "APPL",
                    }
                )
            )
            lab_resources[str(executable)] = contents / "Resources/ScribeVirtualLabNetwork.json"
        # Desktop owns its distinct source-start implementation; the phone
        # bridge retains microphone-finalization authority and must not be copied.
        owner_sources = standalone if name == "desktop-initial-window" else bridge
        commands += [
            common
            + [
                "-parse-as-library",
                "-I",
                str(output),
                "-L",
                str(output),
                "-lCosmasNativeAuth",
                "-lCosmaneuraNativeRecording",
                "-Xlinker",
                "-rpath",
                "-Xlinker",
                str(output),
                "-o",
                str(executable),
                str(bridge / "NativeProviderConnection.swift"),
                str(bridge / "ProviderNativeTransport.swift"),
                *[
                    str(owner_sources / filename)
                    for filename in (
                        "NativeProviderRecordingService.swift",
                        "NativeSourceStartOwner.swift",
                        "NativeSourceProofJournal.swift",
                        "NativeSourceRecovery.swift",
                        "NativeCaptureProcessFence.swift",
                    )
                ],
                str(standalone / f"check-native-{name}.swift"),
            ],
            [str(executable)] + ([str(output / "fixture.der")] if name == "provider" else []),
        ]
    commands += [
        common
        + [
            "-parse-as-library",
            "-o",
            str(output / "token-timing"),
            str(source / "Sources/CosmasNativeAuth/NativeTokenRequestTiming.swift"),
            str(standalone / "check-native-token-timing.swift"),
        ],
        [str(output / "token-timing")],
    ]
    results: list[CheckResult] = []
    for index, command in enumerate(commands):
        if resource := lab_resources.get(command[0]):
            issued = int(time.time())
            resource.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "runId": str(uuid.uuid4()),
                        "proxyPort": 18443,
                        "issuedAtUnixSeconds": issued,
                        "expiresAtUnixSeconds": issued + 15,
                    },
                    sort_keys=True,
                )
                + "\n"
            )
        result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=60)
        log = output / f"{index}.log"
        log.write_text(result.stdout + result.stderr)
        results.append({"command": command, "exit_code": result.returncode, "log": str(log)})
        (output / "result.json").write_text(json.dumps(results, indent=2) + "\n")
        if result.returncode:
            raise SystemExit(f"native check failed: {log}")
        if name_output := result.stdout.strip():
            print(name_output)
    print("Actual native auth/transport checks passed; no network or account access.")


if __name__ == "__main__":
    main()
