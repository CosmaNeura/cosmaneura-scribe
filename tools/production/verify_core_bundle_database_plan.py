"""Verify one saved-plan database create; never execute Terraform or SQL."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

SUBSCRIPTION = "bab2a709-1fcb-4c87-a9fc-802f7477ec13"
SERVER_ID = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/cosmaneura-prod/providers/"
    "Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres"
)
ADDRESS = "azurerm_postgresql_flexible_server_database.scribe[0]"
EXPECTED = {
    "name": "cosmaneura_scribe",
    "server_id": SERVER_ID,
    "charset": "UTF8",
    "collation": "en_US.utf8",
}


def verify(document: dict) -> dict:
    variables = document.get("variables", {})
    if any(variables.get(key, {}).get("value") != value for key, value in {
        "environment": "production",
        "subscription_id": SUBSCRIPTION,
        "prepare_production_core_bundle_database": True,
        "postgres_database_name": "cosmaneura_scribe",
    }.items()):
        raise ValueError("UnexpectedDatabaseSelection")
    if document.get("errored") is True or document.get("deferred_changes"):
        raise ValueError("IncompletePlan")
    if document.get("resource_drift"):
        raise ValueError("UnreconciledResourceDrift")
    changes = document.get("resource_changes")
    if not isinstance(changes, list):
        raise ValueError("MissingResourceChanges")
    creates = 0
    seen = set()
    for resource in changes:
        address = resource.get("address")
        if not isinstance(address, str) or address in seen:
            raise ValueError("InvalidResourceAddress")
        seen.add(address)
        change = resource.get("change", {})
        if resource.get("previous_address") or change.get("importing"):
            raise ValueError("UnexpectedStateAdoption")
        actions = change.get("actions")
        if actions == ["no-op"]:
            continue
        if resource.get("mode") == "data" and actions == ["read"]:
            continue
        if (
            address != ADDRESS
            or resource.get("mode") != "managed"
            or resource.get("type") != "azurerm_postgresql_flexible_server_database"
            or actions != ["create"]
            or change.get("before") is not None
        ):
            raise ValueError("UnexpectedResourceAction")
        after = change.get("after", {})
        unknown = change.get("after_unknown", {})
        if not isinstance(after, dict) or not isinstance(unknown, dict):
            raise ValueError("UnknownDatabaseContract")
        if any(after.get(key) != value or unknown.get(key, False) is not False
               for key, value in EXPECTED.items()):
            raise ValueError("UnexpectedDatabaseContract")
        creates += 1
    if creates != 1:
        raise ValueError("MissingExpectedDatabaseCreate")
    return {
        "schema": "scribe-core-bundle-database-plan-v1",
        "status": "EXACT_LOGICAL_DATABASE_CREATE_ONLY",
        "creates": 1,
        "other_resource_changes": 0,
        "sql_executed": False,
        "production_apply_performed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan_json", type=Path)
    args = parser.parse_args()
    try:
        receipt = verify(json.loads(args.plan_json.read_text()))
    except (OSError, ValueError, TypeError, AttributeError):
        # Plan values may contain credentials; emit no exception or raw value.
        print(json.dumps({"status": "HELD_PLAN_NOT_QUALIFIED"}, sort_keys=True))
        return 1
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
