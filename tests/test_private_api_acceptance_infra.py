from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JOB = ROOT / "infra" / "private_api_acceptance_job.tf"
RUNNER = ROOT / "infra" / "private_terraform_runner.tf"
RUN_SCRIPT = ROOT / "infra" / "runner" / "run.sh"
MAIN = ROOT / "infra" / "main.tf"


def test_job_is_manual_digest_pinned_bounded_and_false_by_default() -> None:
    configuration = JOB.read_text(encoding="utf-8")

    assert configuration.count("default     = false") == 4
    assert "manual_trigger_config {" in configuration
    assert "parallelism              = 1" in configuration
    assert "replica_completion_count = 1" in configuration
    assert "replica_retry_limit          = 0" in configuration
    assert "replica_timeout_in_seconds   = 300" in configuration
    assert (
        'command = ["python", "-m", '
        '"cosmaneura_scribe.private_api_acceptance_runner"]' in configuration
    )
    assert "cosmaneura-scribe-api@${var.private_api_acceptance_image_digest}" in configuration
    assert (
        "name                         = "
        '"cosmaneura-scribe-${local.environment_short}-api-proof"' in configuration
    )
    for forbidden in (
        "args    =",
        "scheduled_trigger_config",
        "event_trigger_config",
        "ingress",
        "scale_rule",
        "Microsoft.App/jobs/start/action",
    ):
        assert forbidden not in configuration


def test_job_attaches_only_the_exact_external_platform_identity() -> None:
    configuration = JOB.read_text(encoding="utf-8")

    assert 'data "azurerm_user_assigned_identity" "platform_workflow"' in configuration
    assert 'resource "azurerm_user_assigned_identity"' not in configuration
    assert configuration.count("data.azurerm_user_assigned_identity.platform_workflow[0].id") == 3
    assert "data.azurerm_user_assigned_identity.platform_workflow[0].client_id" in configuration
    assert "lower(var.platform_workflow_identity_resource_id)" in configuration
    assert "lower(var.trusted_platform_client_id)" in configuration


def test_only_temporary_acr_pull_is_granted_and_no_key_vault_role_exists() -> None:
    configuration = JOB.read_text(encoding="utf-8")

    assert configuration.count('resource "azurerm_role_assignment"') == 1
    assert "7f951dda-4ed3-4680-a7ca-43fe172d538d" in configuration
    assert "azurerm_container_registry.scribe.id" in configuration
    for forbidden in (
        "Key Vault",
        "key_vault",
        "Crypto",
        "Storage Blob",
        "Speech",
        "Contributor",
    ):
        assert forbidden not in configuration


def test_runtime_reader_uses_the_versionless_wrapping_key_scope() -> None:
    configuration = MAIN.read_text(encoding="utf-8")

    assert re.search(
        r'audio_key_name\s*=\s*"session-audio-wrapping"',
        configuration,
    )
    assert (
        'audio_key_versionless_resource_id = "${azurerm_key_vault.scribe.id}/keys/'
        '${local.audio_key_name}"' in configuration
    )
    assert "name         = local.audio_key_name" in configuration

    role = configuration.split(
        'resource "azurerm_role_assignment" "runtime_audio_key_reader" {',
        maxsplit=1,
    )[1].split("}\n", maxsplit=1)[0]
    assert "scope                            = local.audio_key_versionless_resource_id" in role
    assert "azurerm_key_vault_key.audio.resource_id" not in role
    assert "azurerm_key_vault_key.audio" not in role
    assert "/versions/" not in role
    assert "21090545-7ca7-4776-b22c-e363652d74d2" in role
    assert (
        "principal_id                     = "
        "azurerm_user_assigned_identity.runtime.principal_id" in role
    )
    assert "Crypto" not in role


def test_runtime_receives_only_gates_and_derived_nonsecret_inputs() -> None:
    configuration = JOB.read_text(encoding="utf-8")

    for value in (
        "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_ENABLED",
        "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED",
        "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID",
        "COSMANEURA_SCRIBE_WORKFLOW_API_AUDIENCE",
        "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_BASE_URL",
        "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_TENANT_ID",
        "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_PRIVATE_ENDPOINT_CIDRS",
        "local.container_app_name",
        "azurerm_container_app_environment.scribe.default_domain",
        "azurerm_container_app_environment.scribe.static_ip_address",
    ):
        assert value in configuration
    assert "azurerm_container_app.api" not in configuration
    assert "secret" not in configuration.casefold()


def test_private_runner_manifest_carries_every_acceptance_input() -> None:
    configuration = RUNNER.read_text(encoding="utf-8")

    for variable in (
        "deploy_private_api_acceptance_job",
        "enable_private_api_acceptance_job",
        "allow_private_api_acceptance_invocation",
        "platform_workflow_identity_resource_id",
        "private_api_acceptance_tenant_id",
        "private_api_acceptance_image_tag",
        "private_api_acceptance_image_digest",
    ):
        assert variable in configuration

    assert re.search(r"deploy_private_api_acceptance_job\s*=\s*jsonencode\(true\)", configuration)
    assert re.search(r"enable_private_api_acceptance_job\s*=\s*jsonencode\(false\)", configuration)
    assert re.search(
        r"allow_private_api_acceptance_invocation\s*=\s*jsonencode\(false\)",
        configuration,
    )
    assert "var.enable_private_api_acceptance_job" not in configuration
    assert "var.allow_private_api_acceptance_invocation" not in configuration


def test_private_runner_requires_dormant_acceptance_until_reconciliation() -> None:
    variables = (ROOT / "infra" / "variables.tf").read_text(encoding="utf-8")

    assert "var.deploy_private_api_acceptance_job" in variables
    assert "var.private_terraform_reconciliation_completed" in variables
    assert "!var.enable_private_api_acceptance_job" in variables
    assert "!var.allow_private_api_acceptance_invocation" in variables


def test_private_reconciliation_target_graph_has_no_external_identity_lookup() -> None:
    external_identity = "data.azurerm_user_assigned_identity.platform_workflow"
    target_sources = (
        ROOT / "infra" / "main.tf",
        ROOT / "infra" / "container_apps.tf",
        ROOT / "infra" / "runner" / "reconciliation-moves.tf",
    )

    for source in target_sources:
        assert external_identity not in source.read_text(encoding="utf-8")
    runner_script = RUN_SCRIPT.read_text(encoding="utf-8")
    for target in (
        "azurerm_key_vault_key.audio",
        "azurerm_role_assignment.runtime_audio_key_reader",
        "azurerm_role_assignment.runtime_vault",
    ):
        assert f"-target={target}" in runner_script
    assert "-target='azurerm_container_app.api[0]'" in runner_script
    assert "private_api_acceptance" not in runner_script

    job_configuration = JOB.read_text(encoding="utf-8")
    assert "count = var.deploy_private_api_acceptance_job ? 1 : 0" in job_configuration
    assert "azurerm_container_app.api" not in job_configuration
