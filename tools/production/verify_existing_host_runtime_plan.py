"""Verify an unapplied production preparation plan and emit only safe metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

from verify_audio_key_plan import KEY_ID, READER_ID, RUNTIME_PRINCIPAL, SUBSCRIPTION, VAULT_ID

CORE_ID = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/cosmaneura-prod"
POSTGRES_ID = (
    f"{CORE_ID}/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
)
AI_ID = f"{CORE_ID}/providers/Microsoft.CognitiveServices/accounts/cosmaneuraprodopenai"
KEY_CREATES = {
    "azapi_resource.production_audio_key[0]",
    "azurerm_role_assignment.runtime_audio_key_reader",
}
WORKER_CREATES = (
    KEY_CREATES
    | {
        f'{resource}["{phase}"]'
        for phase in ("speech", "translation")
        for resource in (
            "azurerm_user_assigned_identity.production_captured",
            "azurerm_role_assignment.production_captured_acr",
            "azurerm_container_app_job.production_captured",
        )
    }
    | {
        f'{resource}["{zone}"]'
        for zone in (
            "privatelink.cognitiveservices.azure.com",
            "privatelink.openai.azure.com",
            "privatelink.services.ai.azure.com",
        )
        for resource in (
            "azurerm_private_dns_zone.production_ai",
            "azurerm_private_dns_zone_virtual_network_link.production_ai",
        )
    }
    | {
        "azurerm_private_endpoint.production_ai[0]",
        "azurerm_private_endpoint.core_registry_postgres[0]",
        "azurerm_private_dns_zone.core_registry_postgres[0]",
        "azurerm_private_dns_zone_virtual_network_link.core_registry_postgres[0]",
    }
)


def _env(container: dict[str, Any]) -> dict[str, str | None]:
    # Newly prepared MI IDs/private IPs stay unknown in the saved plan. Every
    # fixed safety field below still must be present and equal its expected value.
    values = {item["name"]: item.get("value") for item in container.get("env", [])}
    if len(values) != len(container.get("env", [])):
        raise ValueError("DuplicateEnvironment")
    return values


def verify(document: dict[str, Any], mode: str) -> dict[str, Any]:
    """Refuse extra resource actions, activation, credentials and broader custody."""
    variables = {key: item.get("value") for key, item in document.get("variables", {}).items()}
    allowed_flags = {"enable_production_arm_audio_key_bootstrap"}
    if mode == "workers":
        allowed_flags.add("deploy_production_captured_workers")
        creates = WORKER_CREATES
        updates = {
            "azurerm_network_security_group.container_apps",
            "azurerm_network_security_group.private_endpoints",
        }
    elif mode == "network":
        allowed_flags.add("enable_production_native_direct_upload")
        creates = KEY_CREATES
        updates = {"azurerm_key_vault.scribe", "azurerm_storage_account.audio"}
    else:
        raise ValueError("UnexpectedMode")
    if not (
        variables.get("environment") == "production"
        and variables.get("subscription_id") == SUBSCRIPTION
        and all(variables.get(flag) is True for flag in allowed_flags)
        and all(
            value is False
            for name, value in variables.items()
            if name.startswith(("enable_", "deploy_")) and name not in allowed_flags
        )
        and variables.get("prepare_production_existing_host_runtime_network") is (mode == "network")
        and variables.get("production_capture_tenant_id") == ""
        and variables.get("connect_parallel_platform_vnet") is False
        and variables.get("use_postgres_repository") is False
    ):
        raise ValueError("UnexpectedActivationConfiguration")

    after: dict[str, dict[str, Any]] = {}
    actual_creates: set[str] = set()
    actual_updates: set[str] = set()
    unchanged = 0
    for item in document.get("resource_changes", []):
        action = item.get("change", {}).get("actions")
        if item.get("mode") == "data":
            if action not in (["read"], ["no-op"]):
                raise ValueError("UnexpectedDataAction")
            continue
        address = item.get("address")
        after[address] = item["change"].get("after") or {}
        if action == ["no-op"]:
            unchanged += 1
        elif action == ["create"] and address in creates:
            actual_creates.add(address)
        elif action == ["update"] and address in updates:
            actual_updates.add(address)
        else:
            raise ValueError("UnexpectedResourceAction")
    if actual_creates != creates or actual_updates != updates or unchanged != 24:
        raise ValueError("UnexpectedActionSet")

    reader = after["azurerm_role_assignment.runtime_audio_key_reader"]
    key = after["azapi_resource.production_audio_key[0]"]
    properties = dict(key.get("body", {}).get("properties", {}))
    operations = properties.pop("keyOps", [])
    if not (
        reader.get("scope") == KEY_ID
        and reader.get("role_definition_id") == READER_ID
        and reader.get("principal_id") == RUNTIME_PRINCIPAL
        and reader.get("principal_type") == "ServicePrincipal"
        and key.get("type") == "Microsoft.KeyVault/vaults/keys@2024-11-01"
        and key.get("parent_id") == VAULT_ID
        and key.get("name") == "session-audio-wrapping"
        and key.get("schema_validation_enabled") is True
        and key.get("response_export_values") == []
        and set(key.get("body", {})) == {"properties"}
        and sorted(operations) == ["unwrapKey", "wrapKey"]
        and properties
        == {
            "kty": "RSA",
            "keySize": 3072,
            "attributes": {"enabled": True, "exportable": False},
        }
    ):
        raise ValueError("UnexpectedKeyCustody")
    storage, vault = after["azurerm_storage_account.audio"], after["azurerm_key_vault.scribe"]
    if not (
        storage.get("shared_access_key_enabled") is False
        and storage.get("allow_nested_items_to_be_public") is False
        and storage.get("default_to_oauth_authentication") is True
        and vault.get("purge_protection_enabled") is True
        and vault.get("rbac_authorization_enabled") is True
        and after["azurerm_storage_container.audio"].get("container_access_type") == "private"
    ):
        raise ValueError("UnexpectedDataControls")
    if mode == "network":
        acl = vault.get("network_acls", [])
        if not (
            vault.get("public_network_access_enabled") is True
            and storage.get("public_network_access_enabled") is True
            and len(acl) == 1
            and acl[0].get("bypass") == "None"
            and acl[0].get("default_action") == "Deny"
            and acl[0].get("ip_rules") == ["64.236.176.41/32"]
            and acl[0].get("virtual_network_subnet_ids") == []
        ):
            raise ValueError("UnexpectedPublicNetworkScope")
    else:
        if (
            vault.get("public_network_access_enabled") is not False
            or storage.get("public_network_access_enabled") is not False
        ):
            raise ValueError("UnexpectedWorkerPublicNetwork")
        for phase in ("speech", "translation"):
            job = after[f'azurerm_container_app_job.production_captured["{phase}"]']
            container = job["template"][0]["container"][0]
            env = _env(container)
            principal = f"cosmaneura-scribe-production-captured-{phase}"
            if not (
                job.get("schedule_trigger_config") == []
                and len(job.get("manual_trigger_config", [])) == 1
                and job.get("replica_retry_limit") == 0
                and container.get("command")
                == ["python", "-m", "cosmaneura_scribe.captured_worker_job_runner"]
                and container.get("args") == ["UNCONFIGURED", "--pending"]
                and env.get("AZURE_TOKEN_CREDENTIALS") == "ManagedIdentityCredential"
                and env.get("COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED") == "false"
                and env.get("COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS") == "[]"
                and "COSMANEURA_SCRIBE_DATABASE_URL" not in env
                and env.get("COSMANEURA_SCRIBE_DATABASE_USER") == principal
                and env.get("COSMANEURA_SCRIBE_DATABASE_POOL_SIZE") == "1"
                and env.get("COSMANEURA_SCRIBE_DATABASE_MAX_OVERFLOW") == "0"
            ):
                raise ValueError("UnexpectedWorkerContract")
        for resource, expected in (
            ("production_ai", AI_ID),
            ("core_registry_postgres", POSTGRES_ID),
        ):
            pe = after[f"azurerm_private_endpoint.{resource}[0]"]
            if pe["private_service_connection"][0]["private_connection_resource_id"] != expected:
                raise ValueError("UnexpectedPrivatePathTarget")
    return {
        "schema": "scribe-production-existing-runtime-plan-v1",
        "mode": mode,
        "status": "EXACT_UNAPPLIED_PREPARATION_PLAN",
        "creates": sorted(creates),
        "updates": sorted(updates),
        "unchanged_count": unchanged,
        "delete_count": 0,
        "replacement_count": 0,
        "capture_enabled": False,
        "cohort_configured": False,
        "api_can_unwrap": False,
        "new_hosting_database_or_ai_account": False,
        "production_apply_performed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--mode", choices=("workers", "network"), required=True)
    parser.add_argument("--tofu", default="tofu")
    args = parser.parse_args()
    try:
        result = subprocess.run(
            [args.tofu, "show", "-json", str(args.plan.resolve())],
            capture_output=True,
            check=False,
            timeout=120,
        )
        if result.returncode != 0:
            raise ValueError("PlanReadFailed")
        receipt = verify(json.loads(result.stdout), args.mode)
        receipt["plan_sha256"] = hashlib.sha256(args.plan.read_bytes()).hexdigest()
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
        print(json.dumps({"status": "REJECTED", "reason": "PlanContractFailed"}))
        return 1
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
