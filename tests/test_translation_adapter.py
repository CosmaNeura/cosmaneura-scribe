from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import cast
from uuid import uuid4

import pytest
from cosmaneura_scribe.external_transcript_v1 import (
    ExternalTranscriptBundleV1,
    SourceLocale,
    TranslationOutcome,
    TranslationReviewDecision,
)
from cosmaneura_scribe.translation_adapter import (
    ReservedSpanishTranslation,
    SpanishToEnglishTranslationAdapter,
    SpanishToEnglishTranslationRequest,
    SpanishToEnglishTranslationResult,
    SpanishTranslationPlanStatus,
    TranslationAdapterError,
    TranslationAdapterFailureCode,
    TranslationPreparationCode,
    TranslationPreparationError,
    plan_spanish_translation_work,
    prepare_spanish_to_english_attempt,
)
from test_external_transcript_v1 import (
    UNKNOWN_SEGMENT_ID,
    WORKING_TRANSCRIPT_ID,
    _bilingual_source,
    _review,
    _segment,
    _source,
    _translation,
)

_SOURCE_MARKER = "Contenido clinico sintetico en espanol."
_RESULT_MARKER = "Synthetic clinical content in English."


class _DeterministicAdapter:
    adapter_id = "synthetic_es_en_adapter"
    model_profile_id = "synthetic_es_en_profile_v1"

    def __init__(
        self,
        *,
        result: SpanishToEnglishTranslationResult | None = None,
        error: BaseException | None = None,
    ) -> None:
        self.result = result or SpanishToEnglishTranslationResult(content=_RESULT_MARKER)
        self.error = error
        self.requests: list[SpanishToEnglishTranslationRequest] = []

    async def translate(
        self,
        request: SpanishToEnglishTranslationRequest,
    ) -> SpanishToEnglishTranslationResult:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return self.result


class _InvalidProfileAdapter(_DeterministicAdapter):
    adapter_id = "invalid adapter id"


class _InvalidResponseAdapter(_DeterministicAdapter):
    async def translate(  # type: ignore[override]
        self,
        request: SpanishToEnglishTranslationRequest,
    ) -> object:
        self.requests.append(request)
        return object()


def _reservation() -> ReservedSpanishTranslation:
    return ReservedSpanishTranslation(
        translation_id=uuid4(),
        expected_source_transcript_version=2,
        source_segment_id=uuid4(),
        expected_source_segment_version=3,
        expected_previous_translation_version=1,
        source_locale=SourceLocale.SPANISH_US,
        source_content=_SOURCE_MARKER,
    )


def _bundle(*, translations: tuple = (), reviews: tuple = ()) -> ExternalTranscriptBundleV1:
    return ExternalTranscriptBundleV1(
        source_transcript=_bilingual_source(),
        translations=translations,
        translation_reviews=reviews,
        working_transcript_id=WORKING_TRANSCRIPT_ID,
        working_transcript_version=1,
    )


@pytest.mark.asyncio
async def test_success_is_a_fixed_direction_immutable_attempt() -> None:
    adapter = _DeterministicAdapter()
    reservation = _reservation()

    command = await prepare_spanish_to_english_attempt(adapter, reservation)

    assert len(adapter.requests) == 1
    assert adapter.requests[0].source_locale == SourceLocale.SPANISH_US
    assert adapter.requests[0].target_locale == SourceLocale.ENGLISH_US
    assert adapter.requests[0].content == _SOURCE_MARKER
    assert command.translation_id == reservation.translation_id
    assert command.expected_source_transcript_version == 2
    assert command.source_segment_id == reservation.source_segment_id
    assert command.expected_source_segment_version == 3
    assert command.expected_previous_translation_version == 1
    assert command.outcome == TranslationOutcome.SUCCEEDED
    assert command.content == _RESULT_MARKER
    assert command.failure_code is None
    assert command.translation_adapter_id == adapter.adapter_id
    assert command.translation_model_profile_id == adapter.model_profile_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (
            TranslationAdapterError(TranslationAdapterFailureCode.PROVIDER_REJECTED),
            TranslationAdapterFailureCode.PROVIDER_REJECTED,
        ),
        (TimeoutError("protected timeout detail"), TranslationAdapterFailureCode.PROVIDER_TIMEOUT),
        (
            RuntimeError("protected provider detail"),
            TranslationAdapterFailureCode.PROVIDER_UNAVAILABLE,
        ),
    ],
)
async def test_provider_failures_become_bounded_failed_attempts(
    error: BaseException,
    expected_code: TranslationAdapterFailureCode,
) -> None:
    adapter = _DeterministicAdapter(error=error)

    command = await prepare_spanish_to_english_attempt(adapter, _reservation())

    assert len(adapter.requests) == 1
    assert command.outcome == TranslationOutcome.FAILED
    assert command.content is None
    assert command.failure_code == expected_code.value
    assert "timeout detail" not in repr(command)
    assert "provider detail" not in repr(command)


@pytest.mark.asyncio
async def test_invalid_adapter_response_is_bounded() -> None:
    adapter = _InvalidResponseAdapter()

    command = await prepare_spanish_to_english_attempt(
        cast(SpanishToEnglishTranslationAdapter, adapter),
        _reservation(),
    )

    assert len(adapter.requests) == 1
    assert command.outcome == TranslationOutcome.FAILED
    assert command.failure_code == TranslationAdapterFailureCode.RESPONSE_INVALID.value


@pytest.mark.asyncio
async def test_invalid_adapter_profile_fails_before_provider_call() -> None:
    adapter = _InvalidProfileAdapter()

    with pytest.raises(TranslationPreparationError) as caught:
        await prepare_spanish_to_english_attempt(adapter, _reservation())

    assert caught.value.code == TranslationPreparationCode.ADAPTER_CONFIGURATION_INVALID
    assert adapter.requests == []
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__


@pytest.mark.asyncio
async def test_cancellation_is_not_converted_to_a_failed_attempt() -> None:
    adapter = _DeterministicAdapter(error=asyncio.CancelledError())

    with pytest.raises(asyncio.CancelledError):
        await prepare_spanish_to_english_attempt(adapter, _reservation())

    assert len(adapter.requests) == 1


def test_protected_values_are_hidden_and_reservation_is_strict() -> None:
    request = SpanishToEnglishTranslationRequest(content=_SOURCE_MARKER)
    result = SpanishToEnglishTranslationResult(content=_RESULT_MARKER)
    reservation = _reservation()

    assert _SOURCE_MARKER not in repr(request)
    assert _RESULT_MARKER not in repr(result)
    assert _SOURCE_MARKER not in repr(reservation)
    with pytest.raises(ValueError, match="source content is invalid"):
        replace(reservation, source_content="   ")
    with pytest.raises(ValueError, match="source locale must be es-US"):
        replace(reservation, source_locale=SourceLocale.ENGLISH_US)


def test_planner_selects_missing_spanish_and_reserves_exact_lineage() -> None:
    plan = plan_spanish_translation_work(_bundle())

    assert plan.status == SpanishTranslationPlanStatus.READY
    assert len(plan.candidates) == 1
    candidate = plan.candidates[0]
    assert candidate.expected_source_transcript_version == 1
    assert candidate.expected_source_segment_version == 1
    assert candidate.expected_previous_translation_version == 0
    assert candidate.source_locale == SourceLocale.SPANISH_US
    assert candidate.source_content == "Me siento mejor hoy."
    assert candidate.source_content not in repr(candidate)
    reservation = candidate.reserve(uuid4())
    assert reservation.source_segment_id == candidate.source_segment_id
    assert reservation.source_content == candidate.source_content


@pytest.mark.parametrize(
    ("translations", "reviews", "expected_status", "expected_previous_version"),
    [
        (
            (_translation(),),
            (),
            SpanishTranslationPlanStatus.WAITING_FOR_REVIEW,
            None,
        ),
        (
            (
                _translation(
                    outcome=TranslationOutcome.FAILED,
                    content=None,
                    failure_code="provider_timeout",
                ),
            ),
            (),
            SpanishTranslationPlanStatus.READY,
            1,
        ),
        (
            (_translation(),),
            (_review(decision=TranslationReviewDecision.REJECTED),),
            SpanishTranslationPlanStatus.READY,
            1,
        ),
        (
            (_translation(),),
            (_review(),),
            SpanishTranslationPlanStatus.COMPLETE,
            None,
        ),
    ],
)
def test_planner_distinguishes_review_wait_retry_and_completion(
    translations: tuple,
    reviews: tuple,
    expected_status: SpanishTranslationPlanStatus,
    expected_previous_version: int | None,
) -> None:
    plan = plan_spanish_translation_work(_bundle(translations=translations, reviews=reviews))

    assert plan.status == expected_status
    if expected_previous_version is None:
        assert plan.candidates == ()
    else:
        assert len(plan.candidates) == 1
        assert plan.candidates[0].expected_previous_translation_version == expected_previous_version


def test_planner_stops_before_provider_work_when_source_quality_is_blocked() -> None:
    source = _source(
        _segment(
            UNKNOWN_SEGMENT_ID,
            locale=SourceLocale.UNKNOWN,
            content="Synthetic unresolved source.",
            start_ms=0,
            end_ms=500,
        )
    )
    bundle = ExternalTranscriptBundleV1(
        source_transcript=source,
        working_transcript_id=WORKING_TRANSCRIPT_ID,
        working_transcript_version=1,
    )

    plan = plan_spanish_translation_work(bundle)

    assert plan.status == SpanishTranslationPlanStatus.QUALITY_BLOCKED
    assert plan.candidates == ()
