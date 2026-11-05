#!/usr/bin/env python3
"""Fail closed when staging/qualification build config names live Cosmas hosts.

Normal PRs must not put live Cosmas API or live Clerk sign-in into staging or
qualification packaging config. Live host names are allowed only on the
founder-only production path (explicit allowlist below).

Exit 0 when clean. Exit 1 on any violation or scanner failure.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable
from pathlib import Path

# Bare live hostnames (negative lookbehind avoids matching staging-app.cosmaneura.com).
LIVE_MARKER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("app.cosmaneura.com", re.compile(r"(?<![A-Za-z0-9-])app\.cosmaneura\.com")),
    ("clerk.cosmaneura.com", re.compile(r"(?<![A-Za-z0-9-])clerk\.cosmaneura\.com")),
    ("pk_live_", re.compile(r"pk_live_")),
)

# Committed staging / qualification packaging surfaces. Defaults and fixtures
# here must stay staging-bound. Adding a new path here is fail-closed by design.
STAGING_QUALIFICATION_PATHS: tuple[str, ...] = (
    "scripts/assemble-standalone-provider.py",
    "scripts/assemble-disabled-desktop-candidate.py",
    "scripts/assemble-native-source.py",
    "scripts/build-desktop-provider-host.mjs",
    "scripts/build-ios-provider-renderer.mjs",
    "scripts/prepare-ios-provider-candidate.py",
    "apps/desktop-companion/desktop-release.json",
    "apps/capture/standalone.vite.config.ts",
    "apps/capture/provider.vite.config.ts",
    "deployment/core-bundle.disabled.env.example",
)

# Filename patterns treated as staging/qualification build profiles when not on
# the founder production path.
STAGING_NAME_RE = re.compile(
    r"(?i)(^|/)(.*staging.*|.*qualification.*)(profile|config|plist|env|xcconfig).*$"
)

# Founder-only production path: these may name live hosts (projection, refuse
# gates that compare against live values, production tests, production docs).
FOUNDER_PRODUCTION_PREFIXES: tuple[str, ...] = (
    "scripts/standalone-provider/prepare_production_profiles.py",
    "scripts/standalone-provider/check-production-identity.swift",
    "scripts/standalone-provider/test_production_",
    "scripts/build-desktop-native-provider.py",
    "docs/production/",
    "docs/flight-plans/",
    "docs/PRODUCTION_",
    "deployment/",
)

# Refuse-gate / dual-path code that must mention live hosts to reject them, or
# to accept an explicitly unlocked production profile. Not staging defaults.
REFUSE_OR_DUAL_PATH_ALLOWLIST: frozenset[str] = frozenset(
    {
        "apps/desktop-companion/src/standalone-provider-profile.ts",
        "apps/desktop-companion/src/standalone-provider-profile.test.ts",
        "apps/desktop-companion/src/standalone-native-helpers.test.ts",
        "apps/desktop-companion/src/public-app-release.ts",
        "apps/capture/src/provider/startup.ts",
        "apps/capture/src/provider/startup.test.ts",
        "apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/NativeClerkConfiguration.swift",
        "apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/NativeTokenPolicy.swift",
        "apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/ClerkKitWorkspaceDriver.swift",
        "apps/capture/native-plugins/cosmas-native-auth/Bridge/ProviderNativeTransport.swift",
        "apps/capture/native-plugins/cosmas-native-auth/Bridge/CosmasWorkspaceAuthPlugin.swift",
        "scripts/standalone-provider/ProviderNativeTransport.swift",
        "scripts/standalone-provider/DesktopProviderMain.swift",
        "scripts/standalone-provider/receiver_runtime.py",
        "scripts/standalone-provider/receiver.py",
        "scripts/standalone-provider/check-standalone-identity.swift",
        "scripts/public-app-release.test.mjs",
        "scripts/check-provider-startup.mjs",
        "scripts/check_staging_build_hosts.py",
        "tests/test_staging_build_hosts.py",
    }
)

SKIP_PARTS = frozenset(
    {
        ".git",
        ".venv",
        "__pycache__",
        ".pytest_cache",
        ".ruff_cache",
        "node_modules",
        "docs/reference/archive",
    }
)

TEXT_SUFFIXES = frozenset(
    {
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".mjs",
        ".cjs",
        ".json",
        ".plist",
        ".yml",
        ".yaml",
        ".env",
        ".example",
        ".xcconfig",
        ".swift",
        ".md",
        ".txt",
        ".sh",
        ".toml",
    }
)


def _posix(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def is_founder_production_path(relative: str) -> bool:
    return any(relative.startswith(prefix) for prefix in FOUNDER_PRODUCTION_PREFIXES)


def is_staging_qualification_path(relative: str) -> bool:
    if relative in STAGING_QUALIFICATION_PATHS:
        return True
    if relative in REFUSE_OR_DUAL_PATH_ALLOWLIST:
        return False
    if is_founder_production_path(relative):
        return False
    return bool(STAGING_NAME_RE.search(relative))


def find_live_markers(text: str) -> list[str]:
    return [label for label, pattern in LIVE_MARKER_PATTERNS if pattern.search(text)]


def iter_candidate_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        if any(part in SKIP_PARTS for part in path.parts):
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES and path.name not in {
            "Dockerfile",
            "Makefile",
        }:
            continue
        if path.stat().st_size > 1_000_000:
            continue
        yield path


def find_violations(root: Path) -> list[dict[str, object]]:
    violations: list[dict[str, object]] = []
    seen_required = 0
    for path in iter_candidate_files(root):
        relative = _posix(path, root)
        if not is_staging_qualification_path(relative):
            continue
        seen_required += 1
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            violations.append(
                {
                    "path": relative,
                    "reason": "unreadable_staging_qualification_config",
                    "detail": str(exc),
                }
            )
            continue
        markers = find_live_markers(text)
        if markers:
            violations.append(
                {
                    "path": relative,
                    "reason": "staging_or_qualification_names_live_host",
                    "markers": markers,
                }
            )

    # Fail closed if the required staging assemble surfaces are missing.
    for required in STAGING_QUALIFICATION_PATHS:
        required_path = root / required
        if not required_path.is_file():
            violations.append(
                {
                    "path": required,
                    "reason": "required_staging_surface_missing",
                    "markers": [],
                }
            )
    if seen_required == 0:
        violations.append(
            {
                "path": ".",
                "reason": "no_staging_qualification_surfaces_scanned",
                "markers": [],
            }
        )
    return violations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root to scan",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON on stdout",
    )
    args = parser.parse_args(argv)

    try:
        root = args.root.resolve()
        if not root.is_dir():
            raise ValueError("root_must_be_a_directory")
        violations = find_violations(root)
    except Exception as exc:  # noqa: BLE001 — fail closed on scanner errors
        payload = {"status": "SCANNER_FAILED", "error": str(exc), "violations": []}
        print(json.dumps(payload, sort_keys=True, indent=2) if args.json else payload)
        return 1

    if violations:
        payload = {
            "status": "STAGING_LIVE_HOST_VIOLATION",
            "violations": violations,
            "remediation": (
                "Keep staging/qualification build profiles on staging Cosmas "
                "(staging-app.cosmaneura.com + resolved-emu-53 Clerk). Live hosts "
                "belong only on the founder production path "
                "(prepare_production_profiles + SCRIBE_PRODUCTION_ORGANIZATION)."
            ),
        }
        if args.json:
            print(json.dumps(payload, sort_keys=True, indent=2))
        else:
            print("Staging/qualification build config names a live Cosmas host.", file=sys.stderr)
            for item in violations:
                markers = item.get("markers", [])
                print(f"- {item['path']}: {item['reason']} {markers}", file=sys.stderr)
            print(payload["remediation"], file=sys.stderr)
        return 1

    payload = {"status": "OK", "violations": []}
    if args.json:
        print(json.dumps(payload, sort_keys=True, indent=2))
    else:
        print("Staging/qualification build hosts check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
