"""Package a disabled desktop review candidate from explicit verified builds.

No installation, signing, launch, URL registration, authentication configuration,
upload destination selection, or service access is performed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import plistlib
import shutil
from pathlib import Path


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def ordinary(path: Path) -> Path:
    if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
        raise ValueError(f"An ordinary nonempty build artifact is required: {path}")
    return path


def assemble(args: argparse.Namespace) -> None:
    output = args.output.resolve()
    if not output.is_relative_to(Path("/private/tmp")):
        raise ValueError("An exclusive /private/tmp output is required")
    runtime = args.electron_app.resolve()
    runtime_info = plistlib.loads(ordinary(runtime / "Contents/Info.plist").read_bytes())
    runtime_receipt = json.loads(ordinary(args.runtime_receipt).read_bytes())
    if runtime_info.get("CFBundleShortVersionString") != "44.4.3" or (
        runtime_receipt.get("electron_version") != "44.4.3"
        or runtime_receipt.get("official_checksum_matches") is not True
        or runtime_receipt.get("archive_paths_validated") is not True
    ):
        raise ValueError("The verified repository-pinned Electron 44.4.3 is required")
    host = args.desktop_host.resolve()
    host_receipt = json.loads(ordinary(host / "host-build.json").read_bytes())
    if any(host_receipt.get(flag) is not False for flag in ("installed", "signed", "launch_ready")):
        raise ValueError("A locally built unsigned desktop host is required")
    renderer_hashes = {
        "provider-capture.js": args.expected_js_sha256,
        "provider-capture.css": args.expected_css_sha256,
    }
    for name, expected in renderer_hashes.items():
        if len(expected) != 64 or digest(ordinary(host / "renderer" / name)) != expected:
            raise ValueError(f"Final reviewed renderer hash differs: {name}")
    for name, expected in host_receipt["artifacts_sha256"].items():
        if digest(ordinary(host / name)) != expected:
            raise ValueError(f"Desktop host build artifact differs: {name}")
    builds = [
        ("auth", "ScribeDesktopProvider", args.auth_build),
        ("audio", "ScribeDesktopAudioHelper", args.audio_build),
        ("presentation", "ScribeProviderPresentationHelper", args.audio_build),
    ]
    for _, name, build in builds:
        ordinary(build / name)
    clerk = args.auth_build / "ScribeDesktopProvider_ClerkKit.bundle"
    if not clerk.is_dir() or clerk.is_symlink():
        raise ValueError("The actual built Clerk resource bundle is required")
    output.mkdir(mode=0o700)  # Refuse any existing app, payload or symbolic link.
    app = output / "Cosmaneura Scribe Beta.app"
    shutil.copytree(runtime, app, symlinks=True)
    contents = app / "Contents"
    # Only this newly owned outer bundle changes. Keep every actual helper byte
    # and embedded runtime component; no signing operation is invoked.
    outer_signature = contents / "_CodeSignature"
    if outer_signature.exists():
        shutil.rmtree(outer_signature)
    resources = contents / "Resources"
    packaged = resources / "app"
    shutil.copytree(host, packaged)
    shutil.copy2(host / "Scribe.icns", resources / "Scribe.icns")
    package_profile: dict[str, object] = {
        "schema": 1,
        "enabled": False,
        # Existing fixed Core profile, with no configured upload destination.
        "coreOrigin": "https://staging-app.cosmaneura.com",
        "uploadOrigins": [],
    }
    helper_inputs: dict[str, dict[str, str]] = {}
    for kind, name, build in builds:
        source = ordinary(build / name)
        bundle_id = "com.cosmaneura.scribe.beta.desktop." + kind
        helper = packaged / "native" / (name + ".app")
        macos = helper / "Contents/MacOS"
        helper_resources = helper / "Contents/Resources"
        macos.mkdir(parents=True)
        helper_resources.mkdir()
        target = macos / name
        shutil.copy2(source, target)
        target.chmod(0o755)
        info: dict[str, object] = {
            "CFBundleIdentifier": bundle_id,
            "CFBundleExecutable": name,
            "CFBundleName": name,
            "CFBundleDisplayName": "Cosmaneura Scribe Beta",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.1.0",
            "CFBundleVersion": "1",
            "LSMinimumSystemVersion": "14.2",
            "LSUIElement": True,
        }
        if kind == "auth":
            info["CosmasNativeAuth"] = {"enabled": False}
            info["ScribeProviderReceiver"] = {"enabled": False}
            shutil.copytree(clerk, helper_resources / clerk.name)
        elif kind == "audio":
            info["NSMicrophoneUsageDescription"] = (
                "Scribe records your microphone for the visit you choose."
            )
            info["NSAudioCaptureUsageDescription"] = (
                "Scribe records the meeting window you choose for this visit."
            )
        (helper / "Contents/Info.plist").write_bytes(plistlib.dumps(info, sort_keys=True))
        value = {"path": target.relative_to(packaged).as_posix(), "sha256": digest(target)}
        if value["sha256"] != digest(source):
            raise ValueError("A copied native helper differs from its actual build")
        package_profile[kind] = value
        helper_inputs[kind] = {"build_path": str(source.resolve()), **value}
    (packaged / "provider-profile.json").write_text(json.dumps(package_profile, indent=2) + "\n")
    runtime_info.update(
        {
            "CFBundleIdentifier": "com.cosmaneura.scribe.beta.desktop",
            "CFBundleName": "Cosmaneura Scribe Beta",
            "CFBundleDisplayName": "Cosmaneura Scribe Beta",
            "CFBundleIconFile": "Scribe.icns",
        }
    )
    (contents / "Info.plist").write_bytes(plistlib.dumps(runtime_info, sort_keys=True))
    files = {
        path.relative_to(output).as_posix(): digest(path)
        for path in sorted(output.rglob("*"))
        if path.is_file() and not path.is_symlink()
    }
    receipt = {
        "schema": 1,
        "app": app.relative_to(output).as_posix(),
        "files_sha256": files,
        "electron_version": "44.4.3",
        "electron_archive_sha256": runtime_receipt["archive_sha256"],
        "host_build_sha256": digest(host / "host-build.json"),
        "host_source_sha256": host_receipt["source_sha256"],
        "renderer_sha256": renderer_hashes,
        "native_helpers": helper_inputs,
        "clerk_resource_bundle_included": True,
        "enabled": False,
        "auth_enabled": False,
        "receiver_enabled": False,
        "live_auth_configuration_present": False,
        "configuration_required": True,
        "staging_qualified": False,
        "signed": False,
        "installed": False,
        "launched": False,
    }
    (output / "assembly.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(
        json.dumps(
            {
                "output": str(output),
                "files": len(files),
                "enabled": False,
                "configuration_required": True,
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in (
        "output",
        "desktop-host",
        "auth-build",
        "audio-build",
        "electron-app",
        "runtime-receipt",
    ):
        parser.add_argument("--" + option, type=Path, required=True)
    for option in ("expected-js-sha256", "expected-css-sha256"):
        parser.add_argument("--" + option, required=True)
    assemble(parser.parse_args())
