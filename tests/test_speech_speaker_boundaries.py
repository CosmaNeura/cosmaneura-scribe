"""Synthetic provider contract regressions, not a live diarization evaluation."""

from __future__ import annotations

import asyncio
import json
import wave
from dataclasses import asdict
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.azure_speech_source import normalize_azure_source
from cosmaneura_scribe.external_transcript_v1 import TranscriptLanguageMode
from cosmaneura_scribe.schemas import CaptureChannel, SpeakerRole
from cosmaneura_scribe.speech_observation import SpeechBoundaryObservation
from cosmaneura_scribe.transcription import AudioTrack, AzureSpeechTranscriber, TranscriptionRequest
from test_normalized_source_persistence import _consent, _draft, _seed_configured_session
from test_transcription import FakeAzureClient, _result


@pytest.mark.parametrize(
    "speakers,expected", [([0, 1, 0, 2], [0, 1, 0, 2]), ([None, None, 0, None], [0, 0, 1, 0])]
)
def test_mixed_track_provider_normalization_and_persistence_preserve_identity(
    tmp_path: Path,
    repository_backend: RepositoryBackend,
    speakers: list[int | None],
    expected: list[int],
) -> None:
    tenant_id, consent = uuid4(), _consent()
    draft = _draft(consent, language_mode=TranscriptLanguageMode.ENGLISH)
    path = tmp_path / "synthetic.wav"
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(b"\x01\x00" * 16000)
    response = _result(text="synthetic", speaker=0, offset_ms=0, duration_ms=100, confidence=1)
    response.phrases = [
        _result(
            text="private synthetic phrase",
            speaker=speaker,
            offset_ms=index * 200,
            duration_ms=100,
            confidence=1,
        ).phrases[0]
        for index, speaker in enumerate(speakers)
    ]
    response.duration_milliseconds = 1000
    client = FakeAzureClient([response])
    observations: list[SpeechBoundaryObservation] = []
    provider = AzureSpeechTranscriber(client, max_speakers=4, observer=observations.append)

    async def scenario() -> None:
        # Real repository consent precedes even this fake-provider processing path.
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        result = await provider.transcribe(
            TranscriptionRequest(
                draft.id, consent.id, "en-US", (AudioTrack(uuid4(), CaptureChannel.MIXED, path),)
            )
        )
        normalized = normalize_azure_source(result)
        assert [segment.speaker_slot for segment in normalized.segments] == expected
        assert all(segment.speaker_role == SpeakerRole.UNKNOWN for segment in normalized.segments)
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="speaker-boundary-synthetic-0001",
                request=normalized,
            )
            current = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
        assert current is not None
        labels: dict[UUID, int] = {}
        assert [
            labels.setdefault(segment.speaker_id, len(labels) + 1) for segment in current.segments
        ] == [slot + 1 for slot in expected]
        assert all(segment.speaker_role == SpeakerRole.UNKNOWN for segment in current.segments)
        assert len(labels) == len(set(expected))
        await provider.close()

    asyncio.run(scenario())
    observation = asdict(observations[0])
    assert observation["max_speakers"] == 4
    assert observation["phrase_count"] == 4
    assert observation["missing_speaker_count"] == speakers.count(None)
    assert observation["distinct_non_null_speaker_count"] == len(set(speakers) - {None})
    assert observation["wave_header"] == {
        "channels": 1,
        "sample_rate_hz": 16000,
        "sample_width_bits": 16,
        "format_code": 1,
    }
    assert observation["accepted_distinct_speaker_count"] == len(set(speakers))
    assert "private synthetic phrase" not in json.dumps(observation)
    assert str(path) not in json.dumps(observation)
    assert client.requests[0].definition.diarization_options is not None
    assert client.requests[0].definition.diarization_options.max_speakers == 4
    assert client.requests[0].definition.active_channels is None
