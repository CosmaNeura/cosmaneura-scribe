from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from cosmaneura_scribe.azure_speech_source import normalize_azure_source
from cosmaneura_scribe.external_transcript_v1 import SourceLocale, TranscriptLanguageMode
from cosmaneura_scribe.schemas import CaptureChannel, SpeakerRole
from cosmaneura_scribe.transcription import (
    AudioTrack,
    AzureSpeechTranscriber,
    SttResult,
    SttSegment,
    TranscriptionInputError,
    TranscriptionRequest,
)
from test_transcription import FakeAzureClient, FakeEndpointGuard, _result


@pytest.mark.asyncio
async def test_bilingual_candidate_locales_and_phrase_evidence_reach_normalized_source(
    tmp_path: Path,
) -> None:
    path = tmp_path / "invented-audio.wav"
    path.write_bytes(b"synthetic fixture")
    english = _result(
        text="Do you have a fever?", speaker=1, offset_ms=0, duration_ms=300, confidence=0.98
    )
    spanish = _result(
        text="No tengo fiebre.", speaker=1, offset_ms=500, duration_ms=300, confidence=0.91
    )
    spanish.phrases[0].locale = "es-US"
    client, guard = FakeAzureClient([english, spanish]), FakeEndpointGuard()
    provider = AzureSpeechTranscriber(client, max_speakers=4, endpoint_guard=guard)
    result = await provider.transcribe(
        TranscriptionRequest(
            session_id=uuid4(),
            consent_record_id=uuid4(),
            language_code=TranscriptLanguageMode.ENGLISH_SPANISH,
            tracks=(
                AudioTrack(uuid4(), CaptureChannel.MICROPHONE, path),
                AudioTrack(uuid4(), CaptureChannel.SYSTEM_AUDIO, path),
            ),
        )
    )
    await provider.close()
    assert guard.calls == 2
    assert all(request.definition.locales == ["en-US", "es-US"] for request in client.requests)
    normalized = normalize_azure_source(result)
    assert [s.source_locale for s in normalized.segments] == [
        SourceLocale.ENGLISH_US,
        SourceLocale.SPANISH_US,
    ]
    assert [s.speaker_slot for s in normalized.segments] == [0, 1]
    assert all(s.speaker_role == SpeakerRole.UNKNOWN for s in normalized.segments)
    assert all(s.locale_confidence is None for s in normalized.segments)
    assert normalized.segments[1].content == "No tengo fiebre."
    assert normalized.segments[1].start_ms == 500
    assert "fiebre" not in repr(normalized)


@pytest.mark.asyncio
@pytest.mark.parametrize("locale", [None, "es-MX", "de-DE", "unexpected-private-text"])
async def test_missing_or_unsupported_locale_is_not_inferred_from_hint_or_confidence(
    tmp_path: Path,
    locale: str | None,
) -> None:
    path = tmp_path / "invented.wav"
    path.write_bytes(b"synthetic fixture")
    response = _result(
        text="Synthetic text", speaker=1, offset_ms=0, duration_ms=300, confidence=1.0
    )
    response.phrases[0].locale = locale
    client = FakeAzureClient([response])
    provider = AzureSpeechTranscriber(client, max_speakers=4)
    result = await provider.transcribe(
        TranscriptionRequest(
            session_id=uuid4(),
            consent_record_id=uuid4(),
            language_code="en-US",
            tracks=(AudioTrack(uuid4(), CaptureChannel.MIXED, path),),
        )
    )
    normalized = normalize_azure_source(result)
    assert client.requests[0].definition.locales == ["en-US"]
    assert normalized.segments[0].source_locale == SourceLocale.UNKNOWN
    assert normalized.segments[0].locale_confidence is None
    assert "unexpected-private-text" not in repr(result)


def _speech() -> SttResult:
    return SttResult(
        "azure_ai_speech",
        "en-US+es-US",
        1000,
        (
            SttSegment(
                CaptureChannel.MIXED,
                "same",
                0,
                200,
                0.9,
                "No tengo fiebre.",
                SourceLocale.SPANISH_US,
            ),
            SttSegment(
                CaptureChannel.MIXED, "same", 300, 500, 0.8, "No pain.", SourceLocale.ENGLISH_US
            ),
        ),
    )


def test_one_speaker_can_switch_language_without_becoming_another_person() -> None:
    source = normalize_azure_source(_speech())
    assert [s.speaker_slot for s in source.segments] == [0, 0]
    assert source.segments[0].source_locale != source.segments[1].source_locale


@pytest.mark.parametrize(
    "change",
    [
        {"provider": "not-azure"},
        {"language_code": "es-US"},
        {"language_code": "en-US"},
        {"duration_ms": 100},
        {"segments": ()},
    ],
)
def test_invalid_result_or_mode_cannot_become_source(change) -> None:
    with pytest.raises(TranscriptionInputError) as caught:
        normalize_azure_source(replace(_speech(), **change))
    assert "fiebre" not in str(caught.value)


def test_bridge_does_not_reorder_or_clip_invalid_provider_timestamps() -> None:
    result = _speech()
    with pytest.raises(TranscriptionInputError, match="speech_source_result_invalid"):
        normalize_azure_source(replace(result, segments=tuple(reversed(result.segments))))
