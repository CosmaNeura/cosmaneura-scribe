"""Compile the real desktop source owner and run offline synthetic race checks."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    output = parser.parse_args().output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parents[1]
    auth = repo / "apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth"
    standalone = repo / "scripts/standalone-provider"
    sources = [
        auth / f"{name}.swift"
        for name in [
            "DesktopAuthProtocol",
            "KeychainAccessBlock",
            "NativeAuthAwait",
            "NativeCaptureStartGate",
            "NativeClerkConfiguration",
            "NativeTokenPolicy",
            "NativeWorkspaceAuth",
        ]
    ]
    bridge = [
        standalone / f"{name}.swift"
        for name in [
            "NativeProviderConnection",
            "ProviderNativeTransport",
            "NativeSourceStartOwner",
            "NativeSourceProofJournal",
            "NativeSourceRecovery",
            "NativeCaptureProcessFence",
            "DesktopSourceRegistry",
            "check-native-provider",
            "check-desktop-source",
        ]
    ]
    flags = [
        "xcrun",
        "swiftc",
        "-swift-version",
        "6",
        "-O",
        "-module-cache-path",
        str(output / "cache"),
    ]
    commands = [
        flags
        + [
            "-emit-library",
            "-emit-module",
            "-module-name",
            "CosmasNativeAuth",
            "-emit-module-path",
            str(output / "CosmasNativeAuth.swiftmodule"),
            "-o",
            str(output / "libCosmasNativeAuth.dylib"),
            *map(str, sources),
        ],
        flags
        + [
            "-parse-as-library",
            "-D",
            "NATIVE_BINDING_CHECKS",
            "-I",
            str(output),
            "-L",
            str(output),
            "-lCosmasNativeAuth",
            "-Xlinker",
            "-rpath",
            "-Xlinker",
            str(output),
            "-o",
            str(output / "checks"),
            *map(str, bridge),
        ],
        [str(output / "checks")],
    ]
    results: list[dict[str, object]] = []
    inputs = {
        str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sources + bridge
    }
    for index, command in enumerate(commands):
        result = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=120)
        log = output / f"{index}.log"
        log.write_text(result.stdout + result.stderr)
        results.append({"command": command, "exit_code": result.returncode, "log": str(log)})
        (output / "CHECKS.json").write_text(
            json.dumps(
                {
                    "source_sha256": inputs,
                    "results": results,
                    "synthetic_only": True,
                    "microphone": False,
                    "network": False,
                    "keychain": False,
                },
                indent=2,
            )
            + "\n"
        )
        if result.returncode:
            raise SystemExit(f"Desktop source check failed: {log}")
        if result.stdout.strip():
            print(result.stdout.strip())


if __name__ == "__main__":
    main()
