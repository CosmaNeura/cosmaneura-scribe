"""Prepare unsigned, dormant MAS inputs; never sign, download or launch an app.

The existing direct-distribution builder is retained. This independent target
materializes the exact locked Clerk source, native store path and draft claims
into a fresh directory. Missing Apple identities remain explicit and fail closed.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import plistlib
import shutil
from pathlib import Path

TEAM = "JVV65668U6"
PARENT = "com.cosmaneura.scribe.beta.desktop"
AUTH = PARENT + ".auth"
ELECTRON_VERSION = "44.4.3"
APP_GROUP_TOKEN = "UNAPPROVED_APP_GROUP_NOT_SIGNABLE"


def draft_claims() -> dict[str, dict[str, object]]:
    def native(bundle: str) -> dict[str, object]:
        return {
            "com.apple.security.app-sandbox": True,
            "com.apple.security.application-groups": [APP_GROUP_TOKEN],
            "com.apple.application-identifier": TEAM + "." + bundle,
            "com.apple.developer.team-identifier": TEAM,
        }

    parent = native(PARENT)
    parent.update({"com.apple.security.network.client": True, "com.apple.security.device.audio-input": True})
    auth = native(AUTH)
    auth.update({"com.apple.security.network.client": True, "keychain-access-groups": [TEAM + "." + AUTH]})
    audio = native(PARENT + ".audio")
    audio["com.apple.security.device.audio-input"] = True
    return {
        "parent": parent,
        "electron-child": {"com.apple.security.app-sandbox": True, "com.apple.security.inherit": True},
        "native-auth": auth,
        "native-audio": audio,
        "native-presentation": native(PARENT + ".presentation"),
    }


def prepare(output: Path, clerk_source: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("MAS output must be new")
    # Reuse the exact committed dependency inventory gate; no SDK patching.
    spec = importlib.util.spec_from_file_location("assemble_native_source", repo / "scripts/assemble-native-source.py")
    if spec is None or spec.loader is None:
        raise ValueError("Native source assembler is unavailable")
    assembler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assembler)
    expected = json.loads((repo / "apps/capture/native-plugins/cosmas-native-auth/clerk-source-lock.json").read_text())["files"]
    if assembler.inventory(clerk_source) != expected:
        raise ValueError("Retained Clerk source differs from the committed lock")
    output.mkdir(mode=0o700)
    assembler.assemble(output / "native-source", clerk_source)
    audio = output / "audio-package"
    shutil.copytree(repo / "apps/desktop-companion/native/ScribeDesktopAudio", audio,
                    ignore=shutil.ignore_patterns(".build", ".swiftpm"))
    for name, claims in draft_claims().items():
        path = output / (name + ".entitlements.DRAFT.plist")
        path.write_bytes(plistlib.dumps(claims)); path.chmod(0o600)
    # No fabricated store version/build, App Group, profiles or distribution identity.
    info = {"CFBundleIdentifier": PARENT, "ElectronTeamID": TEAM,
            "LSMinimumSystemVersion": "14.2",
            "LSApplicationCategoryType": "public.app-category.medical",
            "NSMicrophoneUsageDescription": "Scribe records the selected microphone only after patient consent.",
            "NSScreenCaptureUsageDescription": "Scribe captures audio from the meeting selected by the provider after patient consent."}
    (output / "store-info.DRAFT.plist").write_bytes(plistlib.dumps(info))
    sources = assembler.inventory(output)
    receipt = {
        "schema": 1, "state": "MAC_APP_STORE_DORMANT_INPUTS",
        "runtime": {"version": ELECTRON_VERSION, "platform": "mas", "architecture": "arm64",
                    "archive_name": f"electron-v{ELECTRON_VERSION}-mas-arm64.zip", "archive_sha256": None,
                    "release_url": f"https://github.com/electron/electron/releases/tag/v{ELECTRON_VERSION}"},
        "source_sha256": sources,
        "native_auth_source": str(output / "native-source/cosmas-native-auth"),
        "native_swift_flags": ["-DSCRIBE_MAC_APP_STORE"],
        "host_build_flag": "--mac-app-store",
        "apple": {"approved_application_group": None, "development_profiles": None,
                  "distribution_profiles": None, "application_distribution_identity": None,
                  "installer_distribution_identity": None, "app_store_record": None,
                  "marketing_version": None, "bundle_version": None},
        "activation_available": False, "signed": False, "launched": False, "installed": False,
        "missing": ["approved compiled App Group identity and matching parent/native helper profiles",
                    "official MAS runtime archive checksum and exact material inventory",
                    "reviewed native helper sandbox launch/Keychain/container attribution qualification",
                    "existing source-owner journal custody reconciliation; never reset or migrate implicitly",
                    "Clerk installation-marker/biometric cleanup and existing credential custody under sandbox attribution",
                    "actual store bundle version/build and app record",
                    "sandboxed microphone/meeting capture, encrypted save/recovery and saved-audio review qualification"],
    }
    (output / "mas-inputs.DRAFT.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"output": str(output), "activation_available": False, "signed": False, "launched": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--clerk-source", required=True, type=Path)
    options = parser.parse_args()
    prepare(options.output, options.clerk_source)
