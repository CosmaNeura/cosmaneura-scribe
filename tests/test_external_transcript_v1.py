from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import pytest
from cosmaneura_scribe.external_transcript_v1 import (
    EnglishWorkingTranscriptV1,
    ExternalTranscriptBundleV1,
    SourceLocale,
    SourceTranscriptSegmentV1,
    SourceTranscriptV1,
    TranscriptLanguageMode,
    TranslationOutcome,
    TranslationRecordV1,
    TranslationReviewDecision,
    TranslationReviewEvidenceV1,
    WorkingSegmentResolution,
    WorkingTranscriptBlockerCode,
    build_english_working_transcript,
    english_working_transcript_fingerprint,
    external_source_transcript_fingerprint,
)
from cosmaneura_scribe.schemas import SpeakerRole
from pydantic import ValidationError

ENGLISH_SEGMENT_ID = UUID("10000000-0000-4000-8000-000000000001")
SPANISH_SEGMENT_ID = UUID("10000000-0000-4000-8000-000000000002")
UNKNOWN_SEGMENT_ID = UUID("10000000-0000-4000-8000-000000000003")
TRANSLATION_ID = UUID("20000000-0000-4000-8000-000000000001")
SECOND_TRANSLATION_ID = UUID("20000000-0000-4000-8000-000000000002")
REVIEW_ID = UUID("30000000-0000-4000-8000-000000000001")
SECOND_REVIEW_ID = UUID("30000000-0000-4000-8000-000000000002")
WORKING_TRANSCRIPT_ID = UUID("40000000-0000-4000-8000-000000000001")
SECOND_WORKING_TRANSCRIPT_ID = UUID("40000000-0000-4000-8000-000000000002")
SENTINEL = "SYNTHETIC_SECRET_TRANSCRIPT_MARKER"


def _segment(
    segment_id: UUID,
    *,
    locale: SourceLocale,
    content: str,
    start_ms: int,
    end_ms: int,
    version: int = 1,
    role: SpeakerRole = SpeakerRole.PATIENT,
    locale_confidence: float | None = 0.95,
) -> SourceTranscriptSegmentV1:
    return SourceTranscriptSegmentV1(
        source_segment_id=segment_id,
        source_segment_version=version,
        source_locale=locale,
        speaker_id=UUID(int=segment_id.int + 100),
        speaker_role=role,
        content=content,
        start_ms=start_ms,
        end_ms=end_ms,
        locale_confidence=locale_confidence,
    )


def _source(
    *segments: SourceTranscriptSegmentV1,
    mode: TranscriptLanguageMode = TranscriptLanguageMode.ENGLISH_SPANISH,
    version: int = 1,
    duration_ms: int | None = None,
) -> SourceTranscriptV1:
    return SourceTranscriptV1(
        source_transcript_version=version,
        language_mode=mode,
        transcription_adapter_id="synthetic_stt_adapter",
        transcription_model_profile_id="synthetic_stt_profile_v1",
        normalization_profile_id="synthetic_locale_normalizer_v1",
        duration_ms=duration_ms or max(segment.end_ms for segment in segments),
        segments=segments,
    )


def _translation(
    *,
    source_segment_id: UUID = SPANISH_SEGMENT_ID,
    source_segment_version: int = 1,
    translation_id: UUID = TRANSLATION_ID,
    translation_version: int = 1,
    outcome: TranslationOutcome = TranslationOutcome.SUCCEEDED,
    content: str | None = "I feel better today.",
    failure_code: str | None = None,
) -> TranslationRecordV1:
    return TranslationRecordV1(
        translation_id=translation_id,
        translation_version=translation_version,
        source_segment_id=source_segment_id,
        source_segment_version=source_segment_version,
        content=content,
        outcome=outcome,
        translation_adapter_id="synthetic_translation_adapter",
        translation_model_profile_id="synthetic_translation_profile_v1",
        created_at=datetime(2026, 9, 1, 18, 0, tzinfo=UTC),
        failure_code=failure_code,
    )


def _review(
    *,
    review_id: UUID = REVIEW_ID,
    translation_id: UUID = TRANSLATION_ID,
    translation_version: int = 1,
    source_segment_id: UUID = SPANISH_SEGMENT_ID,
    source_segment_version: int = 1,
    decision: TranslationReviewDecision = TranslationReviewDecision.ACCEPTED,
    reviewer_actor_id: str = "core_actor.synthetic_creator",
    reviewed_at: datetime | None = None,
) -> TranslationReviewEvidenceV1:
    return TranslationReviewEvidenceV1(
        review_id=review_id,
        translation_id=translation_id,
        translation_version=translation_version,
        source_segment_id=source_segment_id,
        source_segment_version=source_segment_version,
        decision=decision,
        reviewer_actor_id=reviewer_actor_id,
        reviewed_at=reviewed_at or datetime(2026, 9, 1, 18, 5, tzinfo=UTC),
    )


def _bilingual_source() -> SourceTranscriptV1:
    return _source(
        _segment(
            ENGLISH_SEGMENT_ID,
            locale=SourceLocale.ENGLISH_US,
            content="How are you feeling today?",
            start_ms=0,
            end_ms=1_000,
            role=SpeakerRole.CLINICIAN,
        ),
        _segment(
            SPANISH_SEGMENT_ID,
            locale=SourceLocale.SPANISH_US,
            content="Me siento mejor hoy.",
            start_ms=1_100,
            end_ms=2_000,
            role=SpeakerRole.PATIENT,
        ),
    )


def test_accepted_bilingual_translation_builds_one_ready_english_transcript() -> None:
    source = _bilingual_source()
    translation = _translation()
    working = build_english_working_transcript(
        ExternalTranscriptBundleV1(
            source_transcript=source,
            translations=(translation,),
            translation_reviews=(_review(),),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=3,
        )
    )

    assert working.note_ready is True
    assert working.working_transcript_id == WORKING_TRANSCRIPT_ID
    assert working.working_transcript_version == 3
    assert working.source_transcript_version == 1
    assert working.blockers == ()
    assert [segment.content for segment in working.segments] == [
        "How are you feeling today?",
        "I feel better today.",
    ]
    assert [segment.resolution for segment in working.segments] == [
        WorkingSegmentResolution.ENGLISH_SOURCE,
        WorkingSegmentResolution.SPANISH_TRANSLATION,
    ]
    assert working.segments[0].translation_id is None
    assert working.segments[1].translation_id == translation.translation_id
    assert working.segments[1].translation_review_id == REVIEW_ID
    assert working.segments[1].speaker_id == source.segments[1].speaker_id
    assert source.segments[1].content == "Me siento mejor hoy."
    assert working.model_dump(mode="json")["note_ready"] is True


def test_locale_is_not_inferred_from_speaker_role_or_confidence() -> None:
    source = _source(
        _segment(
            ENGLISH_SEGMENT_ID,
            locale=SourceLocale.SPANISH_US,
            content="Necesito revisar el resultado.",
            start_ms=0,
            end_ms=900,
            role=SpeakerRole.CLINICIAN,
            locale_confidence=None,
        ),
        _segment(
            UNKNOWN_SEGMENT_ID,
            locale=SourceLocale.UNKNOWN,
            content="Synthetic uncertain phrase.",
            start_ms=1_000,
            end_ms=1_500,
            role=SpeakerRole.PATIENT,
            locale_confidence=1.0,
        ),
    )

    assert source.segments[0].source_locale == SourceLocale.SPANISH_US
    assert source.segments[0].locale_confidence is None
    assert source.segments[1].source_locale == SourceLocale.UNKNOWN
    assert source.segments[1].locale_confidence == 1.0
    working = build_english_working_transcript(
        ExternalTranscriptBundleV1(
            source_transcript=source,
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )
    )
    assert WorkingTranscriptBlockerCode.SOURCE_LOCALE_UNKNOWN in {
        blocker.code for blocker in working.blockers
    }


def test_english_mode_allows_unknown_but_rejects_spanish_source() -> None:
    unknown = _source(
        _segment(
            UNKNOWN_SEGMENT_ID,
            locale=SourceLocale.UNKNOWN,
            content="Synthetic uncertain phrase.",
            start_ms=0,
            end_ms=500,
        ),
        mode=TranscriptLanguageMode.ENGLISH,
    )
    assert unknown.segments[0].source_locale == SourceLocale.UNKNOWN

    with pytest.raises(ValidationError, match="spanish_source_requires_bilingual_mode"):
        _source(
            _segment(
                SPANISH_SEGMENT_ID,
                locale=SourceLocale.SPANISH_US,
                content="Contenido sintetico.",
                start_ms=0,
                end_ms=500,
            ),
            mode=TranscriptLanguageMode.ENGLISH,
        )


@pytest.mark.parametrize(
    ("translations", "reviews", "expected_code"),
    [
        ((), (), WorkingTranscriptBlockerCode.TRANSLATION_MISSING),
        (
            (_translation(),),
            (),
            WorkingTranscriptBlockerCode.TRANSLATION_REVIEW_REQUIRED,
        ),
        (
            (_translation(),),
            (_review(decision=TranslationReviewDecision.REJECTED),),
            WorkingTranscriptBlockerCode.TRANSLATION_REVIEW_REQUIRED,
        ),
        (
            (
                _translation(
                    outcome=TranslationOutcome.FAILED,
                    content=None,
                    failure_code="translation_adapter_unavailable",
                ),
            ),
            (),
            WorkingTranscriptBlockerCode.TRANSLATION_FAILED,
        ),
    ],
)
def test_spanish_translation_failure_states_block_note_readiness(
    translations: tuple[TranslationRecordV1, ...],
    reviews: tuple[TranslationReviewEvidenceV1, ...],
    expected_code: WorkingTranscriptBlockerCode,
) -> None:
    working = build_english_working_transcript(
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=translations,
            translation_reviews=reviews,
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )
    )

    assert working.note_ready is False
    assert working.segments[1].resolution == WorkingSegmentResolution.UNRESOLVED
    assert working.segments[1].content is None
    assert working.blockers[-1].source_segment_id == SPANISH_SEGMENT_ID
    assert working.blockers[-1].code == expected_code


def test_successful_unreviewed_retry_takes_precedence_over_failed_attempt() -> None:
    failed = _translation(
        outcome=TranslationOutcome.FAILED,
        content=None,
        failure_code="translation_adapter_unavailable",
    )
    succeeded = _translation(
        translation_id=SECOND_TRANSLATION_ID,
        translation_version=2,
        content="I am doing better.",
    )
    working = build_english_working_transcript(
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(failed, succeeded),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )
    )

    assert working.blockers[-1].code == (WorkingTranscriptBlockerCode.TRANSLATION_REVIEW_REQUIRED)


def test_unknown_locale_and_overlap_are_deterministic_review_blockers() -> None:
    source = _source(
        _segment(
            ENGLISH_SEGMENT_ID,
            locale=SourceLocale.ENGLISH_US,
            content="Synthetic English phrase.",
            start_ms=0,
            end_ms=1_000,
        ),
        _segment(
            UNKNOWN_SEGMENT_ID,
            locale=SourceLocale.UNKNOWN,
            content="Synthetic uncertain phrase.",
            start_ms=900,
            end_ms=1_500,
        ),
    )
    working = build_english_working_transcript(
        ExternalTranscriptBundleV1(
            source_transcript=source,
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )
    )

    assert working.note_ready is False
    assert [blocker.code for blocker in working.blockers] == [
        WorkingTranscriptBlockerCode.SOURCE_OVERLAP,
        WorkingTranscriptBlockerCode.SOURCE_LOCALE_UNKNOWN,
    ]


def test_overlap_detection_uses_the_latest_prior_end_time() -> None:
    source = _source(
        _segment(
            ENGLISH_SEGMENT_ID,
            locale=SourceLocale.ENGLISH_US,
            content="Long synthetic phrase.",
            start_ms=0,
            end_ms=1_000,
        ),
        _segment(
            SPANISH_SEGMENT_ID,
            locale=SourceLocale.ENGLISH_US,
            content="Nested synthetic phrase.",
            start_ms=100,
            end_ms=200,
        ),
        _segment(
            UNKNOWN_SEGMENT_ID,
            locale=SourceLocale.ENGLISH_US,
            content="Later nested synthetic phrase.",
            start_ms=300,
            end_ms=400,
        ),
    )
    working = build_english_working_transcript(
        ExternalTranscriptBundleV1(
            source_transcript=source,
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )
    )

    assert [blocker.source_segment_id for blocker in working.blockers] == [
        SPANISH_SEGMENT_ID,
        UNKNOWN_SEGMENT_ID,
    ]


@pytest.mark.parametrize(
    ("translation", "error_code"),
    [
        (
            _translation(source_segment_id=UUID(int=999)),
            "translation_source_segment_unknown",
        ),
        (
            _translation(source_segment_version=2),
            "translation_source_version_stale",
        ),
        (
            _translation(source_segment_id=ENGLISH_SEGMENT_ID),
            "translation_source_locale_invalid",
        ),
    ],
)
def test_dangling_stale_and_non_spanish_translation_references_are_rejected(
    translation: TranslationRecordV1,
    error_code: str,
) -> None:
    with pytest.raises(ValidationError, match=error_code):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(translation,),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )


def test_multiple_translation_attempts_are_allowed_and_one_accepted_attempt_is_used() -> None:
    first = _translation(content="First synthetic translation.")
    second = _translation(
        translation_id=SECOND_TRANSLATION_ID,
        translation_version=2,
        content="Second synthetic translation.",
    )
    bundle = ExternalTranscriptBundleV1(
        source_transcript=_bilingual_source(),
        translations=(second, first),
        translation_reviews=(
            _review(decision=TranslationReviewDecision.REJECTED),
            _review(
                review_id=SECOND_REVIEW_ID,
                translation_id=SECOND_TRANSLATION_ID,
                translation_version=2,
                decision=TranslationReviewDecision.ACCEPTED,
            ),
        ),
        working_transcript_id=WORKING_TRANSCRIPT_ID,
        working_transcript_version=1,
    )

    working = build_english_working_transcript(bundle)
    assert [translation.translation_version for translation in bundle.translations] == [1, 2]
    assert working.note_ready is True
    assert working.segments[1].content == "Second synthetic translation."


def test_duplicate_translation_versions_ids_and_review_ids_are_rejected() -> None:
    duplicate_version = _translation(
        translation_id=SECOND_TRANSLATION_ID,
        content="Another synthetic translation.",
    )
    with pytest.raises(ValidationError, match="translation_version_duplicate"):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(_translation(), duplicate_version),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )

    duplicate_id = _translation(
        translation_version=2,
        content="Another synthetic translation.",
    )
    with pytest.raises(ValidationError, match="translation_id_duplicate"):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(_translation(), duplicate_id),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )

    with pytest.raises(ValidationError, match="translation_review_id_duplicate"):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(_translation(),),
            translation_reviews=(
                _review(decision=TranslationReviewDecision.REJECTED),
                _review(decision=TranslationReviewDecision.REJECTED),
            ),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )


def test_competing_accepted_translation_reviews_are_rejected() -> None:
    second = _translation(
        translation_id=SECOND_TRANSLATION_ID,
        translation_version=2,
        content="Second synthetic translation.",
    )
    with pytest.raises(ValidationError, match="competing_accepted_translation_reviews"):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(_translation(), second),
            translation_reviews=(
                _review(),
                _review(
                    review_id=SECOND_REVIEW_ID,
                    translation_id=SECOND_TRANSLATION_ID,
                    translation_version=2,
                ),
            ),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )


@pytest.mark.parametrize(
    ("second_decision", "error_code"),
    [
        (TranslationReviewDecision.REJECTED, "translation_review_duplicate"),
        (TranslationReviewDecision.ACCEPTED, "translation_review_decision_conflict"),
    ],
)
def test_one_terminal_review_is_allowed_per_translation_version(
    second_decision: TranslationReviewDecision,
    error_code: str,
) -> None:
    with pytest.raises(ValidationError, match=error_code):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(_translation(),),
            translation_reviews=(
                _review(decision=TranslationReviewDecision.REJECTED),
                _review(
                    review_id=SECOND_REVIEW_ID,
                    decision=second_decision,
                ),
            ),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )


@pytest.mark.parametrize(
    ("review", "error_code"),
    [
        (
            _review(translation_id=UUID(int=999)),
            "translation_review_reference_unknown",
        ),
        (
            _review(translation_version=2),
            "translation_review_reference_unknown",
        ),
        (
            _review(source_segment_version=2),
            "translation_review_source_mismatch",
        ),
        (
            _review(source_segment_id=ENGLISH_SEGMENT_ID),
            "translation_review_source_mismatch",
        ),
    ],
)
def test_dangling_stale_and_mismatched_review_references_are_rejected(
    review: TranslationReviewEvidenceV1,
    error_code: str,
) -> None:
    with pytest.raises(ValidationError, match=error_code):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(_translation(),),
            translation_reviews=(review,),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )


def test_failed_translation_cannot_have_review_evidence() -> None:
    failed = _translation(
        outcome=TranslationOutcome.FAILED,
        content=None,
        failure_code="translation_adapter_unavailable",
    )
    with pytest.raises(ValidationError, match="failed_translation_cannot_be_reviewed"):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(failed,),
            translation_reviews=(_review(),),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )


def test_review_cannot_predate_translation() -> None:
    with pytest.raises(ValidationError, match="translation_review_precedes_translation"):
        ExternalTranscriptBundleV1(
            source_transcript=_bilingual_source(),
            translations=(_translation(),),
            translation_reviews=(_review(reviewed_at=datetime(2026, 9, 1, 17, 59, tzinfo=UTC)),),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )


def test_translation_outcome_requires_exact_content_or_failure_evidence() -> None:
    failed = _translation(
        outcome=TranslationOutcome.FAILED,
        content=None,
        failure_code="translation_adapter_unavailable",
    )
    assert failed.content is None
    assert failed.failure_code == "translation_adapter_unavailable"

    with pytest.raises(ValidationError, match="failed_translation_evidence_invalid"):
        _translation(
            outcome=TranslationOutcome.FAILED,
            content="Invented fallback text.",
            failure_code="translation_adapter_unavailable",
        )
    with pytest.raises(ValidationError, match="translation_evidence_invalid"):
        _translation(outcome=TranslationOutcome.SUCCEEDED, content=None)
    with pytest.raises(ValidationError, match="translation_evidence_invalid"):
        _translation(
            outcome=TranslationOutcome.SUCCEEDED,
            failure_code="unexpected_failure",
        )


@pytest.mark.parametrize("unsupported_outcome", ["pending", "reviewed", "superseded"])
def test_translation_outcome_is_closed(unsupported_outcome: str) -> None:
    payload = _translation().model_dump()
    payload["outcome"] = unsupported_outcome
    with pytest.raises(ValidationError):
        TranslationRecordV1.model_validate(payload)


@pytest.mark.parametrize("unsupported_decision", ["pending", "reviewed", "superseded"])
def test_translation_review_decision_is_closed(unsupported_decision: str) -> None:
    payload = _review().model_dump()
    payload["decision"] = unsupported_decision
    with pytest.raises(ValidationError):
        TranslationReviewEvidenceV1.model_validate(payload)


def test_review_evidence_requires_opaque_actor_and_offset_time() -> None:
    review = _review(reviewer_actor_id="core_actor.subject_42")
    assert review.reviewer_actor_id == "core_actor.subject_42"

    with pytest.raises(ValidationError):
        _review(reviewer_actor_id="https://identity.invalid/actor")
    with pytest.raises(ValidationError, match="translation_reviewed_at_offset_required"):
        _review(reviewed_at=datetime(2026, 9, 1, 18, 5))


def test_source_locale_confidence_is_optional_and_bounded_without_a_domain_threshold() -> None:
    no_confidence = _segment(
        ENGLISH_SEGMENT_ID,
        locale=SourceLocale.ENGLISH_US,
        content="Synthetic English phrase.",
        start_ms=0,
        end_ms=500,
        locale_confidence=None,
    )
    low_confidence = _segment(
        SPANISH_SEGMENT_ID,
        locale=SourceLocale.SPANISH_US,
        content="Contenido sintetico.",
        start_ms=600,
        end_ms=1_000,
        locale_confidence=0.01,
    )
    assert _source(no_confidence, low_confidence).normalization_profile_id == (
        "synthetic_locale_normalizer_v1"
    )

    payload = no_confidence.model_dump()
    payload["locale_confidence"] = 1.01
    with pytest.raises(ValidationError):
        SourceTranscriptSegmentV1.model_validate(payload)
    payload["locale_confidence"] = -0.01
    with pytest.raises(ValidationError):
        SourceTranscriptSegmentV1.model_validate(payload)


def test_contracts_reject_caller_authority_and_raw_provider_fields() -> None:
    source_payload = _bilingual_source().model_dump()
    source_payload["tenant_id"] = "30000000-0000-4000-8000-000000000001"
    source_payload["note_ready"] = True
    with pytest.raises(ValidationError):
        SourceTranscriptV1.model_validate(source_payload)

    segment_payload = _bilingual_source().segments[0].model_dump()
    segment_payload["source_locale"] = "es-MX"
    segment_payload["provider_speaker_name"] = "Synthetic Person"
    with pytest.raises(ValidationError):
        SourceTranscriptSegmentV1.model_validate(segment_payload)

    translation_payload = _translation().model_dump()
    translation_payload["target_locale"] = "es-US"
    translation_payload["provider_resource_id"] = "provider-private-resource"
    with pytest.raises(ValidationError):
        TranslationRecordV1.model_validate(translation_payload)

    raw_provider_payload = _bilingual_source().model_dump()
    raw_provider_payload["transcription_provider"] = "vendor-name"
    with pytest.raises(ValidationError):
        SourceTranscriptV1.model_validate(raw_provider_payload)

    with pytest.raises(ValidationError):
        SourceTranscriptV1(
            source_transcript_version=1,
            language_mode=TranscriptLanguageMode.ENGLISH,
            transcription_adapter_id="https://provider.invalid/resource",
            transcription_model_profile_id="synthetic_stt_profile_v1",
            normalization_profile_id="synthetic_locale_normalizer_v1",
            duration_ms=500,
            segments=(
                _segment(
                    ENGLISH_SEGMENT_ID,
                    locale=SourceLocale.ENGLISH_US,
                    content="Synthetic English phrase.",
                    start_ms=0,
                    end_ms=500,
                ),
            ),
        )


def test_models_are_strict_frozen_and_hide_text() -> None:
    segment = _segment(
        ENGLISH_SEGMENT_ID,
        locale=SourceLocale.ENGLISH_US,
        content=SENTINEL,
        start_ms=0,
        end_ms=500,
    )
    source = _source(segment, mode=TranscriptLanguageMode.ENGLISH)
    bundle = ExternalTranscriptBundleV1(
        source_transcript=source,
        working_transcript_id=WORKING_TRANSCRIPT_ID,
        working_transcript_version=1,
    )
    working = build_english_working_transcript(bundle)
    translation = _translation(content=SENTINEL)

    assert SENTINEL not in repr(segment)
    assert SENTINEL not in repr(source)
    assert SENTINEL not in repr(bundle)
    assert SENTINEL not in repr(working)
    assert SENTINEL not in repr(translation)

    invalid = segment.model_dump()
    invalid["unexpected"] = SENTINEL
    with pytest.raises(ValidationError) as captured:
        SourceTranscriptSegmentV1.model_validate(invalid)
    assert SENTINEL not in str(captured.value)

    strict_payload = segment.model_dump()
    strict_payload["start_ms"] = "0"
    with pytest.raises(ValidationError):
        SourceTranscriptSegmentV1.model_validate(strict_payload)
    with pytest.raises(ValidationError, match="frozen_instance"):
        segment.content = "Mutation is forbidden."


def test_note_readiness_is_computed_and_rejected_as_input() -> None:
    working = build_english_working_transcript(
        ExternalTranscriptBundleV1(
            source_transcript=_source(
                _segment(
                    ENGLISH_SEGMENT_ID,
                    locale=SourceLocale.ENGLISH_US,
                    content="Synthetic English phrase.",
                    start_ms=0,
                    end_ms=500,
                ),
                mode=TranscriptLanguageMode.ENGLISH,
            ),
            working_transcript_id=WORKING_TRANSCRIPT_ID,
            working_transcript_version=1,
        )
    )
    serialized = working.model_dump()
    assert serialized["note_ready"] is True

    with pytest.raises(ValidationError, match="extra_forbidden"):
        EnglishWorkingTranscriptV1.model_validate(serialized)


def test_source_validation_is_ordered_bounded_and_immutable() -> None:
    first = _segment(
        ENGLISH_SEGMENT_ID,
        locale=SourceLocale.ENGLISH_US,
        content="First synthetic phrase.",
        start_ms=500,
        end_ms=900,
    )
    second = _segment(
        SPANISH_SEGMENT_ID,
        locale=SourceLocale.ENGLISH_US,
        content="Second synthetic phrase.",
        start_ms=0,
        end_ms=400,
    )
    with pytest.raises(ValidationError, match="source_segments_out_of_order"):
        _source(first, second)
    with pytest.raises(ValidationError, match="source_segment_id_duplicate"):
        _source(first, first)
    with pytest.raises(ValidationError, match="source_segment_exceeds_duration"):
        _source(first, duration_ms=800)


def test_equal_start_times_use_end_time_and_opaque_id_as_canonical_tiebreakers() -> None:
    later_end = _segment(
        ENGLISH_SEGMENT_ID,
        locale=SourceLocale.ENGLISH_US,
        content="Longer synthetic phrase.",
        start_ms=0,
        end_ms=900,
    )
    earlier_end = _segment(
        SPANISH_SEGMENT_ID,
        locale=SourceLocale.ENGLISH_US,
        content="Shorter synthetic phrase.",
        start_ms=0,
        end_ms=400,
    )
    with pytest.raises(ValidationError, match="source_segments_out_of_order"):
        _source(later_end, earlier_end)

    canonical = _source(earlier_end, later_end)
    assert canonical.segments == (earlier_end, later_end)


def test_source_fingerprint_is_canonical_and_content_bound() -> None:
    source = _bilingual_source()
    replay = SourceTranscriptV1.model_validate(source.model_dump())
    changed_payload = source.model_dump()
    changed_payload["segments"][1]["content"] = "Synthetic changed Spanish source."
    changed = SourceTranscriptV1.model_validate(changed_payload)

    fingerprint = external_source_transcript_fingerprint(source)
    assert fingerprint == external_source_transcript_fingerprint(replay)
    assert fingerprint != external_source_transcript_fingerprint(changed)
    assert len(fingerprint) == 64
    assert "Me siento" not in fingerprint


def test_working_fingerprint_pins_content_lineage_identity_version_and_blockers() -> None:
    source = _bilingual_source()

    def build(
        *,
        translated_content: str = "I feel better today.",
        review_id: UUID = REVIEW_ID,
        working_id: UUID = WORKING_TRANSCRIPT_ID,
        working_version: int = 1,
        reviews: tuple[TranslationReviewEvidenceV1, ...] | None = None,
    ) -> EnglishWorkingTranscriptV1:
        return build_english_working_transcript(
            ExternalTranscriptBundleV1(
                source_transcript=source,
                translations=(_translation(content=translated_content),),
                translation_reviews=(
                    (_review(review_id=review_id),) if reviews is None else reviews
                ),
                working_transcript_id=working_id,
                working_transcript_version=working_version,
            )
        )

    working = build()
    fingerprint = english_working_transcript_fingerprint(working)

    assert fingerprint == english_working_transcript_fingerprint(build())
    assert fingerprint != english_working_transcript_fingerprint(
        build(translated_content="I have less pain.")
    )
    assert fingerprint != english_working_transcript_fingerprint(build(review_id=SECOND_REVIEW_ID))
    assert fingerprint != english_working_transcript_fingerprint(
        build(working_id=SECOND_WORKING_TRANSCRIPT_ID)
    )
    assert fingerprint != english_working_transcript_fingerprint(build(working_version=2))
    assert fingerprint != english_working_transcript_fingerprint(build(reviews=()))
    assert len(fingerprint) == 64
    assert "I feel better" not in fingerprint


def test_translation_and_review_order_are_canonical() -> None:
    second_spanish = _segment(
        UNKNOWN_SEGMENT_ID,
        locale=SourceLocale.SPANISH_US,
        content="Tengo menos dolor.",
        start_ms=2_100,
        end_ms=2_800,
    )
    source = _source(*_bilingual_source().segments, second_spanish)
    first_translation = _translation()
    second_translation = _translation(
        source_segment_id=UNKNOWN_SEGMENT_ID,
        translation_id=SECOND_TRANSLATION_ID,
        content="I have less pain.",
    )
    first_review = _review(decision=TranslationReviewDecision.REJECTED)
    second_review = _review(
        review_id=SECOND_REVIEW_ID,
        source_segment_id=UNKNOWN_SEGMENT_ID,
        translation_id=SECOND_TRANSLATION_ID,
        decision=TranslationReviewDecision.REJECTED,
    )

    forward = ExternalTranscriptBundleV1(
        source_transcript=source,
        translations=(first_translation, second_translation),
        translation_reviews=(first_review, second_review),
        working_transcript_id=WORKING_TRANSCRIPT_ID,
        working_transcript_version=1,
    )
    reversed_input = ExternalTranscriptBundleV1(
        source_transcript=source,
        translations=(second_translation, first_translation),
        translation_reviews=(second_review, first_review),
        working_transcript_id=WORKING_TRANSCRIPT_ID,
        working_transcript_version=1,
    )

    assert forward.translations == reversed_input.translations
    assert forward.translation_reviews == reversed_input.translation_reviews
    assert forward.model_dump(mode="json") == reversed_input.model_dump(mode="json")
