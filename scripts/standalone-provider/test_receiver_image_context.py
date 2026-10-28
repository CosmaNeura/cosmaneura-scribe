"""Offline checks for the sealed standalone-receiver image context."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import check_receiver_image_context as checker
import image_entrypoint
import prepare_receiver_image_context as preparer
import pytest
from prepare_sources import FILES as IDENTITY_FILES

REPOSITORY = Path(__file__).resolve().parents[2]
UV_IMAGE = preparer.UV_BUILDER_PREFIX + "a" * 64
PYTHON_IMAGE = preparer.PYTHON_RUNTIME_PREFIX + "b" * 64


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_git(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=20,
    )
    return result.stdout.strip()


def copy_tracked(source: Path, destination: Path, *paths: str) -> None:
    names = run_git(source, "ls-files", "-z", "--", *paths).split("\0")
    for name in (name for name in names if name):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)


@pytest.fixture
def source_repository(tmp_path: Path) -> tuple[Path, str]:
    root = tmp_path / "source"
    root.mkdir()
    copy_tracked(
        REPOSITORY,
        root,
        *preparer.ROOT_FILES,
        "services/api",
        "deployment/Dockerfile.receiver",
        "deployment/receiver.disabled.json",
        "scripts/standalone-provider",
        "docs/production/production-native-organization-policy.patch",
    )
    for name in (
        "check_receiver_image_context.py",
        "image_entrypoint.py",
        "prepare_receiver_image_context.py",
    ):
        source = REPOSITORY / "scripts/standalone-provider" / name
        target = root / "scripts/standalone-provider" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    run_git(root, "init", "--quiet")
    run_git(root, "config", "user.email", "receiver-image-test@invalid.example")
    run_git(root, "config", "user.name", "Receiver Image Test")
    run_git(root, "add", "--all")
    run_git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "sealed fixture")
    return root, run_git(root, "rev-parse", "HEAD")


def fake_identity_preparer(root: Path, qualified: Path, *, production_native_policy: bool) -> None:
    assert production_native_policy is True
    assert qualified.joinpath("runtime.json").is_file()
    files: dict[str, str] = {}
    for relative in IDENTITY_FILES:
        data = b"production-auth\n" if relative == "api/auth.py" else relative.encode() + b"\n"
        target = root / "identity-source/cosmas_os" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files[relative] = sha256(data)
    (root / "identity-source-manifest.json").write_text(
        json.dumps(
            {
                "purpose": "offline image fixture",
                "source_directory": str(qualified / "server-source/cosmas_os"),
                "files": files,
                "configuration_copied": False,
                "credentials_copied": False,
                "runtime_activated": False,
                "production_native_policy": {
                    "selected": True,
                    "input_sha256": preparer.PINNED_AUTH_SHA256,
                    "patch_sha256": preparer.PRODUCTION_PATCH_SHA256,
                    "output_sha256": preparer.PRODUCTION_AUTH_SHA256,
                },
            }
        )
        + "\n"
    )


def test_image_references_require_reviewed_tag_and_digest() -> None:
    assert (
        preparer.validate_image_reference(UV_IMAGE, expected_prefix=preparer.UV_BUILDER_PREFIX)
        == UV_IMAGE
    )
    with pytest.raises(ValueError):
        preparer.validate_image_reference(
            "ghcr.io/astral-sh/uv:0.11.32-python3.12-trixie-slim",
            expected_prefix=preparer.UV_BUILDER_PREFIX,
        )
    with pytest.raises(ValueError):
        preparer.validate_image_reference(
            preparer.UV_BUILDER_PREFIX + "c" * 64,
            expected_prefix=preparer.PYTHON_RUNTIME_PREFIX,
        )


def test_image_entrypoint_requires_exact_environment_and_materializes_disabled_config(
    tmp_path: Path,
) -> None:
    provider = tmp_path / "provider"
    provider.mkdir()
    receiver_sources: dict[str, str] = {}
    for name in image_entrypoint.RECEIVER_SOURCES:
        data = name.encode() + b"\n"
        provider.joinpath(name).write_bytes(data)
        receiver_sources[name] = sha256(data)
    identity = b'{"identity":"fixture"}\n'
    provider.joinpath("identity-source-manifest.json").write_bytes(identity)
    manifest = provider / "receiver-image-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema": 1,
                "entrypoint": ["python", "/app/provider/image_entrypoint.py"],
                "runtime_target": ["python", "/app/provider/serve.py"],
                "runtime_user": "10001:10001",
                "configuration_path": "/app/provider-config/receiver.json",
                "deployment_environment": [
                    image_entrypoint.CONFIGURATION_ENV.decode(),
                    image_entrypoint.CONTRACT_ENV.decode(),
                ],
                "configuration_embedded": False,
                "credentials_included": False,
                "runtime_activated": False,
                "receiver_sources": receiver_sources,
                "identity_source_manifest_sha256": sha256(identity),
            },
            sort_keys=True,
        )
        + "\n"
    )
    contract = hashlib.sha256(manifest.read_bytes()).hexdigest().encode()
    disabled = b'{"schema":1,"enabled":false}'
    environment = {
        image_entrypoint.CONFIGURATION_ENV: disabled,
        image_entrypoint.CONTRACT_ENV: contract,
        b"PATH": b"/usr/bin",
    }
    assert image_entrypoint.provider_environment(environment) == (disabled, contract)
    for rejected in (
        {image_entrypoint.CONFIGURATION_ENV: disabled},
        {image_entrypoint.CONTRACT_ENV: contract},
        {**environment, image_entrypoint.CONTRACT_ENV: b"A" * 64},
        {**environment, b"COSMANEURA_SCRIBE_PROVIDER_UNREVIEWED": b"1"},
    ):
        with pytest.raises(RuntimeError, match="receiver_image_contract_unavailable"):
            image_entrypoint.provider_environment(rejected)
    configuration = tmp_path / "provider-config/receiver.json"
    configuration.parent.mkdir()
    image_entrypoint.materialize_configuration(
        disabled,
        contract,
        configuration_path=configuration,
        manifest_path=manifest,
    )
    assert configuration.read_bytes() == disabled
    assert configuration.stat().st_mode & 0o777 == 0o600
    mismatched = tmp_path / "mismatched/receiver.json"
    mismatched.parent.mkdir()
    with pytest.raises(RuntimeError, match="receiver_image_contract_unavailable"):
        image_entrypoint.materialize_configuration(
            disabled,
            b"0" * 64,
            configuration_path=mismatched,
            manifest_path=manifest,
        )
    assert not mismatched.exists()
    invalid = tmp_path / "invalid/receiver.json"
    invalid.parent.mkdir()
    with pytest.raises(RuntimeError, match="receiver_image_contract_unavailable"):
        image_entrypoint.materialize_configuration(
            b'{"schema":1,"enabled":false,"extra":true}',
            contract,
            configuration_path=invalid,
            manifest_path=manifest,
        )
    assert not invalid.exists()
    provider.joinpath("serve.py").write_text("tampered\n")
    changed_source = tmp_path / "changed-source/receiver.json"
    changed_source.parent.mkdir()
    with pytest.raises(RuntimeError, match="receiver_image_contract_unavailable"):
        image_entrypoint.materialize_configuration(
            disabled,
            contract,
            configuration_path=changed_source,
            manifest_path=manifest,
        )
    assert not changed_source.exists()
    provider.joinpath("serve.py").write_bytes(b"serve.py\n")
    existing = tmp_path / "existing/receiver.json"
    existing.parent.mkdir()
    existing.write_bytes(b"retain")
    with pytest.raises(RuntimeError, match="receiver_image_contract_unavailable"):
        image_entrypoint.materialize_configuration(
            disabled,
            contract,
            configuration_path=existing,
            manifest_path=manifest,
        )
    assert existing.read_bytes() == b"retain"


def test_prepared_context_is_exact_disabled_and_tamper_evident(
    source_repository: tuple[Path, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, revision = source_repository
    fake_auth_hash = sha256(b"production-auth\n")
    for module in (preparer, checker):
        monkeypatch.setattr(module, "PINNED_AUTH_SHA256", "1" * 64)
        monkeypatch.setattr(module, "PRODUCTION_PATCH_SHA256", "2" * 64)
        monkeypatch.setattr(module, "PRODUCTION_AUTH_SHA256", fake_auth_hash)
    qualified = tmp_path / "qualified"
    qualified.mkdir()
    qualified.joinpath("runtime.json").write_text('{"fixture":true}\n')
    context = tmp_path / "context"
    result = preparer.prepare_context(
        source,
        qualified,
        context,
        source_revision=revision,
        uv_builder_image=UV_IMAGE,
        python_runtime_image=PYTHON_IMAGE,
        identity_preparer=fake_identity_preparer,
    )
    assert result["configuration_embedded"] is False
    assert result["configuration_enabled"] is False
    assert result["credentials_included"] is False
    assert result["runtime_activated"] is False
    assert result["receiver_sources"] == {
        name: checker.sha256(context / "receiver" / name) for name in preparer.RECEIVER_FILES
    }
    report = checker.inspect_context(context, revision)
    assert report == {
        "status": "pass",
        "source_revision": revision,
        "file_count": len(result["files"]),
        "disabled_response": 404,
        "runtime_constructed": False,
        "identity_imported": False,
    }
    (context / "receiver/serve.py").write_text("# tampered\n")
    with pytest.raises(ValueError, match="context hashes changed"):
        checker.inspect_context(context, revision)


def test_preparer_refuses_dirty_build_inputs(
    source_repository: tuple[Path, str], tmp_path: Path
) -> None:
    source, revision = source_repository
    with (source / "deployment/Dockerfile.receiver").open("a") as target:
        target.write("\n# dirty\n")
    qualified = tmp_path / "qualified"
    qualified.mkdir()
    with pytest.raises(ValueError, match="clean revision"):
        preparer.prepare_context(
            source,
            qualified,
            tmp_path / "context",
            source_revision=revision,
            uv_builder_image=UV_IMAGE,
            python_runtime_image=PYTHON_IMAGE,
            identity_preparer=fake_identity_preparer,
        )
