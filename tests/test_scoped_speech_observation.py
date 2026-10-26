"""Consent-backed synthetic SDK/worker contracts, never live recognition evidence."""

from __future__ import annotations

import io
import json
import logging
import wave
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from azure.ai.transcription._utils.utils import prepare_multipart_form_data
from cosmaneura_scribe import captured_worker_job_runner as runner
from cosmaneura_scribe import safe_logging, transcription
from cosmaneura_scribe import scoped_speech_observation as scoped
from cosmaneura_scribe.captured_transcription_worker import CapturedTranscriptionWorker
from cosmaneura_scribe.captured_worker_settings import CapturedWorkerSettings
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.schemas import CaptureChannel, SpeakerRole, TranscriptionJobStatus
from cosmaneura_scribe.speech_observation import (
    SpeechBoundaryObservation,
    WaveHeaderObservation,
    inspect_wave_header,
)
from cosmaneura_scribe.transcription_worker import TranscriptionWorker, TranscriptionWorkerError
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture
from test_captured_worker_job_runner import _settings
from test_transcription import FakeAzureClient, _result
from test_transcription_worker import _seed_uploaded_session


def scope(tenant, session, consent, **changes):
    now = datetime.now(UTC)
    value = dict(
        version=1,
        tenant_id=str(tenant),
        session_id=str(session),
        consent_record_id=str(consent),
        issued_at=now.isoformat(),
        expires_at=(now + timedelta(minutes=20)).isoformat(),
    )
    return json.dumps(value | changes)


def observation(**changes):
    return replace(
        SpeechBoundaryObservation(
            track_index=0,
            sdk_version="1.0.0",
            max_speakers=4,
            phrase_count=4,
            missing_speaker_count=1,
            distinct_non_null_speaker_count=2,
            accepted_phrase_count=3,
            accepted_distinct_speaker_count=2,
            wave_header=WaveHeaderObservation(1, 16000, 16, 1),
            diarization_enabled=True,
            call_id=str(uuid4()),
            accepted_missing_speaker_count=1,
            accepted_distinct_non_null_speaker_count=1,
        ),
        **changes,
    )


@pytest.mark.parametrize(
    "bad",
    [
        None,
        "",
        "not-json",
        "[]",
        "x" * 1025,
        '{"version":1,"version":1}',
        '{"transcript":"private"}',
    ],
)
def test_invalid_scope_is_silent_diagnostic_disable_only(bad):
    settings = CapturedWorkerSettings(captured_speech_observation_scope=bad)
    assert (
        scoped.capture_speech_observer(
            settings.captured_speech_observation_scope, tenant_id=uuid4()
        )
        is None
    )


@pytest.mark.parametrize("bad", ["not-json", "[]", '{"expires_at":"already-past"}'])
def test_malformed_environment_scope_does_not_prevent_settings_startup(monkeypatch, bad):
    monkeypatch.setenv("COSMANEURA_SCRIBE_CAPTURED_SPEECH_OBSERVATION_SCOPE", bad)
    settings = CapturedWorkerSettings()
    assert settings.captured_speech_observation_scope == bad
    assert (
        scoped.capture_speech_observer(
            settings.captured_speech_observation_scope, tenant_id=uuid4()
        )
        is None
    )


@pytest.mark.parametrize(
    "change", ["tenant", "zero", "extra", "expired", "future", "too_long", "naive", "version"]
)
def test_exact_bounded_scope_required(change):
    tenant, session, consent = uuid4(), uuid4(), uuid4()
    now = datetime.now(UTC)
    changes = {
        "tenant": {"tenant_id": str(uuid4())},
        "zero": {"session_id": "00000000-0000-0000-0000-000000000000"},
        "extra": {"text": "private"},
        "expired": {
            "issued_at": (now - timedelta(hours=1)).isoformat(),
            "expires_at": now.isoformat(),
        },
        "future": {"issued_at": (now + timedelta(minutes=1)).isoformat()},
        "too_long": {"expires_at": (now + timedelta(hours=2)).isoformat()},
        "naive": {"issued_at": "2026-10-26T00:00:00"},
        "version": {"version": True},
    }[change]
    assert (
        scoped.capture_speech_observer(scope(tenant, session, consent, **changes), tenant_id=tenant)
        is None
    )


def test_foreign_request_and_expiry_at_response_are_silent(monkeypatch):
    tenant, session, consent = uuid4(), uuid4(), uuid4()
    clock = [datetime.now(UTC)]
    raw = scope(tenant, session, consent, issued_at=(clock[0] - timedelta(seconds=1)).isoformat())
    factory = scoped.capture_speech_observer(raw, tenant_id=tenant, clock=lambda: clock[0])
    assert factory is not None
    calls = []
    monkeypatch.setattr(scoped, "log_speech_boundary", lambda **kw: calls.append(kw))
    for s, c in [(uuid4(), consent), (session, uuid4())]:
        assert factory(SimpleNamespace(session_id=s, consent_record_id=c)) is None
    callback = factory(SimpleNamespace(session_id=session, consent_record_id=consent))
    assert callback is not None
    callback(observation())
    assert len(calls) == 1
    clock[0] += timedelta(hours=1)
    callback(observation())
    assert (
        len(calls) == 1
        and factory(SimpleNamespace(session_id=session, consent_record_id=consent)) is None
    )


async def seeded(tmp_path, *, revoked=False):
    tenant = uuid4()
    repository = InMemoryRepository()
    session = await _seed_uploaded_session(repository, tenant_id=tenant, revoked=revoked)
    path = tmp_path / "private-source-name.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x01\x00" * 16000)
    return tenant, repository, session, path


@pytest.mark.asyncio
async def test_actual_body_counts_filtering_header_and_multi_track_ids(tmp_path, caplog):
    tenant, _, session, path = await seeded(tmp_path)
    factory = scoped.capture_speech_observer(
        scope(tenant, session.id, session.consent_record_id), tenant_id=tenant
    )
    response = _result(text="private phrase", speaker=0, offset_ms=0, duration_ms=100, confidence=1)
    values = [
        (0, "private phrase", 100),
        (1, "private phrase", 100),
        (0, "private phrase", 100),
        (2, "private phrase", 100),
        (None, "private phrase", 100),
        (None, " ", 100),
        (4, "private phrase", 0),
    ]
    response.phrases = [
        _result(text=t, speaker=s, offset_ms=i * 100, duration_ms=d, confidence=1).phrases[0]
        for i, (s, t, d) in enumerate(values)
    ]

    class ReadingClient(FakeAzureClient):
        async def transcribe(self, body, **kwargs):
            # Actual same stream/body consumed before diagnostic reads.
            assert body.audio.read() == path.read_bytes()
            return await super().transcribe(body, **kwargs)

    client = ReadingClient([response, response])
    provider = transcription.AzureSpeechTranscriber(
        client, max_speakers=4, observer_for_request=factory
    )
    request = transcription.TranscriptionRequest(
        session.id,
        session.consent_record_id,
        "en-US",
        tuple(
            transcription.AudioTrack(uuid4(), channel, path)
            for channel in (CaptureChannel.MIXED, CaptureChannel.MICROPHONE)
        ),
    )
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        result = await provider.transcribe(request)
    assert len(client.requests) == 2 and len(result.segments) == 10
    rows = [
        json.loads(r.message)
        for r in caplog.records
        if "captured_speech.provider_boundary" in r.message
    ]
    assert len(rows) == 2 and len({r["call_id"] for r in rows}) == 2
    for i, row in enumerate(rows):
        assert set(row) == safe_logging.SPEECH_BOUNDARY_FIELD_ALLOWLIST and row["track_index"] == i
        assert (
            row["phrase_count"],
            row["missing_speaker_count"],
            row["distinct_non_null_speaker_count"],
        ) == (7, 2, 4)
        assert (
            row["accepted_phrase_count"],
            row["accepted_missing_speaker_count"],
            row["accepted_distinct_non_null_speaker_count"],
            row["accepted_distinct_speaker_count"],
        ) == (5, 1, 3, 4)
        assert row["wave_header"] == dict(
            channels=1, sample_rate_hz=16000, sample_width_bits=16, format_code=1
        )
        wire = prepare_multipart_form_data(client.requests[i].as_dict(), ["audio"], ["definition"])
        definition = json.loads(next(v for k, v in wire if k == "definition"))
        assert (
            definition["diarization"]
            == {"enabled": row["diarization_enabled"], "maxSpeakers": row["max_speakers"]}
            == {"enabled": True, "maxSpeakers": 4}
        )
        assert "private" not in json.dumps(row) and str(path) not in json.dumps(row)


@pytest.mark.parametrize("failure", ["factory", "header", "sdk", "sink", "call_id"])
@pytest.mark.asyncio
async def test_diagnostic_failure_keeps_one_asr_call_and_successful_publication(
    tmp_path, monkeypatch, failure
):
    tenant, repository, session, path = await seeded(tmp_path)

    def fail(*args, **kwargs):
        raise RuntimeError("private diagnostic error")

    factory = scoped.capture_speech_observer(
        scope(tenant, session.id, session.consent_record_id), tenant_id=tenant
    )
    if failure == "factory":
        factory = fail
    elif failure == "sink":
        monkeypatch.setattr(scoped, "log_speech_boundary", fail)
    else:
        monkeypatch.setattr(
            transcription,
            {"header": "inspect_wave_header", "sdk": "azure_sdk_version", "call_id": "uuid4"}[
                failure
            ],
            fail,
        )
    client = FakeAzureClient(
        [
            _result(
                text="Valid synthetic speech",
                speaker=0,
                offset_ms=0,
                duration_ms=1000,
                confidence=1,
            )
        ]
    )
    provider = transcription.AzureSpeechTranscriber(
        client, max_speakers=4, observer_for_request=factory
    )

    class Assembler:
        @asynccontextmanager
        async def assemble(self, request):
            yield (transcription.AudioTrack(uuid4(), CaptureChannel.MIXED, path),)

    worker = TranscriptionWorker(
        repositories=repository, assembler=Assembler(), transcriber=provider
    )
    result = await worker.process(tenant_id=tenant, session_id=session.id)
    assert result.session_id == session.id and len(client.requests) == 1
    async with repository.transaction(tenant) as store:
        job = await store.transcription_job_for(tenant, session.id)
        assert job.status == TranscriptionJobStatus.COMPLETED and job.attempt_count == 1
    assert (await worker.process(tenant_id=tenant, session_id=session.id)).id == result.id
    assert len(client.requests) == 1


@pytest.mark.asyncio
async def test_observer_scope_cannot_bypass_revoked_consent(tmp_path, caplog):
    tenant, repository, session, path = await seeded(tmp_path, revoked=True)
    factory = scoped.capture_speech_observer(
        scope(tenant, session.id, session.consent_record_id), tenant_id=tenant
    )
    client = FakeAzureClient([])
    provider = transcription.AzureSpeechTranscriber(
        client, max_speakers=4, observer_for_request=factory
    )

    class Assembler:
        @asynccontextmanager
        async def assemble(self, request):
            raise AssertionError("revoked consent reached assembly")
            yield ()

    worker = TranscriptionWorker(
        repositories=repository, assembler=Assembler(), transcriber=provider
    )
    with (
        caplog.at_level(logging.INFO, logger="cosmaneura_scribe"),
        pytest.raises(TranscriptionWorkerError),
    ):
        await worker.process(tenant_id=tenant, session_id=session.id)
    assert not client.requests and "provider_boundary" not in caplog.text


def test_header_restores_nonzero_position_even_when_read_raises():
    stream = io.BytesIO(b"x" * 80)
    stream.seek(12)
    assert inspect_wave_header(stream) is None and stream.tell() == 12

    class BrokenRead(io.BytesIO):
        def read(self, *args):
            raise OSError("private")

    stream = BrokenRead(b"x" * 80)
    stream.seek(12)
    with pytest.raises(OSError):
        inspect_wave_header(stream)
    assert stream.tell() == 12


@pytest.mark.asyncio
async def test_failed_header_restore_happens_after_consumption_and_cannot_replay_asr(tmp_path):
    _, _, session, path = await seeded(tmp_path)

    class FailedRestore(io.BytesIO):
        consumed = False

        def seek(self, offset, *args):
            if self.consumed and offset != 0:
                raise OSError("synthetic restore failure")
            return super().seek(offset, *args)

    stream = FailedRestore(path.read_bytes())

    class Client(FakeAzureClient):
        async def transcribe(self, body, **kwargs):
            assert body.audio.read() == path.read_bytes()
            stream.consumed = True
            return await super().transcribe(body, **kwargs)

    client = Client(
        [_result(text="Synthetic source", speaker=0, offset_ms=0, duration_ms=1000, confidence=1)]
    )
    observations = []
    provider = transcription.AzureSpeechTranscriber(
        client, max_speakers=4, observer=observations.append
    )
    track = transcription.AudioTrack(
        uuid4(), CaptureChannel.MIXED, path, reader=SimpleNamespace(open=lambda: stream)
    )
    result = await provider.transcribe(
        transcription.TranscriptionRequest(session.id, session.consent_record_id, "en-US", (track,))
    )
    assert len(client.requests) == 1 and len(result.segments) == 1
    assert len(observations) == 1 and observations[0].wave_header is None
    assert stream.closed


@pytest.mark.parametrize(
    "change",
    [
        dict(sdk_version="https://private"),
        dict(phrase_count=True),
        dict(accepted_phrase_count=100),
        dict(diarization_enabled="true"),
        dict(track_index=100),
        dict(call_id="private-scope-string"),
        dict(wave_header=WaveHeaderObservation(1, 10**9, 16, 1)),
    ],
)
def test_closed_logger_rejects_unbounded_or_content_like_values(change, caplog):
    with (
        caplog.at_level(logging.INFO, logger="cosmaneura_scribe"),
        pytest.raises((TypeError, ValueError)),
    ):
        safe_logging.log_speech_boundary(
            tenant_id=uuid4(),
            session_id=uuid4(),
            consent_record_id=uuid4(),
            scope_sha256="a" * 64,
            observed_at_ms=1,
            observation=observation(**change),
        )
    assert "provider_boundary" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("raw_scope", [None, "malformed", "valid"])
async def test_normal_runner_installs_only_valid_scope_with_validated_tenant(
    tmp_path, monkeypatch, raw_scope
):
    settings = _settings(tmp_path)
    tenant = next(iter(settings.configured_capture_tenant_ids))
    session, consent = uuid4(), uuid4()
    raw = scope(tenant, session, consent) if raw_scope == "valid" else raw_scope
    settings = settings.model_copy(update={"captured_speech_observation_scope": raw})
    calls = []
    worker_calls = []

    async def close():
        pass

    resource = SimpleNamespace(close=close, engine=object())
    monkeypatch.setattr(runner, "build_postgres_provider", lambda s: resource)
    monkeypatch.setattr(runner, "CapturedSourceRepositoryProvider", lambda e: object())
    monkeypatch.setattr(runner, "build_audio_track_assembler", lambda *args: resource)

    def build(s, **kwargs):
        calls.append(kwargs)
        return resource

    monkeypatch.setattr(runner, "build_speech_to_text_provider", build)

    def build_worker(**kwargs):
        worker_calls.append(kwargs)
        return object()

    monkeypatch.setattr(runner, "CapturedTranscriptionWorker", build_worker)

    async def dispatch(*args):
        pass

    monkeypatch.setattr(runner, "_dispatch", dispatch)
    await runner.run_captured_worker(
        arguments=(str(tenant), "--pending"),
        environ={
            "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED": "true",
            "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
        },
        settings_factory=lambda: settings,
    )
    assert len(calls) == 1
    if raw_scope == "valid":
        assert (
            worker_calls[0]["publication_observer"] == calls[0]["observer_for_request"].publication
        )
        assert (
            calls[0]["observer_for_request"](
                SimpleNamespace(session_id=session, consent_record_id=consent)
            )
            is not None
        )
    else:
        assert calls == [{}]
        assert "publication_observer" not in worker_calls[0]


@pytest.mark.postgres
@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["default", "enabled", "failed_sink"])
async def test_captured_postgres_publication_and_recovery_ignore_diagnostic_failure(
    capture, monkeypatch, caplog, mode
):
    # Existing real consent -> admission -> encrypted chunks -> complete fixture.
    await capture.record()
    tenant, session = capture.trial.tenant, capture.trial.draft
    factory = None
    if mode != "default":
        factory = scoped.capture_speech_observer(
            scope(tenant, session.id, session.consent_record_id), tenant_id=tenant
        )
    if mode == "failed_sink":

        def fail(**kwargs):
            raise RuntimeError("synthetic diagnostic sink failure")

        monkeypatch.setattr(scoped, "log_speech_boundary", fail)
    response = _result(
        text="Synthetic source wording", speaker=0, offset_ms=0, duration_ms=1000, confidence=1
    )
    client = FakeAzureClient([response])
    provider = transcription.AzureSpeechTranscriber(
        client, max_speakers=4, observer_for_request=factory
    )
    worker = CapturedTranscriptionWorker(
        repositories=capture.trial.provider,
        assembler=capture.assembler,
        transcriber=provider,
        enabled=True,
    )
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        result = await capture.process(worker)
        assert not result.already_completed
        recovered = await capture.process(worker)
    assert recovered.already_completed and recovered.job_id == result.job_id
    assert len(client.requests) == 1 and len(capture.reader.calls) == 2
    assert await capture.trial.counts() == (1, 1, 1)
    assert not list(capture.temp.iterdir())
    async with capture.trial.provider.transaction(tenant) as store:
        job = await store.transcription_job_for(tenant, session.id)
        assert job.status == TranscriptionJobStatus.COMPLETED and job.attempt_count == 1
        source = await store.get_current_normalized_source_transcript(tenant, session.id)
    assert source is not None and len(source.segments) == 1
    assert source.segments[0].content == "Synthetic source wording"
    assert source.segments[0].speaker_role == SpeakerRole.UNKNOWN
    rows = [r for r in caplog.records if "captured_speech.provider_boundary" in r.message]
    assert len(rows) == (1 if mode == "enabled" else 0)
