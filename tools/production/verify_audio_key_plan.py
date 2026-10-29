"""Reject a broader production bootstrap plan without emitting plan/state secrets."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

SUBSCRIPTION = "bab2a709-1fcb-4c87-a9fc-802f7477ec13"
VAULT_ID = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/cosmaneura-scribe-production"
    "/providers/Microsoft.KeyVault/vaults/cosmaneura-scribe-prod"
)
KEY_ID = f"{VAULT_ID}/keys/session-audio-wrapping"
READER_ID = (
    f"/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/"
    "21090545-7ca7-4776-b22c-e363652d74d2"
)
RUNTIME_PRINCIPAL = "3f712a80-f393-49d0-ab42-6a40bc50dfbd"


def verify(document: dict[str, Any]) -> dict[str, Any]:
    """Return only fixed bootstrap metadata; all failures use fixed labels."""
    variables = {key: value.get("value") for key, value in document.get("variables", {}).items()}
    if not (
        variables.get("environment") == "production"
        and variables.get("subscription_id") == SUBSCRIPTION
        and variables.get("enable_production_arm_audio_key_bootstrap") is True
        and all(
            value is False
            for key, value in variables.items()
            if key.startswith(("enable_", "deploy_"))
            and key != "enable_production_arm_audio_key_bootstrap"
        )
        and variables.get("connect_parallel_platform_vnet") is False
        and variables.get("use_postgres_repository") is False
    ):
        raise ValueError("UnexpectedActivationConfiguration")
    expected = {
        "azapi_resource.production_audio_key[0]": "azapi_resource",
        "azurerm_role_assignment.runtime_audio_key_reader": "azurerm_role_assignment",
    }
    changes: dict[str, dict[str, Any]] = {}
    for item in document.get("resource_changes", []):
        action = item.get("change", {}).get("actions")
        if action == ["no-op"]:
            continue
        address = item.get("address")
        if (
            action != ["create"]
            or address not in expected
            or item.get("type") != expected[address]
            or address in changes
        ):
            raise ValueError("UnexpectedResourceAction")
        changes[address] = item["change"].get("after") or {}
    if set(changes) != set(expected):
        raise ValueError("MissingExpectedCreate")

    key = changes["azapi_resource.production_audio_key[0]"]
    properties = key.get("body", {}).get("properties", {})
    if not (
        key.get("type") == "Microsoft.KeyVault/vaults/keys@2024-11-01"
        and key.get("parent_id") == VAULT_ID
        and key.get("name") == "session-audio-wrapping"
        and key.get("schema_validation_enabled") is True
        and key.get("response_export_values") == []
        and set(key.get("body", {})) == {"properties"}
        and set(properties) == {"kty", "keySize", "keyOps", "attributes"}
        and properties.get("kty") == "RSA"
        and properties.get("keySize") == 3072
        and sorted(properties.get("keyOps", [])) == ["unwrapKey", "wrapKey"]
        and properties.get("attributes") == {"enabled": True, "exportable": False}
    ):
        raise ValueError("UnexpectedKeyContract")
    reader = changes["azurerm_role_assignment.runtime_audio_key_reader"]
    if not (
        reader.get("scope") == KEY_ID
        and reader.get("role_definition_id") == READER_ID
        and reader.get("principal_id") == RUNTIME_PRINCIPAL
        and reader.get("principal_type") == "ServicePrincipal"
    ):
        raise ValueError("UnexpectedReaderContract")
    return {
        "schema": "scribe-production-arm-key-plan-v1",
        "status": "EXACT_KEY_AND_READER_CREATES_ONLY",
        "creates": sorted(expected),
        "update_count": 0,
        "delete_count": 0,
        "replacement_count": 0,
        "key_size": 3072,
        "api_permission": "Key Vault Reader",
        "api_can_unwrap": False,
        "production_apply_performed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
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
        receipt = verify(json.loads(result.stdout))
        receipt["plan_sha256"] = hashlib.sha256(args.plan.read_bytes()).hexdigest()
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
        print(json.dumps({"status": "REJECTED", "reason": "PlanContractFailed"}))
        return 1
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
