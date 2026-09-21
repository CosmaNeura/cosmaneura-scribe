"""Offline, metadata-only preflight of a retained Capacitor iPhone IPA.

This neither executes the app nor verifies signing, TLS, authentication, or beta
acceptance. Unknown bundle layouts fail closed. No extraction or network access.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import plistlib
import re
import stat
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import cast
from urllib.parse import urlsplit

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 10_000


class CandidateInvalid(Exception):
    """Fixed code only; never retain a parser exception or protected input."""


class UniqueMetadata(dict[str, object]):
    def __setitem__(self, key: str, value: object) -> None:
        if key in self:
            raise CandidateInvalid("candidate_metadata_ambiguous")
        super().__setitem__(key, value)


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = UniqueMetadata()
    for key, value in pairs:
        result[key] = value
    return result


class EntryScripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.sources: list[str] = []
        self.unsupported = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in {"script", "base"}:
            return
        if tag == "base" or len({key for key, _ in attrs}) != len(attrs):
            self.unsupported = True
            return
        values = dict(attrs)
        source = values.get("src")
        if values.get("type") != "module" or not source:
            self.unsupported = True
            return
        self.sources.append(source)


def _read(archive: zipfile.ZipFile, name: str) -> bytes:
    info = archive.getinfo(name)
    if info.file_size > MAX_MEMBER_BYTES or info.flag_bits & 1:
        raise CandidateInvalid("archive_member_unsupported")
    with archive.open(info) as stream:
        result = stream.read(MAX_MEMBER_BYTES + 1)
    if len(result) > MAX_MEMBER_BYTES:
        raise CandidateInvalid("archive_member_unsupported")
    return result


def _root(archive: zipfile.ZipFile) -> str:
    members = archive.infolist()
    names = [info.filename for info in members]
    if len(members) > MAX_MEMBERS or len(set(names)) != len(names):
        raise CandidateInvalid("archive_layout_unsupported")
    for info in members:
        name = info.filename
        path = PurePosixPath(name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in name
            or str(path) != name.rstrip("/")
            or stat.S_ISLNK(info.external_attr >> 16)
        ):
            raise CandidateInvalid("archive_layout_unsupported")
    roots = {
        PurePosixPath(name).parts[1]
        for name in names
        if len(PurePosixPath(name).parts) >= 2
        and PurePosixPath(name).parts[0] == "Payload"
        and PurePosixPath(name).parts[1].endswith(".app")
    }
    if len(roots) != 1:
        raise CandidateInvalid("archive_layout_unsupported")
    return f"Payload/{roots.pop()}/"


def _compiled_string(source: str, key: str) -> str:
    # Deliberately limited to the reviewed Vite-emitted JSON-string property.
    # Do not execute JS or infer a value from an unreferenced asset/source map.
    if len(re.findall(r"\b" + re.escape(key) + r"\b", source)) != 1:
        raise CandidateInvalid("compiled_config_unsupported")
    match = re.search(r"\b" + re.escape(key) + r'\s*:\s*("(?:[^"\\]|\\.)*")', source)
    if match is None:
        raise CandidateInvalid("compiled_config_unsupported")
    value = json.loads(match.group(1))
    if not isinstance(value, str):
        raise CandidateInvalid("compiled_config_unsupported")
    return value


def _api_origin(value: str) -> str | None:
    """A public-looking exact HTTPS origin; DNS/TLS/reachability remain unproven."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (
            parsed.scheme != "https"
            or not host
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or "?" in value
            or "#" in value
            or "\\" in value
            or any(character.isspace() for character in value)
        ):
            return None
        if host == "localhost" or host.endswith(
            (".localhost", ".local", ".internal", ".invalid", ".test", ".example")
        ):
            return None
        if host in {"example.com", "example.net", "example.org"} or any(
            host.endswith("." + suffix) for suffix in ("example.com", "example.net", "example.org")
        ):
            return None
        # Reject IP literals and numeric legacy IPv4 forms; no DNS query is made.
        try:
            ipaddress.ip_address(host)
            return None
        except ValueError:
            pass
        labels = host.split(".")
        if len(labels) < 2 or not re.fullmatch(r"[a-z]{2,63}", labels[-1]):
            return None
        if any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
        ):
            return None
        return "https://" + host
    except ValueError:
        return None


def _version(value: object) -> tuple[int, ...] | None:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,2}(?:\.[0-9]{1,2}){0,2}", value):
        return None
    return tuple(int(part) for part in value.split(".")) + (0,) * (3 - len(value.split(".")))


def inspect_candidate(
    ipa: Path,
    *,
    expected_bundle_id: str,
    approved_api_origin: str | None = None,
) -> dict[str, object]:
    report: dict[str, object] = {
        "schema_version": "1.0",
        "check_scope": "offline_capacitor_iphone_candidate",
        "ipa_sha256": None,
        "expected_bundle_id_sha256": None,
        "approved_api_origin_sha256": None,
        "findings": [],
        "static_preflight_passed": False,
        "network_verified": False,
        "signature_verified": False,
        "authentication_verified": False,
        "physical_device_verified": False,
        "release_accepted": False,
    }
    findings: list[str] = []
    report["findings"] = findings
    try:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+", expected_bundle_id):
            raise CandidateInvalid("expected_bundle_id_invalid")
        report["expected_bundle_id_sha256"] = hashlib.sha256(
            expected_bundle_id.encode()
        ).hexdigest()
        approved = _api_origin(approved_api_origin) if approved_api_origin is not None else None
        if approved is not None:
            report["approved_api_origin_sha256"] = hashlib.sha256(approved.encode()).hexdigest()
        with ipa.open("rb") as stream:
            digest = hashlib.sha256()
            count = 0
            while block := stream.read(1024 * 1024):
                count += len(block)
                if count > MAX_ARCHIVE_BYTES:
                    raise CandidateInvalid("archive_size_unsupported")
                digest.update(block)
            report["ipa_sha256"] = digest.hexdigest()
            stream.seek(0)
            with zipfile.ZipFile(stream) as archive:
                root = _root(archive)
                raw_info: object = plistlib.loads(
                    _read(archive, root + "Info.plist"), dict_type=UniqueMetadata
                )
                raw_config: object = json.loads(
                    _read(archive, root + "capacitor.config.json"), object_pairs_hook=_unique_object
                )
                if not isinstance(raw_info, dict) or not isinstance(raw_config, dict):
                    raise CandidateInvalid("candidate_metadata_invalid")
                info = cast(dict[str, object], raw_info)
                config = cast(dict[str, object], raw_config)
                if info.get("CFBundleIdentifier") != expected_bundle_id:
                    findings.append("bundle_identity_mismatch")
                if config.get("appId") != info.get("CFBundleIdentifier"):
                    findings.append("capacitor_identity_mismatch")
                if info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
                    findings.append("not_iphoneos_package")
                if _version(info.get("MinimumOSVersion")) != (17, 0, 0):
                    findings.append("ios17_support_floor_not_preserved")
                native_auth = info.get("CosmasNativeAuth")
                if (
                    not isinstance(native_auth, dict)
                    or cast(dict[str, object], native_auth).get("enabled") is not True
                ):
                    findings.append("native_auth_not_configured")
                if "server" in config:
                    findings.append("remote_webview_config_unsupported")
                if config.get("loggingBehavior") != "none":
                    findings.append("bridge_logging_not_disabled")
                html = EntryScripts()
                html.feed(_read(archive, root + "public/index.html").decode("utf-8"))
                html.close()
                if html.unsupported or len(html.sources) != 1:
                    raise CandidateInvalid("web_entry_unsupported")
                entry = html.sources[0]
                if not re.fullmatch(r"(?:\./)?assets/[A-Za-z0-9_-]+\.js", entry):
                    raise CandidateInvalid("web_entry_unsupported")
                entry = entry.removeprefix("./")
                bundle = _read(archive, root + "public/" + entry).decode("utf-8")
                origin = _api_origin(_compiled_string(bundle, "VITE_API_BASE"))
                if origin is None:
                    findings.append("api_origin_not_device_candidate")
                if _compiled_string(bundle, "VITE_WORKSPACE_NATIVE_AUTH_ENABLED") != "true":
                    findings.append("native_auth_web_gate_disabled")
                for key, value in (
                    ("VITE_COSMAS_ENV", "synth_os"),
                    ("VITE_WORKSPACE_ENABLED", "true"),
                    ("VITE_WORKSPACE_AUTHENTICATED_ENABLED", "true"),
                    ("VITE_WORKSPACE_NATIVE_SYNTHETIC_ENABLED", "false"),
                    ("VITE_DESKTOP_SYNTHETIC_ENABLED", "false"),
                ):
                    if _compiled_string(bundle, key) != value:
                        findings.append("native_auth_trial_profile_mismatch")
                        break
                if approved_api_origin is None:
                    findings.append("approved_api_origin_missing")
                else:
                    if approved is None:
                        findings.append("approved_api_origin_invalid")
                    elif origin != approved:
                        findings.append("api_origin_not_approved")
    except CandidateInvalid as error:
        findings.append(str(error))
    except Exception:
        # Plist/XML, ZIP/decompressor and filesystem errors can contain input.
        # This offline diagnostic fails closed without printing their context.
        findings.append("candidate_unreadable")
    report["static_preflight_passed"] = not findings
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ipa", type=Path, required=True)
    parser.add_argument("--expected-bundle-id", required=True)
    parser.add_argument("--approved-api-origin")
    args = parser.parse_args()
    report = inspect_candidate(
        args.ipa,
        expected_bundle_id=args.expected_bundle_id,
        approved_api_origin=args.approved_api_origin,
    )
    print(json.dumps(report, sort_keys=True))
    return 0 if report["static_preflight_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
