from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "infra" / "private_terraform_runner.tf"
VARIABLES = ROOT / "infra" / "variables.tf"
NETWORK = ROOT / "infra" / "network_security.tf"
MAIN = ROOT / "infra" / "main.tf"
DOCKERFILE = ROOT / "infra" / "runner" / "Dockerfile"
TOFU_CONFIG = ROOT / "infra" / "runner" / "tofurc"
RUN_SCRIPT = ROOT / "infra" / "runner" / "run.sh"
CONTAINER_APPS = ROOT / "infra" / "container_apps.tf"


def test_private_runner_manifest_is_closed_and_current() -> None:
    runner = RUNNER.read_text(encoding="utf-8")
    variables = VARIABLES.read_text(encoding="utf-8")

    assert re.search(r'ARM_PROVIDER_ENHANCED_VALIDATION_RESOURCE_PROVIDERS\s*=\s*"false"', runner)
    assert re.search(r'ARM_RESOURCE_PROVIDER_REGISTRATIONS\s*=\s*"none"', runner)
    assert re.search(r'ARM_USE_CLI\s*=\s*"true"', runner)
    assert re.search(r'ARM_USE_MSI\s*=\s*"false"', runner)
    assert "ARM_MSI_API_VERSION" not in runner
    assert "use_msi              = true" in RUN_SCRIPT.read_text(encoding="utf-8")
    run_script = RUN_SCRIPT.read_text(encoding="utf-8")
    assert "az account get-access-token" in run_script
    assert '--subscription "$ARM_SUBSCRIPTION_ID"' in run_script
    assert "--resource https://management.azure.com/" in run_script
    assert "--output none >/dev/null 2>&1" in run_script
    assert 'fail "AzureCliTokenPreflightFailed"' in run_script
    assert "ARM_SKIP_PROVIDER_REGISTRATION" not in runner
    for flag in (
        "deploy_delivery_reconciler_job",
        "enable_delivery_reconciler_job",
    ):
        assert f"{flag}" in runner
        assert f"!var.{flag}" in variables
    assert "804c4bacd692bc157ab101ff5055d999e00a37cc" in variables
    assert "2ae856ade789aed0abcef834b0f4ef84a51ef855" not in variables
    assert "var.deploy_private_api_acceptance_job" in variables
    assert "var.private_terraform_reconciliation_completed" in variables
    assert "enable_capture_protocol" in runner
    assert re.search(r"enable_capture_protocol\s*=\s*jsonencode\(false\)", runner)
    assert "!var.enable_capture_protocol" in variables
    assert "!var.enable_private_api_acceptance_job" in variables
    assert "!var.allow_private_api_acceptance_invocation" in variables
    for runner_input in (
        "deploy_private_terraform_runner",
        "enable_private_terraform_runner",
        "private_terraform_reconciliation_completed",
        "private_terraform_runner_image_repository",
        "private_terraform_runner_image_tag",
        "private_terraform_runner_image_digest",
        "terraform_state_container_resource_id",
        "terraform_state_resource_group_name",
        "terraform_state_storage_account_name",
        "terraform_state_container_name",
        "terraform_state_key",
        "private_terraform_plan_blob_name",
    ):
        assert runner_input in runner
    assert re.search(r"deploy_private_terraform_runner\s*=\s*jsonencode\(true\)", runner)
    assert re.search(r"enable_private_terraform_runner\s*=\s*jsonencode\(true\)", runner)
    assert re.search(
        r"private_terraform_reconciliation_completed\s*=\s*jsonencode\(false\)", runner
    )


def test_key_vault_tenant_id_preserves_sensitive_state_metadata() -> None:
    main = MAIN.read_text(encoding="utf-8")
    vault_start = main.index('resource "azurerm_key_vault" "scribe"')
    vault_end = main.index('resource "azurerm_key_vault_key" "audio"', vault_start)

    assert "tenant_id           = sensitive(var.tenant_id)" in main[vault_start:vault_end]


def test_api_uses_constant_audio_container_name_without_data_plane_dependency() -> None:
    main = MAIN.read_text(encoding="utf-8")
    container_apps = CONTAINER_APPS.read_text(encoding="utf-8")

    assert 'audio_container_name = "audio"' in main
    assert "name                  = local.audio_container_name" in main
    assert "value = local.audio_container_name" in container_apps
    assert "value = azurerm_storage_container.audio.name" not in container_apps


def test_state_role_is_data_only_and_exact_object_conditioned() -> None:
    runner = RUNNER.read_text(encoding="utf-8")

    assert 'resource "azurerm_role_definition" "private_terraform_runner_state"' in runner
    assert "actions     = []" in runner
    assert "not_actions = []" in runner
    assert "ba92f5b4-2d11-453d-a403-e96b0029c9fe" not in runner
    assert "role_definition_resource_id" in runner
    assert "${var.terraform_state_resource_group_name}" in runner
    for object_name in (
        "${var.terraform_state_key}",
        "${var.private_terraform_plan_blob_name}",
        "${var.private_terraform_plan_blob_name}.manifest.json",
    ):
        assert f"StringEquals '{object_name}'" in runner
    assert "SubOperationMatches{'Blob.List'}" in runner
    assert (
        "@Request[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:prefix] "
        "StringEquals '${var.terraform_state_key}env:'" in runner
    )
    assert (
        "!(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete'})"
        in runner
    )
    assert "StringNotEquals '${var.terraform_state_key}'" in runner
    variables = VARIABLES.read_text(encoding="utf-8")
    assert "lower(var.terraform_state_container_resource_id) == lower(" in variables
    assert "var.private_terraform_plan_blob_name != var.terraform_state_key" in variables
    assert (
        '"${var.private_terraform_plan_blob_name}.manifest.json" != var.terraform_state_key'
        in variables
    )


def test_temporary_network_access_is_enable_gated() -> None:
    network = NETWORK.read_text(encoding="utf-8")

    for rule_name, service_tag in (
        ("AllowTemporaryTerraformArmOutbound", "AzureResourceManager"),
        ("AllowTemporaryTerraformStateOutbound", "Storage.NorthCentralUS"),
    ):
        rule_start = network.index(f'name                       = "{rule_name}"')
        gate_start = network.rfind(
            "for_each = var.enable_private_terraform_runner ? [1] : []",
            0,
            rule_start,
        )
        assert gate_start >= 0
        rule_end = network.index("  }\n", rule_start)
        assert f'destination_address_prefix = "{service_tag}"' in network[gate_start:rule_end]


def test_private_runner_linked_resource_permissions_are_exact_and_temporary() -> None:
    runner = RUNNER.read_text(encoding="utf-8")

    identity_start = runner.index(
        'resource "azurerm_role_assignment" "private_terraform_runner_runtime_identity_operator"'
    )
    identity_end = runner.index("\n}\n", identity_start)
    identity_role = runner[identity_start:identity_end]
    assert "count = var.enable_private_terraform_runner ? 1 : 0" in identity_role
    assert (
        "scope                            = azurerm_user_assigned_identity.runtime.id"
        in identity_role
    )
    assert "f1a07417-d97a-45cb-824c-7a7467783830" in identity_role

    environment_start = runner.index(
        'resource "azurerm_role_assignment" "private_terraform_runner_environment_join"'
    )
    environment_end = runner.index("\n}\n", environment_start)
    environment_role = runner[environment_start:environment_end]
    assert "count = var.enable_private_terraform_runner ? 1 : 0" in environment_role
    assert (
        "scope                            = azurerm_container_app_environment.scribe.id"
        in environment_role
    )
    assert "358470bc-b998-42bd-ab17-a7e34c199c0f" in environment_role

    assert "azurerm_role_assignment.private_terraform_runner_runtime_identity_operator" in runner
    assert "azurerm_role_assignment.private_terraform_runner_environment_join" in runner


def test_private_key_keeps_private_network_dependencies() -> None:
    main = MAIN.read_text(encoding="utf-8")
    key_start = main.index('resource "azurerm_key_vault_key" "audio"')
    key_end = main.index('resource "azurerm_private_endpoint" "audio_blob"', key_start)
    key = main[key_start:key_end]

    assert "key_vault_id = azurerm_key_vault.scribe.id" in key
    assert "azurerm_private_dns_zone_virtual_network_link.key_vault" in key
    assert "azurerm_private_endpoint.key_vault" in key


def test_runner_uses_a_baked_fail_closed_provider_mirror() -> None:
    runner = RUNNER.read_text(encoding="utf-8")
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    tofu_config = TOFU_CONFIG.read_text(encoding="utf-8")

    assert "ghcr.io/opentofu/opentofu" not in dockerfile
    assert "OPENTOFU_VERSION=1.12.5" in dockerfile
    assert (
        "OPENTOFU_LINUX_AMD64_SHA256="
        "a6894d45ae7a17ce83189cce8fe04b5a65f68cefceb62455b5a6a89fa53ab38f" in dockerfile
    )
    assert "ADD https://github.com/opentofu/opentofu/releases/download/" in dockerfile
    assert "sha256sum --check --strict" in dockerfile
    assert "tarfile.open('/tmp/tofu.tar.gz', 'r:gz')" in dockerfile
    assert "command -v python3" in dockerfile
    assert "command -v awk" not in dockerfile
    assert "command -v jq" not in dockerfile
    assert re.search(r'TF_CLI_CONFIG_FILE\s*=\s*"/workspace/infra/runner/tofurc"', runner)
    assert "tofu providers mirror -platform=linux_amd64 /opt/tofu/providers" in dockerfile
    assert "filesystem_mirror" in tofu_config
    assert 'include = ["registry.opentofu.org/hashicorp/azurerm"]' in tofu_config
    assert "direct" not in tofu_config


def test_runner_classifies_plan_failures_without_emitting_provider_output() -> None:
    script = RUN_SCRIPT.read_text(encoding="utf-8")

    assert "classify-plan-error /tmp/tofu-plan.log 2>/dev/null" in script
    assert "*) classify_plan_failure ;;" in script
    assert '*) plan_error_class="PlanFailed" ;;' in script
    for error_class in (
        "PlanTargetOrConfigurationFailed",
        "PlanProviderRegistrationFailed",
        "PlanKeyVaultNetworkOrDnsFailed",
        "PlanStorageDataPlaneReadFailed",
        "PlanApiReadFailed",
        "PlanIdentityOrRbacFailed",
        "PlanFailed",
    ):
        assert error_class in script
    assert ">/tmp/tofu-plan.log 2>&1" in script
    for unsafe_command in (
        "cat /tmp/tofu-plan.log",
        "grep /tmp/tofu-plan.log",
        "tail /tmp/tofu-plan.log",
    ):
        assert unsafe_command not in script


def test_runner_classifies_apply_failures_without_emitting_provider_output() -> None:
    script = RUN_SCRIPT.read_text(encoding="utf-8")

    assert "classify-apply-error /tmp/tofu-apply.log 2>/dev/null" in script
    assert "classify_apply_failure" in script
    assert '*) apply_error_class="ApplyFailed" ;;' in script
    for error_class in (
        "ApplyTargetOrConfigurationFailed",
        "ApplyLinkedResourceAuthorizationFailed",
        "ApplyKeyVaultNetworkOrDnsFailed",
        "ApplyStorageDataPlaneFailed",
        "ApplyApiUpdateFailed",
        "ApplyIdentityOrRbacFailed",
        "ApplyFailed",
    ):
        assert error_class in script
    assert ">/tmp/tofu-apply.log 2>&1" in script
    for unsafe_command in (
        "cat /tmp/tofu-apply.log",
        "grep /tmp/tofu-apply.log",
        "tail /tmp/tofu-apply.log",
    ):
        assert unsafe_command not in script
