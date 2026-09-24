from __future__ import annotations

import json
from typing import cast
from uuid import UUID

import pytest
from cosmaneura_scribe.external_transcript_v1 import TranslationOutcome
from cosmaneura_scribe.translation_attempt_persistence import TranslationAttemptCommand
from cosmaneura_scribe.translation_job_v1 import CompletedTranslationJobV1
from pydantic import ValidationError

TENANT_ID = UUID("10000000-0000-4000-8000-000000000001")
SESSION_ID = UUID("20000000-0000-4000-8000-000000000001")
TRANSLATION_ID = UUID("30000000-0000-4000-8000-000000000001")
SEGMENT_ID = UUID("40000000-0000-4000-8000-000000000001")
SYNTHETIC_TRANSLATION = "Synthetic protected English translation."


def _command(
    *,
    outcome: TranslationOutcome = TranslationOutcome.SUCCEEDED,
) -> TranslationAttemptCommand:
    return TranslationAttemptCommand(
        translation_id=TRANSLATION_ID,
        expected_source_transcript_version=2,
        source_segment_id=SEGMENT_ID,
        expected_source_segment_version=3,
        expected_previous_translation_version=1,
        outcome=outcome,
        translation_adapter_id="synthetic_es_en_adapter",
        translation_model_profile_id="synthetic_es_en_profile_v1",
        content=SYNTHETIC_TRANSLATION if outcome == TranslationOutcome.SUCCEEDED else None,
        failure_code=None if outcome == TranslationOutcome.SUCCEEDED else "provider_timeout",
    )


@pytest.mark.parametrize(
    "outcome",
    [TranslationOutcome.SUCCEEDED, TranslationOutcome.FAILED],
)
def test_completed_job_round_trips_exact_command_through_json(
    outcome: TranslationOutcome,
) -> None:
    command = _command(outcome=outcome)
    completed = CompletedTranslationJobV1.from_command(
        tenant_id=TENANT_ID,
        session_id=SESSION_ID,
        command=command,
    )

    replay = CompletedTranslationJobV1.model_validate_json(completed.model_dump_json())

    assert replay == completed
    assert replay.to_command() == command
    assert replay.tenant_id == TENANT_ID
    assert replay.session_id == SESSION_ID
    assert replay.source_locale == "es-US"
    assert replay.target_locale == "en-US"
    if outcome == TranslationOutcome.SUCCEEDED:
        assert replay.fingerprint() == (
            "9f071962b44a8fc3fefbb9f95581b2ad4e42e2be9f55bea35cea3e31cb6e96bd"
        )
    else:
        assert len(replay.fingerprint()) == 64


def test_completed_job_fingerprint_binds_scope_lineage_and_result() -> None:
    completed = CompletedTranslationJobV1.from_command(
        tenant_id=TENANT_ID,
        session_id=SESSION_ID,
        command=_command(),
    )
    original = completed.fingerprint()

    changed_values = (
        {"tenant_id": UUID(int=TENANT_ID.int + 1)},
        {"session_id": UUID(int=SESSION_ID.int + 1)},
        {"translation_id": UUID(int=TRANSLATION_ID.int + 1)},
        {"expected_source_transcript_version": 3},
        {"source_segment_id": UUID(int=SEGMENT_ID.int + 1)},
        {"expected_source_segment_version": 4},
        {"expected_previous_translation_version": 2},
        {"translation_adapter_id": "different_adapter"},
        {"translation_model_profile_id": "different_profile"},
        {"content": "Different synthetic English translation."},
    )
    for update in changed_values:
        assert completed.model_copy(update=update).fingerprint() != original


def test_completed_job_rejects_wrong_direction_extra_fields_and_invalid_outcomes() -> None:
    completed = CompletedTranslationJobV1.from_command(
        tenant_id=TENANT_ID,
        session_id=SESSION_ID,
        command=_command(),
    )
    payload = completed.model_dump(mode="json")

    invalid_payloads = (
        {key: value for key, value in payload.items() if key != "schema_version"},
        {key: value for key, value in payload.items() if key != "source_locale"},
        {key: value for key, value in payload.items() if key != "target_locale"},
        {**payload, "source_locale": "en-US"},
        {**payload, "target_locale": "es-US"},
        {**payload, "unexpected": "field"},
        {**payload, "outcome": "succeeded", "content": None},
        {**payload, "outcome": "failed", "failure_code": None},
    )
    for invalid in invalid_payloads:
        with pytest.raises(ValidationError):
            CompletedTranslationJobV1.model_validate_json(json.dumps(invalid))

    with pytest.raises(ValidationError):
        CompletedTranslationJobV1.model_validate_json(
            json.dumps({**payload, "outcome": cast(TranslationOutcome, "unknown")})
        )


def test_completed_job_repr_and_validation_errors_hide_protected_content() -> None:
    completed = CompletedTranslationJobV1.from_command(
        tenant_id=TENANT_ID,
        session_id=SESSION_ID,
        command=_command(),
    )

    assert SYNTHETIC_TRANSLATION not in repr(completed)
    assert str(TENANT_ID) not in repr(completed)
    with pytest.raises(ValidationError) as caught:
        CompletedTranslationJobV1.model_validate(
            {
                **completed.model_dump(mode="python"),
                "content": f"  {SYNTHETIC_TRANSLATION}  ",
                "failure_code": "provider_timeout",
            }
        )
    assert SYNTHETIC_TRANSLATION not in str(caught.value)
    assert SYNTHETIC_TRANSLATION not in repr(caught.value)
