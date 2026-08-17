from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / "infra" / "runner" / "metadata.py"


def _run(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(METADATA), *arguments],
        check=False,
        capture_output=True,
        text=True,
    )


def test_metadata_reads_only_typed_fields(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    state.write_text(
        json.dumps(
            {
                "lineage": "9cc263b9-f1e2-dfc8-4a33-a67cb73459a6",
                "serial": 27,
            }
        ),
        encoding="utf-8",
    )

    lineage = _run("read-field", str(state), "lineage", "string")
    serial = _run("read-field", str(state), "serial", "integer")

    assert lineage.returncode == 0
    assert lineage.stdout == "9cc263b9-f1e2-dfc8-4a33-a67cb73459a6\n"
    assert serial.returncode == 0
    assert serial.stdout == "27\n"


def test_metadata_rejects_invalid_input_without_detail(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    state.write_text('{"serial":true,"unsafe":"do-not-echo"}\n', encoding="utf-8")

    result = _run("read-field", str(state), "serial", "integer")

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == ""


def test_metadata_writes_the_pinned_manifest_shape(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    plan_sha256 = "a" * 64
    lineage = "9cc263b9-f1e2-dfc8-4a33-a67cb73459a6"

    result = _run("write-manifest", str(manifest), plan_sha256, lineage, "27")

    assert result.returncode == 0
    assert json.loads(manifest.read_text(encoding="utf-8")) == {
        "format_version": 1,
        "plan_sha256": plan_sha256,
        "state_lineage": lineage,
        "state_serial": 27,
    }


def test_plan_error_classifier_emits_only_fixed_classes(tmp_path: Path) -> None:
    unsafe = "canary-token https://unsafe.example.invalid body=private"
    cases = {
        "PlanTargetOrConfigurationFailed": (
            "Error: Moved resource instances excluded by targeting " + unsafe
        ),
        "PlanProviderRegistrationFailed": (
            "MissingSubscriptionRegistration: register the resource provider " + unsafe
        ),
        "PlanKeyVaultNetworkOrDnsFailed": (
            "azurerm_key_vault_key.audio: ForbiddenByFirewall status code 403 " + unsafe
        ),
        "PlanStorageDataPlaneReadFailed": (
            'retrieving Account "example" for Container "audio": '
            "AuthorizationPermissionMismatch status code: 403 " + unsafe
        ),
        "PlanApiReadFailed": ("Microsoft.App/containerApps/read AuthorizationFailed " + unsafe),
        "PlanIdentityOrRbacFailed": "AuthorizationFailed: caller is not authorized " + unsafe,
        "PlanFailed": "unrecognized provider failure " + unsafe,
    }

    for expected, log_text in cases.items():
        plan_log = tmp_path / f"{expected}.log"
        plan_log.write_text(log_text, encoding="utf-8")

        result = _run("classify-plan-error", str(plan_log))

        assert result.returncode == 0
        assert result.stdout == f"{expected}\n"
        assert result.stderr == ""
        assert "canary" not in result.stdout
        assert "unsafe" not in result.stdout


def test_plan_error_classifier_precedence_is_fail_closed(tmp_path: Path) -> None:
    plan_log = tmp_path / "mixed.log"
    plan_log.write_text(
        "azurerm_key_vault_key.audio ForbiddenByConnection status code 403",
        encoding="utf-8",
    )

    result = _run("classify-plan-error", str(plan_log))

    assert result.returncode == 0
    assert result.stdout == "PlanKeyVaultNetworkOrDnsFailed\n"
    assert result.stderr == ""


def test_plan_error_classifier_covers_aca_msi_api_failure(tmp_path: Path) -> None:
    plan_log = tmp_path / "aca-msi.log"
    plan_log.write_text(
        "UnsupportedApiVersion: could not acquire access token "
        "https://unsafe.example.invalid body=private",
        encoding="utf-8",
    )

    result = _run("classify-plan-error", str(plan_log))

    assert result.returncode == 0
    assert result.stdout == "PlanIdentityOrRbacFailed\n"
    assert result.stderr == ""
    assert "unsafe" not in result.stdout


def test_plan_error_classifier_covers_aca_identity_header_failure(tmp_path: Path) -> None:
    plan_log = tmp_path / "aca-header.log"
    plan_log.write_text(
        "ManagedIdentityAuthorizer received HTTP status 403 "
        "https://unsafe.example.invalid body=private",
        encoding="utf-8",
    )

    result = _run("classify-plan-error", str(plan_log))

    assert result.returncode == 0
    assert result.stdout == "PlanIdentityOrRbacFailed\n"
    assert result.stderr == ""
    assert "unsafe" not in result.stdout


def test_plan_error_classifier_covers_storage_timeout_without_leaking_detail(
    tmp_path: Path,
) -> None:
    plan_log = tmp_path / "storage-timeout.log"
    plan_log.write_text(
        'azurerm_storage_container.audio retrieving Account "secret" for Container "audio": '
        "operation timed out https://unsafe.example.invalid",
        encoding="utf-8",
    )

    result = _run("classify-plan-error", str(plan_log))

    assert result.returncode == 0
    assert result.stdout == "PlanStorageDataPlaneReadFailed\n"
    assert result.stderr == ""
    assert "secret" not in result.stdout
    assert "unsafe" not in result.stdout


def test_plan_error_classifier_uses_only_the_bounded_tail(tmp_path: Path) -> None:
    plan_log = tmp_path / "large.log"
    plan_log.write_bytes(b"AuthorizationFailed" + b"x" * (1024 * 1024) + b"unknown-tail\xff")

    result = _run("classify-plan-error", str(plan_log))

    assert result.returncode == 0
    assert result.stdout == "PlanFailed\n"
    assert result.stderr == ""


def test_plan_error_classifier_rejects_missing_log_without_detail(tmp_path: Path) -> None:
    result = _run("classify-plan-error", str(tmp_path / "missing.log"))

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == ""
