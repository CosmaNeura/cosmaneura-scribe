from __future__ import annotations

import asyncio
import hashlib
import os
import sys
import wave
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from conftest import verified_test_tenant
from cosmaneura_scribe.audio_assembly import (
    EncryptedBlobAudioTrackAssembler,
    RepositoryAudioAssemblyManifestProvider,
)
from cosmaneura_scribe.captured_source_runtime import CapturedSourceRepositoryProvider
from cosmaneura_scribe.captured_transcription_worker import CapturedTranscriptionWorker
from cosmaneura_scribe.external_transcript_v1 import TranscriptLanguageMode
from cosmaneura_scribe.main import (
    app,
    get_audio_encryption_key_provider,
    get_audio_storage,
    get_repository_provider,
)
from cosmaneura_scribe.postgres_repository import PostgresRepositoryProvider
from cosmaneura_scribe.repository import CaptureIngestModeError
from cosmaneura_scribe.schemas import AudioChunk, CaptureChannel
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings, get_settings
from cosmaneura_scribe.storage import InMemoryAudioStorage
from cosmaneura_scribe.transcript_review_service import CreatorTranscriptReviewService
from cosmaneura_scribe.transcription import SttResult, TranscriptionRequest
from cosmaneura_scribe.transcription_worker import (
    AudioAssemblyRequest,
    TranscriptionWorker,
    TranscriptionWorkerError,
)
from test_audio_assembly import (
    WRAPPED_DEK,
    MemoryBlobReader,
    StaticKeyUnwrapper,
    _encrypt,
    _wave_bytes,
)
from test_capture_protocol_api import CaptureKeyProvider
from test_captured_source_runtime import Trial, _result, _translate_and_review_capture
from test_captured_source_runtime import trial as trial

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]
FRAMES = (b"\x01\x00" * 24000, b"\x02\x00" * 24000)


class ReadingSpeech:
    name = "azure_ai_speech"

    def __init__(self) -> None:
        self.calls = 0
        self.expected_language = "en-US+es-US"
        self.result = _result()
        self.fail = False
        self.block = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = False

    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        self.calls += 1
        assert request.language_code == self.expected_language
        assert len(request.tracks) == 1
        assert request.tracks[0].channel == CaptureChannel.MIXED
        with request.tracks[0].open() as stream, wave.open(stream) as wav:
            assert wav.getframerate() == 16000
            assert wav.readframes(wav.getnframes()) == b"".join(FRAMES)
        self.started.set()
        if self.block:
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        if self.fail:
            raise RuntimeError("synthetic-protected-provider-error")
        return self.result

    async def close(self) -> None:
        pass


@dataclass
class CaptureHarness:
    trial: Trial
    client: httpx.AsyncClient
    assembler: EncryptedBlobAudioTrackAssembler
    reader: MemoryBlobReader
    speech: ReadingSpeech
    key: bytes
    temp: Path
    completion: dict | None = None

    async def post(self, suffix: str, body: dict, key: str) -> httpx.Response:
        return await self.client.post(
            f"/v1/sessions/{self.trial.draft.id}/{suffix}",
            json=body,
            headers={"Idempotency-Key": key},
        )

    def worker(self, **kwargs) -> CapturedTranscriptionWorker:
        return CapturedTranscriptionWorker(
            repositories=self.trial.provider,
            assembler=self.assembler,
            transcriber=self.speech,
            enabled=True,
            **kwargs,
        )

    async def record(self) -> None:
        response = await self.post(
            "audio-key",
            {
                "key_version": "capture-key-version",
                "wrapped_dek": WRAPPED_DEK,
            },
            "capture-key-0001",
        )
        assert response.status_code == 201
        lease = await self.post("capture-lease", {"protocol_version": "1.0"}, "lease-0001")
        assert lease.status_code == 201
        renewed = await self.post(
            f"capture-leases/{lease.json()['lease_id']}/renew",
            {
                "protocol_version": "1.0",
                "expected_generation": 1,
            },
            "renew-0001",
        )
        assert renewed.status_code == 200
        current = renewed.json()
        reservation = await self.post(
            "chunk-reservations",
            {
                "protocol_version": "1.0",
                "capture_lease_id": current["lease_id"],
                "capture_lease_generation": current["generation"],
                "channel": "mixed",
                "first_sequence_number": 0,
                "count": 2,
            },
            "reserve-0001",
        )
        assert reservation.status_code == 201
        for index, item in enumerate(reservation.json()["reservations"]):
            object_id = UUID(item["object_id"])
            authorization = await self.post(
                f"chunks/{object_id}/upload-authorization",
                {
                    "protocol_version": "1.0",
                },
                f"authorize-{index:04}",
            )
            assert authorization.status_code == 201
            chunk = AudioChunk(
                id=uuid4(),
                session_id=self.trial.draft.id,
                sequence_number=index,
                channel=CaptureChannel.MIXED,
                object_id=object_id,
                sha256="0" * 64,
                ciphertext_size_bytes=1,
                registered_at=datetime.now(UTC),
            )
            request = AudioAssemblyRequest(
                tenant_id=self.trial.tenant,
                session_id=self.trial.draft.id,
                chunks=(chunk,),
                job_id=uuid4(),
                lease_token=uuid4(),
            )
            envelope = _encrypt(
                request,
                chunk,
                _wave_bytes(FRAMES[index]),
                self.key,
                (index + 1).to_bytes(12, "big"),
            )
            self.reader.objects[object_id] = envelope
            registered = await self.post(
                "chunks",
                {
                    "sequence_number": index,
                    "channel": "mixed",
                    "object_id": str(object_id),
                    "sha256": hashlib.sha256(envelope).hexdigest(),
                    "ciphertext_size_bytes": len(envelope),
                },
                f"register-{index:04}",
            )
            assert registered.status_code == 201
        self.completion = {
            "protocol_version": "1.0",
            "capture_lease_id": current["lease_id"],
            "capture_lease_generation": current["generation"],
            "channels": [{"channel": "mixed", "final_sequence_number": 1}],
        }
        complete = await self.post("capture-complete", self.completion, "complete-0001")
        assert complete.status_code == 200 and complete.json()["status"] == "uploaded"

    async def process(self, worker: CapturedTranscriptionWorker | None = None):
        return await (worker or self.worker()).process(
            tenant_id=self.trial.tenant, session_id=self.trial.draft.id
        )


@pytest_asyncio.fixture
async def capture(trial: Trial, tmp_path: Path) -> AsyncIterator[CaptureHarness]:
    settings = Settings(
        capture_protocol_enabled=True,
        repository_backend="postgres",
        database_url=trial.admin_url,
        database_ssl=False,
        workflow_authentication_enabled=True,
        entra_tenant_id=uuid4(),
        workflow_api_audience=str(uuid4()),
        trusted_platform_client_id=uuid4(),
    )
    overrides = dict(app.dependency_overrides)
    # Explicit offline identity/storage/key fixtures. Never a hosted auth claim.
    app.dependency_overrides.update(
        {
            get_repository_provider: lambda: trial.provider,
            get_settings: lambda: settings,
            get_verified_tenant_id: verified_test_tenant,
            get_audio_encryption_key_provider: CaptureKeyProvider,
            get_audio_storage: lambda: InMemoryAudioStorage(settings),
        }
    )
    reader, speech, key = MemoryBlobReader({}), ReadingSpeech(), b"s" * 32
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=RepositoryAudioAssemblyManifestProvider(trial.provider),
        reader=reader,
        key_unwrapper=StaticKeyUnwrapper(key),
        temporary_directory=tmp_path,
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://synthetic.invalid",
            headers={"X-Tenant-ID": str(trial.tenant)},
        ) as client:
            yield CaptureHarness(trial, client, assembler, reader, speech, key, tmp_path)
    finally:
        await assembler.close()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(overrides)


async def test_protocol_encrypted_wave_worker_and_completed_recovery(capture: CaptureHarness):
    await capture.record()
    result = await capture.process()
    assert not result.already_completed
    assert capture.speech.calls == 1 and len(capture.reader.calls) == 2
    assert not list(capture.temp.iterdir())
    assert await capture.trial.counts() == (1, 1, 1)
    await capture.trial.provider.engine.dispose()
    recovered = await capture.process()
    assert recovered.already_completed and recovered.job_id == result.job_id
    assert capture.speech.calls == 1 and len(capture.reader.calls) == 2
    assert await capture.trial.counts() == (1, 1, 1)
    review = await CreatorTranscriptReviewService(capture.trial.provider, enabled=True).read(
        tenant_id=capture.trial.tenant,
        session_id=capture.trial.draft.id,
        creator_actor_id=capture.trial.draft.creator_actor_id,
    )
    assert not review.working_transcript.note_ready
    assert capture.completion is not None
    replay = await capture.post("capture-complete", capture.completion, "complete-0001")
    assert replay.status_code == 200 and replay.json()["status"] == "processing"
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        phase = await store.get_session(capture.trial.tenant, capture.trial.draft.id)
        assert phase is not None
        with pytest.raises(CaptureIngestModeError):
            await store.update_session(capture.trial.tenant, phase)
    default = PostgresRepositoryProvider(capture.trial.provider.engine)
    async with default.transaction(capture.trial.tenant) as store:
        assert await store.get_session(capture.trial.tenant, capture.trial.draft.id) is None
        assert (
            await store.get_session_audio_key(capture.trial.tenant, capture.trial.draft.id) is None
        )
        assert await store.chunks_for(capture.trial.tenant, capture.trial.draft.id) == []
        assert (
            await store.transcription_job_for(capture.trial.tenant, capture.trial.draft.id) is None
        )

    await _translate_and_review_capture(capture.trial)
    assert (await capture.process()).already_completed and capture.speech.calls == 1
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        ready = await store.get_session(capture.trial.tenant, capture.trial.draft.id)
        assert ready is not None and ready.status.value == "transcript_ready"


@pytest.mark.parametrize(
    "fault", ["disabled", "tenant", "session", "revoked", "unstarted", "legacy", "adapter"]
)
async def test_denied_before_audio_or_provider(capture: CaptureHarness, fault: str):
    if fault != "unstarted":
        await capture.record()
    trial = capture.trial
    if fault == "revoked":
        async with trial.provider.transaction(trial.tenant) as store:
            await store.revoke_consent(trial.tenant, trial.consent.id)
    worker = capture.worker()
    if fault == "adapter":
        capture.speech.name = "unadmitted_adapter"
    if fault == "disabled":
        worker = CapturedTranscriptionWorker(
            repositories=trial.provider,
            assembler=capture.assembler,
            transcriber=capture.speech,
        )
    if fault == "legacy":
        worker = TranscriptionWorker(
            repositories=trial.provider,
            assembler=capture.assembler,
            transcriber=capture.speech,
        )
    with pytest.raises(TranscriptionWorkerError):
        await worker.process(
            tenant_id=uuid4() if fault == "tenant" else trial.tenant,
            session_id=uuid4() if fault == "session" else trial.draft.id,
        )
    assert capture.speech.calls == 0 and capture.reader.calls == []
    assert await trial.counts() == (0, 0, 0)


@pytest.mark.parametrize("fault", ["provider", "language", "channel"])
async def test_invalid_source_stops_without_publication_or_retry(
    capture: CaptureHarness, fault: str
):
    await capture.record()
    result = capture.speech.result
    if fault == "provider":
        capture.speech.result = replace(result, provider="unadmitted")
    elif fault == "language":
        capture.speech.result = replace(result, language_code="en-US")
    else:
        capture.speech.result = replace(
            result,
            segments=tuple(
                replace(segment, channel=CaptureChannel.MICROPHONE) for segment in result.segments
            ),
        )
    for _ in range(2):
        with pytest.raises(TranscriptionWorkerError) as error:
            await capture.process()
        assert error.value.__context__ is None
    assert capture.speech.calls == 1
    assert await capture.trial.counts() == (0, 0, 0)
    assert not list(capture.temp.iterdir())


async def test_retryable_provider_error_then_success(capture: CaptureHarness):
    await capture.record()
    capture.speech.fail = True
    with pytest.raises(TranscriptionWorkerError) as error:
        await capture.process()
    assert error.value.__context__ is None
    assert capture.speech.calls == 1
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        failed = await store.transcription_job_for(capture.trial.tenant, capture.trial.draft.id)
    assert failed is not None
    assert failed.status.value == "retryable"
    assert failed.last_error_code == "captured_speech_processing_failed"
    capture.speech.fail = False
    await capture.process()
    assert capture.speech.calls == 2 and await capture.trial.counts() == (1, 1, 1)


async def test_publication_failure_is_distinct_and_retryable(
    capture: CaptureHarness, monkeypatch: pytest.MonkeyPatch,
):
    await capture.record()
    worker = capture.worker()

    async def fail_publication(**kwargs: object) -> None:
        raise RuntimeError("synthetic-protected-publication-detail")

    with monkeypatch.context() as patch:
        patch.setattr(worker._runtime, "publish_speech_result", fail_publication)
        with pytest.raises(TranscriptionWorkerError) as error:
            await capture.process(worker)
    assert error.value.__context__ is None
    assert "synthetic-protected" not in repr(error.value)
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        failed = await store.transcription_job_for(capture.trial.tenant, capture.trial.draft.id)
    assert failed is not None
    assert failed.status.value == "retryable" and failed.attempt_count == 1
    assert failed.last_error_code == "captured_speech_publication_failed"
    assert capture.speech.calls == 1 and await capture.trial.counts() == (0, 0, 0)
    await capture.process(worker)
    assert capture.speech.calls == 2 and await capture.trial.counts() == (1, 1, 1)


async def test_exhausted_job_does_not_repeat_or_invent_source(capture: CaptureHarness):
    await capture.record()
    capture.speech.fail = True
    for _ in range(3):
        with pytest.raises(TranscriptionWorkerError):
            await capture.process(capture.worker(max_attempts=2))
    assert capture.speech.calls == 2 and await capture.trial.counts() == (0, 0, 0)
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        job = await store.transcription_job_for(capture.trial.tenant, capture.trial.draft.id)
        assert job is not None and job.status.value == "terminal"


@pytest.mark.parametrize("fault", ["cancel", "revoke", "competing"])
async def test_inflight_lease_and_cancellation(capture: CaptureHarness, fault: str):
    await capture.record()
    capture.speech.block = True
    worker = capture.worker(
        lease_duration=timedelta(seconds=10),
        heartbeat_interval=timedelta(milliseconds=30),
    )
    task = asyncio.create_task(capture.process(worker))
    await asyncio.wait_for(capture.speech.started.wait(), timeout=5)
    try:
        if fault == "competing":
            with pytest.raises(TranscriptionWorkerError):
                await capture.process(worker)
            capture.speech.release.set()
            await asyncio.wait_for(task, timeout=5)
            assert await capture.trial.counts() == (1, 1, 1)
        elif fault == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            async with capture.trial.provider.transaction(capture.trial.tenant) as store:
                await store.revoke_consent(capture.trial.tenant, capture.trial.consent.id)
            with pytest.raises(TranscriptionWorkerError):
                await asyncio.wait_for(task, timeout=5)
        assert capture.speech.calls == 1
        if fault != "competing":
            assert capture.speech.cancelled and await capture.trial.counts() == (0, 0, 0)
        assert not list(capture.temp.iterdir())
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_lost_publication_reply_recovers_without_speech_replay(capture: CaptureHarness):
    await capture.record()

    class LostReply(CapturedSourceRepositoryProvider):
        lost = False

        @asynccontextmanager
        async def transaction(self, tenant_id: UUID):
            async with super().transaction(tenant_id) as store:
                yield store
                job = await store.transcription_job_for(tenant_id, capture.trial.draft.id)
                completed = job is not None and job.status.value == "completed"
            if completed and not self.lost:
                self.lost = True
                raise OSError("synthetic lost commit acknowledgment")

    worker = CapturedTranscriptionWorker(
        repositories=LostReply(capture.trial.provider.engine),
        assembler=capture.assembler,
        transcriber=capture.speech,
        enabled=True,
    )
    with pytest.raises(TranscriptionWorkerError):
        await capture.process(worker)
    assert (await capture.process()).already_completed
    assert capture.speech.calls == 1 and await capture.trial.counts() == (1, 1, 1)


async def test_english_capture_is_ready_without_translation(capture: CaptureHarness):
    trial = capture.trial
    trial.draft = replace(trial.draft, id=uuid4(), language_mode=TranscriptLanguageMode.ENGLISH)
    await trial.runtime.admit(tenant_id=trial.tenant, draft=trial.draft)
    capture.speech.expected_language = "en-US"
    capture.speech.result = replace(
        capture.speech.result,
        language_code="en-US",
        segments=(capture.speech.result.segments[0], capture.speech.result.segments[2]),
    )
    await capture.record()
    await capture.process()
    current = await CreatorTranscriptReviewService(trial.provider, enabled=True).read(
        tenant_id=trial.tenant,
        session_id=trial.draft.id,
        creator_actor_id=trial.draft.creator_actor_id,
    )
    assert current.working_transcript.note_ready


@pytest.mark.parametrize("fault", ["revoked_manifest", "tampered_blob", "lost_lease"])
async def test_assembly_and_last_egress_fences(capture: CaptureHarness, fault: str):
    await capture.record()
    trial = capture.trial
    if fault == "revoked_manifest":

        class RevokingManifest(RepositoryAudioAssemblyManifestProvider):
            async def resolve(self, request):
                async with trial.provider.transaction(trial.tenant) as store:
                    await store.revoke_consent(trial.tenant, trial.consent.id)
                return await super().resolve(request)

        capture.assembler = EncryptedBlobAudioTrackAssembler(
            manifests=RevokingManifest(trial.provider),
            reader=capture.reader,
            key_unwrapper=StaticKeyUnwrapper(capture.key),
            temporary_directory=capture.temp,
        )
    elif fault == "tampered_blob":
        object_id = next(iter(capture.reader.objects))
        envelope = capture.reader.objects[object_id]
        capture.reader.objects[object_id] = envelope[:-1] + bytes([envelope[-1] ^ 1])
    worker = capture.worker()
    if fault == "lost_lease":

        class StealingAssembler:
            @asynccontextmanager
            async def assemble(self, request):
                async with capture.assembler.assemble(request) as tracks:
                    await trial.query(
                        "UPDATE transcription_jobs SET lease_token = :token "
                        "WHERE tenant_id = :tenant AND session_id = :session",
                        token=uuid4(),
                    )
                    yield tracks

        worker = CapturedTranscriptionWorker(
            repositories=trial.provider,
            assembler=StealingAssembler(),
            transcriber=capture.speech,
            enabled=True,
        )
    with pytest.raises(TranscriptionWorkerError):
        await capture.process(worker)
    assert capture.speech.calls == 0 and await trial.counts() == (0, 0, 0)
    if fault == "revoked_manifest":
        assert capture.reader.calls == []
    assert not list(capture.temp.iterdir())


async def test_new_process_acknowledges_completed_job_without_audio_access(capture: CaptureHarness):
    await capture.record()
    initial = await capture.process()
    program = """
import asyncio, os
from uuid import UUID
from sqlalchemy.ext.asyncio import create_async_engine
from cosmaneura_scribe.captured_source_runtime import CapturedSourceRepositoryProvider
from cosmaneura_scribe.captured_transcription_worker import CapturedTranscriptionWorker
class NoAudio:
    def assemble(self, request):
        raise AssertionError("completed job must not assemble")
class NoSpeech:
    name = "azure_ai_speech"
    async def transcribe(self, request):
        raise AssertionError("completed job must not transcribe")
async def run():
    provider = CapturedSourceRepositoryProvider(create_async_engine(os.environ["TRIAL_DB"]))
    try:
        outcome = await CapturedTranscriptionWorker(repositories=provider,
            assembler=NoAudio(), transcriber=NoSpeech(), enabled=True).process(
            tenant_id=UUID(os.environ["TRIAL_TENANT"]),
            session_id=UUID(os.environ["TRIAL_SESSION"]))
        assert outcome.already_completed and str(outcome.job_id) == os.environ["TRIAL_JOB"]
        print("completed-recovered-without-provider")
    finally:
        await provider.close()
asyncio.run(run())
"""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        program,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={
            **os.environ,
            "TRIAL_DB": capture.trial.provider.engine.url.render_as_string(hide_password=False),
            "TRIAL_TENANT": str(capture.trial.tenant),
            "TRIAL_SESSION": str(capture.trial.draft.id),
            "TRIAL_JOB": str(initial.job_id),
        },
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=20)
        assert process.returncode == 0
        assert output == b"completed-recovered-without-provider\n"
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert capture.speech.calls == 1 and await capture.trial.counts() == (1, 1, 1)
