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
from .transcript_constraints import MAX_TRANSCRIPT_CONTENT_CHARS
from .working_transcript_persistence import WorkingTranscriptPublication

_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_FAILURE_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class TranslationAttemptWriteDisposition(StrEnum):
    RECORDED = "recorded"
    REPLAYED = "replayed"


class TranslationAttemptPersistenceCode(StrEnum):
    CONSENT_INVALID = "translation_consent_invalid"
    EVIDENCE_INVALID = "translation_evidence_invalid"
    IDENTITY_CONFLICT = "translation_identity_conflict"
    RETENTION_EXPIRED = "translation_retention_expired"
    STATE_CONFLICT = "translation_state_conflict"


class TranslationAttemptPersistenceError(RuntimeError):
    """Bounded persistence failure that never renders protected input."""

    def __init__(self, code: TranslationAttemptPersistenceCode) -> None:
        self.code = code
        super().__init__(code.value)

    def __repr__(self) -> str:
        return f"TranslationAttemptPersistenceError({self.code.value!r})"


@dataclass(frozen=True, repr=False)
class TranslationAttemptCommand:
    """Internal result from a Scribe-reserved attempt; not a transport model."""

    translation_id: UUID
    expected_source_transcript_version: int
    source_segment_id: UUID
    expected_source_segment_version: int
    expected_previous_translation_version: int
    outcome: TranslationOutcome
    translation_adapter_id: str
    translation_model_profile_id: str
    content: str | None = field(default=None, repr=False)
    failure_code: str | None = None

    def __post_init__(self) -> None:
        if self.expected_source_transcript_version < 1:
            raise ValueError("expected source transcript version must be positive")
        if self.expected_source_segment_version < 1:
            raise ValueError("expected source segment version must be positive")
        if self.expected_previous_translation_version < 0:
            raise ValueError("expected previous translation version cannot be negative")
        if not isinstance(cast(object, self.outcome), TranslationOutcome) or self.outcome not in (
            TranslationOutcome.SUCCEEDED,
            TranslationOutcome.FAILED,
        ):
            raise ValueError("translation outcome is invalid")
        for value in (
            self.translation_adapter_id,
            self.translation_model_profile_id,
        ):
            if _SAFE_IDENTIFIER.fullmatch(value) is None:
                raise ValueError("translation profile identifier is invalid")
        if self.outcome == TranslationOutcome.SUCCEEDED:
            if (
                self.content is None
                or not self.content.strip()
                or len(self.content) > MAX_TRANSCRIPT_CONTENT_CHARS
                or self.failure_code is not None
            ):
                raise ValueError("successful translation result is invalid")
        elif (
            self.content is not None
            or self.failure_code is None
            or _FAILURE_CODE.fullmatch(self.failure_code) is None
        ):
            raise ValueError("failed translation result is invalid")

    def __repr__(self) -> str:
        return "TranslationAttemptCommand(<protected>)"


@dataclass(frozen=True, repr=False)
class TranslationAttemptPublication:
    session_id: UUID
    translation_id: UUID
    translation_version: int
    source_transcript_version: int
    source_segment_id: UUID
    source_segment_version: int
    created_at: datetime
    status: ConfiguredExternalSessionStatus
    current_working_transcript: WorkingTranscriptPublication = field(repr=False)
    disposition: TranslationAttemptWriteDisposition

    def __post_init__(self) -> None:
        if self.translation_version < 1:
            raise ValueError("translation version must be positive")
        if self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
            raise ValueError("created_at must include a UTC offset")

    def __repr__(self) -> str:
        return f"TranslationAttemptPublication(disposition={self.disposition.value!r})"


def translation_matches_command(
    record: TranslationRecordV1,
    command: TranslationAttemptCommand,
    *,
    source_transcript_version: int,
) -> bool:
    return bool(
        source_transcript_version == command.expected_source_transcript_version
        and record.translation_id == command.translation_id
        and record.translation_version == command.expected_previous_translation_version + 1
        and record.source_segment_id == command.source_segment_id
        and record.source_segment_version == command.expected_source_segment_version
        and record.source_locale == SourceLocale.SPANISH_US
        and record.target_locale == SourceLocale.ENGLISH_US
        and record.outcome == command.outcome
        and record.content == command.content
        and record.failure_code == command.failure_code
        and record.translation_adapter_id == command.translation_adapter_id
        and record.translation_model_profile_id == command.translation_model_profile_id
    )


def allocate_translation_version(
    source: NormalizedSourceTranscriptRecord,
    translations: tuple[TranslationRecordV1, ...],
    reviews: tuple[TranslationReviewEvidenceV1, ...],
    command: TranslationAttemptCommand,
) -> int:
    if source.source_transcript_version != command.expected_source_transcript_version:
        raise TranslationAttemptPersistenceError(TranslationAttemptPersistenceCode.STATE_CONFLICT)
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
        raise TranslationAttemptPersistenceError(TranslationAttemptPersistenceCode.EVIDENCE_INVALID)
    segment_attempts = sorted(
        (
            item
            for item in translations
            if item.source_segment_id == command.source_segment_id
            and item.source_segment_version == command.expected_source_segment_version
        ),
        key=lambda item: item.translation_version,
    )
    previous_version = segment_attempts[-1].translation_version if segment_attempts else 0
    if previous_version != command.expected_previous_translation_version:
        raise TranslationAttemptPersistenceError(TranslationAttemptPersistenceCode.STATE_CONFLICT)
    if any(
        review.source_segment_id == command.source_segment_id
        and review.source_segment_version == command.expected_source_segment_version
        and review.decision == TranslationReviewDecision.ACCEPTED
        for review in reviews
    ):
        raise TranslationAttemptPersistenceError(TranslationAttemptPersistenceCode.STATE_CONFLICT)
    if segment_attempts:
        latest = segment_attempts[-1]
        latest_review = next(
            (
                review
                for review in reviews
                if review.translation_id == latest.translation_id
                and review.translation_version == latest.translation_version
            ),
            None,
        )
        if latest.outcome == TranslationOutcome.SUCCEEDED and (
            latest_review is None or latest_review.decision != TranslationReviewDecision.REJECTED
        ):
            raise TranslationAttemptPersistenceError(
                TranslationAttemptPersistenceCode.STATE_CONFLICT
            )
    return previous_version + 1


def build_translation_record(
    command: TranslationAttemptCommand,
    *,
    translation_version: int,
    created_at: datetime,
) -> TranslationRecordV1:
    try:
        return TranslationRecordV1(
            translation_id=command.translation_id,
            translation_version=translation_version,
            source_segment_id=command.source_segment_id,
            source_segment_version=command.expected_source_segment_version,
            content=command.content,
            outcome=command.outcome,
            translation_adapter_id=command.translation_adapter_id,
            translation_model_profile_id=command.translation_model_profile_id,
            created_at=created_at,
            failure_code=command.failure_code,
        )
    except (TypeError, ValueError):
        raise TranslationAttemptPersistenceError(
            TranslationAttemptPersistenceCode.EVIDENCE_INVALID
        ) from None
