"""Verify a prepared receiver context and exercise its disabled ASGI boundary."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

import httpx
from prepare_receiver_image_context import (
    PYTHON_RUNTIME_PREFIX,
    RECEIVER_FILES,
    UV_BUILDER_PREFIX,
    validate_image_reference,
)
from prepare_sources import FILES as IDENTITY_FILES
from prepare_sources import (
    PINNED_AUTH_SHA256,
    PRODUCTION_AUTH_SHA256,
    PRODUCTION_PATCH_SHA256,
)

REVISION = re.compile(r"[0-9a-f]{40}")


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


async def disabled_smoke(context: Path) -> None:
    before = {name for name in sys.modules if name == "cosmas_os" or name.startswith("cosmas_os.")}
    api_source = str(context / "services/api/src")
    module_name = "production_receiver_image_runtime"
    write_bytecode = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    sys.path.insert(0, api_source)
    try:
        spec = importlib.util.spec_from_file_location(
            module_name, context / "receiver/receiver_runtime.py"
        )
        if spec is None or spec.loader is None:
            raise ValueError("receiver runtime is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        called = False

        async def forbidden(_config):
            nonlocal called
            called = True
            raise AssertionError("disabled receiver constructed runtime resources")

        module.build_runtime = forbidden
        service = module.ReceiverService(context / "deployment/receiver.disabled.json")
        async with service._lifecycle.router.lifespan_context(service._lifecycle):
            transport = httpx.ASGITransport(app=service, raise_app_exceptions=True)
            async with httpx.AsyncClient(
                transport=transport, base_url="https://receiver.invalid"
            ) as client:
                response = await client.get("/healthz")
    finally:
        sys.modules.pop(module_name, None)
        sys.path.remove(api_source)
        sys.dont_write_bytecode = write_bytecode
    after = {name for name in sys.modules if name == "cosmas_os" or name.startswith("cosmas_os.")}
    if (
        called
        or response.status_code != 404
        or response.json() != {"detail": "provider_unavailable"}
    ):
        raise ValueError("disabled receiver did not fail closed")
    if after != before:
        raise ValueError("disabled receiver imported its external identity package")


def inspect_context(context: Path, expected_revision: str) -> dict[str, object]:
    context = context.resolve()
    if context.is_symlink() or not context.is_dir() or not REVISION.fullmatch(expected_revision):
        raise ValueError("receiver image context is unavailable")
    manifest_path = context / "receiver-image-manifest.json"
    if (
        manifest_path.is_symlink()
        or not manifest_path.is_file()
        or manifest_path.stat().st_size > 1_000_000
    ):
        raise ValueError("receiver image manifest is unavailable")
    manifest = json.loads(manifest_path.read_text())
    if (
        set(manifest)
        != {
            "schema",
            "purpose",
            "source_revision",
            "base_images",
            "entrypoint",
            "runtime_target",
            "runtime_user",
            "configuration_path",
            "deployment_environment",
            "configuration_embedded",
            "configuration_enabled",
            "default_startup",
            "credentials_included",
            "runtime_activated",
            "dependency_lock_sha256",
            "receiver_sources",
            "identity_source_manifest_sha256",
            "files",
        }
        or manifest["schema"] != 1
        or manifest["source_revision"] != expected_revision
        or manifest["entrypoint"] != ["python", "/app/provider/image_entrypoint.py"]
        or manifest["runtime_target"] != ["python", "/app/provider/serve.py"]
        or manifest["runtime_user"] != "10001:10001"
        or manifest["configuration_path"] != "/app/provider-config/receiver.json"
        or manifest["deployment_environment"]
        != [
            "COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON",
            "COSMANEURA_SCRIBE_PROVIDER_IMAGE_CONTRACT_SHA256",
        ]
        or manifest["configuration_embedded"] is not False
        or manifest["configuration_enabled"] is not False
        or manifest["default_startup"] != "fail_closed_without_reviewed_contract"
        or manifest["credentials_included"] is not False
        or manifest["runtime_activated"] is not False
    ):
        raise ValueError("receiver image manifest contract mismatch")
    if set(manifest["base_images"]) != {"uv_builder", "python_runtime"}:
        raise ValueError("receiver base image bindings are incomplete")
    validate_image_reference(
        manifest["base_images"]["uv_builder"], expected_prefix=UV_BUILDER_PREFIX
    )
    validate_image_reference(
        manifest["base_images"]["python_runtime"], expected_prefix=PYTHON_RUNTIME_PREFIX
    )
    if set(path.name for path in context.iterdir()) != {
        "Dockerfile",
        "README.md",
        "deployment",
        "identity-source",
        "identity-source-manifest.json",
        "pyproject.toml",
        "receiver",
        "receiver-image-manifest.json",
        "services",
        "uv.lock",
    }:
        raise ValueError("receiver image context contains an unexpected root entry")
    actual: dict[str, str] = {}
    for path in sorted(context.rglob("*")):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError("receiver context contains unsupported filesystem entries")
        if path.is_file() and path != manifest_path:
            relative = str(path.relative_to(context))
            if "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"}:
                raise ValueError("receiver context contains generated Python state")
            actual[relative] = sha256(path)
    if actual != manifest["files"]:
        raise ValueError("receiver image context hashes changed")
    expected_receiver_sources = {
        name: sha256(context / "receiver" / name) for name in RECEIVER_FILES
    }
    if manifest["receiver_sources"] != expected_receiver_sources:
        raise ValueError("receiver source manifest changed")
    if manifest["dependency_lock_sha256"] != sha256(context / "uv.lock"):
        raise ValueError("receiver dependency lock changed")
    if manifest["identity_source_manifest_sha256"] != sha256(
        context / "identity-source-manifest.json"
    ):
        raise ValueError("receiver identity source manifest changed")
    if json.loads((context / "deployment/receiver.disabled.json").read_text()) != {
        "schema": 1,
        "enabled": False,
    }:
        raise ValueError("receiver image configuration is not disabled")
    identity = json.loads((context / "identity-source-manifest.json").read_text())
    if (
        identity.get("production_native_policy")
        != {
            "selected": True,
            "input_sha256": PINNED_AUTH_SHA256,
            "patch_sha256": PRODUCTION_PATCH_SHA256,
            "output_sha256": PRODUCTION_AUTH_SHA256,
        }
        or identity.get("files", {}).get("api/auth.py") != PRODUCTION_AUTH_SHA256
    ):
        raise ValueError("receiver production identity binding changed")
    if set(identity.get("files", {})) != set(IDENTITY_FILES):
        raise ValueError("receiver production identity source set changed")
    dockerfile = (context / "Dockerfile").read_text()
    required = (
        "ARG UV_BUILDER_IMAGE",
        "ARG PYTHON_RUNTIME_IMAGE",
        "FROM ${UV_BUILDER_IMAGE} AS builder",
        "FROM ${PYTHON_RUNTIME_IMAGE} AS runtime",
        "USER 10001:10001",
        'CMD ["python", "/app/provider/image_entrypoint.py"]',
        "RUN uv sync --locked --no-editable --no-dev",
    )
    if any(dockerfile.count(value) != 1 for value in required) or "ADD " in dockerfile:
        raise ValueError("receiver Dockerfile contract changed")
    if "receiver.disabled.json ./provider-config" in dockerfile:
        raise ValueError("receiver image embeds runtime configuration")
    asyncio.run(disabled_smoke(context))
    return {
        "status": "pass",
        "source_revision": expected_revision,
        "file_count": len(actual),
        "disabled_response": 404,
        "runtime_constructed": False,
        "identity_imported": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--expected-source-revision", required=True)
    args = parser.parse_args()
    print(json.dumps(inspect_context(args.context, args.expected_source_revision), sort_keys=True))


if __name__ == "__main__":
    main()
