from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "tools/production/verify_existing_host_runtime_plan.py"
)
SPEC = importlib.util.spec_from_file_location("existing_runtime_plan", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PLAN = importlib.util.module_from_spec(SPEC)
with patch.object(sys, "path", [str(MODULE_PATH.parent), *sys.path]):
    SPEC.loader.exec_module(PLAN)


def _network_plan() -> dict:
    values = {
        "environment": "production",
        "subscription_id": PLAN.SUBSCRIPTION,
        "enable_production_arm_audio_key_bootstrap": True,
        "enable_production_native_direct_upload": True,
        "prepare_production_existing_host_runtime_network": True,
        "enable_capture_protocol": False,
        "deploy_container_app": False,
        "production_capture_tenant_id": "",
        "connect_parallel_platform_vnet": False,
        "use_postgres_repository": False,
    }
    after = {
        "azapi_resource.production_audio_key[0]": {
            "type": "Microsoft.KeyVault/vaults/keys@2024-11-01",
            "parent_id": PLAN.VAULT_ID,
            "name": "session-audio-wrapping",
            "schema_validation_enabled": True,
            "response_export_values": [],
            "body": {
                "properties": {
                    "kty": "RSA",
                    "keySize": 3072,
                    "keyOps": ["wrapKey", "unwrapKey"],
                    "attributes": {"enabled": True, "exportable": False},
                }
            }
        },
        "azurerm_role_assignment.runtime_audio_key_reader": {
            "scope": PLAN.KEY_ID,
            "role_definition_id": PLAN.READER_ID,
            "principal_id": PLAN.RUNTIME_PRINCIPAL,
            "principal_type": "ServicePrincipal",
        },
        "azurerm_key_vault.scribe": {
            "purge_protection_enabled": True,
            "rbac_authorization_enabled": True,
            "public_network_access_enabled": True,
            "network_acls": [
                {
                    "bypass": "None",
                    "default_action": "Deny",
                    "ip_rules": ["64.236.176.41/32"],
                    "virtual_network_subnet_ids": [],
                }
            ],
        },
        "azurerm_storage_account.audio": {
            "shared_access_key_enabled": False,
            "allow_nested_items_to_be_public": False,
            "default_to_oauth_authentication": True,
            "public_network_access_enabled": True,
        },
        "azurerm_storage_container.audio": {"container_access_type": "private"},
    }
    # Minimal synthetic no-op records deliberately contain no state values.
    after.update({f"synthetic_noop_{index}": {} for index in range(23)})
    return {
        "variables": {name: {"value": value} for name, value in values.items()},
        "resource_changes": [
            {
                "address": address,
                "mode": "managed",
                "change": {
                    "actions": [
                        "create"
                        if address in PLAN.KEY_CREATES
                        else "update"
                        if address in ("azurerm_key_vault.scribe", "azurerm_storage_account.audio")
                        else "no-op"
                    ],
                    "after": fields,
                },
            }
            for address, fields in after.items()
        ],
    }


def _after(document: dict, address: str) -> dict:
    return next(
        item["change"]["after"]
        for item in document["resource_changes"]
        if item["address"] == address
    )


def test_network_receipt_emits_fixed_metadata_only() -> None:
    receipt = PLAN.verify(_network_plan(), "network")
    assert receipt["status"] == "EXACT_UNAPPLIED_PREPARATION_PLAN"
    assert receipt["capture_enabled"] is False
    assert receipt["api_can_unwrap"] is False
    assert "variables" not in receipt and "resource_changes" not in receipt


@pytest.mark.parametrize("actions", [["create"], ["update"], ["delete"], ["delete", "create"]])
def test_extra_core_resource_action_is_rejected(actions: list[str]) -> None:
    document = _network_plan()
    document["resource_changes"].append(
        {
            "address": "azurerm_container_app.core",
            "mode": "managed",
            "change": {"actions": actions, "after": {"secret": "synthetic-must-not-emit"}},
        }
    )
    with pytest.raises(ValueError, match="UnexpectedResourceAction"):
        PLAN.verify(document, "network")


@pytest.mark.parametrize(
    "field,value",
    [
        ("scope", PLAN.CORE_ID),
        ("role_definition_id", "Key Vault Crypto User"),
        ("principal_id", "00000000-0000-4000-8000-000000000001"),
    ],
)
def test_broader_custody_or_other_principal_is_rejected(field: str, value: str) -> None:
    document = _network_plan()
    _after(document, "azurerm_role_assignment.runtime_audio_key_reader")[field] = value
    with pytest.raises(ValueError, match="UnexpectedKeyCustody"):
        PLAN.verify(document, "network")


@pytest.mark.parametrize(
    "field,value",
    [
        ("bypass", "AzureServices"),
        ("default_action", "Allow"),
        ("ip_rules", ["64.236.176.0/24"]),
        ("virtual_network_subnet_ids", ["synthetic-subnet"]),
    ],
)
def test_global_vault_bypass_or_broader_egress_is_rejected(field: str, value: object) -> None:
    document = _network_plan()
    _after(document, "azurerm_key_vault.scribe")["network_acls"][0][field] = value
    with pytest.raises(ValueError, match="UnexpectedPublicNetworkScope"):
        PLAN.verify(document, "network")


def test_activation_and_anonymous_audio_are_rejected() -> None:
    document = _network_plan()
    document["variables"]["enable_capture_protocol"]["value"] = True
    with pytest.raises(ValueError, match="UnexpectedActivationConfiguration"):
        PLAN.verify(document, "network")
    document = _network_plan()
    _after(document, "azurerm_storage_container.audio")["container_access_type"] = "blob"
    with pytest.raises(ValueError, match="UnexpectedDataControls"):
        PLAN.verify(document, "network")
