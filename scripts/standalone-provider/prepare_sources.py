"""Copy qualified identity inputs, optionally applying the reviewed production patch.

This prepares source only. It never copies credentials, clinical data, a database,
TLS keys, an app or active runtime configuration, and never starts a process.
"""

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

FILES = (
    "__init__.py",
    "config.py",
    "db.py",
    "models.py",
    "api/__init__.py",
    "api/auth.py",
    "application/__init__.py",
    "application/workspace.py",
    "domain/__init__.py",
    "domain/enums.py",
    "domain/hashing.py",
    "domain/work_lanes.py",
)

PINNED_AUTH_SHA256 = "7eac6550c8723f80e558f61c34b6c74b3017e2d8f795344eb5ccd62d1c3fae7d"
PRODUCTION_AUTH_SHA256 = "c2d1c08ed2edbc537b5c18540ae11ee1fd976809caad371926b4c92c7ce30c92"
PRODUCTION_PATCH_SHA256 = "623ada7976eb70a745038006a680f16ac80a17eae7c9c1ede0c3bc11cf73c5e5"
PRODUCTION_PATCH = (
    Path(__file__).resolve().parents[2]
    / "docs/production/production-native-organization-policy.patch"
)


def patched_production_auth(source: bytes) -> bytes:
    """Apply the reviewed patch to exactly the qualified verifier bytes."""
    if hashlib.sha256(source).hexdigest() != PINNED_AUTH_SHA256:
        raise ValueError("Qualified production identity source changed")
    patch = PRODUCTION_PATCH.read_bytes()
    if hashlib.sha256(patch).hexdigest() != PRODUCTION_PATCH_SHA256:
        raise ValueError("Reviewed production identity patch changed")
    with tempfile.TemporaryDirectory(prefix="scribe-production-identity-") as temporary:
        root = Path(temporary)
        target = root / "cosmas_os/api/auth.py"
        target.parent.mkdir(parents=True)
        target.write_bytes(source)
        result = subprocess.run(
            [
                "/usr/bin/patch",
                "--batch",
                "--forward",
                "--fuzz=0",
                "-p1",
                "-i",
                str(PRODUCTION_PATCH),
            ],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=10,
            check=False,
        )
        revised = target.read_bytes()
    if result.returncode != 0 or hashlib.sha256(revised).hexdigest() != PRODUCTION_AUTH_SHA256:
        raise ValueError("Reviewed production identity patch did not apply exactly")
    return revised


def prepare(
    root: Path, qualified_receiver: Path, *, production_native_policy: bool = False
) -> None:
    destination = root / "identity-source"
    if destination.exists() or not root.is_dir():
        raise ValueError("New owned source directory required")
    config = json.loads((qualified_receiver / "runtime.json").read_text())
    if config.get("native_token_profile") != "w13-ios-native-session-v1":
        raise ValueError("Qualified native identity checkpoint required")
    expected = config["source_sha256"]
    contents: dict[str, bytes] = {}
    for relative in FILES:
        data = (qualified_receiver / "server-source/cosmas_os" / relative).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected.get(relative):
            raise ValueError("Qualified identity source changed")
        contents[relative] = data
    production_policy: dict[str, object] | None = None
    if production_native_policy:
        contents["api/auth.py"] = patched_production_auth(contents["api/auth.py"])
        production_policy = {
            "selected": True,
            "input_sha256": PINNED_AUTH_SHA256,
            "patch_sha256": PRODUCTION_PATCH_SHA256,
            "output_sha256": PRODUCTION_AUTH_SHA256,
        }
    # Verify the complete input set before writing any candidate source.
    root.chmod(0o700)
    for relative, data in contents.items():
        target = destination / "cosmas_os" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (root / "identity-source-manifest.json").write_text(
        json.dumps(
            {
                "purpose": (
                    "Receipt-gated production native policy source preparation"
                    if production_native_policy
                    else "Unchanged qualified identity reuse for standalone provider preparation"
                ),
                "source_directory": str(qualified_receiver / "server-source/cosmas_os"),
                "files": {
                    relative: hashlib.sha256(data).hexdigest()
                    for relative, data in contents.items()
                },
                "configuration_copied": False,
                "credentials_copied": False,
                "runtime_activated": False,
                "production_native_policy": production_policy,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--qualified-receiver", type=Path, required=True)
    parser.add_argument("--production-native-policy", action="store_true")
    args = parser.parse_args()
    prepare(
        args.root.resolve(),
        args.qualified_receiver.resolve(),
        production_native_policy=args.production_native_policy,
    )
    print(
        "Prepared 12 hash-verified identity source files"
        + (" with the reviewed production native policy" if args.production_native_policy else "")
        + "; no configuration or service activated."
    )
