"""Verify helper pins and existing provider claims in a signed desktop package."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import struct
import subprocess
from pathlib import Path
from typing import cast
from xml.parsers.expat import ExpatError

PROVIDER_ID = "com.cosmaneura.scribe.beta.desktop.auth"
PROVIDER_CLAIMS: dict[str, object] = {
    "com.apple.application-identifier": "JVV65668U6." + PROVIDER_ID,
    "com.apple.developer.team-identifier": "JVV65668U6",
    "keychain-access-groups": ["JVV65668U6." + PROVIDER_ID],
}
HOST_CLAIMS: dict[str, object] = {
    "com.apple.security.cs.allow-jit": True,
    "com.apple.security.device.audio-input": True,
}


def provider_claims(binary: bytes) -> dict[str, object]:
    """Read signed XML claims; codesign's default display is not plist data."""
    return signed_claims(binary, PROVIDER_CLAIMS)


def signed_claims(binary: bytes, expected: dict[str, object]) -> dict[str, object]:
    """Require the exact claims for the responsible process, not its child."""

    def require(condition: bool) -> None:
        if not condition:
            raise ValueError("provider_signature_invalid")

    require(32 <= len(binary) <= 64 * 1024 * 1024)
    require(struct.unpack_from("<I", binary)[0] == 0xFEEDFACF)
    commands, command_bytes = struct.unpack_from("<II", binary, 16)
    require(commands <= 1024 and 32 + command_bytes <= len(binary))
    offset = 32
    signature = None
    for _ in range(commands):
        require(offset + 8 <= 32 + command_bytes)
        command, size = struct.unpack_from("<II", binary, offset)
        require(size >= 8 and offset + size <= 32 + command_bytes)
        if command == 0x1D:
            require(size == 16 and signature is None)
            signature = struct.unpack_from("<II", binary, offset + 8)
        offset += size
    require(offset == 32 + command_bytes and signature is not None)
    assert signature is not None
    begin, length = signature
    require(length >= 12 and begin >= offset and begin + length <= len(binary))
    magic, size, count = struct.unpack_from(">III", binary, begin)
    require(magic == 0xFADE0CC0 and 12 <= size <= length and count <= 64)
    require(12 + count * 8 <= size)
    claims: dict[str, object] | None = None
    seen: set[int] = set()
    cms_signature = False
    for index in range(count):
        slot, relative = struct.unpack_from(">II", binary, begin + 12 + index * 8)
        require(slot not in seen)
        seen.add(slot)
        require(relative >= 12 + count * 8 and relative + 8 <= size)
        blob_magic, blob_size = struct.unpack_from(">II", binary, begin + relative)
        require(blob_size >= 8 and relative + blob_size <= size)
        if slot == 0:
            require(blob_magic == 0xFADE0C02 and blob_size >= 16)
            flags = struct.unpack_from(">I", binary, begin + relative + 12)[0]
            # Ad-hoc signatures cannot authenticate existing Keychain access.
            require(flags & 0x2 == 0)
        elif slot == 0x10000:
            require(blob_magic == 0xFADE0B01 and blob_size > 8)
            cms_signature = True
        elif slot == 5:
            require(blob_magic == 0xFADE7171)
            try:
                value = plistlib.loads(binary[begin + relative + 8 : begin + relative + blob_size])
            except (plistlib.InvalidFileException, ValueError, TypeError, ExpatError) as error:
                raise ValueError("provider_claims_invalid") from error
            require(isinstance(value, dict))
            claims = cast(dict[str, object], value)
        elif slot == 7:
            require(blob_magic == 0xFADE7172)
    require(claims == expected and 7 in seen and 0 in seen and cms_signature)
    assert claims is not None
    require(all(type(claims[key]) is type(value) for key, value in expected.items()))
    return claims


def check_helper_pins(resources: Path) -> Path:
    raw: object = json.loads((resources / "provider-profile.json").read_text())
    if not isinstance(raw, dict):
        raise ValueError("helper_profile_invalid")
    profile = cast(dict[str, object], raw)
    auth_helper: Path | None = None
    for kind in ("auth", "audio", "presentation"):
        value = profile[kind]
        if not isinstance(value, dict):
            raise ValueError("helper_profile_invalid")
        binding = cast(dict[str, object], value)
        if set(binding) != {"path", "sha256"}:
            raise ValueError("helper_profile_invalid")
        name = binding["path"]
        if not isinstance(name, str) or Path(name).is_absolute() or "\\" in name:
            raise ValueError("helper_path_invalid")
        if any(part in ("", ".", "..") for part in name.split("/")):
            raise ValueError("helper_path_invalid")
        helper = resources / name
        if helper.resolve() != helper or not helper.is_file() or not os.access(helper, os.X_OK):
            raise ValueError("helper_path_invalid")
        if hashlib.sha256(helper.read_bytes()).hexdigest() != binding["sha256"]:
            raise ValueError("helper_pin_mismatch")
        if kind == "auth":
            auth_helper = helper
    assert auth_helper is not None
    return auth_helper


def check_package(application: Path) -> dict[str, object]:
    application = application.absolute()
    if application.resolve() != application or not application.is_dir():
        raise ValueError("application_path_invalid")
    info = plistlib.loads((application / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.cosmaneura.scribe.beta.desktop":
        raise ValueError("application_identity_invalid")
    executable = info.get("CFBundleExecutable")
    if not isinstance(executable, str) or not executable or Path(executable).name != executable:
        raise ValueError("application_executable_invalid")
    signed_claims((application / "Contents/MacOS" / executable).read_bytes(), HOST_CLAIMS)
    resources = application / "Contents/Resources/app"
    helper = check_helper_pins(resources)
    native_info = plistlib.loads((helper.parent.parent / "Info.plist").read_bytes())
    if native_info.get("CFBundleIdentifier") != PROVIDER_ID:
        raise ValueError("provider_identity_invalid")
    provider_claims(helper.read_bytes())
    verified = subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(application)],
        capture_output=True,
        check=False,
    )
    if verified.returncode:
        raise ValueError("application_signature_invalid")
    return {
        "build": info["CFBundleVersion"],
        "helper_pins_verified": 3,
        "provider_existing_claims_verified": True,
        "responsible_host_microphone_entitlement_verified": True,
        "strict_deep_signature_verified": True,
        "launched": False,
        "data_keys_accessed": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("application", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(check_package(args.application)))
    except (ValueError, KeyError, OSError, struct.error) as error:
        # No arbitrary paths, parser input or subprocess output in diagnostics.
        parser.exit(1, "Signed desktop package verification failed: " + type(error).__name__ + "\n")
