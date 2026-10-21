"""Build only native XPC/stdio bridge executables from reviewed local source.

No executable, service or application is launched. No Apple signing/account,
installed app, credentials or user data are accessed or changed.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path

GROUP = "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store"


def build(output: Path, native_auth: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    output = output.absolute()
    output.mkdir(mode=0o700)  # Existing output always fails; no replacement.
    module = repo / "apps/desktop-companion/native/ScribeDesktopAudio/Sources/ScribeStorePipe"
    audio = repo / "apps/desktop-companion/native/ScribeDesktopAudio"
    environment = {
        **os.environ,
        "CLANG_MODULE_CACHE_PATH": str(output / "modules"),
        "SWIFTPM_MODULECACHE_OVERRIDE": str(output / "modules"),
    }
    source_roots = [
        audio / "Sources",
        repo / "apps/desktop-companion/native/ScribeDesktopStoreBridge",
        repo / "scripts/standalone-provider",
    ]

    def inventory() -> dict[str, str]:
        sources = {
            p.relative_to(repo).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for root in source_roots
            for p in sorted(root.rglob("*"))
            if p.is_file() and not p.is_symlink()
        }
        for path in [
            Path(__file__),
            repo / "scripts/build-desktop-native-provider.py",
            audio / "Package.swift",
        ]:
            sources[path.relative_to(repo).as_posix()] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
        return sources

    sources = inventory()
    commands = []
    for product in ["ScribeDesktopAudioStoreService", "ScribePresentationStoreService"]:
        command = [
            "xcrun",
            "swift",
            "build",
            "--package-path",
            str(audio),
            "--scratch-path",
            str(output / "swift-build"),
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
            "--product",
            product,
            "-Xswiftc",
            "-DSCRIBE_MAC_APP_STORE",
            "-Xswiftc",
            "-DSCRIBE_MAC_APP_STORE_XPC",
            "-Xcc",
            "-DSCRIBE_MAC_APP_STORE_XPC=1",
        ]
        commands.append(command)
        with (output / (product + ".build.log")).open("w") as log:
            subprocess.run(
                command, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True
            )
    spec = importlib.util.spec_from_file_location(
        "native_provider_builder", repo / "scripts/build-desktop-native-provider.py"
    )
    if spec is None or spec.loader is None:
        raise ValueError("Native provider builder unavailable")
    auth_builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auth_builder)
    auth_builder.build(output / "auth", native_auth, mac_app_store_xpc=True)
    command = [
        "xcrun",
        "clang",
        "-std=c11",
        "-fblocks",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-mmacosx-version-min=14.4",
        "-DSCRIBE_MAC_APP_STORE_XPC=1",
        "-I",
        str(module / "include"),
        str(module / "StorePipeProtocol.c"),
        str(module / "StorePeerRequirement.c"),
        str(repo / "apps/desktop-companion/native/ScribeDesktopStoreBridge/StorePipeBridge.c"),
        "-framework",
        "CoreFoundation",
        "-framework",
        "Security",
        "-o",
        str(output / "ScribeStorePipeBridge"),
    ]
    commands.append(command)
    with (output / "bridge.build.log").open("w") as log:
        subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    # SwiftPM's actual outputs are discovered and uniquely bound, never assumed.
    artifacts = {}
    for name in [
        "ScribeDesktopAudioStoreService",
        "ScribePresentationStoreService",
        "ScribeDesktopProvider",
        "ScribeStorePipeBridge",
    ]:
        candidates = [
            p
            for p in output.rglob(name)
            if p.is_file() and not p.is_symlink() and ".build" not in p.parts
        ]
        if len(candidates) != 1:
            raise ValueError("Production executable output is not unique")
        path = candidates[0]
        artifacts[name] = {
            "path": path.relative_to(output).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
    if inventory() != sources:
        raise ValueError("Source changed during compilation; no final build receipt")
    receipt = {
        "schema": 1,
        "state": "MAC_APP_STORE_XPC_COMPILED_UNQUALIFIED",
        "commands": commands,
        "source_sha256": sources,
        "artifacts": artifacts,
        "compiled_application_group": GROUP,
        "auth_build_receipt": "auth/build-inputs.json",
        "signed": False,
        "launched": False,
        "sandbox_qualified": False,
        "legacy_custody_qualified": False,
    }
    (output / "native-build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--native-auth-source", type=Path, required=True)
    options = parser.parse_args()
    build(options.output, options.native_auth_source)
