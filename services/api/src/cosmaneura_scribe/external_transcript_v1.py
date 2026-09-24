from __future__ import annotations

from collections import Counter
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    computed_field,
    field_validator,
    model_validator,
)

from .canonical_json import canonical_sha256
from .schemas import SpeakerRole
from .transcript_constraints import (
    MAX_TRANSCRIPT_CONTENT_CHARS,
    MAX_TRANSCRIPT_DURATION_MS,
    MAX_TRANSCRIPT_SEGMENTS,
)

EXTERNAL_TRANSCRIPT_SCHEMA_VERSION = "1.0"
MAX_EXTERNAL_TRANSCRIPT_VALIDATION_ISSUES = 32
MAX_EXTERNAL_TRANSCRIPT_VALIDATION_LOCATION_DEPTH = 8

ProtocolVersion = Literal["1.0"]
SafeIdentifier = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    ),
]
ClinicalText = Annotated[
    str,
    Field(min_length=1, max_length=MAX_TRANSCRIPT_CONTENT_CHARS, repr=False),
]


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class TranscriptLanguageMode(StrEnum):
    ENGLISH = "en-US"
    ENGLISH_SPANISH = "en-US+es-US"


class SourceLocale(StrEnum):
    ENGLISH_US = "en-US"
    SPANISH_US = "es-US"
    UNKNOWN = "unknown"


class TranslationOutcome(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class TranslationReviewDecision(StrEnum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class WorkingSegmentResolution(StrEnum):
    ENGLISH_SOURCE = "english_source"
    SPANISH_TRANSLATION = "spanish_translation"
    UNRESOLVED = "unresolved"


class WorkingTranscriptBlockerCode(StrEnum):
    SOURCE_LOCALE_UNKNOWN = "source_locale_unknown"
    SOURCE_OVERLAP = "source_overlap"
    TRANSLATION_MISSING = "translation_missing"
    TRANSLATION_REVIEW_REQUIRED = "translation_review_required"
    TRANSLATION_FAILED = "translation_failed"


class ExternalTranscriptValidationCode(StrEnum):
    REQUIRED = "required"
    FIELD_NOT_ALLOWED = "field_not_allowed"
    IMMUTABLE = "immutable"
    INVALID_TYPE = "invalid_type"
    INVALID_FORMAT = "invalid_format"
    OUT_OF_BOUNDS = "out_of_bounds"
    DOMAIN_CONSTRAINT = "domain_constraint"
    VALIDATION_FAILED = "validation_failed"


_VALIDATION_LOCATION_TOKENS = frozenset(
    """
    schema_version source_transcript source_transcript_version language_mode
    transcription_adapter_id transcription_model_profile_id normalization_profile_id duration_ms
    segments source_segment_id source_segment_version source_locale speaker_id speaker_role content
    start_ms end_ms locale_confidence translations translation_reviews translation_id
    translation_version target_locale outcome translation_adapter_id translation_model_profile_id
    created_at failure_code review_id decision reviewer_actor_id reviewed_at working_transcript_id
    working_transcript_version resolution translation_review_id blockers code note_ready
    """.split()
)


class SourceTranscriptSegmentV1(_StrictFrozenModel):
    source_segment_id: UUID
    source_segment_version: int = Field(ge=1)
    source_locale: SourceLocale
    speaker_id: UUID
    speaker_role: SpeakerRole
    content: ClinicalText
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    locale_confidence: float | None = Field(default=None, ge=0, le=1)

    @field_validator("content")
    @classmethod
    def source_content_is_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("source_segment_content_empty")
        return value

    @field_validator("locale_confidence")
    @classmethod
    def normalize_locale_confidence_signed_zero(cls, value: float | None) -> float | None:
        return 0.0 if value == 0.0 else value

    @model_validator(mode="after")
    def timestamps_are_ordered(self) -> SourceTranscriptSegmentV1:
        if self.end_ms <= self.start_ms:
            raise ValueError("source_segment_timestamps_invalid")
        return self


class SourceTranscriptV1(_StrictFrozenModel):
    schema_version: ProtocolVersion = EXTERNAL_TRANSCRIPT_SCHEMA_VERSION
    source_transcript_version: int = Field(ge=1)
    language_mode: TranscriptLanguageMode
    transcription_adapter_id: SafeIdentifier
    transcription_model_profile_id: SafeIdentifier
    normalization_profile_id: SafeIdentifier
    duration_ms: int = Field(gt=0, le=MAX_TRANSCRIPT_DURATION_MS)
    segments: tuple[SourceTranscriptSegmentV1, ...] = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_SEGMENTS,
        repr=False,
    )

    @model_validator(mode="after")
    def validate_source_transcript(self) -> SourceTranscriptV1:
        segment_ids = [segment.source_segment_id for segment in self.segments]
        if len(segment_ids) != len(set(segment_ids)):
            raise ValueError("source_segment_id_duplicate")
        expected_order = sorted(
            self.segments,
            key=lambda segment: (
                segment.start_ms,
                segment.end_ms,
                segment.source_segment_id.int,
            ),
        )
        if list(self.segments) != expected_order:
            raise ValueError("source_segments_out_of_order")
        if any(segment.end_ms > self.duration_ms for segment in self.segments):
            raise ValueError("source_segment_exceeds_duration")
        if sum(len(segment.content) for segment in self.segments) > MAX_TRANSCRIPT_CONTENT_CHARS:
            raise ValueError("source_transcript_content_too_large")
        if self.language_mode == TranscriptLanguageMode.ENGLISH and any(
            segment.source_locale == SourceLocale.SPANISH_US for segment in self.segments
        ):
            raise ValueError("spanish_source_requires_bilingual_mode")
        return self


class TranslationRecordV1(_StrictFrozenModel):
    translation_id: UUID
    translation_version: int = Field(ge=1)
    source_segment_id: UUID
    source_segment_version: int = Field(ge=1)
    source_locale: Literal["es-US"] = "es-US"
    target_locale: Literal["en-US"] = "en-US"
    content: str | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_TRANSCRIPT_CONTENT_CHARS,
        repr=False,
    )
    outcome: TranslationOutcome
    translation_adapter_id: SafeIdentifier
    translation_model_profile_id: SafeIdentifier
    created_at: datetime
    failure_code: SafeIdentifier | None = None

    @field_validator("created_at")
    @classmethod
    def created_at_has_utc_offset(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("translation_created_at_offset_required")
        return value

    @field_validator("content")
    @classmethod
    def translation_content_is_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("translation_content_empty")
        return value

    @model_validator(mode="after")
    def validate_outcome(self) -> TranslationRecordV1:
        if self.outcome == TranslationOutcome.FAILED:
            if self.content is not None or self.failure_code is None:
                raise ValueError("failed_translation_evidence_invalid")
        elif self.content is None or self.failure_code is not None:
            raise ValueError("translation_evidence_invalid")
        return self


class TranslationReviewEvidenceV1(_StrictFrozenModel):
    review_id: UUID
    translation_id: UUID
    translation_version: int = Field(ge=1)
    source_segment_id: UUID
    source_segment_version: int = Field(ge=1)
    decision: TranslationReviewDecision
    reviewer_actor_id: SafeIdentifier
    reviewed_at: datetime

    @field_validator("reviewed_at")
    @classmethod
    def reviewed_at_has_utc_offset(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("translation_reviewed_at_offset_required")
        return value


class ExternalTranscriptBundleV1(_StrictFrozenModel):
    schema_version: ProtocolVersion = EXTERNAL_TRANSCRIPT_SCHEMA_VERSION
    source_transcript: SourceTranscriptV1 = Field(repr=False)
    translations: tuple[TranslationRecordV1, ...] = Field(
        default=(),
        max_length=MAX_TRANSCRIPT_SEGMENTS,
        repr=False,
    )
    translation_reviews: tuple[TranslationReviewEvidenceV1, ...] = Field(
        default=(),
        max_length=MAX_TRANSCRIPT_SEGMENTS,
        repr=False,
    )
    working_transcript_id: UUID
    working_transcript_version: int = Field(ge=1)

    @field_validator("translations")
    @classmethod
    def canonicalize_translation_order(
        cls,
        value: tuple[TranslationRecordV1, ...],
    ) -> tuple[TranslationRecordV1, ...]:
        return tuple(
            sorted(
                value,
                key=lambda translation: (
                    translation.source_segment_id.int,
                    translation.source_segment_version,
                    translation.translation_version,
                    translation.translation_id.int,
                ),
            )
        )

    @field_validator("translation_reviews")
    @classmethod
    def canonicalize_translation_review_order(
        cls,
        value: tuple[TranslationReviewEvidenceV1, ...],
    ) -> tuple[TranslationReviewEvidenceV1, ...]:
        return tuple(
            sorted(
                value,
                key=lambda review: (
                    review.source_segment_id.int,
                    review.source_segment_version,
                    review.translation_version,
                    review.translation_id.int,
                    review.reviewed_at,
                    review.review_id.int,
                    review.reviewer_actor_id,
                    review.decision,
                ),
            )
        )

    @model_validator(mode="after")
    def validate_translation_history(self) -> ExternalTranscriptBundleV1:
        if (
            sum(
                len(translation.content)
                for translation in self.translations
                if translation.content is not None
            )
            > MAX_TRANSCRIPT_CONTENT_CHARS
        ):
            raise ValueError("translation_content_too_large")

        translation_ids = [translation.translation_id for translation in self.translations]
        if len(translation_ids) != len(set(translation_ids)):
            raise ValueError("translation_id_duplicate")

        review_ids = [review.review_id for review in self.translation_reviews]
        if len(review_ids) != len(set(review_ids)):
            raise ValueError("translation_review_id_duplicate")

        versions = [
            (
                translation.source_segment_id,
                translation.source_segment_version,
                translation.translation_version,
            )
            for translation in self.translations
        ]
        if len(versions) != len(set(versions)):
            raise ValueError("translation_version_duplicate")

        source_by_id = {
            segment.source_segment_id: segment for segment in self.source_transcript.segments
        }
        translation_by_key: dict[tuple[UUID, int], TranslationRecordV1] = {}
        for translation in self.translations:
            source = source_by_id.get(translation.source_segment_id)
            if source is None:
                raise ValueError("translation_source_segment_unknown")
            if translation.source_segment_version != source.source_segment_version:
                raise ValueError("translation_source_version_stale")
            if source.source_locale != SourceLocale.SPANISH_US:
                raise ValueError("translation_source_locale_invalid")
            translation_by_key[(translation.translation_id, translation.translation_version)] = (
                translation
            )

        reviews_by_translation: dict[tuple[UUID, int], TranslationReviewEvidenceV1] = {}
        accepted_reviews_by_source: Counter[tuple[UUID, int]] = Counter()
        for review in self.translation_reviews:
            translation = translation_by_key.get(
                (review.translation_id, review.translation_version)
            )
            if translation is None:
                raise ValueError("translation_review_reference_unknown")
            if (
                review.source_segment_id != translation.source_segment_id
                or review.source_segment_version != translation.source_segment_version
            ):
                raise ValueError("translation_review_source_mismatch")
            if translation.outcome != TranslationOutcome.SUCCEEDED:
                raise ValueError("failed_translation_cannot_be_reviewed")
            if review.reviewed_at < translation.created_at:
                raise ValueError("translation_review_precedes_translation")
            review_key = (review.translation_id, review.translation_version)
            previous_review = reviews_by_translation.get(review_key)
            if previous_review is not None:
                if previous_review.decision != review.decision:
                    raise ValueError("translation_review_decision_conflict")
                raise ValueError("translation_review_duplicate")
            reviews_by_translation[review_key] = review
            if review.decision == TranslationReviewDecision.ACCEPTED:
                accepted_reviews_by_source[
                    (review.source_segment_id, review.source_segment_version)
                ] += 1
        if any(count > 1 for count in accepted_reviews_by_source.values()):
            raise ValueError("competing_accepted_translation_reviews")
        return self


class EnglishWorkingTranscriptSegmentV1(_StrictFrozenModel):
    source_segment_id: UUID
    source_segment_version: int = Field(ge=1)
    source_locale: SourceLocale
    speaker_id: UUID
    speaker_role: SpeakerRole
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    resolution: WorkingSegmentResolution
    content: str | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_TRANSCRIPT_CONTENT_CHARS,
        repr=False,
    )
    translation_id: UUID | None = None
    translation_version: int | None = Field(default=None, ge=1)
    translation_review_id: UUID | None = None

    @field_validator("content")
    @classmethod
    def working_content_is_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("working_segment_content_empty")
        return value

    @model_validator(mode="after")
    def validate_resolution(self) -> EnglishWorkingTranscriptSegmentV1:
        if self.end_ms <= self.start_ms:
            raise ValueError("working_segment_timestamps_invalid")
        if self.resolution == WorkingSegmentResolution.ENGLISH_SOURCE:
            if (
                self.source_locale != SourceLocale.ENGLISH_US
                or self.content is None
                or self.translation_id is not None
                or self.translation_version is not None
                or self.translation_review_id is not None
            ):
                raise ValueError("english_source_resolution_invalid")
        elif self.resolution == WorkingSegmentResolution.SPANISH_TRANSLATION:
            if (
                self.source_locale != SourceLocale.SPANISH_US
                or self.content is None
                or self.translation_id is None
                or self.translation_version is None
                or self.translation_review_id is None
            ):
                raise ValueError("spanish_translation_resolution_invalid")
        elif (
            self.content is not None
            or self.translation_id is not None
            or self.translation_version is not None
            or self.translation_review_id is not None
        ):
            raise ValueError("unresolved_segment_contains_content")
        return self


class WorkingTranscriptBlockerV1(_StrictFrozenModel):
    source_segment_id: UUID
    code: WorkingTranscriptBlockerCode


class EnglishWorkingTranscriptV1(_StrictFrozenModel):
    schema_version: ProtocolVersion = EXTERNAL_TRANSCRIPT_SCHEMA_VERSION
    working_transcript_id: UUID
    working_transcript_version: int = Field(ge=1)
    source_transcript_version: int = Field(ge=1)
    segments: tuple[EnglishWorkingTranscriptSegmentV1, ...] = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_SEGMENTS,
        repr=False,
    )
    blockers: tuple[WorkingTranscriptBlockerV1, ...] = ()

    @model_validator(mode="after")
    def validate_readiness(self) -> EnglishWorkingTranscriptV1:
        segment_ids = [segment.source_segment_id for segment in self.segments]
        if len(segment_ids) != len(set(segment_ids)):
            raise ValueError("working_segment_id_duplicate")
        expected_order = sorted(
            self.segments,
            key=lambda segment: (
                segment.start_ms,
                segment.end_ms,
                segment.source_segment_id.int,
            ),
        )
        if list(self.segments) != expected_order:
            raise ValueError("working_segments_out_of_order")
        if not self.blockers and any(
            segment.resolution == WorkingSegmentResolution.UNRESOLVED for segment in self.segments
        ):
            raise ValueError("working_transcript_unresolved")
        known_segments = set(segment_ids)
        blocker_keys = [(blocker.source_segment_id, blocker.code) for blocker in self.blockers]
        if any(blocker.source_segment_id not in known_segments for blocker in self.blockers):
            raise ValueError("working_blocker_source_unknown")
        if len(blocker_keys) != len(set(blocker_keys)):
            raise ValueError("working_blocker_duplicate")
        return self

    @computed_field
    @property
    def note_ready(self) -> bool:
        return not self.blockers and all(
            segment.resolution != WorkingSegmentResolution.UNRESOLVED for segment in self.segments
        )


def build_english_working_transcript(
    bundle: ExternalTranscriptBundleV1,
) -> EnglishWorkingTranscriptV1:
    translations_by_source: dict[UUID, list[TranslationRecordV1]] = {}
    for translation in bundle.translations:
        translations_by_source.setdefault(translation.source_segment_id, []).append(translation)
    accepted_reviews_by_source: dict[UUID, TranslationReviewEvidenceV1] = {}
    for review in bundle.translation_reviews:
        if review.decision == TranslationReviewDecision.ACCEPTED:
            accepted_reviews_by_source[review.source_segment_id] = review

    translations_by_key = {
        (translation.translation_id, translation.translation_version): translation
        for translation in bundle.translations
    }

    working_segments: list[EnglishWorkingTranscriptSegmentV1] = []
    blockers: list[WorkingTranscriptBlockerV1] = []
    latest_end_ms: int | None = None
    for source in bundle.source_transcript.segments:
        if latest_end_ms is not None and source.start_ms < latest_end_ms:
            blockers.append(
                WorkingTranscriptBlockerV1(
                    source_segment_id=source.source_segment_id,
                    code=WorkingTranscriptBlockerCode.SOURCE_OVERLAP,
                )
            )

        translation: TranslationRecordV1 | None = None
        translation_review: TranslationReviewEvidenceV1 | None = None
        if source.source_locale == SourceLocale.ENGLISH_US:
            resolution = WorkingSegmentResolution.ENGLISH_SOURCE
            content = source.content
        elif source.source_locale == SourceLocale.UNKNOWN:
            resolution = WorkingSegmentResolution.UNRESOLVED
            content = None
            blockers.append(
                WorkingTranscriptBlockerV1(
                    source_segment_id=source.source_segment_id,
                    code=WorkingTranscriptBlockerCode.SOURCE_LOCALE_UNKNOWN,
                )
            )
        else:
            candidates = translations_by_source.get(source.source_segment_id, [])
            current = [
                candidate
                for candidate in candidates
                if candidate.source_segment_version == source.source_segment_version
            ]
            accepted_review = accepted_reviews_by_source.get(source.source_segment_id)
            if accepted_review is not None:
                translation_review = accepted_review
                translation = translations_by_key[
                    (accepted_review.translation_id, accepted_review.translation_version)
                ]
                if translation.content is None:  # defended by TranslationRecordV1
                    raise ValueError("accepted_translation_content_missing")
                resolution = WorkingSegmentResolution.SPANISH_TRANSLATION
                content = translation.content
            else:
                resolution = WorkingSegmentResolution.UNRESOLVED
                content = None
                outcomes = {candidate.outcome for candidate in current}
                if TranslationOutcome.SUCCEEDED in outcomes:
                    code = WorkingTranscriptBlockerCode.TRANSLATION_REVIEW_REQUIRED
                elif TranslationOutcome.FAILED in outcomes:
                    code = WorkingTranscriptBlockerCode.TRANSLATION_FAILED
                else:
                    code = WorkingTranscriptBlockerCode.TRANSLATION_MISSING
                blockers.append(
                    WorkingTranscriptBlockerV1(
                        source_segment_id=source.source_segment_id,
                        code=code,
                    )
                )

        working_segments.append(
            EnglishWorkingTranscriptSegmentV1(
                source_segment_id=source.source_segment_id,
                source_segment_version=source.source_segment_version,
                source_locale=source.source_locale,
                speaker_id=source.speaker_id,
                speaker_role=source.speaker_role,
                start_ms=source.start_ms,
                end_ms=source.end_ms,
                resolution=resolution,
                content=content,
                translation_id=translation.translation_id if translation is not None else None,
                translation_version=(
                    translation.translation_version if translation is not None else None
                ),
                translation_review_id=(
                    translation_review.review_id if translation_review is not None else None
                ),
            )
        )
        latest_end_ms = (
            source.end_ms if latest_end_ms is None else max(latest_end_ms, source.end_ms)
        )

    return EnglishWorkingTranscriptV1(
        working_transcript_id=bundle.working_transcript_id,
        working_transcript_version=bundle.working_transcript_version,
        source_transcript_version=bundle.source_transcript.source_transcript_version,
        segments=tuple(working_segments),
        blockers=tuple(blockers),
    )


def external_source_transcript_fingerprint(source: SourceTranscriptV1) -> str:
    return canonical_sha256(
        {
            "contract": "external-source-transcript-v1",
            "schema_version": source.schema_version,
            "language_mode": source.language_mode,
            "source_transcript_version": source.source_transcript_version,
            "source_transcript": source,
        }
    )


def english_working_transcript_fingerprint(bundle: ExternalTranscriptBundleV1) -> str:
    working = build_english_working_transcript(bundle)
    return canonical_sha256(
        {
            "contract": "english-working-transcript-v1",
            "schema_version": bundle.schema_version,
            "working_transcript_id": bundle.working_transcript_id,
            "working_transcript_version": bundle.working_transcript_version,
            "source_transcript": bundle.source_transcript,
            "translations": bundle.translations,
            "translation_reviews": bundle.translation_reviews,
            "working_transcript": working,
        }
    )


def serialize_external_transcript_validation_error(error: ValidationError) -> dict[str, object]:
    """Return the only validation-error shape safe for a future external boundary."""
    issues: list[dict[str, str]] = []
    for raw_error in error.errors(
        include_url=False,
        include_context=False,
        include_input=False,
    )[:MAX_EXTERNAL_TRANSCRIPT_VALIDATION_ISSUES]:
        error_type = raw_error["type"]
        issues.append(
            {
                "code": _safe_validation_code(error_type).value,
                "location": _safe_validation_location(raw_error["loc"], error_type),
            }
        )
    if not issues:
        issues.append(
            {
                "code": ExternalTranscriptValidationCode.VALIDATION_FAILED.value,
                "location": "root",
            }
        )
    return {"code": "external_transcript_validation_failed", "issues": issues}


def _safe_validation_code(error_type: str) -> ExternalTranscriptValidationCode:
    if error_type == "missing":
        return ExternalTranscriptValidationCode.REQUIRED
    if error_type == "extra_forbidden":
        return ExternalTranscriptValidationCode.FIELD_NOT_ALLOWED
    if error_type in {"frozen_field", "frozen_instance"}:
        return ExternalTranscriptValidationCode.IMMUTABLE
    if error_type in {
        "greater_than",
        "greater_than_equal",
        "less_than",
        "less_than_equal",
        "too_long",
        "too_short",
        "string_too_long",
        "string_too_short",
    }:
        return ExternalTranscriptValidationCode.OUT_OF_BOUNDS
    if error_type.endswith("_type"):
        return ExternalTranscriptValidationCode.INVALID_TYPE
    if error_type == "value_error":
        return ExternalTranscriptValidationCode.DOMAIN_CONSTRAINT
    if (
        error_type in {"enum", "literal_error", "string_pattern_mismatch"}
        or "parsing" in error_type
    ):
        return ExternalTranscriptValidationCode.INVALID_FORMAT
    return ExternalTranscriptValidationCode.VALIDATION_FAILED


def _safe_validation_location(location: tuple[int | str, ...], error_type: str) -> str:
    safe: list[str] = []
    for index, token in enumerate(location[:MAX_EXTERNAL_TRANSCRIPT_VALIDATION_LOCATION_DEPTH]):
        if error_type == "extra_forbidden" and index == len(location) - 1:
            safe.append("unknown_field")
        elif isinstance(token, int):
            safe.append("item")
        elif token in _VALIDATION_LOCATION_TOKENS:
            safe.append(token)
        else:
            safe.append("unknown_field")
    return ".".join(safe) if safe else "root"
