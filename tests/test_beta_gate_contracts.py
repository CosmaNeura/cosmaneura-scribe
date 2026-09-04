from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

_ROOT = Path(__file__).resolve().parents[1]
_ACCESS_MATRIX = _ROOT / "tests/fixtures/beta/invite_and_creator_access_matrix_v1.json"
_ACTIVATION_MANIFEST = _ROOT / "docs/beta/BETA_DARK_ACTIVATION_MANIFEST_V1.json"


def _load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    assert isinstance(value, dict)
    return cast(dict[str, Any], value)


def test_beta_auth_contract_reuses_existing_identity_paths() -> None:
    matrix = _load_object(_ACCESS_MATRIX)
    contract = matrix["auth_contract"]

    assert contract == {
        "human_identity_system": "existing_clerk",
        "workload_identity_system": "existing_entra",
        "new_auth_path": False,
        "sole_inviter": "founder",
        "outside_mcd_invite": {
            "exact_email": True,
            "expiring": True,
            "single_use": True,
        },
        "beta_grant": {
            "server_enforced": True,
            "revocable": True,
            "practice_scoped": True,
        },
        "resource_rule": "creator_only",
    }
    assert set(matrix["onboarding_flows"]) == {"mcd_existing", "outside_mcd"}


def test_beta_access_cases_fail_closed_and_enforce_creator_only() -> None:
    matrix = _load_object(_ACCESS_MATRIX)
    cases = matrix["cases"]
    assert len({case["case_id"] for case in cases}) == len(cases)
    assert {case["identity_origin"] for case in cases} == {"mcd", "outside_mcd"}

    for case in cases:
        expected = case["expected"]
        eligible = bool(
            case["authenticated"]
            and not case["session_revoked"]
            and case["beta_grant"] == "active"
            and not case["view_as"]
        )
        assert expected["enter_beta"] == ("allow" if eligible else "deny")
        assert expected["create_own_capture"] == ("allow" if eligible else "deny")

        creator_access = bool(
            eligible
            and case["practice_relation"] == "same"
            and case["resource_creator"] == "self"
        )
        target_decision = "allow" if creator_access else "deny"
        assert expected["list_target_artifact"] == target_decision
        assert expected["read_target_artifact"] == target_decision
        assert expected["review_target_translation"] == target_decision

        invite = case["invite"]
        if case["identity_origin"] == "outside_mcd" and expected["enter_beta"] == "allow":
            assert invite == {
                "required": True,
                "exact_email_match": True,
                "unexpired": True,
                "redemption_count": 1,
            }


def test_beta_activation_manifest_is_non_phi_and_false_by_default() -> None:
    manifest = _load_object(_ACTIVATION_MANIFEST)

    assert manifest["artifact_type"] == "planning_only_not_deployable"
    assert manifest["target_environment"] == "dedicated_non_phi_beta"
    assert manifest["activation_authorized"] is False
    assert manifest["phi_allowed"] is False
    assert manifest["cohort"] == {
        "kind": "internal_product_micro_beta",
        "maximum_testers": 3,
        "practice_count": 1,
        "practice_data": "synthetic_only",
        "sole_inviter": "founder",
    }
    assert manifest["activation_defaults"]
    assert all(value is False for value in manifest["activation_defaults"].values())
    assert manifest["kill_switch_order"][:2] == [
        "stop_new_invitations",
        "stop_new_capture_sessions",
    ]
    assert "phi" in manifest["forbidden_until_controlled_mcd_launch"]
    assert "founder_activation_decision" in manifest["required_before_activation"]
