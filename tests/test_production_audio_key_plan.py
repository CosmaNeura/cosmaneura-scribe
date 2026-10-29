from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "tools/production/verify_audio_key_plan.py"
SPEC = importlib.util.spec_from_file_location("production_audio_key_plan", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PLAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLAN)


def _plan() -> dict:
    return {
        "variables": {
            "environment": {"value": "production"},
            "subscription_id": {"value": PLAN.SUBSCRIPTION},
            "enable_production_arm_audio_key_bootstrap": {"value": True},
            "enable_capture_protocol": {"value": False},
            "deploy_container_app": {"value": False},
            "connect_parallel_platform_vnet": {"value": False},
            "use_postgres_repository": {"value": False},
        },
        "resource_changes": [
            {
                "address": "azapi_resource.production_audio_key[0]",
                "type": "azapi_resource",
                "change": {
                    "actions": ["create"],
                    "after": {
                        "type": "Microsoft.KeyVault/vaults/keys@2024-11-01",
                        "name": "session-audio-wrapping",
                        "parent_id": PLAN.VAULT_ID,
                        "schema_validation_enabled": True,
                        "response_export_values": [],
                        "body": {
                            "properties": {
                                "kty": "RSA",
                                "keySize": 3072,
                                "keyOps": ["unwrapKey", "wrapKey"],
                                "attributes": {"enabled": True, "exportable": False},
                            }
                        },
                    },
                },
            },
            {
                "address": "azurerm_role_assignment.runtime_audio_key_reader",
                "type": "azurerm_role_assignment",
                "change": {
                    "actions": ["create"],
                    "after": {
                        "scope": PLAN.KEY_ID,
                        "role_definition_id": PLAN.READER_ID,
                        "principal_id": PLAN.RUNTIME_PRINCIPAL,
                        "principal_type": "ServicePrincipal",
                    },
                },
            },
        ],
    }


def test_exact_bootstrap_emits_only_fixed_metadata() -> None:
    receipt = PLAN.verify(_plan())
    assert receipt["status"] == "EXACT_KEY_AND_READER_CREATES_ONLY"
    assert receipt["api_can_unwrap"] is False
    assert receipt["production_apply_performed"] is False
    assert set(receipt) == {
        "schema", "status", "creates", "update_count", "delete_count",
        "replacement_count", "key_size", "api_permission", "api_can_unwrap",
        "production_apply_performed",
    }


@pytest.mark.parametrize("actions", [["update"], ["delete", "create"], ["delete"], ["read"]])
def test_any_extra_action_is_rejected(actions: list[str]) -> None:
    document = _plan()
    document["resource_changes"].append({
        "address": "azurerm_key_vault.scribe",
        "type": "azurerm_key_vault",
        "change": {"actions": actions, "after": {"public_network_access_enabled": True}},
    })
    with pytest.raises(ValueError, match="UnexpectedResourceAction"):
        PLAN.verify(document)


@pytest.mark.parametrize("field,value", [
    ("role_definition_id", "12338af0-0e69-4776-bea7-57ae8d297424"),
    ("scope", PLAN.VAULT_ID),
    ("principal_id", "39d00a14-ca79-4cbf-8821-3e2af90ea0e2"),
])
def test_crypto_grant_vault_scope_and_client_id_are_rejected(field: str, value: str) -> None:
    document = _plan()
    document["resource_changes"][1]["change"]["after"][field] = value
    with pytest.raises(ValueError, match="UnexpectedReaderContract"):
        PLAN.verify(document)


@pytest.mark.parametrize("key,value", [
    ("keyOps", ["unwrapKey", "wrapKey", "sign"]),
    ("keySize", 2048),
    ("attributes", {"enabled": True, "exportable": True}),
])
def test_weaker_or_broader_key_is_rejected(key: str, value: object) -> None:
    document = _plan()
    document["resource_changes"][0]["change"]["after"]["body"]["properties"][key] = value
    with pytest.raises(ValueError, match="UnexpectedKeyContract"):
        PLAN.verify(document)


def test_activation_and_missing_key_are_rejected() -> None:
    document = _plan()
    document["variables"]["enable_capture_protocol"]["value"] = True
    with pytest.raises(ValueError, match="UnexpectedActivationConfiguration"):
        PLAN.verify(document)
    document = copy.deepcopy(_plan())
    document["resource_changes"].pop(0)
    with pytest.raises(ValueError, match="MissingExpectedCreate"):
        PLAN.verify(document)
