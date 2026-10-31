from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "tools/production/verify_core_bundle_database_plan.py"
)
SPEC = importlib.util.spec_from_file_location("core_bundle_database_plan", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PLAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLAN)


def _plan() -> dict:
    return {
        "variables": {key: {"value": value} for key, value in {
            "environment": "production",
            "subscription_id": PLAN.SUBSCRIPTION,
            "resource_group_name": "cosmaneura-scribe-production",
            "create_resource_group": True,
            "prepare_production_core_bundle_database": True,
            "postgres_database_name": "cosmaneura_scribe",
        }.items()},
        "resource_changes": [{
            "address": PLAN.ADDRESS,
            "mode": "managed",
            "type": "azurerm_postgresql_flexible_server_database",
            "change": {"actions": ["create"], "before": None,
                       "after": dict(PLAN.EXPECTED), "after_unknown": {"id": True}},
        }],
    }


class DatabasePlanTests(unittest.TestCase):
    def test_one_database_and_noop_existing_identity_are_accepted(self) -> None:
        document = _plan()
        document["resource_changes"].append({
            "address": "azurerm_user_assigned_identity.database_migrations[0]",
            "mode": "managed", "change": {"actions": ["no-op"]},
        })
        self.assertEqual(PLAN.verify(document), {
            "schema": "scribe-core-bundle-database-plan-v1",
            "status": "EXACT_LOGICAL_DATABASE_CREATE_ONLY", "creates": 1,
            "other_resource_changes": 0, "sql_executed": False,
            "production_apply_performed": False,
        })

    def test_any_extra_managed_change_is_rejected(self) -> None:
        for actions in [["create"], ["update"], ["delete"], ["delete", "create"], ["read"]]:
            with self.subTest(actions=actions):
                document = _plan()
                document["resource_changes"].append({
                    "address": "azurerm_user_assigned_identity.database_migrations[0]",
                    "mode": "managed", "change": {"actions": actions},
                })
                with self.assertRaisesRegex(ValueError, "UnexpectedResourceAction"):
                    PLAN.verify(document)

    def test_owned_resource_group_selection_is_preserved(self) -> None:
        for key, value in [("create_resource_group", False),
                           ("resource_group_name", "another-group")]:
            with self.subTest(field=key):
                document = _plan()
                document["variables"][key]["value"] = value
                with self.assertRaisesRegex(ValueError, "UnexpectedDatabaseSelection"):
                    PLAN.verify(document)

    def test_shared_or_wrong_database_contract_is_rejected(self) -> None:
        for key, value in [("name", "production"), ("server_id", "another-server"),
                           ("charset", "SQL_ASCII"), ("collation", "C")]:
            with self.subTest(field=key):
                document = _plan()
                document["resource_changes"][0]["change"]["after"][key] = value
                with self.assertRaisesRegex(ValueError, "UnexpectedDatabaseContract"):
                    PLAN.verify(document)

    def test_incomplete_or_unreconciled_plans_are_rejected(self) -> None:
        for mutation in ["unknown", "drift", "deferred", "incomplete", "not_applyable",
                         "import", "move", "missing", "duplicate"]:
            with self.subTest(mutation=mutation):
                document = _plan()
                resource = document["resource_changes"][0]
                if mutation == "unknown":
                    resource["change"]["after_unknown"]["server_id"] = True
                elif mutation == "drift":
                    document["resource_drift"] = [{"change": {"actions": ["update"]}}]
                elif mutation == "deferred":
                    document["deferred_changes"] = [{}]
                elif mutation == "incomplete":
                    document["complete"] = False
                elif mutation == "not_applyable":
                    document["applyable"] = False
                elif mutation == "import":
                    resource["change"]["importing"] = {"id": "existing-database"}
                elif mutation == "move":
                    resource["previous_address"] = "other.database"
                elif mutation == "duplicate":
                    document["resource_changes"].append(copy.deepcopy(resource))
                else:
                    document["resource_changes"] = []
                with self.assertRaises(ValueError):
                    PLAN.verify(document)


if __name__ == "__main__":
    unittest.main()
