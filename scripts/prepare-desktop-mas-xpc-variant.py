"""Prepare reviewed XPC MAS source and unsigned claims, never apps/signing/runtime.

The macOS Team-ID group is fence-only. Native auth alone receives its distinct
Store Keychain group. Profiles must authorize the new auth App ID and compiled
groups; Apple runtime/container and capture qualification remain required.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import plistlib
import shutil
from pathlib import Path

TEAM = "JVV65668U6"
HELPER_BASE = "com.cosmaneura.scribe.beta.desktop"
PARENT = HELPER_BASE + ".store"
BRIDGE = PARENT + ".bridge"
GROUP = TEAM + "." + PARENT
AUTH = HELPER_BASE + ".store.auth"
BRIDGE_BUNDLE_PATH = "Contents/MacOS/ScribeStorePipeBridge"
RUNTIME_SHA256 = "7e37fa13b746341f88dc37c188a1a56c515b06dd54eaf48a86ec16a3a0b678c6"


def place_store_bridge(application: Path, source: Path) -> dict[str, str]:
    """Copy only the unsigned bridge into its fixed code location, exclusively.

    Release callers bind source bytes and validate the complete app separately.
    This placement does not sign, launch, or establish XPC namespace access.
    """
    macos = application / "Contents/MacOS"
    if (
        not application.is_absolute()
        or application.resolve() != application
        or not application.name.endswith(".app")
        or not macos.is_dir()
        or macos.is_symlink()
        or macos.resolve() != macos
        or not source.is_absolute()
        or source.resolve() != source
        or not source.is_file()
        or source.is_symlink()
        or (application / "Contents/Resources/app/native/ScribeStorePipeBridge").exists()
        or (application / "Contents/Resources/app/native/ScribeStorePipeBridge").is_symlink()
    ):
        raise ValueError("Store bridge placement requires a canonical unsigned app")
    target = application / BRIDGE_BUNDLE_PATH
    with source.open("rb") as incoming, target.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing)
    target.chmod(0o755)
    return {"path": BRIDGE_BUNDLE_PATH, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}


def xpc_claims() -> dict[str, dict[str, object]]:
    def role(bundle: str) -> dict[str, object]:
        return {
            "com.apple.security.app-sandbox": True,
            "com.apple.security.application-groups": [GROUP],
            "com.apple.application-identifier": TEAM + "." + bundle,
            "com.apple.developer.team-identifier": TEAM,
        }

    parent = role(PARENT)
    parent["com.apple.security.network.client"] = True
    auth = role(AUTH)
    auth.update(
        {
            "com.apple.security.network.client": True,
            "keychain-access-groups": [TEAM + "." + AUTH],
        }
    )
    audio = role(HELPER_BASE + ".audio")
    audio["com.apple.security.device.audio-input"] = True
    return {
        "parent": parent,
        "inherited-child": {
            "com.apple.security.app-sandbox": True,
            "com.apple.security.inherit": True,
        },
        "native-auth": auth,
        "native-audio": audio,
        "native-presentation": role(HELPER_BASE + ".presentation"),
    }


def validate_auth_profile_authorization(entitlements: dict[str, object]) -> None:
    """Check verified CMS profile authorization, not its executable grants.

    The caller separately verifies CMS trust, expiration and profile type. The
    signed executable still receives only the exact claims from xpc_claims().
    """
    def permits(key: str, exact: str) -> bool:
        values = entitlements.get(key)
        return isinstance(values, list) and any(
            isinstance(value, str)
            and (value == exact or value == TEAM + ".*")
            for value in values
        )

    if (
        entitlements.get("com.apple.application-identifier") != TEAM + "." + AUTH
        or entitlements.get("com.apple.developer.team-identifier") != TEAM
        or not permits("com.apple.security.application-groups", GROUP)
        or not permits("keychain-access-groups", TEAM + "." + AUTH)
    ):
        raise ValueError("Store auth profile does not authorize the isolated identity")


def service_info(role: str) -> dict[str, object]:
    executable = {
        "auth": "ScribeDesktopProvider",
        "audio": "ScribeDesktopAudioStoreService",
        "presentation": "ScribePresentationStoreService",
    }[role]
    return {
        "CFBundleIdentifier": AUTH if role == "auth" else HELPER_BASE + "." + role,
        "CFBundlePackageType": "XPC!",
        "CFBundleExecutable": executable,
        "LSMinimumSystemVersion": "14.4",
        "XPCService": {
            "ServiceType": "Application",
            "RunLoopType": "NSRunLoop",
            "JoinExistingSession": True,
        },
        "NSMicrophoneUsageDescription": (
            "Scribe records the selected microphone only after patient consent."
        ),
        "NSScreenCaptureUsageDescription": (
            "Scribe captures audio from the meeting selected by the provider after patient consent."
        ),
    }


def prepare(output: Path, clerk_source: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "dormant_mas", repo / "scripts/prepare-desktop-mas-variant.py"
    )
    if spec is None or spec.loader is None:
        raise ValueError("Retained source preparer unavailable")
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    # Source copies only. The older dormant target is unchanged and remains nil.
    original.prepare(output, clerk_source)
    # Electron's MAS Mach namespace is Team ID + parent bundle ID. Select the
    # isolated Store group without granting the direct app's legacy group.
    info_path = output / "store-info.DRAFT.plist"
    info = plistlib.loads(info_path.read_bytes())
    info["CFBundleIdentifier"] = PARENT
    info["LSMinimumSystemVersion"] = "14.4"
    info_path.write_bytes(plistlib.dumps(info))
    for name, claims in xpc_claims().items():
        target = output / ("xpc-" + name + ".entitlements.DRAFT.plist")
        target.write_bytes(plistlib.dumps(claims))
        target.chmod(0o600)
    for role in ["auth", "audio", "presentation"]:
        target = output / (role + ".xpc.Info.DRAFT.plist")
        target.write_bytes(plistlib.dumps(service_info(role)))
        target.chmod(0o600)
    receipt = {
        "schema": 1,
        "state": "MAC_APP_STORE_XPC_UNQUALIFIED_INPUTS",
        "compiled_fence_only_application_group": GROUP,
        "host_build_flag": "--mac-app-store-xpc",
        "native_swift_flags": ["-DSCRIBE_MAC_APP_STORE", "-DSCRIBE_MAC_APP_STORE_XPC"],
        "native_clang_flags": ["-DSCRIBE_MAC_APP_STORE_XPC=1"],
        "runtime_archive_sha256": RUNTIME_SHA256,
        "parent_bundle_identifier": PARENT,
        "inherited_bridge_identifier": BRIDGE,
        "profile_helper_path": BRIDGE_BUNDLE_PATH,
        "private_services": [service_info(role) for role in ["auth", "audio", "presentation"]],
        "source_preparation_receipt": "mas-inputs.DRAFT.json",
        "missing": [
            "independent review of this exact XPC source",
            "actual new auth App ID/profiles and MAS signing/installer identities",
            "real signed sandbox/peer identity/Keychain/user session/TCC qualification",
            (
                "separate Store fence/journal and local app data coexistence qualification"
            ),
            (
                "actual capture stop/drain, concurrent catalo"
                "gue/capture, encrypted save/audio review qua"
                "lification"
            ),
        ],
        "signed": False,
        "launched": False,
        "installed": False,
        "qualified": False,
    }
    (output / "xpc-inputs.DRAFT.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--clerk-source", type=Path, required=True)
    options = parser.parse_args()
    prepare(options.output, options.clerk_source)
