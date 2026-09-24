from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol, cast
from uuid import UUID

from .external_transcript_v1 import (
    ExternalTranscriptBundleV1,
    SourceLocale,
    TranslationOutcome,
    TranslationReviewDecision,
    WorkingTranscriptBlockerCode,
    build_english_working_transcript,
)
from .transcript_constraints import MAX_TRANSCRIPT_CONTENT_CHARS
from .translation_attempt_persistence import TranslationAttemptCommand

_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class TranslationAdapterFailureCode(StrEnum):
    """Bounded provider outcomes safe to persist and expose to operators."""

    PROVIDER_REJECTED = "provider_rejected"
    PROVIDER_TIMEOUT = "provider_timeout"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    RESPONSE_INVALID = "provider_response_invalid"


class TranslationPreparationCode(StrEnum):
    ADAPTER_CONFIGURATION_INVALID = "translation_adapter_configuration_invalid"


class SpanishTranslationPlanStatus(StrEnum):
    READY = "ready"
    WAITING_FOR_REVIEW = "waiting_for_review"
    COMPLETE = "complete"
    QUALITY_BLOCKED = "quality_blocked"


class TranslationAdapterError(RuntimeError):
    """A provider-neutral failure that contains no provider response or clinical text."""

    def __init__(self, code: TranslationAdapterFailureCode) -> None:
        if not isinstance(cast(object, code), TranslationAdapterFailureCode):
            raise ValueError("translation adapter failure code is invalid")
        self.code = code
        super().__init__(code.value)

    def __repr__(self) -> str:
        return f"TranslationAdapterError({self.code.value!r})"


class TranslationPreparationError(RuntimeError):
    """A bounded local configuration failure raised before a provider call."""

    def __init__(self, code: TranslationPreparationCode) -> None:
        self.code = code
        super().__init__(code.value)

    def __repr__(self) -> str:
        return f"TranslationPreparationError({self.code.value!r})"


@dataclass(frozen=True, repr=False)
class SpanishToEnglishTranslationRequest:
    """The minimum protected payload exposed to a translation adapter."""

    content: str = field(repr=False)
    source_locale: SourceLocale = field(default=SourceLocale.SPANISH_US, init=False)
    target_locale: SourceLocale = field(default=SourceLocale.ENGLISH_US, init=False)

    def __post_init__(self) -> None:
        if not self.content.strip() or len(self.content) > MAX_TRANSCRIPT_CONTENT_CHARS:
            raise ValueError("translation source content is invalid")

    def __repr__(self) -> str:
        return "SpanishToEnglishTranslationRequest(<protected>)"


@dataclass(frozen=True, repr=False)
class SpanishToEnglishTranslationResult:
    """A successful protected result returned by an adapter."""

    content: str = field(repr=False)

    def __post_init__(self) -> None:
        if not self.content.strip() or len(self.content) > MAX_TRANSCRIPT_CONTENT_CHARS:
            raise ValueError("translation result content is invalid")

    def __repr__(self) -> str:
        return "SpanishToEnglishTranslationResult(<protected>)"


class SpanishToEnglishTranslationAdapter(Protocol):
    """Provider-neutral, manually selected es-US to en-US translation boundary."""

    @property
    def adapter_id(self) -> str: ...

    @property
    def model_profile_id(self) -> str: ...

    async def translate(
        self,
        request: SpanishToEnglishTranslationRequest,
    ) -> SpanishToEnglishTranslationResult: ...


@dataclass(frozen=True, repr=False)
class ReservedSpanishTranslation:
    """Durable caller-owned reservation for exactly one Spanish source version."""

    translation_id: UUID
    expected_source_transcript_version: int
    source_segment_id: UUID
    expected_source_segment_version: int
    expected_previous_translation_version: int
    source_locale: SourceLocale
    source_content: str = field(repr=False)

    def __post_init__(self) -> None:
        if self.expected_source_transcript_version < 1:
            raise ValueError("expected source transcript version must be positive")
        if self.expected_source_segment_version < 1:
            raise ValueError("expected source segment version must be positive")
        if self.expected_previous_translation_version < 0:
            raise ValueError("expected previous translation version cannot be negative")
        if (
            not isinstance(cast(object, self.source_locale), SourceLocale)
            or self.source_locale != SourceLocale.SPANISH_US
        ):
            raise ValueError("reserved translation source locale must be es-US")
        if (
            not self.source_content.strip()
            or len(self.source_content) > MAX_TRANSCRIPT_CONTENT_CHARS
        ):
            raise ValueError("reserved translation source content is invalid")

    def __repr__(self) -> str:
        return "ReservedSpanishTranslation(<protected>)"


@dataclass(frozen=True, repr=False)
class SpanishTranslationCandidate:
    """Current source lineage eligible for a new provider attempt."""

    expected_source_transcript_version: int
    source_segment_id: UUID
    expected_source_segment_version: int
    expected_previous_translation_version: int
    source_locale: SourceLocale
    source_content: str = field(repr=False)

    def __post_init__(self) -> None:
        if self.expected_source_transcript_version < 1:
            raise ValueError("expected source transcript version must be positive")
        if self.expected_source_segment_version < 1:
            raise ValueError("expected source segment version must be positive")
        if self.expected_previous_translation_version < 0:
            raise ValueError("expected previous translation version cannot be negative")
        if (
            not isinstance(cast(object, self.source_locale), SourceLocale)
            or self.source_locale != SourceLocale.SPANISH_US
        ):
            raise ValueError("translation candidate source locale must be es-US")
        if (
            not self.source_content.strip()
            or len(self.source_content) > MAX_TRANSCRIPT_CONTENT_CHARS
        ):
            raise ValueError("translation candidate source content is invalid")

    def reserve(self, translation_id: UUID) -> ReservedSpanishTranslation:
        return ReservedSpanishTranslation(
            translation_id=translation_id,
            expected_source_transcript_version=self.expected_source_transcript_version,
            source_segment_id=self.source_segment_id,
            expected_source_segment_version=self.expected_source_segment_version,
            expected_previous_translation_version=(
                self.expected_previous_translation_version
            ),
            source_locale=self.source_locale,
            source_content=self.source_content,
        )

    def __repr__(self) -> str:
        return "SpanishTranslationCandidate(<protected>)"


@dataclass(frozen=True, repr=False)
class SpanishTranslationPlan:
    status: SpanishTranslationPlanStatus
    candidates: tuple[SpanishTranslationCandidate, ...] = field(default=(), repr=False)

    def __post_init__(self) -> None:
        if not isinstance(cast(object, self.status), SpanishTranslationPlanStatus):
            raise ValueError("translation plan status is invalid")
        if self.status == SpanishTranslationPlanStatus.READY:
            if not self.candidates:
                raise ValueError("ready translation plan requires candidates")
        elif self.candidates:
            raise ValueError("non-ready translation plan cannot contain candidates")

    def __repr__(self) -> str:
        return (
            "SpanishTranslationPlan("
            f"status={self.status.value!r}, candidate_count={len(self.candidates)})"
        )


def plan_spanish_translation_work(
    bundle: ExternalTranscriptBundleV1,
) -> SpanishTranslationPlan:
    """Select current Spanish segments without inferring language or minting identities."""

    working = build_english_working_transcript(bundle)
    quality_blockers = {
        WorkingTranscriptBlockerCode.SOURCE_LOCALE_UNKNOWN,
        WorkingTranscriptBlockerCode.SOURCE_OVERLAP,
    }
    if any(blocker.code in quality_blockers for blocker in working.blockers):
        return SpanishTranslationPlan(status=SpanishTranslationPlanStatus.QUALITY_BLOCKED)

    translations_by_source = {
        source.source_segment_id: sorted(
            (
                translation
                for translation in bundle.translations
                if translation.source_segment_id == source.source_segment_id
                and translation.source_segment_version == source.source_segment_version
            ),
            key=lambda translation: translation.translation_version,
        )
        for source in bundle.source_transcript.segments
    }
    reviews_by_translation = {
        (review.translation_id, review.translation_version): review
        for review in bundle.translation_reviews
    }
    accepted_source_ids = {
        review.source_segment_id
        for review in bundle.translation_reviews
        if review.decision == TranslationReviewDecision.ACCEPTED
    }
    waiting_for_review = False
    candidates: list[SpanishTranslationCandidate] = []
    for source in bundle.source_transcript.segments:
        if (
            source.source_locale != SourceLocale.SPANISH_US
            or source.source_segment_id in accepted_source_ids
        ):
            continue
        attempts = translations_by_source[source.source_segment_id]
        latest = attempts[-1] if attempts else None
        if latest is not None and latest.outcome == TranslationOutcome.SUCCEEDED:
            review = reviews_by_translation.get(
                (latest.translation_id, latest.translation_version)
            )
            if review is None:
                waiting_for_review = True
                continue
            if review.decision != TranslationReviewDecision.REJECTED:
                continue
        candidates.append(
            SpanishTranslationCandidate(
                expected_source_transcript_version=(
                    bundle.source_transcript.source_transcript_version
                ),
                source_segment_id=source.source_segment_id,
                expected_source_segment_version=source.source_segment_version,
                expected_previous_translation_version=(
                    latest.translation_version if latest is not None else 0
                ),
                source_locale=source.source_locale,
                source_content=source.content,
            )
        )

    if candidates:
        return SpanishTranslationPlan(
            status=SpanishTranslationPlanStatus.READY,
            candidates=tuple(candidates),
        )
    if waiting_for_review:
        return SpanishTranslationPlan(status=SpanishTranslationPlanStatus.WAITING_FOR_REVIEW)
    return SpanishTranslationPlan(status=SpanishTranslationPlanStatus.COMPLETE)


def _adapter_profile(
    adapter: SpanishToEnglishTranslationAdapter,
) -> tuple[str, str]:
    failed = False
    try:
        raw_adapter_id = cast(object, adapter.adapter_id)
        raw_model_profile_id = cast(object, adapter.model_profile_id)
    except Exception:
        failed = True
        raw_adapter_id = ""
        raw_model_profile_id = ""
    if (
        failed
        or not isinstance(raw_adapter_id, str)
        or not isinstance(raw_model_profile_id, str)
        or _SAFE_IDENTIFIER.fullmatch(raw_adapter_id) is None
        or _SAFE_IDENTIFIER.fullmatch(raw_model_profile_id) is None
    ):
        raise TranslationPreparationError(
            TranslationPreparationCode.ADAPTER_CONFIGURATION_INVALID
        ) from None
    return raw_adapter_id, raw_model_profile_id


def _failed_attempt(
    reservation: ReservedSpanishTranslation,
    *,
    adapter_id: str,
    model_profile_id: str,
    code: TranslationAdapterFailureCode,
) -> TranslationAttemptCommand:
    return TranslationAttemptCommand(
        translation_id=reservation.translation_id,
        expected_source_transcript_version=reservation.expected_source_transcript_version,
        source_segment_id=reservation.source_segment_id,
        expected_source_segment_version=reservation.expected_source_segment_version,
        expected_previous_translation_version=(
            reservation.expected_previous_translation_version
        ),
        outcome=TranslationOutcome.FAILED,
        translation_adapter_id=adapter_id,
        translation_model_profile_id=model_profile_id,
        failure_code=code.value,
    )


async def prepare_spanish_to_english_attempt(
    adapter: SpanishToEnglishTranslationAdapter,
    reservation: ReservedSpanishTranslation,
) -> TranslationAttemptCommand:
    """Call an adapter once and convert its outcome into immutable bounded evidence.

    The caller persists the returned command verbatim with the transaction-owning writer. A
    resumable worker must durably retain that command before retrying a database commit; it must
    never call the provider again to reconcile an ambiguous commit.
    """

    adapter_id, model_profile_id = _adapter_profile(adapter)
    request = SpanishToEnglishTranslationRequest(content=reservation.source_content)
    failure_code: TranslationAdapterFailureCode | None = None
    result: SpanishToEnglishTranslationResult | None = None
    try:
        candidate = cast(object, await adapter.translate(request))
        if isinstance(candidate, SpanishToEnglishTranslationResult):
            result = candidate
        else:
            failure_code = TranslationAdapterFailureCode.RESPONSE_INVALID
    except TranslationAdapterError as error:
        failure_code = error.code
    except TimeoutError:
        failure_code = TranslationAdapterFailureCode.PROVIDER_TIMEOUT
    except Exception:
        failure_code = TranslationAdapterFailureCode.PROVIDER_UNAVAILABLE

    if failure_code is not None or result is None:
        return _failed_attempt(
            reservation,
            adapter_id=adapter_id,
            model_profile_id=model_profile_id,
            code=failure_code or TranslationAdapterFailureCode.RESPONSE_INVALID,
        )
    return TranslationAttemptCommand(
        translation_id=reservation.translation_id,
        expected_source_transcript_version=reservation.expected_source_transcript_version,
        source_segment_id=reservation.source_segment_id,
        expected_source_segment_version=reservation.expected_source_segment_version,
        expected_previous_translation_version=(
            reservation.expected_previous_translation_version
        ),
        outcome=TranslationOutcome.SUCCEEDED,
        translation_adapter_id=adapter_id,
        translation_model_profile_id=model_profile_id,
        content=result.content,
    )
