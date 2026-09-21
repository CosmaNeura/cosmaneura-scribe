"""Opt-in bridge from actual Azure phrase evidence to the versioned receiver.

The explicit captured worker uses this bridge; no environment registers it by
default. The legacy transcript writer does not persist phrase locales and must
not be used for the bilingual source handoff.
An integration must call this bridge before the consent/tenant-scoped receiver;
normalization alone is neither authorization nor durable acceptance.
"""

from __future__ import annotations

from pydantic import ValidationError

from .external_transcript_v1 import (
    NormalizedSourceTranscriptRequestV1,
    NormalizedSourceTranscriptSegmentV1,
    SourceLocale,
    TranscriptLanguageMode,
)
from .schemas import CaptureChannel, SpeakerRole
from .transcription import SttResult, TranscriptionInputError

AZURE_SOURCE_NORMALIZATION_PROFILE = "azure_phrase_en_es_evidence_v1"


def normalize_azure_source(result: SttResult) -> NormalizedSourceTranscriptRequestV1:
    """Retain exact source text/times/locale without inferring who or what was said.

Azure supplies recognition confidence but no phrase-language confidence in the
selected SDK contract. Leave locale_confidence unset. Unexpected/missing locale
evidence stays unknown and the existing working projection blocks note readiness.
Speaker IDs are scoped to tracks; the same provider ID on two tracks is not proof
that the two people are the same. Only explicit later review can assign roles.
"""
    if result.provider != "azure_ai_speech" or result.language_code not in {
        TranscriptLanguageMode.ENGLISH,
        TranscriptLanguageMode.ENGLISH_SPANISH,
    }:
        raise TranscriptionInputError("speech_source_profile_invalid")
    if result.language_code == TranscriptLanguageMode.ENGLISH and any(
        segment.source_locale == SourceLocale.SPANISH_US for segment in result.segments
    ):
        raise TranscriptionInputError("speech_source_language_mode_conflict")

    slots: dict[tuple[CaptureChannel, str], int] = {}
    segments: list[NormalizedSourceTranscriptSegmentV1] = []
    try:
        for segment in result.segments:
            key = (segment.channel, segment.provider_speaker_id)
            slot = slots.setdefault(key, len(slots))
            segments.append(NormalizedSourceTranscriptSegmentV1(
                speaker_slot=slot,
                speaker_role=SpeakerRole.UNKNOWN,
                source_locale=segment.source_locale,
                content=segment.content,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                locale_confidence=None,
            ))
        return NormalizedSourceTranscriptRequestV1(
            schema_version="1.0", duration_ms=result.duration_ms, segments=tuple(segments),
        )
    except ValidationError:
        raise TranscriptionInputError("speech_source_result_invalid") from None
