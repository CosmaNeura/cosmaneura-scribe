"""Prepare one hash-bound, disabled standalone-receiver image context.

The command reads one clean Git revision plus a retained qualified identity
checkpoint. It does not contact a registry, build an image, read credentials,
or start a receiver. The output directory must not already exist.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from prepare_sources import (
    FILES as IDENTITY_FILES,
)
from prepare_sources import (
    PINNED_AUTH_SHA256,
    PRODUCTION_AUTH_SHA256,
    PRODUCTION_PATCH_SHA256,
)
from prepare_sources import (
    prepare as prepare_identity,
)

RECEIVER_FILES = (
    "azure_ingress.py",
    "core_context_receiver.py",
    "core_bundle_child.py",
    "image_entrypoint.py",
    "receiver.py",
    "receiver_runtime.py",
    "serve.py",
)
ROOT_FILES = ("README.md", "pyproject.toml", "uv.lock")
TRACKED_INPUTS = (
    *ROOT_FILES,
    "services/api",
    "deployment/Dockerfile.receiver",
    "deployment/receiver.disabled.json",
    *(f"scripts/standalone-provider/{name}" for name in RECEIVER_FILES),
    "scripts/standalone-provider/check_receiver_image_context.py",
    "scripts/standalone-provider/prepare_receiver_image_context.py",
    "scripts/standalone-provider/prepare_sources.py",
    "docs/production/production-native-organization-policy.patch",
)
REVISION = re.compile(r"[0-9a-f]{40}")
IMAGE = re.compile(r"[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}")
UV_BUILDER_PREFIX = "ghcr.io/astral-sh/uv:0.11.32-python3.12-trixie-slim@sha256:"
PYTHON_RUNTIME_PREFIX = "docker.io/library/python:3.12-slim-trixie@sha256:"
MAX_CONTEXT_BYTES = 32 * 1024 * 1024


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_image_reference(value: str, *, expected_prefix: str) -> str:
    if not IMAGE.fullmatch(value) or value.count("@sha256:") != 1:
        raise ValueError("receiver base image must be an explicit sha256 reference")
    if not value.startswith(expected_prefix):
        raise ValueError("receiver base image does not match the reviewed repository and tag")
    return value


def git(repo: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=repo,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=20,
    )
    if completed.returncode:
        raise ValueError("receiver source checkout is unavailable")
    return completed.stdout.decode("utf-8", "strict")


def clean_revision(repo: Path, expected: str) -> None:
    if not REVISION.fullmatch(expected) or git(repo, "rev-parse", "HEAD").strip() != expected:
        raise ValueError("receiver source revision mismatch")
    status = git(
        repo,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *TRACKED_INPUTS,
    )
    if status:
        raise ValueError("receiver image inputs must come from a clean revision")


def tracked_api_files(repo: Path) -> tuple[str, ...]:
    names = tuple(
        name for name in git(repo, "ls-files", "-z", "--", "services/api").split("\0") if name
    )
    if not names or any(not name.startswith("services/api/") for name in names):
        raise ValueError("receiver API package inputs are unavailable")
    return names


def copy_regular(source: Path, destination: Path) -> int:
    if source.is_symlink() or not source.is_file():
        raise ValueError("receiver image input must be a regular file")
    size = source.stat().st_size
    if size > MAX_CONTEXT_BYTES:
        raise ValueError("receiver image input is too large")
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o644)
    return size


def normalize_identity_manifest(root: Path, qualified_receiver: Path) -> None:
    path = root / "identity-source-manifest.json"
    value = json.loads(path.read_text())
    policy = value.get("production_native_policy")
    if policy != {
        "selected": True,
        "input_sha256": PINNED_AUTH_SHA256,
        "patch_sha256": PRODUCTION_PATCH_SHA256,
        "output_sha256": PRODUCTION_AUTH_SHA256,
    }:
        raise ValueError("production identity policy was not prepared exactly")
    expected_files = set(IDENTITY_FILES)
    if set(value.get("files", {})) != expected_files:
        raise ValueError("production identity source set is incomplete")
    for relative, digest in value["files"].items():
        target = root / "identity-source/cosmas_os" / relative
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or sha256(target) != digest:
            raise ValueError("production identity source manifest mismatch")
    if value["files"]["api/auth.py"] != PRODUCTION_AUTH_SHA256:
        raise ValueError("production identity verifier was not transformed exactly")
    runtime = qualified_receiver / "runtime.json"
    value["source_directory"] = "qualified-receiver/server-source/cosmas_os"
    value["qualified_runtime_sha256"] = sha256(runtime)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    path.chmod(0o644)


def prepare_context(
    repo: Path,
    qualified_receiver: Path,
    output: Path,
    *,
    source_revision: str,
    uv_builder_image: str,
    python_runtime_image: str,
    identity_preparer: Callable[..., None] = prepare_identity,
) -> dict[str, object]:
    repo, qualified_receiver, output = (
        repo.resolve(),
        qualified_receiver.resolve(),
        output.resolve(),
    )
    clean_revision(repo, source_revision)
    validate_image_reference(uv_builder_image, expected_prefix=UV_BUILDER_PREFIX)
    validate_image_reference(python_runtime_image, expected_prefix=PYTHON_RUNTIME_PREFIX)
    if output.exists() or not qualified_receiver.is_dir():
        raise ValueError("new context and qualified receiver are required")
    output.mkdir(mode=0o700, parents=False)
    copied_bytes = 0
    for relative in ROOT_FILES:
        copied_bytes += copy_regular(repo / relative, output / relative)
    for relative in tracked_api_files(repo):
        copied_bytes += copy_regular(repo / relative, output / relative)
    copied_bytes += copy_regular(repo / "deployment/Dockerfile.receiver", output / "Dockerfile")
    copied_bytes += copy_regular(
        repo / "deployment/receiver.disabled.json",
        output / "deployment/receiver.disabled.json",
    )
    for name in RECEIVER_FILES:
        copied_bytes += copy_regular(
            repo / "scripts/standalone-provider" / name,
            output / "receiver" / name,
        )
    if copied_bytes > MAX_CONTEXT_BYTES:
        raise ValueError("receiver image context is too large")
    identity_preparer(output, qualified_receiver, production_native_policy=True)
    normalize_identity_manifest(output, qualified_receiver)
    for directory in (output / "services", output / "receiver", output / "identity-source"):
        for path in (directory, *directory.rglob("*")):
            if path.is_dir():
                path.chmod(0o755)
            elif path.is_file():
                path.chmod(0o644)
    files = {
        str(path.relative_to(output)): sha256(path)
        for path in sorted(output.rglob("*"))
        if path.is_file() and path.name != "receiver-image-manifest.json"
    }
    manifest: dict[str, object] = {
        "schema": 1,
        "purpose": "disabled production standalone receiver image context",
        "source_revision": source_revision,
        "base_images": {
            "uv_builder": uv_builder_image,
            "python_runtime": python_runtime_image,
        },
        "entrypoint": ["python", "/app/provider/image_entrypoint.py"],
        "runtime_target": ["python", "/app/provider/serve.py"],
        "runtime_user": "10001:10001",
        "configuration_path": "/app/provider-config/receiver.json",
        "deployment_environment": [
            "COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON",
            "COSMANEURA_SCRIBE_PROVIDER_IMAGE_CONTRACT_SHA256",
        ],
        "configuration_embedded": False,
        "configuration_enabled": False,
        "default_startup": "fail_closed_without_reviewed_contract",
        "credentials_included": False,
        "runtime_activated": False,
        "dependency_lock_sha256": sha256(output / "uv.lock"),
        "receiver_sources": {name: sha256(output / "receiver" / name) for name in RECEIVER_FILES},
        "identity_source_manifest_sha256": sha256(output / "identity-source-manifest.json"),
        "files": files,
    }
    (output / "receiver-image-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    (output / "receiver-image-manifest.json").chmod(0o644)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--qualified-receiver", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--uv-builder-image", required=True)
    parser.add_argument("--python-runtime-image", required=True)
    args = parser.parse_args()
    result = prepare_context(
        args.repo,
        args.qualified_receiver,
        args.output,
        source_revision=args.source_revision,
        uv_builder_image=args.uv_builder_image,
        python_runtime_image=args.python_runtime_image,
    )
    print(
        json.dumps(
            {
                "schema": result["schema"],
                "source_revision": result["source_revision"],
                "file_count": len(result["files"]),
                "configuration_embedded": result["configuration_embedded"],
                "credentials_included": result["credentials_included"],
                "runtime_activated": result["runtime_activated"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
