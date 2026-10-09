from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .external_transcript_v1 import (
    ExternalTranscriptBundleV1,
    SourceLocale,
    TranslationOutcome,
    TranslationReviewDecision,
    WorkingTranscriptBlockerCode,
    build_english_working_transcript,
)
from .normalized_source_persistence import (
    ConfiguredExternalSessionStatus,
    derive_working_transcript_status,
)
from .schemas import SpeakerRole
from .transcript_constraints import (
    MAX_TRANSCRIPT_CONTENT_CHARS,
    MAX_TRANSCRIPT_SEGMENTS,
)
from .translation_review_persistence import CreatorTranslationReviewCommand

CreatorReviewSchemaVersion = Literal["1.0"]


class CreatorReviewQueueStatus(StrEnum):
    NOT_READY = "not_ready"
    REVIEW_REQUIRED = "review_required"
    COMPLETE = "complete"
    QUALITY_BLOCKED = "quality_blocked"


class _StrictProtectedModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class CreatorTranslationProgressV1(_StrictProtectedModel):
    """Current-source metadata only; never authority to execute or retry a call."""

    source_segment_id: UUID = Field(repr=False)
    source_segment_version: int = Field(ge=1, repr=False)
    state: Literal["queued", "unconfirmed", "result_saved"]


class CreatorTranslationReviewItemV1(_StrictProtectedModel):
    source_segment_id: UUID = Field(repr=False)
    source_segment_version: int = Field(ge=1, repr=False)
    translation_id: UUID = Field(repr=False)
    translation_version: int = Field(ge=1, repr=False)
    source_locale: Literal["es-US"]
    target_locale: Literal["en-US"]
    speaker_role: SpeakerRole
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    source_content: str = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_CONTENT_CHARS,
        repr=False,
    )
    translated_content: str = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_CONTENT_CHARS,
        repr=False,
    )

    @model_validator(mode="after")
    def validate_item(self) -> CreatorTranslationReviewItemV1:
        if self.end_ms <= self.start_ms:
            raise ValueError("creator review timestamps are invalid")
        if not self.source_content.strip() or not self.translated_content.strip():
            raise ValueError("creator review content is empty")
        return self

    def __repr__(self) -> str:
        return "CreatorTranslationReviewItemV1(<protected>)"

    def __str__(self) -> str:
        return self.__repr__()


class CreatorTranslationReviewQueueV1(_StrictProtectedModel):
    schema_version: CreatorReviewSchemaVersion
    session_id: UUID = Field(repr=False)
    source_transcript_version: int = Field(ge=1, repr=False)
    working_transcript_id: UUID = Field(repr=False)
    working_transcript_version: int = Field(ge=1, repr=False)
    status: CreatorReviewQueueStatus
    items: tuple[CreatorTranslationReviewItemV1, ...] = Field(
        default=(),
        max_length=MAX_TRANSCRIPT_SEGMENTS,
        repr=False,
    )

    @model_validator(mode="after")
    def validate_queue(self) -> CreatorTranslationReviewQueueV1:
        if self.status == CreatorReviewQueueStatus.REVIEW_REQUIRED:
            if not self.items:
                raise ValueError("creator review queue is empty")
        elif self.items:
            raise ValueError("creator review queue items are not actionable")
        segment_ids = [item.source_segment_id for item in self.items]
        if len(segment_ids) != len(set(segment_ids)):
            raise ValueError("creator review source segment is duplicated")
        return self

    def __repr__(self) -> str:
        return (
            "CreatorTranslationReviewQueueV1("
            f"status={self.status.value!r}, item_count={len(self.items)})"
        )

    def __str__(self) -> str:
        return self.__repr__()


class CreatorTranslationDecisionRequestV1(_StrictProtectedModel):
    """Creator input only; authority fields must be supplied by trusted Core code."""

    schema_version: CreatorReviewSchemaVersion
    expected_source_transcript_version: int = Field(ge=1, repr=False)
    source_segment_id: UUID = Field(repr=False)
    expected_source_segment_version: int = Field(ge=1, repr=False)
    translation_id: UUID = Field(repr=False)
    expected_translation_version: int = Field(ge=1, repr=False)
    decision: TranslationReviewDecision

    def to_authorized_command(
        self,
        *,
        review_id: UUID,
        reviewer_actor_id: str,
        reviewed_at: datetime,
    ) -> CreatorTranslationReviewCommand:
        return CreatorTranslationReviewCommand(
            review_id=review_id,
            expected_source_transcript_version=(self.expected_source_transcript_version),
            source_segment_id=self.source_segment_id,
            expected_source_segment_version=self.expected_source_segment_version,
            translation_id=self.translation_id,
            expected_translation_version=self.expected_translation_version,
            decision=self.decision,
            reviewer_actor_id=reviewer_actor_id,
            reviewed_at=reviewed_at,
        )

    def __repr__(self) -> str:
        return "CreatorTranslationDecisionRequestV1(<protected>)"

    def __str__(self) -> str:
        return self.__repr__()


def build_creator_translation_review_queue(
    *,
    session_id: UUID,
    bundle: ExternalTranscriptBundleV1,
) -> CreatorTranslationReviewQueueV1:
    """Build the current creator-review view without performing authorization."""

    working = build_english_working_transcript(bundle)
    derived_status = derive_working_transcript_status(working)
    status_mapping = {
        ConfiguredExternalSessionStatus.TRANSLATION_PENDING: (CreatorReviewQueueStatus.NOT_READY),
        ConfiguredExternalSessionStatus.REVIEW_REQUIRED: (CreatorReviewQueueStatus.REVIEW_REQUIRED),
        ConfiguredExternalSessionStatus.QUALITY_BLOCKED: (CreatorReviewQueueStatus.QUALITY_BLOCKED),
        ConfiguredExternalSessionStatus.TRANSCRIPT_READY: (CreatorReviewQueueStatus.COMPLETE),
    }
    queue_status = status_mapping[derived_status]
    if queue_status != CreatorReviewQueueStatus.REVIEW_REQUIRED:
        return CreatorTranslationReviewQueueV1(
            schema_version="1.0",
            session_id=session_id,
            source_transcript_version=bundle.source_transcript.source_transcript_version,
            working_transcript_id=bundle.working_transcript_id,
            working_transcript_version=bundle.working_transcript_version,
            status=queue_status,
        )

    review_required_source_ids = {
        blocker.source_segment_id
        for blocker in working.blockers
        if blocker.code == WorkingTranscriptBlockerCode.TRANSLATION_REVIEW_REQUIRED
    }
    reviews_by_translation = {
        (review.translation_id, review.translation_version) for review in bundle.translation_reviews
    }
    items: list[CreatorTranslationReviewItemV1] = []
    for source in bundle.source_transcript.segments:
        if (
            source.source_locale != SourceLocale.SPANISH_US
            or source.source_segment_id not in review_required_source_ids
        ):
            continue
        latest = max(
            (
                translation
                for translation in bundle.translations
                if translation.source_segment_id == source.source_segment_id
                and translation.source_segment_version == source.source_segment_version
                and translation.outcome == TranslationOutcome.SUCCEEDED
                and (
                    translation.translation_id,
                    translation.translation_version,
                )
                not in reviews_by_translation
            ),
            key=lambda translation: translation.translation_version,
            default=None,
        )
        if latest is None or latest.content is None:
            raise ValueError("creator_review_projection_inconsistent")
        items.append(
            CreatorTranslationReviewItemV1(
                source_segment_id=source.source_segment_id,
                source_segment_version=source.source_segment_version,
                translation_id=latest.translation_id,
                translation_version=latest.translation_version,
                source_locale="es-US",
                target_locale="en-US",
                speaker_role=source.speaker_role,
                start_ms=source.start_ms,
                end_ms=source.end_ms,
                source_content=source.content,
                translated_content=latest.content,
            )
        )
    return CreatorTranslationReviewQueueV1(
        schema_version="1.0",
        session_id=session_id,
        source_transcript_version=bundle.source_transcript.source_transcript_version,
        working_transcript_id=bundle.working_transcript_id,
        working_transcript_version=bundle.working_transcript_version,
        status=queue_status,
        items=tuple(items),
    )
