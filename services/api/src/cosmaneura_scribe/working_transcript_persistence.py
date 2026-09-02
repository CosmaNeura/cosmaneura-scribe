from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from .external_transcript_v1 import (
    EnglishWorkingTranscriptV1,
    ExternalTranscriptBundleV1,
    SourceTranscriptSegmentV1,
    SourceTranscriptV1,
    TranslationRecordV1,
    TranslationReviewEvidenceV1,
    build_english_working_transcript,
    english_working_transcript_fingerprint,
)
from .normalized_source_persistence import (
    ConfiguredExternalSessionStatus,
    NormalizedSourceTranscriptRecord,
    derive_working_transcript_status,
)


class WorkingTranscriptPublishDisposition(StrEnum):
    PUBLISHED = "published"
    REPLACED = "replaced"
    REPLAYED = "replayed"


class WorkingTranscriptPersistenceCode(StrEnum):
    CONSENT_INVALID = "working_consent_invalid"
    EVIDENCE_INVALID = "working_evidence_invalid"
    RETENTION_EXPIRED = "working_retention_expired"
    STATE_CONFLICT = "working_state_conflict"


class WorkingTranscriptPersistenceError(RuntimeError):
    """Bounded failure that never includes transcript or identity values."""

    def __init__(self, code: WorkingTranscriptPersistenceCode) -> None:
        self.code = code
        super().__init__(code.value)

    def __repr__(self) -> str:
        return f"WorkingTranscriptPersistenceError({self.code.value!r})"


@dataclass(frozen=True, repr=False)
class WorkingTranscriptPublication:
    """Protected internal receipt; it is not a public response model."""

    session_id: UUID
    working_transcript_id: UUID
    working_transcript_version: int
    source_transcript_version: int
    status: ConfiguredExternalSessionStatus
    created_at: datetime
    disposition: WorkingTranscriptPublishDisposition

    def __post_init__(self) -> None:
        if self.working_transcript_version < 1 or self.source_transcript_version < 1:
            raise ValueError("working transcript versions must be positive")
        if self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
            raise ValueError("created_at must include a UTC offset")

    def __repr__(self) -> str:
        return f"WorkingTranscriptPublication(disposition={self.disposition.value!r})"


@dataclass(frozen=True, repr=False)
class NormalizedWorkingTranscriptRecord:
    """Internal persisted aggregate; all nested values are protected."""

    working_transcript: EnglishWorkingTranscriptV1 = field(repr=False)
    working_fingerprint: str = field(repr=False)
    translation_inputs: tuple[TranslationRecordV1, ...] = field(repr=False)
    review_inputs: tuple[TranslationReviewEvidenceV1, ...] = field(repr=False)
    created_at: datetime

    def __repr__(self) -> str:
        return "NormalizedWorkingTranscriptRecord(<protected>)"


@dataclass(frozen=True, repr=False)
class WorkingTranscriptDerivation:
    bundle: ExternalTranscriptBundleV1 = field(repr=False)
    working_transcript: EnglishWorkingTranscriptV1 = field(repr=False)
    status: ConfiguredExternalSessionStatus
    working_fingerprint: str = field(repr=False)

    def __repr__(self) -> str:
        return "WorkingTranscriptDerivation(<protected>)"


_PROJECTABLE_TRANSITIONS = {
    ConfiguredExternalSessionStatus.SOURCE_RECEIVED: frozenset(
        {
            ConfiguredExternalSessionStatus.TRANSLATION_PENDING,
            ConfiguredExternalSessionStatus.QUALITY_BLOCKED,
            ConfiguredExternalSessionStatus.TRANSCRIPT_READY,
        }
    ),
    ConfiguredExternalSessionStatus.TRANSLATION_PENDING: frozenset(
        {
            ConfiguredExternalSessionStatus.TRANSLATION_PENDING,
            ConfiguredExternalSessionStatus.REVIEW_REQUIRED,
        }
    ),
    ConfiguredExternalSessionStatus.REVIEW_REQUIRED: frozenset(
        {
            ConfiguredExternalSessionStatus.TRANSLATION_PENDING,
            ConfiguredExternalSessionStatus.REVIEW_REQUIRED,
            ConfiguredExternalSessionStatus.TRANSCRIPT_READY,
        }
    ),
    ConfiguredExternalSessionStatus.QUALITY_BLOCKED: frozenset(
        {ConfiguredExternalSessionStatus.QUALITY_BLOCKED}
    ),
    ConfiguredExternalSessionStatus.TRANSCRIPT_READY: frozenset(
        {ConfiguredExternalSessionStatus.TRANSCRIPT_READY}
    ),
}


def can_publish_working_transcript(
    current: ConfiguredExternalSessionStatus,
    derived: ConfiguredExternalSessionStatus,
) -> bool:
    return derived in _PROJECTABLE_TRANSITIONS.get(current, frozenset())


def derive_persisted_working_transcript(
    source: NormalizedSourceTranscriptRecord,
    translations: tuple[TranslationRecordV1, ...],
    reviews: tuple[TranslationReviewEvidenceV1, ...],
    *,
    working_transcript_id: UUID,
    working_transcript_version: int,
) -> WorkingTranscriptDerivation:
    """Build one canonical projection from trusted, persisted evidence."""
    try:
        source_transcript = SourceTranscriptV1(
            source_transcript_version=source.source_transcript_version,
            language_mode=source.language_mode,
            transcription_adapter_id=source.transcription_adapter_id,
            transcription_model_profile_id=source.transcription_model_profile_id,
            normalization_profile_id=source.normalization_profile_id,
            duration_ms=source.duration_ms,
            segments=tuple(
                SourceTranscriptSegmentV1(
                    source_segment_id=segment.source_segment_id,
                    source_segment_version=segment.source_segment_version,
                    source_locale=segment.source_locale,
                    speaker_id=segment.speaker_id,
                    speaker_role=segment.speaker_role,
                    content=segment.content,
                    start_ms=segment.start_ms,
                    end_ms=segment.end_ms,
                    locale_confidence=segment.locale_confidence,
                )
                for segment in source.segments
            ),
        )
        bundle = ExternalTranscriptBundleV1(
            source_transcript=source_transcript,
            translations=translations,
            translation_reviews=reviews,
            working_transcript_id=working_transcript_id,
            working_transcript_version=working_transcript_version,
        )
        working = build_english_working_transcript(bundle)
        return WorkingTranscriptDerivation(
            bundle=bundle,
            working_transcript=working,
            status=derive_working_transcript_status(working),
            working_fingerprint=english_working_transcript_fingerprint(bundle),
        )
    except (TypeError, ValueError):
        raise WorkingTranscriptPersistenceError(
            WorkingTranscriptPersistenceCode.EVIDENCE_INVALID
        ) from None
