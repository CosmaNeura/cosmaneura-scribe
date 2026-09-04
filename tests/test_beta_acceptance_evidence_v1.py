from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from cosmaneura_scribe.beta_acceptance_evidence_v1 import (
    BetaAcceptanceRunV1,
    BetaArtifactComponent,
    BetaArtifactSetV1,
    BetaClientSurface,
    BetaFindingCategory,
    BetaFindingSeverity,
    BetaFindingStatus,
    BetaFindingV1,
    BetaScenarioEvidenceV1,
    BetaScenarioId,
    BetaScenarioOutcome,
    BetaTechnicalBlocker,
    DesktopBetaArtifactV1,
    FounderAcceptanceDecision,
    IOSBetaArtifactV1,
    TranslationBetaArtifactV1,
    build_beta_scenario_evidence,
    required_components_for_scenario,
    required_surfaces_for_scenario,
)
from pydantic import ValidationError

RUN_ID = UUID("10000000-0000-4000-8000-000000000001")
TENANT_ID = UUID("20000000-0000-4000-8000-000000000001")
PRACTICE_ID = UUID("30000000-0000-4000-8000-000000000001")
FINDING_ID = UUID("40000000-0000-4000-8000-000000000001")
STARTED_AT = datetime(2026, 9, 4, 18, 0, tzinfo=UTC)
ENDED_AT = STARTED_AT + timedelta(hours=2)


def _artifacts() -> BetaArtifactSetV1:
    return BetaArtifactSetV1(
        schema_version="1.0",
        candidate_id="synthetic-beta-candidate-001",
        scribe_git_sha="1" * 40,
        core_git_sha="2" * 40,
        scribe_image_digest=f"sha256:{'3' * 64}",
        core_image_digest=f"sha256:{'4' * 64}",
        database_migration_head="synthetic_head_001",
        bootstrap_policy_version="synthetic_policy_001",
        environment_id="synthetic_beta_environment",
        environment_config_sha256="5" * 64,
        synthetic_tenant_id=TENANT_ID,
        synthetic_practice_id=PRACTICE_ID,
        desktop=DesktopBetaArtifactV1(
            package_version="0.1.0-beta.1",
            package_sha256="6" * 64,
            signing_identity_sha256="7" * 64,
            notarization_status="accepted",
            macos_test_version="15.6.1",
        ),
        ios=IOSBetaArtifactV1(
            bundle_identifier="health.cosmas.scribe.beta",
            marketing_version="0.1.0",
            build_version="1",
            archive_sha256="8" * 64,
            signing_team_id="ABCDE12345",
            testflight_build_id="synthetic-testflight-001",
            distribution_status="ready_to_test",
            ios_test_version="18.6.2",
        ),
        translation=TranslationBetaArtifactV1(
            adapter_id="synthetic_es_en_adapter",
            model_profile_id="synthetic_es_en_profile_v1",
            completed_job_schema_version="1.0",
            completed_command_fingerprint="9" * 64,
        ),
    )


def _passed_results(
    artifacts: BetaArtifactSetV1,
) -> tuple[BetaScenarioEvidenceV1, ...]:
    return tuple(
        build_beta_scenario_evidence(
            artifacts=artifacts,
            scenario_id=scenario_id,
            started_at=STARTED_AT,
            ended_at=ENDED_AT - timedelta(minutes=1),
            outcome=BetaScenarioOutcome.PASSED,
            failure_code=None,
            evidence_file_sha256=f"{index:064x}",
        )
        for index, scenario_id in enumerate(BetaScenarioId, start=1)
    )


def _run(
    *,
    artifacts: BetaArtifactSetV1 | None = None,
    scenario_results: tuple[BetaScenarioEvidenceV1, ...] | None = None,
    findings: tuple[BetaFindingV1, ...] = (),
    ended_at: datetime | None = ENDED_AT,
    founder_decision: FounderAcceptanceDecision = FounderAcceptanceDecision.PENDING,
    founder_decided_at: datetime | None = None,
) -> BetaAcceptanceRunV1:
    current_artifacts = artifacts or _artifacts()
    return BetaAcceptanceRunV1(
        schema_version="1.0",
        run_id=RUN_ID,
        artifacts=current_artifacts,
        started_at=STARTED_AT,
        ended_at=ended_at,
        scenario_results=(
            _passed_results(current_artifacts)
            if scenario_results is None
            else scenario_results
        ),
        findings=findings,
        founder_decision=founder_decision,
        founder_decided_at=founder_decided_at,
    )


def test_exact_artifact_set_round_trips_and_has_stable_fingerprints() -> None:
    artifacts = _artifacts()
    replay = BetaArtifactSetV1.model_validate_json(artifacts.model_dump_json())

    assert replay == artifacts
    assert replay.fingerprint() == artifacts.fingerprint()
    assert len(artifacts.fingerprint()) == 64
    assert len(
        {
            artifacts.component_fingerprint(component)
            for component in BetaArtifactComponent
        }
    ) == len(BetaArtifactComponent)
    assert str(TENANT_ID) not in repr(artifacts)
    assert str(PRACTICE_ID) not in str(artifacts)


def test_scenario_builder_pins_required_surfaces_and_components() -> None:
    artifacts = _artifacts()

    for scenario_id in BetaScenarioId:
        result = build_beta_scenario_evidence(
            artifacts=artifacts,
            scenario_id=scenario_id,
            started_at=STARTED_AT,
            ended_at=STARTED_AT + timedelta(minutes=1),
            outcome=BetaScenarioOutcome.PASSED,
            failure_code=None,
            evidence_file_sha256="a" * 64,
        )
        assert result.surfaces == required_surfaces_for_scenario(scenario_id)
        assert tuple(binding.component for binding in result.artifact_bindings) == (
            required_components_for_scenario(scenario_id)
        )
        assert all(
            binding.fingerprint == artifacts.component_fingerprint(binding.component)
            for binding in result.artifact_bindings
        )
        assert result.synthetic_only_confirmed is True
        assert result.phi_present is False

    meet_surfaces = required_surfaces_for_scenario(BetaScenarioId.GOOGLE_MEET_CHROME)
    assert set(meet_surfaces) == {
        BetaClientSurface.BACKEND,
        BetaClientSurface.DESKTOP,
    }
    assert BetaClientSurface.IOS not in meet_surfaces


def test_complete_passing_run_requires_separate_founder_acceptance() -> None:
    pending = _run()

    assert pending.technically_ready() is True
    assert pending.technical_blockers() == ()
    assert pending.activation_authorized() is False

    accepted = _run(
        founder_decision=FounderAcceptanceDecision.ACCEPTED,
        founder_decided_at=ENDED_AT + timedelta(minutes=1),
    )

    assert accepted.technically_ready() is True
    assert accepted.activation_authorized() is True
    assert len(accepted.fingerprint()) == 64


def test_missing_failed_and_open_control_findings_block_acceptance() -> None:
    artifacts = _artifacts()
    incomplete = _run(
        artifacts=artifacts,
        scenario_results=_passed_results(artifacts)[:-1],
        ended_at=None,
    )
    assert set(incomplete.technical_blockers()) == {
        BetaTechnicalBlocker.RUN_NOT_COMPLETE,
        BetaTechnicalBlocker.SCENARIO_MISSING,
    }

    failed_result = build_beta_scenario_evidence(
        artifacts=artifacts,
        scenario_id=BetaScenarioId.RETENTION_DELETION,
        started_at=STARTED_AT,
        ended_at=ENDED_AT - timedelta(minutes=1),
        outcome=BetaScenarioOutcome.FAILED,
        failure_code="synthetic_retention_check_failed",
        evidence_file_sha256="b" * 64,
    )
    failed_results = tuple(
        result
        for result in _passed_results(artifacts)
        if result.scenario_id != failed_result.scenario_id
    ) + (failed_result,)
    assert BetaTechnicalBlocker.SCENARIO_NOT_PASSING in _run(
        artifacts=artifacts,
        scenario_results=failed_results,
    ).technical_blockers()

    open_auth_finding = BetaFindingV1(
        schema_version="1.0",
        finding_id=FINDING_ID,
        finding_code="synthetic_session_continuity",
        scenario_id=BetaScenarioId.EXISTING_MCD_IDENTITY,
        category=BetaFindingCategory.AUTH,
        severity=BetaFindingSeverity.SEV3,
        status=BetaFindingStatus.OPEN,
        detected_at=STARTED_AT,
    )
    blocked = _run(findings=(open_auth_finding,))
    assert blocked.technical_blockers() == (
        BetaTechnicalBlocker.OPEN_CRITICAL_CONTROL_FINDING,
    )
    with pytest.raises(ValidationError, match="cannot accept incomplete beta evidence"):
        _run(
            findings=(open_auth_finding,),
            founder_decision=FounderAcceptanceDecision.ACCEPTED,
            founder_decided_at=ENDED_AT + timedelta(minutes=1),
        )


def test_changed_component_invalidates_only_dependent_scenario_evidence() -> None:
    original = _artifacts()
    existing_identity = build_beta_scenario_evidence(
        artifacts=original,
        scenario_id=BetaScenarioId.EXISTING_MCD_IDENTITY,
        started_at=STARTED_AT,
        ended_at=STARTED_AT + timedelta(minutes=1),
        outcome=BetaScenarioOutcome.PASSED,
        failure_code=None,
        evidence_file_sha256="c" * 64,
    )
    bilingual = build_beta_scenario_evidence(
        artifacts=original,
        scenario_id=BetaScenarioId.BILINGUAL_FLOW,
        started_at=STARTED_AT,
        ended_at=STARTED_AT + timedelta(minutes=1),
        outcome=BetaScenarioOutcome.PASSED,
        failure_code=None,
        evidence_file_sha256="d" * 64,
    )
    changed = original.model_copy(
        update={
            "translation": original.translation.model_copy(
                update={"model_profile_id": "synthetic_es_en_profile_v2"}
            )
        }
    )

    unaffected = _run(
        artifacts=changed,
        scenario_results=(existing_identity,),
    )
    assert unaffected.scenario_results == (existing_identity,)
    assert unaffected.missing_scenarios()

    with pytest.raises(ValidationError, match="artifact binding is stale"):
        _run(artifacts=changed, scenario_results=(bilingual,))


def test_evidence_contract_rejects_phi_shaped_extras_and_hides_values() -> None:
    artifacts = _artifacts()
    result = build_beta_scenario_evidence(
        artifacts=artifacts,
        scenario_id=BetaScenarioId.BILINGUAL_FLOW,
        started_at=STARTED_AT,
        ended_at=STARTED_AT + timedelta(minutes=1),
        outcome=BetaScenarioOutcome.PASSED,
        failure_code=None,
        evidence_file_sha256="e" * 64,
    )
    payload = result.model_dump(mode="json")
    protected_marker = "Synthetic Patient Name 1900-01-01"

    with pytest.raises(ValidationError) as caught:
        BetaScenarioEvidenceV1.model_validate_json(
            json.dumps({**payload, "patient_name": protected_marker})
        )

    assert protected_marker not in str(caught.value)
    assert protected_marker not in repr(caught.value)

    with pytest.raises(ValidationError):
        BetaScenarioEvidenceV1.model_validate_json(
            json.dumps(
                {
                    **payload,
                    "synthetic_only_confirmed": False,
                    "phi_present": True,
                }
            )
        )
