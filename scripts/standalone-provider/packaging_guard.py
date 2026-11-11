"""Offline packaging latches and preflight; errors never echo configuration values."""

from __future__ import annotations

import json
import os
import plistlib
import xml.etree.ElementTree as ET
from pathlib import Path

STAGING_CORE = "https://staging-app.cosmaneura.com"
PRODUCTION_CORE = "https://app.cosmaneura.com"
PRODUCTION_DEFINE = "SCRIBE_PRODUCTION_ORGANIZATION"
UNLOCK_ENV = "SCRIBE_FOUNDER_PRODUCTION_UNLOCK"


def require_founder_unlock(deliberate: bool = False) -> None:
    if deliberate is not True or os.environ.get(UNLOCK_ENV) != "1":
        raise ValueError(
            "Production packaging locked: founder entry requires "
            "--i-am-john-unlocking-production and SCRIBE_FOUNDER_PRODUCTION_UNLOCK=1"
        )


def environment_marker(core_origin: str) -> str:
    if core_origin == STAGING_CORE:
        return "S"
    if core_origin == PRODUCTION_CORE:
        return "P"
    raise ValueError("Packaging requires an approved Core origin")


def refuse_live_payload(value: object, label: str, *, production: bool = False) -> None:
    if production:
        return
    if isinstance(value, dict):
        if value.get("production_organization_compiled") is True:
            raise ValueError(f"Staging packaging refused: production compile definition in {label}")
        for key, item in value.items():
            refuse_live_payload(key, label)
            refuse_live_payload(item, label)
    elif isinstance(value, (list, tuple)):
        for item in value:
            refuse_live_payload(item, label)
    elif isinstance(value, bytes):
        refuse_live_payload(value.decode("utf-8", errors="replace"), label)
    elif isinstance(value, str):
        lowered = value.lower()
        for marker, reason in (
            (PRODUCTION_CORE, "live Cosmas API"),
            ("https://clerk.cosmaneura.com", "live Clerk"),
            ("pk_live_", "live Clerk key"),
            (PRODUCTION_DEFINE.lower(), "production compile definition"),
        ):
            if marker in lowered:
                raise ValueError(f"Staging packaging refused: {reason} marker in {label}")


def preflight_tree(root: Path, label: str, *, production: bool = False) -> None:
    """Inspect copied configuration, not source gates or executable literals."""
    if production:
        return

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Staging packaging refused: duplicate configuration in {label}")
            result[key] = value
        return result

    pending, visited = [root], set()
    while pending:
        path = pending.pop()
        if path.is_dir():
            resolved = path.resolve()
            if resolved not in visited:
                visited.add(resolved)
                pending.extend(path.iterdir())
            continue
        if path.suffix.lower() not in {".plist", ".json", ".xcconfig", ".pbxproj"} and (
            path.name not in {"compile-definition.txt", "compile-definitions.txt", "Package.swift"}
        ):
            continue
        if path.is_symlink():
            raise ValueError(f"Staging packaging refused: symbolic configuration in {label}")
        if path.is_file():
            raw = path.read_bytes()
            refuse_live_payload(raw, label)
            if path.suffix.lower() == ".plist":
                payload = plistlib.loads(raw)
                if raw.startswith(b"bplist"):
                    for encoding in ("utf-16-be", "utf-16-le"):
                        refuse_live_payload(raw.decode(encoding, errors="replace"), label)
                else:
                    refuse_live_payload(list(ET.fromstring(raw).itertext()), label)
            elif path.suffix.lower() == ".json":
                payload = json.loads(raw, object_pairs_hook=unique)
            else:
                payload = raw
            refuse_live_payload(payload, label)


def preflight_compile_environment(*, production: bool = False) -> None:
    for name in (
        "SWIFTFLAGS",
        "OTHER_SWIFT_FLAGS",
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
        "CFLAGS",
        "CPPFLAGS",
        "CXXFLAGS",
        "LDFLAGS",
    ):
        refuse_live_payload(os.environ.get(name, ""), "compile environment", production=production)


def require_store_auth_enabled(desktop_profile: object, auth_info: object) -> None:
    """Store App Store candidates must ship with sign-in enabled.

    Default assemblers stamp enabled:false (Setup required). That is valid for
    disabled review candidates and invalid for a Store submission package.
    """
    if not isinstance(desktop_profile, dict) or desktop_profile.get("enabled") is not True:
        raise ValueError("Store package requires provider-profile enabled=true")
    if not isinstance(auth_info, dict):
        raise ValueError("Store package requires CosmasNativeAuth.enabled=true")
    auth = auth_info.get("CosmasNativeAuth")
    if not isinstance(auth, dict) or auth.get("enabled") is not True:
        raise ValueError("Store package requires CosmasNativeAuth.enabled=true")


def require_store_application_auth_enabled(application: Path) -> None:
    """Fail closed when a Store .app still carries a disabled auth package."""
    resources = application / "Contents/Resources/app"
    profile_path = resources / "provider-profile.json"
    if not profile_path.is_file() or profile_path.is_symlink():
        raise ValueError("Store package requires provider-profile.json")
    profile = json.loads(profile_path.read_text())
    auth_info_path = (
        resources / "native/ScribeDesktopProvider.app/Contents/Info.plist"
    )
    # Store XPC packages keep auth under Contents/XPCServices or the helper app.
    if not auth_info_path.is_file():
        candidates = sorted(resources.rglob("ScribeDesktopProvider*/Contents/Info.plist"))
        auth_info_path = next((path for path in candidates if path.is_file()), auth_info_path)
    if not auth_info_path.is_file() or auth_info_path.is_symlink():
        raise ValueError("Store package requires CosmasNativeAuth Info.plist")
    auth_info = plistlib.loads(auth_info_path.read_bytes())
    require_store_auth_enabled(profile, auth_info)
