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


def build(
    output: Path, native_auth: Path, *, mac_app_store: bool = False, mac_app_store_xpc: bool = False
) -> None:
    if mac_app_store and mac_app_store_xpc:
        raise ValueError("Select one explicit store topology")
    store = mac_app_store or mac_app_store_xpc
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
    if store:
        store_source = repo / (
            "apps/desktop-companion/native/ScribeDesktopA"
            "udio/Sources/ScribeDesktopAudio/NativeDeskto"
            "pStoreContainer.swift"
        )
        copy(
            store_source,
            package / "Sources/ScribeDesktopProvider/NativeDesktopStoreContainer.swift",
        )
    copy(
        auth / "Bridge/W13PrivateTransport.swift",
        package / "Sources/ScribeDesktopProvider/W13PrivateTransport.swift",
    )
    if mac_app_store_xpc:
        source_root = (
            repo / "apps/desktop-companion/native/ScribeDesktopAudio/Sources/ScribeStorePipe"
        )
        for source in sorted(source_root.rglob("*")):
            if source.is_file():
                copy(source, package / "Sources/ScribeStorePipe" / source.relative_to(source_root))
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
    if mac_app_store_xpc:
        manifest = package / "Package.swift"
        manifest.write_text(
            manifest.read_text()
            .replace("platforms: [.macOS(.v14)]", 'platforms: [.macOS("14.4")]')
            .replace(
                'targets: [.target(name: "ClerkKit",',
                (
                    'targets: [.target(name: "ScribeStorePipe", p'
                    'ublicHeadersPath: "include", linkerSettings:'
                    ' [.linkedFramework("Security"), .linkedFrame'
                    'work("CoreFoundation")]), .target(name: "Cle'
                    'rkKit",'
                ),
            )
            .replace(
                'dependencies: ["CosmasNativeAuth", "CosmaneuraNativeRecording"]',
                (
                    'dependencies: ["CosmasNativeAuth", "Cosmaneu'
                    'raNativeRecording", "ScribeStorePipe"]'
                ),
            )
        )
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
    if store:
        command += ["-Xswiftc", "-DSCRIBE_MAC_APP_STORE"]
    if mac_app_store_xpc:
        command += [
            "-Xswiftc",
            "-DSCRIBE_MAC_APP_STORE_XPC",
            "-Xcc",
            "-DSCRIBE_MAC_APP_STORE_XPC=1",
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
                **(
                    {
                        "distribution": "mac-app-store-xpc-unqualified"
                        if mac_app_store_xpc
                        else "mac-app-store-dormant",
                        "approved_application_group": (
                            "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store"
                        )
                        if mac_app_store_xpc
                        else None,
                    }
                    if store
                    else {}
                ),
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
    parser.add_argument("--mac-app-store", action="store_true")
    parser.add_argument("--mac-app-store-xpc", action="store_true")
    options = parser.parse_args()
    build(
        options.output,
        options.native_auth_source,
        mac_app_store=options.mac_app_store,
        mac_app_store_xpc=options.mac_app_store_xpc,
    )
