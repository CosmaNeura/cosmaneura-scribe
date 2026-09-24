"""Assemble an unsigned, disabled review payload from explicit local build outputs.

Does not install, sign, register URL schemes, launch helpers, enable an account,
select an upload service, or contact a service. Output must be a new directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import plistlib
import shutil
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assemble(args: argparse.Namespace) -> None:
    output = args.output.resolve()
    output.mkdir(mode=0o700)  # exclusive: preserve any existing application/payload
    desktop = output / "desktop"
    shutil.copytree(args.desktop_host, desktop)
    profile = plistlib.loads(args.ios_profile.read_bytes())
    if (
        profile["CFBundleIdentifier"] != "com.cosmaneura.scribe.beta"
        or profile["CosmasNativeAuth"]["enabled"] is not False
        or profile["CosmasNativeAuth"]["frontendOrigin"]
        != "https://resolved-emu-53.clerk.accounts.dev"
        or profile["ScribeProviderReceiver"]["profile"] != "core-staging-https-v1"
    ):
        raise ValueError("Expected the approved, disabled P1 iOS staging profile")
    helpers = {}
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
        info = {
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
    package_profile = {
        "schema": 1,
        "enabled": False,
        "coreOrigin": "https://staging-app.cosmaneura.com",
        "uploadOrigins": [],
        **helpers,
    }
    (desktop / "provider-profile.json").write_text(json.dumps(package_profile, indent=2) + "\n")
    ios = output / "ios"
    shutil.copytree(args.ios_renderer, ios / "www")
    profile["ScribeProviderApplication"] = {"enabled": False, "uploadOrigins": []}
    (ios / "StandaloneBuildProfile.plist").write_bytes(plistlib.dumps(profile, sort_keys=True))
    files = {
        p.relative_to(output).as_posix(): digest(p)
        for p in sorted(output.rglob("*"))
        if p.is_file()
    }
    receipt = {
        "schema": 1,
        "files_sha256": files,
        "desktop_factory_included": True,
        "native_helpers": list(helpers),
        "ios_provider_entry_included": True,
        "enabled": False,
        "signed": False,
        "installed": False,
        "launched": False,
        "pending": [
            "exact Scribe ciphertext upload origin",
            "reviewed release configuration and activation",
            "staging provider qualification",
            "distribution signing and installed packaging",
            "installed workflow acceptance",
        ],
    }
    (output / "assembly.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"output": str(output), "files": len(files), "enabled": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in (
        "output",
        "desktop-host",
        "auth-build",
        "audio-build",
        "ios-renderer",
        "ios-profile",
    ):
        parser.add_argument("--" + option, type=Path, required=True)
    assemble(parser.parse_args())
