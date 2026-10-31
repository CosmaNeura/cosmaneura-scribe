"""Prepare a local Core overlay from a verified sealed Scribe context; no build."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from check_receiver_image_context import inspect_context, sha256

CORE_IMAGE = re.compile(
    r"cosmaneuraprodregistry\.azurecr\.io/cosmaneura/cosmaneura:([0-9a-f]{40})@sha256:[0-9a-f]{64}"
)
CORE_USER = re.compile(r"(?:0|[1-9][0-9]{0,8}):(?:0|[1-9][0-9]{0,8})")


def copy_migration_assets(repository: Path, output: Path, revision: str) -> dict[str, str]:
    names = subprocess.run(
        ["git", "ls-files", "-z", "--", "alembic.ini", "alembic/env.py", "alembic/versions/*.py"],
        cwd=repository, capture_output=True, check=True,
    ).stdout.decode().split("\0")
    files: dict[str, str] = {}
    for relative in sorted(name for name in names if name):
        source = repository / relative
        expected = subprocess.run(
            ["git", "show", revision + ":" + relative],
            cwd=repository, capture_output=True, check=True,
        ).stdout
        if source.is_symlink() or not source.is_file() or source.read_bytes() != expected:
            raise ValueError("core_bundle_migration_source_invalid")
        target = output / relative
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o644)
        files[relative] = sha256(target)
    required = {"alembic.ini", "alembic/env.py", "alembic/versions/0001_scribe_core.py"}
    if not required <= files.keys():
        raise ValueError("core_bundle_migration_source_incomplete")
    return files


def prepare_bundle_context(
    sealed: Path,
    output: Path,
    *,
    core_image: str,
    core_revision: str,
    scribe_revision: str,
    core_runtime_user: str,
    source_repository: Path | None = None,
) -> dict[str, object]:
    match = CORE_IMAGE.fullmatch(core_image)
    if match is None or match[1] != core_revision or CORE_USER.fullmatch(core_runtime_user) is None:
        raise ValueError("core_bundle_image_inputs_invalid")
    inspect_context(sealed, scribe_revision)
    repository = source_repository or Path(__file__).parents[2]
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repository, capture_output=True, text=True, check=True
    ).stdout.strip()
    clean = (
        subprocess.run(
            ["git", "diff", "--quiet", "HEAD"], cwd=repository, capture_output=True, check=False
        ).returncode
        == 0
    )
    if revision != scribe_revision or not clean:
        raise ValueError("core_bundle_source_revision_invalid")
    dockerfile = repository / "deployment/Dockerfile.core-bundle"
    expected = subprocess.run(
        ["git", "show", scribe_revision + ":deployment/Dockerfile.core-bundle"],
        cwd=repository,
        capture_output=True,
        check=True,
    ).stdout
    if dockerfile.read_bytes() != expected:
        raise ValueError("core_bundle_source_revision_invalid")
    if (
        dockerfile.is_symlink()
        or not dockerfile.is_file()
        or output.exists()
        or output.is_symlink()
    ):
        raise ValueError("core_bundle_context_invalid")
    # The exact sealed input remains intact in its own directory. The overlay
    # adds no credential, native configuration, tenant or runtime activation.
    output.mkdir(mode=0o700)
    try:
        shutil.copytree(sealed, output / "sealed", symlinks=False)
        shutil.copyfile(dockerfile, output / "Dockerfile.core-bundle")
        migration_files = copy_migration_assets(repository, output / "scribe-migrations", revision)
        inspect_context(output / "sealed", scribe_revision)
        manifest: dict[str, object] = {
            "schema": "core-scribe-three-container-bundle-v1",
            "core_source_revision": core_revision,
            "scribe_source_revision": scribe_revision,
            "core_image": core_image,
            "core_runtime_user": core_runtime_user,
            "scribe_child_user": "10001:10001",
            "receiver_manifest_sha256": sha256(output / "sealed/receiver-image-manifest.json"),
            "dockerfile_sha256": sha256(output / "Dockerfile.core-bundle"),
            "scribe_migration_files_sha256": migration_files,
            "configuration_embedded": False,
            "credentials_included": False,
            "image_built": False,
            "image_published": False,
            "runtime_activated": False,
            "azure_resources_created": 0,
        }
        (output / "core-bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        return manifest
    except Exception:
        shutil.rmtree(output)
        raise
