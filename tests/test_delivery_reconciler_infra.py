from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JOB_CONFIGURATION = ROOT / "infra" / "delivery_reconciler_job.tf"
POSTGRES_CONFIGURATION = ROOT / "infra" / "postgres.tf"


def test_delivery_reconciler_job_is_manual_bounded_and_false_by_default() -> None:
    configuration = JOB_CONFIGURATION.read_text(encoding="utf-8")

    assert configuration.count("default     = false") == 2
    assert 'manual_trigger_config {' in configuration
    assert "parallelism              = 1" in configuration
    assert "replica_completion_count = 1" in configuration
    assert "replica_retry_limit          = 0" in configuration
    assert "replica_timeout_in_seconds   = 900" in configuration
    assert (
        'command = ["python", "-m", "cosmaneura_scribe.delivery_reconciler_runner"]'
        in configuration
    )
    for forbidden in (
        'args    =',
        "scheduled_trigger_config",
        "event_trigger_config",
        "ingress",
        "scale_rule",
    ):
        assert forbidden not in configuration


def test_delivery_reconciler_identity_gets_only_acr_pull_from_this_stack() -> None:
    configurations = "\n".join(
        path.read_text(encoding="utf-8") for path in sorted((ROOT / "infra").glob("*.tf"))
    )
    identity_assignments = [
        line.strip()
        for line in configurations.splitlines()
        if line.strip().startswith("principal_id ") and "delivery_reconciler" in line
    ]

    assert identity_assignments == [
        "principal_id                     = "
        "azurerm_user_assigned_identity.delivery_reconciler[0].principal_id"
    ]
    job_configuration = JOB_CONFIGURATION.read_text(encoding="utf-8")
    assert job_configuration.count('resource "azurerm_role_assignment"') == 1
    assert "7f951dda-4ed3-4680-a7ca-43fe172d538d" in job_configuration
    for forbidden in ("Storage Blob", "Key Vault", "Speech", "Contributor"):
        assert forbidden not in job_configuration


def test_database_principal_values_exist_only_behind_enable_gate() -> None:
    configuration = POSTGRES_CONFIGURATION.read_text(encoding="utf-8")

    assert configuration.count(
        "for_each = var.enable_delivery_reconciler_job ? [1] : []"
    ) == 2
    assert "COSMANEURA_SCRIBE_DATABASE_DELIVERY_RECONCILER_PRINCIPAL_NAME" in configuration
    assert "COSMANEURA_SCRIBE_DATABASE_DELIVERY_RECONCILER_PRINCIPAL_OBJECT_ID" in configuration
