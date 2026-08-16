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


def test_private_runner_manifest_is_closed_and_current() -> None:
    runner = RUNNER.read_text(encoding="utf-8")
    variables = VARIABLES.read_text(encoding="utf-8")

    assert re.search(r'ARM_PROVIDER_ENHANCED_VALIDATION_RESOURCE_PROVIDERS\s*=\s*"false"', runner)
    assert re.search(r'ARM_RESOURCE_PROVIDER_REGISTRATIONS\s*=\s*"none"', runner)
    assert "ARM_SKIP_PROVIDER_REGISTRATION" not in runner
    for flag in (
        "deploy_delivery_reconciler_job",
        "enable_delivery_reconciler_job",
    ):
        assert f"{flag}" in runner
        assert f"!var.{flag}" in variables
    assert "804c4bacd692bc157ab101ff5055d999e00a37cc" in variables
    assert "2ae856ade789aed0abcef834b0f4ef84a51ef855" not in variables


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
