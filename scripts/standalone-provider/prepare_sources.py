"""Copy the already qualified identity inputs into a separate provider candidate.

This prepares source only. It never copies credentials, clinical data, a database,
TLS keys, an app or active runtime configuration, and never starts a process.
"""

import argparse
import hashlib
import json
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


def prepare(root: Path, qualified_receiver: Path) -> None:
    destination = root / "identity-source"
    if destination.exists() or not root.is_dir():
        raise ValueError("New owned source directory required")
    config = json.loads((qualified_receiver / "runtime.json").read_text())
    if config.get("native_token_profile") != "w13-ios-native-session-v1":
        raise ValueError("Qualified native identity checkpoint required")
    expected = config["source_sha256"]
    contents = {}
    for relative in FILES:
        data = (qualified_receiver / "server-source/cosmas_os" / relative).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected.get(relative):
            raise ValueError("Qualified identity source changed")
        contents[relative] = data
    # Verify the complete input set before writing any candidate source.
    root.chmod(0o700)
    for relative, data in contents.items():
        target = destination / "cosmas_os" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (root / "identity-source-manifest.json").write_text(
        json.dumps(
            {
                "purpose": "Unchanged qualified identity reuse for standalone provider preparation",
                "source_directory": str(qualified_receiver / "server-source/cosmas_os"),
                "files": {
                    relative: hashlib.sha256(data).hexdigest()
                    for relative, data in contents.items()
                },
                "configuration_copied": False,
                "credentials_copied": False,
                "runtime_activated": False,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--qualified-receiver", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.root.resolve(), args.qualified_receiver.resolve())
    print("Prepared 12 hash-verified identity source files; no configuration or service activated.")
