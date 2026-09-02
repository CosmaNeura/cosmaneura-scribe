from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import cast
from uuid import UUID

from .external_transcript_v1 import (
    SourceLocale,
    TranslationOutcome,
    TranslationRecordV1,
    TranslationReviewDecision,
    TranslationReviewEvidenceV1,
)
from .normalized_source_persistence import (
    ConfiguredExternalSessionStatus,
    NormalizedSourceTranscriptRecord,
)
from .working_transcript_persistence import WorkingTranscriptPublication

_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class TranslationReviewWriteDisposition(StrEnum):
    RECORDED = "recorded"
    REPLAYED = "replayed"


class TranslationReviewPersistenceCode(StrEnum):
    CONSENT_INVALID = "translation_review_consent_invalid"
    CREATOR_MISMATCH = "translation_review_creator_mismatch"
    EVIDENCE_INVALID = "translation_review_evidence_invalid"
    IDENTITY_CONFLICT = "translation_review_identity_conflict"
    RETENTION_EXPIRED = "translation_review_retention_expired"
    STATE_CONFLICT = "translation_review_state_conflict"


class TranslationReviewPersistenceError(RuntimeError):
    """Bounded persistence failure that never renders protected input."""

    def __init__(self, code: TranslationReviewPersistenceCode) -> None:
        self.code = code
        super().__init__(code.value)

    def __repr__(self) -> str:
        return f"TranslationReviewPersistenceError({self.code.value!r})"


@dataclass(frozen=True, repr=False)
class CreatorTranslationReviewCommand:
    """Internal Core-reauthorized decision; never construct from request fields."""

    review_id: UUID
    expected_source_transcript_version: int
    source_segment_id: UUID
    expected_source_segment_version: int
    translation_id: UUID
    expected_translation_version: int
    decision: TranslationReviewDecision
    reviewer_actor_id: str
    reviewed_at: datetime

    def __post_init__(self) -> None:
        if self.expected_source_transcript_version < 1:
            raise ValueError("expected source transcript version must be positive")
        if self.expected_source_segment_version < 1:
            raise ValueError("expected source segment version must be positive")
        if self.expected_translation_version < 1:
            raise ValueError("expected translation version must be positive")
        if not isinstance(
            cast(object, self.decision), TranslationReviewDecision
        ) or self.decision not in (
            TranslationReviewDecision.ACCEPTED,
            TranslationReviewDecision.REJECTED,
        ):
            raise ValueError("translation review decision is invalid")
        if _SAFE_IDENTIFIER.fullmatch(self.reviewer_actor_id) is None:
            raise ValueError("translation reviewer identifier is invalid")
        if self.reviewed_at.tzinfo is None or self.reviewed_at.utcoffset() is None:
            raise ValueError("reviewed_at must include a UTC offset")

    def __repr__(self) -> str:
        return "CreatorTranslationReviewCommand(<protected>)"


@dataclass(frozen=True, repr=False)
class TranslationReviewPublication:
    session_id: UUID
    review_id: UUID
    source_transcript_version: int
    source_segment_id: UUID
    source_segment_version: int
    translation_id: UUID
    translation_version: int
    decision: TranslationReviewDecision
    reviewer_actor_id: str = field(repr=False)
    reviewed_at: datetime
    status: ConfiguredExternalSessionStatus
    current_working_transcript: WorkingTranscriptPublication = field(repr=False)
    disposition: TranslationReviewWriteDisposition

    def __post_init__(self) -> None:
        if self.source_transcript_version < 1 or self.source_segment_version < 1:
            raise ValueError("translation review source versions must be positive")
        if self.translation_version < 1:
            raise ValueError("translation review translation version must be positive")
        if self.reviewed_at.tzinfo is None or self.reviewed_at.utcoffset() is None:
            raise ValueError("reviewed_at must include a UTC offset")

    def __repr__(self) -> str:
        return f"TranslationReviewPublication(disposition={self.disposition.value!r})"


def review_matches_command(
    review: TranslationReviewEvidenceV1,
    command: CreatorTranslationReviewCommand,
    *,
    source_transcript_version: int,
) -> bool:
    return bool(
        source_transcript_version == command.expected_source_transcript_version
        and review.review_id == command.review_id
        and review.source_segment_id == command.source_segment_id
        and review.source_segment_version == command.expected_source_segment_version
        and review.translation_id == command.translation_id
        and review.translation_version == command.expected_translation_version
        and review.decision == command.decision
        and review.reviewer_actor_id == command.reviewer_actor_id
        and review.reviewed_at == command.reviewed_at
    )


def validate_review_target(
    source: NormalizedSourceTranscriptRecord,
    translations: tuple[TranslationRecordV1, ...],
    reviews: tuple[TranslationReviewEvidenceV1, ...],
    command: CreatorTranslationReviewCommand,
) -> TranslationRecordV1:
    if source.source_transcript_version != command.expected_source_transcript_version:
        raise TranslationReviewPersistenceError(TranslationReviewPersistenceCode.STATE_CONFLICT)
    segment = next(
        (
            item
            for item in source.segments
            if item.source_segment_id == command.source_segment_id
            and item.source_segment_version == command.expected_source_segment_version
        ),
        None,
    )
    if segment is None or segment.source_locale != SourceLocale.SPANISH_US:
        raise TranslationReviewPersistenceError(TranslationReviewPersistenceCode.EVIDENCE_INVALID)
    segment_attempts = sorted(
        (
            item
            for item in translations
            if item.source_segment_id == command.source_segment_id
            and item.source_segment_version == command.expected_source_segment_version
        ),
        key=lambda item: item.translation_version,
    )
    if not segment_attempts:
        raise TranslationReviewPersistenceError(TranslationReviewPersistenceCode.STATE_CONFLICT)
    translation = segment_attempts[-1]
    if (
        translation.translation_id != command.translation_id
        or translation.translation_version != command.expected_translation_version
        or translation.outcome != TranslationOutcome.SUCCEEDED
    ):
        raise TranslationReviewPersistenceError(TranslationReviewPersistenceCode.STATE_CONFLICT)
    if command.reviewed_at < translation.created_at:
        raise TranslationReviewPersistenceError(TranslationReviewPersistenceCode.EVIDENCE_INVALID)
    if any(
        item.translation_id == translation.translation_id
        and item.translation_version == translation.translation_version
        for item in reviews
    ) or any(
        item.source_segment_id == command.source_segment_id
        and item.source_segment_version == command.expected_source_segment_version
        and item.decision == TranslationReviewDecision.ACCEPTED
        for item in reviews
    ):
        raise TranslationReviewPersistenceError(TranslationReviewPersistenceCode.STATE_CONFLICT)
    return translation


def build_review_record(
    command: CreatorTranslationReviewCommand,
) -> TranslationReviewEvidenceV1:
    try:
        return TranslationReviewEvidenceV1(
            review_id=command.review_id,
            translation_id=command.translation_id,
            translation_version=command.expected_translation_version,
            source_segment_id=command.source_segment_id,
            source_segment_version=command.expected_source_segment_version,
            decision=command.decision,
            reviewer_actor_id=command.reviewer_actor_id,
            reviewed_at=command.reviewed_at,
        )
    except (TypeError, ValueError):
        raise TranslationReviewPersistenceError(
            TranslationReviewPersistenceCode.EVIDENCE_INVALID
        ) from None


def review_projection_matches_decision(
    decision: TranslationReviewDecision,
    status: ConfiguredExternalSessionStatus,
) -> bool:
    if decision == TranslationReviewDecision.ACCEPTED:
        return status in {
            ConfiguredExternalSessionStatus.REVIEW_REQUIRED,
            ConfiguredExternalSessionStatus.TRANSCRIPT_READY,
        }
    return status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING
