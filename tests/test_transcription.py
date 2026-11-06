from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import pytest
from aiohttp import web
from azure.ai.transcription.aio import TranscriptionClient
from azure.ai.transcription.models import (
    TranscribedPhrase,
    TranscriptionContent,
    TranscriptionResult,
)
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import (
    ClientAuthenticationError,
    DecodeError,
    HttpResponseError,
    ServiceRequestError,
    ServiceResponseError,
)
from cosmaneura_scribe import transcription
from cosmaneura_scribe.schemas import CaptureChannel
from cosmaneura_scribe.settings import Settings
from cosmaneura_scribe.transcription import (
    SPEECH_DEADLINE_SECONDS,
    SPEECH_READ_TIMEOUT_SECONDS,
    AudioTrack,
    AzureSpeechProviderError,
    AzureSpeechTranscriber,
    SttResult,
    SttSegment,
    TranscriptionInputError,
    TranscriptionRequest,
)
from cosmaneura_scribe.transcription_benchmark import (
    BenchmarkManifest,
    encode_results,
    load_manifest,
    run_benchmark,
    word_error_rate,
)
from pydantic import ValidationError


def _result(
    *,
    text: str,
    speaker: int | None,
    offset_ms: int,
    duration_ms: int,
    confidence: float,
) -> TranscriptionResult:
    return TranscriptionResult(
        duration_milliseconds=offset_ms + duration_ms,
        combined_phrases=[],
        phrases=[
            TranscribedPhrase(
                channel=0,
                speaker=speaker,
                offset_milliseconds=offset_ms,
                duration_milliseconds=duration_ms,
                text=text,
                words=None,
                locale="en-US",
                confidence=confidence,
            )
        ],
    )


class FakeAzureClient:
    def __init__(self, results: list[TranscriptionResult]) -> None:
        self.results = iter(results)
        self.requests: list[TranscriptionContent] = []
        self.closed = False

    async def transcribe(self, body: TranscriptionContent, **kwargs: object) -> TranscriptionResult:
        assert kwargs == {
            "logging_enable": False,
            "read_timeout": SPEECH_READ_TIMEOUT_SECONDS,
        }
        self.requests.append(body)
        return next(self.results)

    async def close(self) -> None:
        self.closed = True


class FailingAzureClient(FakeAzureClient):
    def __init__(self, failure: Exception) -> None:
        super().__init__([])
        self.failure = failure

    async def transcribe(self, body: TranscriptionContent, **kwargs: object) -> TranscriptionResult:
        del body, kwargs
        raise self.failure


class FakeProvider:
    @property
    def name(self) -> str:
        return "fixture_stt"

    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        return SttResult(
            provider=self.name,
            language_code=request.language_code,
            duration_ms=2_000,
            segments=(
                SttSegment(
                    channel=request.tracks[0].channel,
                    provider_speaker_id="speaker-1",
                    start_ms=0,
                    end_ms=2_000,
                    confidence=0.95,
                    content="Deidentified clinical fixture",
                ),
            ),
        )

    async def close(self) -> None:
        return None


class FakeEndpointGuard:
    def __init__(self, *, failure: Exception | None = None) -> None:
        self.calls = 0
        self.failure = failure

    async def verify(self) -> None:
        self.calls += 1
        if self.failure is not None:
            raise self.failure


def test_azure_adapter_constructs_async_managed_identity_transport() -> None:
    provider = AzureSpeechTranscriber.from_settings(
        Settings(
            managed_identity_client_id=uuid4(),
            transcription_backend="azure",
            azure_speech_endpoint="https://cosmaneura-scribe-test.cognitiveservices.azure.com",
            azure_speech_private_endpoint_cidrs=("10.42.1.6/32",),
        )
    )

    assert provider.name == "azure_ai_speech"
    asyncio.run(provider.close())


def test_azure_adapter_preserves_channel_speaker_and_timing_without_repr_leak(
    tmp_path: Path,
) -> None:
    microphone_path = tmp_path / "sensitive-microphone-name.wav"
    system_path = tmp_path / "sensitive-system-name.wav"
    microphone_path.write_bytes(b"fixture")
    system_path.write_bytes(b"fixture")
    client = FakeAzureClient(
        [
            _result(
                text="Clinician fixture text",
                speaker=2,
                offset_ms=500,
                duration_ms=500,
                confidence=1.2,
            ),
            _result(
                text="Patient fixture text",
                speaker=None,
                offset_ms=0,
                duration_ms=400,
                confidence=0.8,
            ),
        ]
    )
    provider = AzureSpeechTranscriber(client, max_speakers=4)
    request = TranscriptionRequest(
        session_id=uuid4(),
        consent_record_id=uuid4(),
        language_code="en-US",
        tracks=(
            AudioTrack(uuid4(), CaptureChannel.MICROPHONE, microphone_path),
            AudioTrack(uuid4(), CaptureChannel.SYSTEM_AUDIO, system_path),
        ),
    )

    result = asyncio.run(provider.transcribe(request))
    asyncio.run(provider.close())

    assert [segment.channel for segment in result.segments] == [
        CaptureChannel.SYSTEM_AUDIO,
        CaptureChannel.MICROPHONE,
    ]
    assert result.segments[0].provider_speaker_id == "channel-system_audio"
    assert result.segments[1].provider_speaker_id == "2"
    assert result.segments[1].confidence == 1.0
    assert client.closed is True
    representation = repr((request, result))
    assert "sensitive-" not in representation
    assert "fixture text" not in representation


def test_benchmark_emits_metrics_without_paths_or_transcript(tmp_path: Path) -> None:
    audio_path = tmp_path / "do-not-log-audio.wav"
    reference_path = tmp_path / "do-not-log-reference.txt"
    manifest_path = tmp_path / "manifest.json"
    audio_path.write_bytes(b"fixture")
    reference_path.write_text("Deidentified clinical reference", encoding="utf-8")
    manifest_path.write_text(
        """
        {
          "schema_version": "1.0",
          "deidentified": true,
          "cases": [{
            "case_id": "sample-001",
            "consent_record_id": "00000000-0000-4000-8000-000000000001",
            "consent_verified": true,
            "source_kind": "synthetic",
            "audio_path": "do-not-log-audio.wav",
            "reference_path": "do-not-log-reference.txt",
            "language_code": "en-US",
            "channel": "mixed"
          }]
        }
        """,
        encoding="utf-8",
    )

    manifest = load_manifest(manifest_path)
    results = asyncio.run(run_benchmark(manifest, FakeProvider()))
    encoded = encode_results(results)

    assert results[0].case_id == "sample-001"
    assert results[0].word_error_rate > 0
    assert "do-not-log" not in encoded
    assert "Deidentified" not in encoded


def test_missing_audio_error_does_not_expose_local_path(tmp_path: Path) -> None:
    missing_path = tmp_path / "sensitive-patient-audio.wav"
    provider = AzureSpeechTranscriber(FakeAzureClient([]), max_speakers=4)
    request = TranscriptionRequest(
        session_id=uuid4(),
        consent_record_id=uuid4(),
        language_code="en-US",
        tracks=(AudioTrack(uuid4(), CaptureChannel.MIXED, missing_path),),
    )

    with pytest.raises(TranscriptionInputError) as exception:
        asyncio.run(provider.transcribe(request))

    assert str(exception.value) == "audio track unavailable"
    assert "sensitive-patient" not in repr(exception.value)


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.reason = "unsafe response detail"


@pytest.mark.parametrize(
    ("failure", "expected_code"),
    [
        (
            ClientAuthenticationError(message="unsafe credential detail"),
            "speech_credential_unavailable",
        ),
        (
            ServiceRequestError("unsafe transport detail"),
            "speech_service_transport_error",
        ),
        (
            ServiceResponseError("unsafe response detail"),
            "speech_service_response_error",
        ),
        (DecodeError("unsafe decode detail"), "speech_service_response_error"),
        (
            HttpResponseError(
                message="unsafe request detail",
                response=_Response(400),  # type: ignore[arg-type]
            ),
            "speech_request_rejected",
        ),
        (
            HttpResponseError(
                message="unsafe authorization detail",
                response=_Response(403),  # type: ignore[arg-type]
            ),
            "speech_authorization_rejected",
        ),
        (
            HttpResponseError(
                message="unsafe throttle detail",
                response=_Response(429),  # type: ignore[arg-type]
            ),
            "speech_service_throttled",
        ),
        (
            HttpResponseError(
                message="unsafe server detail",
                response=_Response(503),  # type: ignore[arg-type]
            ),
            "speech_service_unavailable",
        ),
    ],
)
def test_azure_adapter_maps_provider_failures_to_fixed_codes_without_detail(
    tmp_path: Path,
    failure: Exception,
    expected_code: str,
) -> None:
    audio_path = tmp_path / "sensitive-audio-name.wav"
    audio_path.write_bytes(b"fixture")
    provider = AzureSpeechTranscriber(FailingAzureClient(failure), max_speakers=4)
    request = TranscriptionRequest(
        session_id=uuid4(),
        consent_record_id=uuid4(),
        language_code="en-US",
        tracks=(AudioTrack(uuid4(), CaptureChannel.MIXED, audio_path),),
    )

    with pytest.raises(AzureSpeechProviderError, match=f"^{expected_code}$") as caught:
        asyncio.run(provider.transcribe(request))

    representation = repr(caught.value)
    assert "unsafe" not in representation
    assert "sensitive-audio-name" not in representation


def test_azure_adapter_checks_private_endpoint_before_each_egress(tmp_path: Path) -> None:
    audio_path = tmp_path / "synthetic.wav"
    audio_path.write_bytes(b"fixture")
    client = FakeAzureClient(
        [
            _result(
                text="Synthetic fixture",
                speaker=1,
                offset_ms=0,
                duration_ms=500,
                confidence=0.9,
            )
        ]
    )
    guard = FakeEndpointGuard()
    provider = AzureSpeechTranscriber(
        client,
        max_speakers=4,
        endpoint_guard=guard,
    )

    asyncio.run(
        provider.transcribe(
            TranscriptionRequest(
                session_id=uuid4(),
                consent_record_id=uuid4(),
                language_code="en-US",
                tracks=(AudioTrack(uuid4(), CaptureChannel.MIXED, audio_path),),
            )
        )
    )

    assert guard.calls == 1
    assert len(client.requests) == 1


def test_manifest_requires_explicit_deidentification() -> None:
    with pytest.raises(ValidationError):
        BenchmarkManifest.model_validate(
            {
                "schema_version": "1.0",
                "deidentified": False,
                "cases": [
                    {
                        "case_id": "sample-001",
                        "consent_record_id": "00000000-0000-4000-8000-000000000001",
                        "consent_verified": True,
                        "source_kind": "synthetic",
                        "audio_path": "audio.wav",
                        "reference_path": "reference.txt",
                    }
                ],
            }
        )


def test_word_error_rate_handles_substitution_insertion_and_punctuation() -> None:
    assert word_error_rate("One two three", "one four three extra") == pytest.approx(2 / 3)
    assert word_error_rate("Hello, world!", "hello world") == 0


def test_speech_limits_leave_workers_time_to_record_the_failure() -> None:
    root = Path(__file__).resolve().parents[1]
    production = (root / "infra/production_captured_workers.tf").read_text(encoding="utf-8")
    legacy = (root / "infra/transcription_job.tf").read_text(encoding="utf-8")
    smoke = (root / "infra/speech.tf").read_text(encoding="utf-8")
    render = (root / "scripts/render_configured_worker_release.py").read_text(encoding="utf-8")

    assert SPEECH_READ_TIMEOUT_SECONDS < SPEECH_DEADLINE_SECONDS < 7200
    assert 'replica_timeout_in_seconds   = each.key == "speech" ? 7200 : 1800' in production
    assert "replica_timeout_in_seconds   = 7200" in legacy
    assert "replica_timeout_in_seconds   = 7200" in smoke
    assert '"replicaTimeout": 7200 if phase == "speech" else 1800' in render


def _one_track_request(path: Path) -> TranscriptionRequest:
    return TranscriptionRequest(
        session_id=uuid4(),
        consent_record_id=uuid4(),
        language_code="en-US",
        tracks=(AudioTrack(uuid4(), CaptureChannel.MICROPHONE, path),),
    )


def test_deadline_bounds_the_whole_provider_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF")

    class HangingClient(FakeAzureClient):
        async def transcribe(
            self, body: TranscriptionContent, **kwargs: object
        ) -> TranscriptionResult:
            del body, kwargs
            await asyncio.sleep(30)
            raise AssertionError("deadline did not end the call")

    monkeypatch.setattr(transcription, "SPEECH_DEADLINE_SECONDS", 0.01)
    provider = AzureSpeechTranscriber(cast(Any, HangingClient([])), max_speakers=2)

    with pytest.raises(AzureSpeechProviderError, match="speech_service_response_error"):
        asyncio.run(provider.transcribe(_one_track_request(audio)))


def test_read_timeout_reaches_the_real_sdk_transport_without_a_second_post(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF" + bytes(64))
    posts: list[int] = []

    async def silent(request: web.Request) -> web.Response:
        await request.read()
        posts.append(1)
        await asyncio.sleep(1)
        return web.json_response({})

    async def scenario() -> None:
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", silent)
        runner = web.AppRunner(app, shutdown_timeout=0)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = cast(Any, site._server).sockets[0].getsockname()[1]
        client = TranscriptionClient(
            endpoint=f"http://127.0.0.1:{port}",
            credential=AzureKeyCredential("synthetic"),
            logging_enable=False,
        )
        provider = AzureSpeechTranscriber(cast(Any, client), max_speakers=2)
        try:
            with pytest.raises(AzureSpeechProviderError, match="speech_service_response_error"):
                await provider.transcribe(_one_track_request(audio))
        finally:
            await client.close()
            await runner.cleanup()

    monkeypatch.setattr(transcription, "SPEECH_READ_TIMEOUT_SECONDS", 0.2)
    asyncio.run(scenario())
    assert len(posts) == 1
