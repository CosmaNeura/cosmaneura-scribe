from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol, cast
from uuid import UUID

from .external_transcript_v1 import SourceLocale, TranslationOutcome
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
