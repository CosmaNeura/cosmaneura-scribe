from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.creator_review_contract_v1 import (
    CreatorReviewQueueStatus,
    CreatorTranslationDecisionRequestV1,
    build_creator_translation_review_queue,
)
from cosmaneura_scribe.external_transcript_v1 import (
    ExternalTranscriptBundleV1,
    SourceLocale,
    TranslationOutcome,
    TranslationRecordV1,
    TranslationReviewDecision,
    TranslationReviewEvidenceV1,
)
from pydantic import ValidationError
from test_external_transcript_v1 import (
    UNKNOWN_SEGMENT_ID,
    WORKING_TRANSCRIPT_ID,
    _bilingual_source,
    _review,
    _segment,
    _source,
    _translation,
)

SESSION_ID = UUID("50000000-0000-4000-8000-000000000001")
SOURCE_MARKER = "Me siento mejor hoy."
TRANSLATION_MARKER = "I feel better today."


def _bundle(
    *,
    translations: tuple[TranslationRecordV1, ...] = (),
    reviews: tuple[TranslationReviewEvidenceV1, ...] = (),
) -> ExternalTranscriptBundleV1:
    return ExternalTranscriptBundleV1(
        source_transcript=_bilingual_source(),
        translations=translations,
        translation_reviews=reviews,
        working_transcript_id=WORKING_TRANSCRIPT_ID,
        working_transcript_version=1,
    )


@pytest.mark.parametrize(
    ("bundle", "expected_status"),
    [
        (_bundle(), CreatorReviewQueueStatus.NOT_READY),
        (
            _bundle(
                translations=(
                    _translation(
                        outcome=TranslationOutcome.FAILED,
                        content=None,
                        failure_code="provider_timeout",
                    ),
                )
            ),
            CreatorReviewQueueStatus.NOT_READY,
        ),
        (
            _bundle(translations=(_translation(),), reviews=(_review(),)),
            CreatorReviewQueueStatus.COMPLETE,
        ),
        (
            _bundle(
                translations=(_translation(),),
                reviews=(
                    _review(decision=TranslationReviewDecision.REJECTED),
                ),
            ),
            CreatorReviewQueueStatus.NOT_READY,
        ),
    ],
)
def test_non_actionable_review_states_have_no_items(
    bundle: ExternalTranscriptBundleV1,
    expected_status: CreatorReviewQueueStatus,
) -> None:
    queue = build_creator_translation_review_queue(session_id=SESSION_ID, bundle=bundle)

    assert queue.status == expected_status
    assert queue.items == ()


def test_quality_blocked_source_has_no_review_items() -> None:
    source = _source(
        _segment(
            UNKNOWN_SEGMENT_ID,
            locale=SourceLocale.UNKNOWN,
            content="Synthetic locale requiring correction.",
            start_ms=0,
            end_ms=500,
        )
    )
    queue = build_creator_translation_review_queue(
        session_id=SESSION_ID,
        bundle=ExternalTranscriptBundleV1(
            source_transcript=source,
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        ),
    )

    assert queue.status == CreatorReviewQueueStatus.QUALITY_BLOCKED
    assert queue.items == ()


def test_successful_unreviewed_translation_builds_protected_review_item() -> None:
    translation = _translation()
    queue = build_creator_translation_review_queue(
        session_id=SESSION_ID,
        bundle=_bundle(translations=(translation,)),
    )

    assert queue.status == CreatorReviewQueueStatus.REVIEW_REQUIRED
    assert len(queue.items) == 1
    item = queue.items[0]
    assert item.source_content == SOURCE_MARKER
    assert item.translated_content == TRANSLATION_MARKER
    assert item.translation_id == translation.translation_id
    assert item.source_locale == "es-US"
    assert item.target_locale == "en-US"
    assert SOURCE_MARKER not in repr(item)
    assert TRANSLATION_MARKER not in repr(item)
    assert SOURCE_MARKER not in str(item)
    assert TRANSLATION_MARKER not in str(item)
    assert str(SESSION_ID) not in repr(queue)
    assert str(SESSION_ID) not in str(queue)


def test_creator_decision_wire_shape_excludes_authority_fields() -> None:
    translation = _translation()
    item = build_creator_translation_review_queue(
        session_id=SESSION_ID,
        bundle=_bundle(translations=(translation,)),
    ).items[0]
    payload = {
        "schema_version": "1.0",
        "expected_source_transcript_version": 1,
        "source_segment_id": str(item.source_segment_id),
        "expected_source_segment_version": item.source_segment_version,
        "translation_id": str(item.translation_id),
        "expected_translation_version": item.translation_version,
        "decision": "accepted",
    }

    request = CreatorTranslationDecisionRequestV1.model_validate_json(json.dumps(payload))
    command = request.to_authorized_command(
        review_id=uuid4(),
        reviewer_actor_id="synthetic_core_actor",
        reviewed_at=datetime(2026, 9, 4, 17, 0, tzinfo=UTC),
    )

    assert set(request.model_dump(mode="json")) == set(payload)
    assert command.translation_id == item.translation_id
    assert command.decision == TranslationReviewDecision.ACCEPTED
    assert command.reviewer_actor_id == "synthetic_core_actor"
    assert "reviewer_actor_id" not in payload
    assert "review_id" not in payload
    assert "reviewed_at" not in payload

    for authority_field in ("reviewer_actor_id", "review_id", "reviewed_at"):
        with pytest.raises(ValidationError):
            CreatorTranslationDecisionRequestV1.model_validate_json(
                json.dumps({**payload, authority_field: "attacker-controlled"})
            )


def test_review_decision_validation_hides_inputs() -> None:
    marker = "synthetic-attacker-controlled-field"
    translation = _translation()
    item = build_creator_translation_review_queue(
        session_id=SESSION_ID,
        bundle=_bundle(translations=(translation,)),
    ).items[0]
    payload = {
        "schema_version": "1.0",
        "expected_source_transcript_version": 1,
        "source_segment_id": str(item.source_segment_id),
        "expected_source_segment_version": item.source_segment_version,
        "translation_id": str(item.translation_id),
        "expected_translation_version": item.translation_version,
        "decision": marker,
    }

    with pytest.raises(ValidationError) as caught:
        CreatorTranslationDecisionRequestV1.model_validate_json(json.dumps(payload))

    assert marker not in str(caught.value)
    assert marker not in repr(caught.value)
