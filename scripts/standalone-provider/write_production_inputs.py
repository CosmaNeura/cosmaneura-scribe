"""Write founder --production-inputs JSON from a Core pin and helper bindings.

Offline only: reads a Core infra/production_live_settings.tf pin, then either
hashes local helper executables from auth/audio build directories (Direct Beta /
assemble-standalone-provider.py layout) or admits a Store bridge declaration from
hash-mac-store-bridge.mjs (MAS XPC / build 132), validates with
prepare_production_profiles.project, and writes schema-1 JSON exclusively.

Modes:
- Build-dir mode (--auth-build + --audio-build): Direct Beta route. Output is for
  scripts/assemble-production-provider.py / assemble-standalone-provider.py.
- Store mode (--store-bridge-declaration): MAS XPC route. Output is for the
  founder prepare CLI scripts/standalone-provider/prepare_production_profiles.py
  only. The Direct Beta assembler refuses macho-store-v1 declarations. There is
  no in-repo step that installs prepare's desktop-profile.json into a MAS .app as
  Contents/Resources/app/provider-profile.json; for build 132 that install is an
  operator step in the release runbook.

Never prints, hashes-for-print, or diffs the output file—stdout/stderr list key
names (present/missing) and the output path only. No network, Azure, Clerk,
1Password, or environment-secret reads.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from prepare_production_profiles import project

_VALIDATOR_PATH = Path(__file__).resolve().with_name("prepare_production_profiles.py")
_DISALLOWED_WORKSPACE_ID = "56f527ab-0caf-459b-bda9-cf7f0ca2f709"
_DEFAULT_EXPECT_PROFILE = "core-production-personal-v1"
_HELPER_EXECUTABLES = (
    ("auth", "ScribeDesktopProvider"),
    ("audio", "ScribeDesktopAudioHelper"),
    ("presentation", "ScribeProviderPresentationHelper"),
)
_HELPER_PATHS = {
    kind: "native/" + executable + ".app/Contents/MacOS/" + executable
    for kind, executable in _HELPER_EXECUTABLES
}
_STORE_BRIDGE_PATH = "Contents/MacOS/ScribeStorePipeBridge"
_STORE_HASH_ALGORITHM = "macho-store-v1"
_STORE_DECLARATION_KEYS = ("path", "sha256", "hashAlgorithm")
_STORE_DECLARATION_MAX_BYTES = 1024
_PUBLISHABLE_KEY_STOP = "STOP: publishable key does not match validator literal"
_STRING_LITERAL = re.compile(r'"([^"]*)"')
_SHA256_HEX = re.compile(r"[0-9a-f]{64}")

_STATUS_KEYS = (
    "schema",
    "receiver",
    "receiver.profile",
    "receiver.enabled",
    "receiver.beta_box_id",
    "receiver.production",
    "receiver.production.deployment_receipt_sha256",
    "receiver.production.session_claims_receipt_sha256",
    "receiver.production.native_policy_receipt_sha256",
    "receiver.production.protected_data_receipt_sha256",
    "client",
    "client.publishable_key",
    "client.upload_origin",
    "client.workspace_id",
    "desktop_helpers",
    "desktop_helpers.auth.path",
    "desktop_helpers.auth.sha256",
    "desktop_helpers.audio.path",
    "desktop_helpers.audio.sha256",
    "desktop_helpers.presentation.path",
    "desktop_helpers.presentation.sha256",
)


class Refuse(Exception):
    """Refuse with a names-only reason; never carry binding values."""


class PublishableKeyMismatch(Exception):
    """Derived key does not match the validator's clerk-host literal / pk_live_ form."""


def _unique_assignment(source: str, key: str) -> str:
    matches = list(
        re.finditer(rf"(?m)^[ \t]*{re.escape(key)}[ \t]*=[ \t]*(.+?)[ \t]*$", source)
    )
    if len(matches) != 1:
        raise Refuse(f"assignment:{key}:missing_or_ambiguous")
    return matches[0].group(1).strip()


def _unique_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate configuration field")
        result[key] = value
    return result


def _parse_receiver_configuration_json(source: str) -> dict[str, Any]:
    rhs = _unique_assignment(source, "receiver_configuration_json")
    if rhs.startswith("jsonencode("):
        raise Refuse("receiver_configuration_json:jsonencode_unsupported")
    if not (rhs.startswith('"') and rhs.endswith('"')):
        raise Refuse("receiver_configuration_json:malformed")
    try:
        text = json.loads(rhs)
        if not isinstance(text, str):
            raise Refuse("receiver_configuration_json:malformed")
        if "${" in text or "%{" in text:
            raise Refuse("receiver_configuration_json:interpolation")
        value = json.loads(text, object_pairs_hook=_unique_object_pairs)
    except Refuse:
        raise
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise Refuse("receiver_configuration_json:malformed") from exc
    if not isinstance(value, dict):
        raise Refuse("receiver_configuration_json:malformed")
    return value


def _parse_capture_upload_origin(source: str) -> str:
    rhs = _unique_assignment(source, "capture_upload_origins")
    match = re.fullmatch(r"toset\(\[(.*)\]\)", rhs, flags=re.DOTALL)
    if match is None:
        raise Refuse("capture_upload_origins:malformed")
    inner = match.group(1).strip()
    # Exactly one HCL/JSON string literal — no empty list, no trailing refs.
    if not re.fullmatch(r'"[^"]*"', inner):
        raise Refuse("capture_upload_origins:count")
    literal = _STRING_LITERAL.fullmatch(inner)
    if literal is None:
        raise Refuse("capture_upload_origins:count")
    origin = literal.group(1)
    if not origin.startswith("https://"):
        raise Refuse("capture_upload_origins:not_https")
    return origin


def validator_clerk_host_literal() -> bytes:
    """Read the clerk-host bytes literal from prepare_production_profiles.project."""
    text = _VALIDATOR_PATH.read_text(encoding="utf-8")
    matches = re.findall(r'!=\s*(b"[^"]+\$")', text)
    if len(matches) != 1:
        raise Refuse("validator:clerk_host_literal:missing_or_ambiguous")
    token = matches[0]
    if not (token.startswith('b"') and token.endswith('"')):
        raise Refuse("validator:clerk_host_literal:malformed")
    literal = token[2:-1].encode("ascii")
    if not literal.endswith(b"$"):
        raise Refuse("validator:clerk_host_literal:malformed")
    return literal


def encode_publishable_key(host_literal: bytes) -> str:
    """Derive pk_live_ from clerk-host bytes (url-safe alphabet)."""
    return "pk_live_" + base64.urlsafe_b64encode(host_literal).decode("ascii")


def matches_validator_pk_live_form(key: str, host_literal: bytes) -> bool:
    """Same pk_live_ + decode checks as prepare_production_profiles.project."""
    if not key.startswith("pk_live_") or len(key) > 1024:
        return False
    encoded = key[8:].replace("-", "+").replace("_", "/")
    try:
        decoded = base64.b64decode(
            encoded + "=" * ((4 - len(encoded) % 4) % 4), validate=True
        )
    except (ValueError, TypeError):
        return False
    return decoded == host_literal


def _canonical_pk_live(host_literal: bytes) -> str:
    """Canonical pk_live_ for the validator clerk-host bytes."""
    return "pk_live_" + base64.urlsafe_b64encode(host_literal).decode("ascii")


def derive_and_verify_publishable_key() -> str:
    """Derive key from the validator's own clerk-host literal; STOP on mismatch."""
    host_literal = validator_clerk_host_literal()
    key = encode_publishable_key(host_literal)
    if key != _canonical_pk_live(host_literal) or not matches_validator_pk_live_form(
        key, host_literal
    ):
        raise PublishableKeyMismatch()
    return key


def verify_against_validator_literal(key: str) -> None:
    """Compare a candidate key to the validator's clerk-host literal and pk_live_ form."""
    host_literal = validator_clerk_host_literal()
    if key != _canonical_pk_live(host_literal) or not matches_validator_pk_live_form(
        key, host_literal
    ):
        raise PublishableKeyMismatch()


def _digest(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise Refuse(f"helper:{path.name}:missing")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def desktop_helpers_from_builds(auth_build: Path, audio_build: Path) -> dict[str, dict[str, str]]:
    """Match assemble-standalone-provider.assemble helper binding exactly."""
    helpers: dict[str, dict[str, str]] = {}
    for kind, executable in _HELPER_EXECUTABLES:
        source = (auth_build if kind == "auth" else audio_build) / executable
        if source.is_symlink() or not source.is_file():
            raise Refuse(f"helper:{executable}:missing")
        helpers[kind] = {
            "path": "native/" + executable + ".app/Contents/MacOS/" + executable,
            "sha256": _digest(source),
        }
    return helpers


def desktop_helpers_from_store_declaration(
    declaration_path: Path,
) -> dict[str, dict[str, str]]:
    """Admit hash-mac-store-bridge.mjs JSON into all three desktop_helpers roles."""
    if declaration_path.is_symlink() or not declaration_path.is_file():
        raise Refuse("store_bridge_declaration:missing")
    try:
        size = declaration_path.stat().st_size
    except OSError as exc:
        raise Refuse("store_bridge_declaration:unreadable") from exc
    if size > _STORE_DECLARATION_MAX_BYTES:
        raise Refuse("store_bridge_declaration:too_large")
    try:
        raw = declaration_path.read_bytes()
    except OSError as exc:
        raise Refuse("store_bridge_declaration:unreadable") from exc
    if len(raw) > _STORE_DECLARATION_MAX_BYTES:
        raise Refuse("store_bridge_declaration:too_large")
    try:
        value = json.loads(raw, object_pairs_hook=_unique_object_pairs)
    except RecursionError as exc:
        raise Refuse("store_bridge_declaration:malformed") from exc
    except ValueError as exc:
        # json.JSONDecodeError is a ValueError; keep one malformed arm.
        if str(exc) == "duplicate configuration field":
            raise Refuse("store_bridge_declaration:duplicate_keys") from exc
        raise Refuse("store_bridge_declaration:malformed") from exc
    except TypeError as exc:
        raise Refuse("store_bridge_declaration:malformed") from exc
    if not isinstance(value, dict):
        raise Refuse("store_bridge_declaration:malformed")
    declaration_in: dict[str, Any] = value
    if set(declaration_in) != set(_STORE_DECLARATION_KEYS):
        raise Refuse("store_bridge_declaration:keys")
    path = declaration_in["path"]
    sha256 = declaration_in["sha256"]
    algorithm = declaration_in["hashAlgorithm"]
    if not isinstance(path, str) or path != _STORE_BRIDGE_PATH:
        raise Refuse("store_bridge_declaration:path")
    if not isinstance(algorithm, str) or algorithm != _STORE_HASH_ALGORITHM:
        raise Refuse("store_bridge_declaration:hashAlgorithm")
    if not isinstance(sha256, str) or _SHA256_HEX.fullmatch(sha256) is None:
        raise Refuse("store_bridge_declaration:sha256")
    declaration = {
        "path": path,
        "sha256": sha256,
        "hashAlgorithm": algorithm,
    }
    return {
        "auth": dict(declaration),
        "audio": dict(declaration),
        "presentation": dict(declaration),
    }


def resolve_desktop_helpers(
    *,
    auth_build: Path | None,
    audio_build: Path | None,
    store_bridge_declaration: Path | None,
) -> dict[str, dict[str, str]]:
    """Require exactly one helper mode: build dirs or Store bridge declaration."""
    has_store = store_bridge_declaration is not None
    has_auth = auth_build is not None
    has_audio = audio_build is not None
    if has_store and (has_auth or has_audio):
        raise Refuse("mode:exclusive")
    if has_store:
        assert store_bridge_declaration is not None
        return desktop_helpers_from_store_declaration(store_bridge_declaration)
    if has_auth and has_audio:
        assert auth_build is not None and audio_build is not None
        return desktop_helpers_from_builds(auth_build, audio_build)
    if has_auth or has_audio:
        raise Refuse("mode:incomplete")
    raise Refuse("mode:required")


def _lookup_parent(payload: dict[str, Any], dotted: str) -> tuple[Any, str]:
    parent_path, leaf = dotted.rsplit(".", 1)
    current: Any = payload
    for part in parent_path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None, leaf
        current = current[part]
    return current, leaf


def _key_present(payload: dict[str, Any] | None, key: str) -> bool:
    if payload is None:
        return False
    if "." not in key:
        return key in payload
    parent, leaf = _lookup_parent(payload, key)
    return isinstance(parent, dict) and leaf in parent


def report_status(
    payload: dict[str, Any] | None,
    out: Path,
    *,
    stream: Any | None = None,
) -> None:
    """Names and present/missing only—never values, output hashes, or diffs."""
    target = sys.stdout if stream is None else stream
    for key in _STATUS_KEYS:
        state = "present" if _key_present(payload, key) else "missing"
        target.write(f"{key}: {state}\n")
    target.write(f"output: {out}\n")


def build_payload(
    *,
    core_pin: Path,
    auth_build: Path | None = None,
    audio_build: Path | None = None,
    store_bridge_declaration: Path | None = None,
    expect_profile: str = _DEFAULT_EXPECT_PROFILE,
) -> dict[str, Any]:
    if core_pin.is_symlink() or not core_pin.is_file():
        raise Refuse("core_pin:missing")
    try:
        source = core_pin.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise Refuse("core_pin:encoding") from exc
    except OSError as exc:
        raise Refuse("core_pin:unreadable") from exc

    receiver = _parse_receiver_configuration_json(source)
    actual_profile = receiver.get("profile")
    if not isinstance(actual_profile, str):
        raise Refuse("receiver.profile:missing")
    # Only personal is admitted, even if expect_profile were coerced to match the pin.
    if (
        expect_profile != _DEFAULT_EXPECT_PROFILE
        or actual_profile != _DEFAULT_EXPECT_PROFILE
    ):
        raise Refuse("receiver.profile:mismatch")

    # Copy every field verbatim (including production.*_receipt_sha256); force enabled.
    receiver = dict(receiver)
    receiver["enabled"] = False

    workspace_id = receiver.get("beta_box_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        raise Refuse("client.workspace_id:missing")
    if workspace_id == _DISALLOWED_WORKSPACE_ID:
        raise Refuse("client.workspace_id:disallowed")

    upload_origin = _parse_capture_upload_origin(source)
    publishable_key = derive_and_verify_publishable_key()
    verify_against_validator_literal(publishable_key)

    helpers = resolve_desktop_helpers(
        auth_build=auth_build,
        audio_build=audio_build,
        store_bridge_declaration=store_bridge_declaration,
    )
    payload = {
        "schema": 1,
        "receiver": receiver,
        "client": {
            "publishable_key": publishable_key,
            "upload_origin": upload_origin,
            "workspace_id": workspace_id,
        },
        "desktop_helpers": helpers,
    }
    try:
        project(payload)
    except ValueError as exc:
        raise Refuse("validator:failure") from exc

    sealed_key = payload["client"]["publishable_key"]
    if not isinstance(sealed_key, str):
        raise PublishableKeyMismatch()
    verify_against_validator_literal(sealed_key)
    return payload


def write_payload(payload: dict[str, Any], out: Path) -> None:
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    fd: int | None = None
    created = False
    try:
        fd = os.open(out, flags, 0o600)
        created = True
        with os.fdopen(fd, "wb") as handle:
            fd = None
            handle.write(data)
    except FileExistsError as exc:
        raise Refuse("output:exists") from exc
    except OSError as exc:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if created:
            try:
                out.unlink(missing_ok=True)
            except OSError:
                pass
        raise Refuse("output:unwritable") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core-pin", type=Path, required=True)
    parser.add_argument(
        "--auth-build",
        type=Path,
        default=None,
        help=(
            "Direct Beta: directory containing ScribeDesktopProvider "
            "(assemble layout; with --audio-build → assemble-production-provider)"
        ),
    )
    parser.add_argument(
        "--audio-build",
        type=Path,
        default=None,
        help=(
            "Direct Beta: directory containing ScribeDesktopAudioHelper and "
            "ScribeProviderPresentationHelper (assemble layout)"
        ),
    )
    parser.add_argument(
        "--store-bridge-declaration",
        type=Path,
        default=None,
        help=(
            "MAS XPC / build 132: file holding hash-mac-store-bridge.mjs JSON. "
            "Mutually exclusive with --auth-build/--audio-build. Output is for "
            "prepare_production_profiles.py only (not the Direct Beta assembler). "
            "Installing desktop-profile.json as provider-profile.json in the MAS "
            ".app is an operator release-runbook step; no in-repo packager does it."
        ),
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--expect-profile",
        default=_DEFAULT_EXPECT_PROFILE,
        choices=(_DEFAULT_EXPECT_PROFILE,),
        help="Read-only expected receiver.profile (personal only)",
    )
    args = parser.parse_args(argv)
    payload: dict[str, Any] | None = None
    try:
        payload = build_payload(
            core_pin=args.core_pin,
            auth_build=args.auth_build,
            audio_build=args.audio_build,
            store_bridge_declaration=args.store_bridge_declaration,
            expect_profile=args.expect_profile,
        )
        write_payload(payload, args.out)
    except PublishableKeyMismatch:
        sys.stderr.write(_PUBLISHABLE_KEY_STOP + "\n")
        report_status(None, args.out, stream=sys.stderr)
        return 1
    except Refuse as exc:
        sys.stderr.write(f"refuse:{exc}\n")
        report_status(None, args.out, stream=sys.stderr)
        return 1
    report_status(payload, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
