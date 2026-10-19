"""Prepare reviewed XPC MAS source and unsigned claims, never apps/signing/runtime.

The macOS Team-ID group is fence-only and does not require App Group registration.
Native auth alone retains its existing Keychain group. Store provisioning,
installer identity, legacy custody and real sandbox qualification remain required.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import plistlib
from pathlib import Path

TEAM = "JVV65668U6"
PARENT = "com.cosmaneura.scribe.beta.desktop"
GROUP = TEAM + "." + PARENT
RUNTIME_SHA256 = "7e37fa13b746341f88dc37c188a1a56c515b06dd54eaf48a86ec16a3a0b678c6"


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
    auth = role(PARENT + ".auth")
    auth.update(
        {
            "com.apple.security.network.client": True,
            "keychain-access-groups": [TEAM + "." + PARENT + ".auth"],
        }
    )
    audio = role(PARENT + ".audio")
    audio["com.apple.security.device.audio-input"] = True
    return {
        "parent": parent,
        "inherited-child": {
            "com.apple.security.app-sandbox": True,
            "com.apple.security.inherit": True,
        },
        "native-auth": auth,
        "native-audio": audio,
        "native-presentation": role(PARENT + ".presentation"),
    }


def service_info(role: str) -> dict[str, object]:
    executable = {
        "auth": "ScribeDesktopProvider",
        "audio": "ScribeDesktopAudioStoreService",
        "presentation": "ScribePresentationStoreService",
    }[role]
    return {
        "CFBundleIdentifier": PARENT + "." + role,
        "CFBundlePackageType": "XPC!",
        "CFBundleExecutable": executable,
        "LSMinimumSystemVersion": "14.2",
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
        "inherited_bridge_identifier": PARENT,
        "profile_helper_path": "native/ScribeStorePipeBridge",
        "private_services": [service_info(role) for role in ["auth", "audio", "presentation"]],
        "source_preparation_receipt": "mas-inputs.DRAFT.json",
        "missing": [
            "independent review of this exact XPC source",
            "actual MAS signing/profile and installer identities plus separate Mac store record",
            "real signed sandbox/peer identity/Keychain/user session/TCC qualification",
            (
                "legacy95 fence and journal custody admission"
                "; missing/cold marker is not absence proof"
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
