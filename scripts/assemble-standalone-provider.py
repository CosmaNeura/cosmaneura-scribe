"""Assemble an unsigned provider payload from explicit local build outputs.

Does not install, sign, register URL schemes, launch helpers, enable an account,
select an upload service, or contact a service. Output must be a new directory.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import plistlib
import shutil
import sys
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def production_profiles(args: argparse.Namespace, helpers: dict) -> dict | None:
    source = getattr(args, "production_inputs", None)
    enabled = getattr(args, "enable_production_clients", False)
    if source is None:
        if enabled or getattr(args, "production_native_build_receipt", None) is not None:
            raise ValueError("production_profile_unavailable")
        return None
    if getattr(args, "ios_profile", None) is not None:
        raise ValueError("production_profile_unavailable")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("production_profile_unavailable")
            result[key] = value
        return result

    receipt = getattr(args, "production_native_build_receipt", None)
    if (
        source.is_symlink()
        or not source.is_file()
        or source.stat().st_size > 16384
        or receipt is None
        or receipt.is_symlink()
        or not receipt.is_file()
        or receipt.stat().st_size > 1048576
    ):
        raise ValueError("production_profile_unavailable")
    build = json.loads(receipt.read_bytes(), object_pairs_hook=unique)
    command = build.get("command")
    if (
        build.get("production_organization_compiled") is not True
        or not isinstance(command, list)
        or not all(isinstance(item, str) for item in command)
        or "-DSCRIBE_PRODUCTION_ORGANIZATION" not in command
        or any("SCRIBE_VIRTUAL_LAB_NETWORK" in item for item in command)
    ):
        raise ValueError("production_profile_unavailable")
    repo = Path(__file__).resolve().parents[1]
    pins = build.get("source_sha256", {})
    required = {
        "scripts/standalone-provider/DesktopProviderMain.swift": [
            "scripts/standalone-provider/DesktopProviderMain.swift"
        ],
        "scripts/standalone-provider/ProviderNativeTransport.swift": [
            "scripts/standalone-provider/ProviderNativeTransport.swift"
        ],
    }
    for name in ("NativeClerkConfiguration.swift", "NativeTokenPolicy.swift"):
        path = "apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/" + name
        required[path] = [path, "native-auth/Sources/CosmasNativeAuth/" + name]
    for path, aliases in required.items():
        found = [name for name in aliases if name in pins]
        if len(found) != 1 or pins[found[0]] != digest(repo / path):
            raise ValueError("production_profile_unavailable")
    value = json.loads(source.read_bytes(), object_pairs_hook=unique)
    if not isinstance(value, dict) or value.get("desktop_helpers") != helpers:
        raise ValueError("production_profile_unavailable")
    directory = Path(__file__).resolve().parent / "standalone-provider"
    sys.path.insert(0, str(directory))
    try:
        spec = importlib.util.spec_from_file_location(
            "production_profile_projection", directory / "prepare_production_profiles.py"
        )
        assert spec is not None and spec.loader is not None
        projector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(projector)
        runtime = sys.modules["receiver_runtime"]
        if Path(runtime.__file__).resolve() != directory / "receiver_runtime.py":
            raise ValueError("production_profile_unavailable")
        return projector.project(value, enable_clients=enabled)
    finally:
        sys.path.remove(str(directory))


def assemble(args: argparse.Namespace) -> None:
    helpers: dict[str, dict[str, str]] = {}
    for kind, executable in (
        ("auth", "ScribeDesktopProvider"),
        ("audio", "ScribeDesktopAudioHelper"),
        ("presentation", "ScribeProviderPresentationHelper"),
    ):
        source = (args.auth_build if kind == "auth" else args.audio_build) / executable
        if not source.is_file() or source.is_symlink():
            raise ValueError("Native build output is unavailable")
        helpers[kind] = {
            "path": "native/" + executable + ".app/Contents/MacOS/" + executable,
            "sha256": digest(source),
        }
    projected = production_profiles(args, helpers)
    profile = projected["ios"] if projected else plistlib.loads(args.ios_profile.read_bytes())
    if not projected and (
        profile["CFBundleIdentifier"] != "com.cosmaneura.scribe.beta"
        or profile["CosmasNativeAuth"]["enabled"] is not False
        or profile["CosmasNativeAuth"]["frontendOrigin"]
        != "https://resolved-emu-53.clerk.accounts.dev"
        or profile["ScribeProviderReceiver"]["profile"] != "core-staging-https-v1"
    ):
        raise ValueError("Expected the approved, disabled P1 iOS staging profile")
    output = args.output.resolve()
    output.mkdir(mode=0o700)  # exclusive: preserve any existing application/payload
    desktop = output / "desktop"
    shutil.copytree(args.desktop_host, desktop)
    for kind, executable in (
        ("auth", "ScribeDesktopProvider"),
        ("audio", "ScribeDesktopAudioHelper"),
        ("presentation", "ScribeProviderPresentationHelper"),
    ):
        source = (args.auth_build if kind == "auth" else args.audio_build) / executable
        if not source.is_file() or source.is_symlink():
            raise ValueError("Native build output is unavailable")
        bundle_id = "com.cosmaneura.scribe.beta.desktop." + kind
        bundle = desktop / "native" / (executable + ".app")
        macos = bundle / "Contents/MacOS"
        resources = bundle / "Contents/Resources"
        macos.mkdir(parents=True)
        resources.mkdir()
        target = macos / executable
        shutil.copy2(source, target)
        target.chmod(0o755)
        info: dict[str, object] = {
            "CFBundleIdentifier": bundle_id,
            "CFBundleExecutable": executable,
            "CFBundleName": executable,
            "CFBundleDisplayName": "Cosmaneura Scribe Beta",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.1.0",
            "CFBundleVersion": "1",
            "LSMinimumSystemVersion": "14.2",
            "LSUIElement": True,
        }
        if kind == "auth":
            info.update(
                {
                    "CosmasNativeAuth": profile["CosmasNativeAuth"],
                    "ScribeProviderReceiver": profile["ScribeProviderReceiver"],
                    "CFBundleURLTypes": [{"CFBundleURLSchemes": [bundle_id]}],
                }
            )
            shutil.copytree(
                args.auth_build / "ScribeDesktopProvider_ClerkKit.bundle",
                resources / "ScribeDesktopProvider_ClerkKit.bundle",
            )
        elif kind == "audio":
            info.update(
                {
                    "NSMicrophoneUsageDescription": (
                        "Scribe records your microphone for the visit you choose."
                    ),
                    "NSAudioCaptureUsageDescription": (
                        "Scribe records the meeting window you choose for this visit."
                    ),
                }
            )
        (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps(info, sort_keys=True))
        helpers[kind] = {"path": target.relative_to(desktop).as_posix(), "sha256": digest(target)}
    if projected and any(projected["desktop"][kind] != value for kind, value in helpers.items()):
        raise ValueError("production_profile_unavailable")
    package_profile: dict[str, object] = (
        projected["desktop"]
        if projected
        else {
            "schema": 1,
            "enabled": False,
            "coreOrigin": "https://staging-app.cosmaneura.com",
            "uploadOrigins": [],
            **helpers,
        }
    )
    (desktop / "provider-profile.json").write_text(json.dumps(package_profile, indent=2) + "\n")
    ios = output / "ios"
    shutil.copytree(args.ios_renderer, ios / "www")
    profile["UIBackgroundModes"] = sorted(set(profile.get("UIBackgroundModes", []) + ["audio"]))
    if not projected:
        profile["ScribeProviderApplication"] = {"enabled": False, "uploadOrigins": []}
    (ios / "StandaloneBuildProfile.plist").write_bytes(plistlib.dumps(profile, sort_keys=True))
    files = {
        p.relative_to(output).as_posix(): digest(p)
        for p in sorted(output.rglob("*"))
        if p.is_file()
    }
    receipt: dict[str, object] = {
        "schema": 1,
        "files_sha256": files,
        "desktop_factory_included": True,
        "native_helpers": list(helpers),
        "ios_provider_entry_included": True,
        "enabled": bool(projected and projected["desktop"]["enabled"]),
        "profile": "core-production-organization-v1" if projected else "core-staging-personal-v1",
        "production_qualified": False,
        "production_native_build_receipt_sha256": digest(args.production_native_build_receipt)
        if projected
        else None,
        "production_profile_inputs_sha256": digest(args.production_inputs) if projected else None,
        "ios_production_compile_required": bool(projected),
        "signed": False,
        "installed": False,
        "launched": False,
        "pending": [
            *([] if projected else ["exact Scribe ciphertext upload origin"]),
            "reviewed release configuration and activation",
            "production installed-client qualification"
            if projected
            else "staging provider qualification",
            "distribution signing and installed packaging",
            "installed workflow acceptance",
        ],
    }
    (output / "assembly.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"output": str(output), "files": len(files), "enabled": receipt["enabled"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in (
        "output",
        "desktop-host",
        "auth-build",
        "audio-build",
        "ios-renderer",
    ):
        parser.add_argument("--" + option, type=Path, required=True)
    profile = parser.add_mutually_exclusive_group(required=True)
    profile.add_argument("--ios-profile", type=Path)
    profile.add_argument("--production-inputs", type=Path)
    parser.add_argument("--production-native-build-receipt", type=Path)
    parser.add_argument("--enable-production-clients", action="store_true")
    assemble(parser.parse_args())
