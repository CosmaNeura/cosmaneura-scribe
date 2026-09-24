from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from cosmaneura_scribe.normalized_source_persistence import ConfiguredExternalSessionStatus
from cosmaneura_scribe.settings import Settings

_ROOT = Path(__file__).resolve().parents[1]
_ACCESS_MATRIX = _ROOT / "tests/fixtures/beta/invite_and_creator_access_matrix_v1.json"
_DASHBOARD_MATRIX = _ROOT / "tests/fixtures/beta/limited_dashboard_state_matrix_v1.json"
_ENCOUNTER_MATRIX = _ROOT / "tests/fixtures/beta/encounter_binding_matrix_v1.json"
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
    assert (
        "encrypted_translation_job_store_and_ambiguity_runbook"
        in manifest["required_before_activation"]
    )
    assert "core_owned_encounter_binding_evidence" in manifest[
        "required_before_activation"
    ]


def test_existing_scribe_runtime_controls_remain_dark() -> None:
    for name in (
        "external_ingest_admission_enabled",
        "derived_writer_database_permissions_enabled",
        "master_platform_handoff_enabled",
    ):
        assert Settings.model_fields[name].default is False


def test_limited_dashboard_matrix_covers_every_status_and_stays_creator_only() -> None:
    matrix = _load_object(_DASHBOARD_MATRIX)
    states = matrix["states"]
    by_status = {state["source_status"]: state for state in states}

    assert set(by_status) == {status.value for status in ConfiguredExternalSessionStatus}
    assert all(state["creator_authorization_required"] is True for state in states)
    assert all(state["show_to_non_creator"] is False for state in states)
    assert {
        state["source_status"]
        for state in states
        if state["can_review_translation"]
    } == {ConfiguredExternalSessionStatus.REVIEW_REQUIRED.value}
    assert {
        state["source_status"] for state in states if state["can_request_note"]
    } == {ConfiguredExternalSessionStatus.TRANSCRIPT_READY.value}


def test_encounter_binding_keeps_demographics_in_core_and_precedes_capture() -> None:
    matrix = _load_object(_ENCOUNTER_MATRIX)

    assert matrix["ownership"] == {
        "human_identity": "core_existing_clerk",
        "demographics_and_matching": "core",
        "canonical_encounter": "core",
        "recording_and_transcript": "scribe",
        "recording_visibility": "immutable_creator_only",
    }
    boundary = matrix["scribe_boundary"]
    assert boundary["tenant_source"] == "verified_entra_context"
    assert boundary["creator_source"] == "core_authenticated_actor"
    assert set(boundary["allowed_request_fields"]) == {
        "appointment_id",
        "practitioner_id",
        "patient_id",
        "consent_record_id",
        "modality",
    }
    assert set(boundary["forbidden_request_fields"]) == {
        "tenant_id",
        "creator_actor_id",
        "patient_name",
        "patient_date_of_birth",
        "possible_matches",
    }
    assert not set(boundary["allowed_request_fields"]) & set(
        boundary["forbidden_request_fields"]
    )
    assert all(matrix["rules"].values())


def test_encounter_binding_cases_require_explicit_safe_resolution() -> None:
    matrix = _load_object(_ENCOUNTER_MATRIX)
    cases = matrix["cases"]
    by_id = {case["case_id"]: case for case in cases}

    assert len(by_id) == len(cases)
    assert {
        "existing_appointment_authorized",
        "existing_appointment_unauthorized",
        "manual_no_match_create_new",
        "manual_match_existing_patient",
        "manual_possible_match_unresolved",
        "manual_possible_match_explicit_new",
        "manual_selected_match_unauthorized",
        "manual_incomplete_demographics",
        "revoked_grant_denied",
        "view_as_denied",
        "exact_idempotent_replay",
        "idempotency_payload_conflict",
    } == set(by_id)

    successful_actions = {
        "bind_existing_appointment",
        "create_unscheduled_for_existing_patient",
        "create_unscheduled_new_patient",
        "replay_existing_binding",
    }
    for case in cases:
        eligible = bool(
            case["authenticated"]
            and not case["session_revoked"]
            and case["beta_grant"] == "active"
            and case["practice_relation"] == "same"
            and not case["view_as"]
        )
        expected = case["expected"]
        successful = expected["action"] in successful_actions
        assert expected["create_scribe_session"] is successful
        assert expected["capture_start_allowed"] is successful
        assert expected["dashboard_visible_to_creator"] is successful
        assert expected["duplicate_encounter_created"] is False
        if successful:
            assert eligible

        if case["mode"] == "existing_appointment" and eligible:
            should_bind = bool(
                case["appointment_authorized"]
                and case["selected_match_authorized"]
                and case["idempotency"] != "payload_conflict"
            )
            assert successful is should_bind

        if case["mode"] == "manual_demographics" and eligible:
            complete = bool(
                case["manual_name_present"] and case["manual_dob_present"]
            )
            if not complete or case["idempotency"] == "payload_conflict":
                assert not successful
            if (
                complete
                and case["possible_match_count"]
                and case["explicit_resolution"] == "none"
            ):
                assert expected["action"] == "wait_for_explicit_resolution"
                assert not successful
            if case["explicit_resolution"] == (
                "create_unscheduled_for_existing_patient"
            ):
                assert case["possible_match_count"] >= 1
                assert successful is bool(case["selected_match_authorized"])

    assert by_id["exact_idempotent_replay"]["expected"]["action"] == (
        "replay_existing_binding"
    )
    assert by_id["manual_possible_match_unresolved"]["expected"]["action"] == (
        "wait_for_explicit_resolution"
    )
