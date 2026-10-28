"""Fail-closed image launcher for one reviewed standalone-receiver contract.

The platform supplies exactly two provider-scoped environment values: one
closed-world receiver configuration and the SHA-256 of this image's packaged
manifest. The launcher writes the configuration once with owner-only mode,
validates it through the receiver's real configuration model, removes both
values from the process environment, then execs the fixed server entry.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from collections.abc import Mapping
from pathlib import Path

from receiver_runtime import load_configuration

CONFIGURATION_ENV = b"COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON"
CONTRACT_ENV = b"COSMANEURA_SCRIBE_PROVIDER_IMAGE_CONTRACT_SHA256"
PROVIDER_PREFIX = b"COSMANEURA_SCRIBE_PROVIDER_"
EXPECTED_ENVIRONMENT = {CONFIGURATION_ENV, CONTRACT_ENV}
CONFIGURATION_PATH = Path("/app/provider-config/receiver.json")
MANIFEST_PATH = Path("/app/provider/receiver-image-manifest.json")
SERVER_PATH = Path("/app/provider/serve.py")
HEX_SHA256 = re.compile(rb"[0-9a-f]{64}")
HEX_SHA256_TEXT = re.compile(r"[0-9a-f]{64}")
RECEIVER_SOURCES = {
    "azure_ingress.py",
    "image_entrypoint.py",
    "receiver.py",
    "receiver_runtime.py",
    "serve.py",
}
IDENTITY_FILES = {
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
}
IDENTITY_MANIFEST_FIELDS = {
    "purpose",
    "source_directory",
    "files",
    "configuration_copied",
    "credentials_copied",
    "runtime_activated",
    "production_native_policy",
    "qualified_runtime_sha256",
}
PINNED_AUTH_SHA256 = "7eac6550c8723f80e558f61c34b6c74b3017e2d8f795344eb5ccd62d1c3fae7d"
PRODUCTION_PATCH_SHA256 = "c86ade8e6e9736f856c1d4a9e5be024eb5ee4a3c0cb8bc96241f1d1e8ed36e41"
PRODUCTION_AUTH_SHA256 = "f147c31547a1bacc98b211bdb3c791203e8ac204077792b186e691290f473413"


def fail() -> RuntimeError:
    return RuntimeError("receiver_image_contract_unavailable")


def digest(path: Path) -> bytes:
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1_000_000:
            raise fail()
        with path.open("rb") as source:
            return hashlib.file_digest(source, "sha256").hexdigest().encode("ascii")
    except OSError:
        raise fail() from None


def provider_environment(environment: Mapping[bytes, bytes]) -> tuple[bytes, bytes]:
    selected = {key for key in environment if key.startswith(PROVIDER_PREFIX)}
    if selected != EXPECTED_ENVIRONMENT:
        raise fail()
    configuration = environment.get(CONFIGURATION_ENV, b"")
    contract = environment.get(CONTRACT_ENV, b"")
    if not isinstance(configuration, bytes) or not isinstance(contract, bytes):
        raise fail()
    if not configuration or len(configuration) > 16_384 or HEX_SHA256.fullmatch(contract) is None:
        raise fail()
    return configuration, contract


def validate_manifest(path: Path, contract: bytes) -> None:
    if digest(path) != contract:
        raise fail()

    def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise fail()
            result[key] = value
        return result

    try:
        manifest = json.loads(path.read_bytes(), object_pairs_hook=unique)
        sources = manifest.get("receiver_sources")
        if (
            manifest.get("schema") != 1
            or manifest.get("entrypoint") != ["python", "/app/provider/image_entrypoint.py"]
            or manifest.get("runtime_target") != ["python", "/app/provider/serve.py"]
            or manifest.get("runtime_user") != "10001:10001"
            or manifest.get("configuration_path") != "/app/provider-config/receiver.json"
            or manifest.get("deployment_environment")
            != [
                CONFIGURATION_ENV.decode("ascii"),
                CONTRACT_ENV.decode("ascii"),
            ]
            or manifest.get("configuration_embedded") is not False
            or manifest.get("credentials_included") is not False
            or manifest.get("runtime_activated") is not False
            or not isinstance(sources, dict)
            or set(sources) != RECEIVER_SOURCES
        ):
            raise fail()
        for name, expected in sources.items():
            if not isinstance(expected, str) or HEX_SHA256_TEXT.fullmatch(expected) is None:
                raise fail()
            if digest(path.parent / name) != expected.encode("ascii"):
                raise fail()
        identity_digest = manifest.get("identity_source_manifest_sha256")
        if (
            not isinstance(identity_digest, str)
            or HEX_SHA256_TEXT.fullmatch(identity_digest) is None
        ):
            raise fail()
        identity_path = path.parent / "identity-source-manifest.json"
        if digest(identity_path) != identity_digest.encode("ascii"):
            raise fail()
        identity = json.loads(identity_path.read_bytes(), object_pairs_hook=unique)
        files = identity.get("files")
        if (
            set(identity) != IDENTITY_MANIFEST_FIELDS
            or identity.get("purpose")
            != "Receipt-gated production native policy source preparation"
            or identity.get("source_directory") != "qualified-receiver/server-source/cosmas_os"
            or identity.get("configuration_copied") is not False
            or identity.get("credentials_copied") is not False
            or identity.get("runtime_activated") is not False
            or identity.get("production_native_policy")
            != {
                "selected": True,
                "input_sha256": PINNED_AUTH_SHA256,
                "patch_sha256": PRODUCTION_PATCH_SHA256,
                "output_sha256": PRODUCTION_AUTH_SHA256,
            }
            or not isinstance(identity.get("qualified_runtime_sha256"), str)
            or HEX_SHA256_TEXT.fullmatch(identity["qualified_runtime_sha256"]) is None
            or not isinstance(files, dict)
            or set(files) != IDENTITY_FILES
            or files.get("api/auth.py") != PRODUCTION_AUTH_SHA256
        ):
            raise fail()
        identity_root = path.parent / "identity-source/cosmas_os"
        for name, expected in files.items():
            if not isinstance(expected, str) or HEX_SHA256_TEXT.fullmatch(expected) is None:
                raise fail()
            if digest(identity_root / name) != expected.encode("ascii"):
                raise fail()
    except (AttributeError, json.JSONDecodeError, OSError, TypeError, ValueError):
        raise fail() from None


def materialize_configuration(
    configuration: bytes,
    contract: bytes,
    *,
    configuration_path: Path = CONFIGURATION_PATH,
    manifest_path: Path = MANIFEST_PATH,
) -> None:
    validate_manifest(manifest_path, contract)
    parent = configuration_path.parent
    created = False
    try:
        if parent.is_symlink() or not parent.is_dir():
            raise fail()
        descriptor = os.open(
            configuration_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        created = True
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as target:
                target.write(configuration)
                target.flush()
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)
        if (
            configuration_path.is_symlink()
            or stat.S_IMODE(configuration_path.stat().st_mode) != 0o600
            or configuration_path.read_bytes() != configuration
        ):
            raise fail()
        load_configuration(configuration_path)
    except (OSError, RuntimeError, ValueError):
        if created:
            try:
                configuration_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise fail() from None


def main() -> None:
    configuration, contract = provider_environment(os.environb)
    materialize_configuration(configuration, contract)
    environment = os.environ.copy()
    environment.pop(CONFIGURATION_ENV.decode("ascii"), None)
    environment.pop(CONTRACT_ENV.decode("ascii"), None)
    try:
        os.execve(sys.executable, [sys.executable, str(SERVER_PATH)], environment)
    except OSError:
        raise fail() from None


if __name__ == "__main__":
    main()
