"""Build the native provider helper offline from the retained local Clerk SDK.

The output is an unsigned executable plus its real SwiftPM resource bundle.
No helper is launched and no installed app, dependency cache or Keychain is changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path


def build(output: Path, native_auth: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    output = output.resolve()
    output.mkdir(mode=0o700)
    package = output / "package"
    package.mkdir()
    auth = native_auth.resolve()
    if not (auth / "Sources/CosmasNativeAuth").is_dir():
        raise ValueError("Explicit retained native auth source is required")
    inputs = {}

    def copy(source: Path, target: Path) -> None:
        if source.is_symlink():
            raise ValueError("Native source must be an ordinary local file")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        relative = (
            source.relative_to(repo).as_posix()
            if source.is_relative_to(repo)
            else "native-auth/" + source.relative_to(auth).as_posix()
        )
        inputs[relative] = hashlib.sha256(source.read_bytes()).hexdigest()

    for source_root, target_name in (
        (auth / "vendor/Sources/ClerkKit", "ClerkKit"),
        (auth / "Sources/CosmasNativeAuth", "CosmasNativeAuth"),
        (
            repo / "apps/capture/native-plugins/native-recording/Sources/CosmaneuraNativeRecording",
            "CosmaneuraNativeRecording",
        ),
    ):
        for source in sorted(source_root.rglob("*")):
            if source.is_file():
                copy(source, package / "Sources" / target_name / source.relative_to(source_root))
    for name in (
        "DesktopProviderMain.swift",
        "DesktopProviderInput.swift",
        "DesktopSourceRegistry.swift",
        "NativeProviderConnection.swift",
        "NativeProviderRecordingService.swift",
        "NativeSourceStartOwner.swift",
        "NativeSourceProofJournal.swift",
        "NativeSourceRecovery.swift",
        "NativeCaptureProcessFence.swift",
        "ProviderNativeTransport.swift",
    ):
        copy(
            repo / "scripts/standalone-provider" / name,
            package / "Sources/ScribeDesktopProvider" / name,
        )
    copy(
        auth / "Bridge/W13PrivateTransport.swift",
        package / "Sources/ScribeDesktopProvider/W13PrivateTransport.swift",
    )
    (package / "Package.swift").write_text("""// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "ScribeDesktopProvider", defaultLocalization: "en",
 platforms: [.macOS(.v14)],
 products: [.executable(name: "ScribeDesktopProvider", targets: ["ScribeDesktopProvider"])],
 targets: [.target(name: "ClerkKit", resources: [.process("Resources")]),
 .target(name: "CosmasNativeAuth", dependencies: ["ClerkKit"]),
 .target(name: "CosmaneuraNativeRecording"),
 .executableTarget(name: "ScribeDesktopProvider",
                   dependencies: ["CosmasNativeAuth", "CosmaneuraNativeRecording"])])
""")
    command = [
        "xcrun",
        "swift",
        "build",
        "--package-path",
        str(package),
        "--scratch-path",
        str(output / "build"),
        "--cache-path",
        str(output / "cache"),
        "--config-path",
        str(output / "configuration"),
        "--security-path",
        str(output / "security"),
        "--disable-sandbox",
        "--configuration",
        "release",
        "-debug-info-format",
        "none",
    ]
    environment = {
        **os.environ,
        "CLANG_MODULE_CACHE_PATH": str(output / "modules"),
        "SWIFTPM_MODULECACHE_OVERRIDE": str(output / "modules"),
    }
    with (output / "build.log").open("w") as log:
        subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    (output / "build-inputs.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "command": command,
                "source_sha256": inputs,
                "native_auth_source": str(auth),
                "signed": False,
                "launched": False,
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps({"output": str(output), "signed": False, "launched": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--native-auth-source", type=Path, required=True)
    options = parser.parse_args()
    build(options.output, options.native_auth_source)
