"""Assemble committed native sources with the exact retained Clerk dependency.

Offline only. Copies into a new output directory; never edits the retained SDK,
signs, installs, reads credentials, or selects a different dependency version.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def inventory(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Native input must be an ordinary directory")
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Native input must not contain symbolic links")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    return result


def assemble(output: Path, clerk_source: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    plugins = repo / "apps/capture/native-plugins"
    expected = json.loads((plugins / "cosmas-native-auth/clerk-source-lock.json").read_text())[
        "files"
    ]
    if inventory(clerk_source) != expected:
        raise ValueError("Retained Clerk dependency does not match the committed lock")
    # Both installed platforms use the same wire/consent/error contract.
    shared = "ProviderNativeTransport.swift"
    if (plugins / "cosmas-native-auth/Bridge" / shared).read_bytes() != (
        repo / "scripts/standalone-provider" / shared
    ).read_bytes():
        raise ValueError("Desktop and mobile transport sources differ")
    output.mkdir(parents=True, exist_ok=False)
    for name in (
        "cosmas-native-auth",
        "ios-pcm-capture",
        "ios-pcm-capacitor",
        "native-recording",
        "secure-queue",
    ):
        source = plugins / name
        inventory(source)  # Reject links before copying first-party sources too.
        shutil.copytree(
            source, output / name, ignore=shutil.ignore_patterns("vendor", ".build", ".swiftpm")
        )
    vendor = output / "cosmas-native-auth/vendor"
    shutil.copytree(clerk_source, vendor)
    if inventory(vendor) != expected:
        raise ValueError("Copied Clerk dependency changed during assembly")
    files = inventory(output)
    receipt = {"schema": 1, "files": files, "signed": False, "installed": False}
    (output / "source-manifest.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"output": str(output), "files": len(files), "signed": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--clerk-source", type=Path, required=True)
    args = parser.parse_args()
    assemble(args.output, args.clerk_source)
