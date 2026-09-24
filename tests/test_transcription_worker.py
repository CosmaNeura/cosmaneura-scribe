from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    SessionStatus,
    SpeakerRole,
    TranscriptionJobStatus,
)
from cosmaneura_scribe.session_state_v1 import SessionIngestMode
from cosmaneura_scribe.transcription import (
    AudioTrack,
    SttResult,
    SttSegment,
    TranscriptionRequest,
)
from cosmaneura_scribe.transcription_worker import (
    AudioAssemblyRequest,
    ChannelPriorRoleLabeler,
    TranscriptionWorker,
    TranscriptionWorkerError,
)


class FakeAssembler:
    def __init__(self) -> None:
        self.call_count = 0

    @asynccontextmanager
    async def assemble(
        self, request: AudioAssemblyRequest
    ) -> AsyncIterator[tuple[AudioTrack, ...]]:
        self.call_count += 1
        assert request.chunks
        yield (
            AudioTrack(uuid4(), CaptureChannel.MICROPHONE, Path("/secure/clinician.enc")),
            AudioTrack(uuid4(), CaptureChannel.SYSTEM_AUDIO, Path("/secure/patient.enc")),
        )


class LeaseStealingAssembler(FakeAssembler):
    def __init__(self, repository: InMemoryRepository) -> None:
        super().__init__()
        self._repository = repository

    @asynccontextmanager
    async def assemble(
        self, request: AudioAssemblyRequest
    ) -> AsyncIterator[tuple[AudioTrack, ...]]:
        self.call_count += 1
        now = datetime.now(UTC)
        async with self._repository.transaction(request.tenant_id) as store:
            current = await store.transcription_job_for(request.tenant_id, request.session_id)
            assert current is not None
            expired = current.model_copy(update={"lease_until": now - timedelta(seconds=1)})
            assert await store.update_transcription_job(
                request.tenant_id,
                expired,
                expected_lease_token=request.lease_token,
            )
            stolen = await store.claim_transcription_job(
                request.tenant_id,
                request.session_id,
                job_id=current.id,
                lease_token=uuid4(),
                now=now,
                lease_until=now + timedelta(minutes=5),
                max_attempts=3,
            )
            assert stolen is not None
        yield (AudioTrack(uuid4(), CaptureChannel.MIXED, Path("/secure/stolen-lease.enc")),)


class FakeTranscriber:
    def __init__(self, *, failures: int = 0) -> None:
        self.failures = failures
        self.call_count = 0

    @property
    def name(self) -> str:
        return "fixture_stt"

    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        self.call_count += 1
        if self.call_count <= self.failures:
            raise RuntimeError("sensitive-patient-path-and-transcript")
        return SttResult(
            provider=self.name,
            language_code=request.language_code,
            duration_ms=2_000,
            segments=(
                SttSegment(
                    channel=CaptureChannel.MICROPHONE,
                    provider_speaker_id="speaker-1",
                    start_ms=0,
                    end_ms=900,
                    confidence=0.96,
                    content="Synthetic clinician fixture",
                ),
                SttSegment(
                    channel=CaptureChannel.SYSTEM_AUDIO,
                    provider_speaker_id="speaker-1",
                    start_ms=1_000,
                    end_ms=2_000,
                    confidence=0.92,
                    content="Synthetic patient fixture",
                ),
            ),
        )

    async def close(self) -> None:
        return None


class BlockingTranscriber(FakeTranscriber):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = False

    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        self.started.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return await super().transcribe(request)


class OversizedContentTranscriber(FakeTranscriber):
    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        self.call_count += 1
        return SttResult(
            provider=self.name,
            language_code=request.language_code,
            duration_ms=1_000,
            segments=(
                SttSegment(
                    channel=CaptureChannel.MICROPHONE,
                    provider_speaker_id="speaker-1",
                    start_ms=0,
                    end_ms=1_000,
                    confidence=0.96,
                    content="x" * 100_001,
                ),
            ),
        )


class TrackingRepository(InMemoryRepository):
    def __init__(self, *, fail_after_renewals: int | None = None) -> None:
        super().__init__()
        self.fail_after_renewals = fail_after_renewals
        self.renewed = asyncio.Event()
        self.renewal_count = 0

    async def renew_transcription_job(
        self,
        tenant_id: UUID,
        job_id: UUID,
        *,
        lease_token: UUID,
        now: datetime,
        lease_until: datetime,
    ) -> bool:
        self.renewal_count += 1
        if self.fail_after_renewals is not None and self.renewal_count > self.fail_after_renewals:
            self.renewed.set()
            return False
        result = await super().renew_transcription_job(
            tenant_id,
            job_id,
            lease_token=lease_token,
            now=now,
            lease_until=lease_until,
        )
        self.renewed.set()
        return result


async def _wait_for_event_or_worker_failure(
    event: asyncio.Event,
    processing: asyncio.Task[object],
) -> None:
    event_wait = asyncio.create_task(event.wait())
    try:
        done, _ = await asyncio.wait(
            {event_wait, processing},
            timeout=5,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if processing in done:
            await processing
            pytest.fail("worker completed before the expected event")
        assert event_wait in done, "worker event timed out"
    finally:
        event_wait.cancel()
        await asyncio.gather(event_wait, return_exceptions=True)


async def _seed_uploaded_session(
    repository: InMemoryRepository,
    *,
    tenant_id: UUID,
    revoked: bool = False,
) -> CaptureSession:
    now = datetime.now(UTC)
    consent = ConsentRecord(
        id=uuid4(),
        appointment_id="synthetic-appointment",
        practitioner_id="synthetic-practitioner",
        patient_id="synthetic-patient",
        modality=CaptureModality.VIRTUAL,
        participant_regions={"US-NY"},
        method=ConsentMethod.VERBAL_ATTESTATION,
        all_parties_consented=True,
        granted_at=now,
        policy_version="all-party-v1",
        revoked_at=now if revoked else None,
    )
    session = CaptureSession(
        id=uuid4(),
        appointment_id=consent.appointment_id,
        practitioner_id=consent.practitioner_id,
        patient_id=consent.patient_id,
        consent_record_id=consent.id,
        modality=consent.modality,
        status=SessionStatus.UPLOADED,
        created_at=now,
    )
    chunk = AudioChunk(
        id=uuid4(),
        session_id=session.id,
        sequence_number=0,
        channel=CaptureChannel.MIXED,
        object_id=uuid4(),
        sha256="a" * 64,
        ciphertext_size_bytes=1_024,
        registered_at=now,
    )
    async with repository.transaction(tenant_id) as store:
        await store.add_consent(tenant_id, consent)
        await store.add_session(tenant_id, session)
        await store.add_chunk(tenant_id, chunk)
    return session


def test_audio_worker_rejects_external_transcript_sessions_before_effectful_work() -> None:
    tenant_id = uuid4()
    repository = InMemoryRepository()
    assembler = FakeAssembler()
    transcriber = FakeTranscriber()

    async def scenario() -> None:
        chunk_session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        session = chunk_session.model_copy(
            update={"ingest_mode": SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT}
        )
        # Simulate a malformed pre-guard row to prove the worker still fails closed.
        repository.sessions[(tenant_id, session.id)] = session
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
        )

        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session.id)

        assert exception.value.code == "session_not_ready"
        async with repository.transaction(tenant_id) as store:
            assert await store.transcription_job_for(tenant_id, session.id) is None
            assert await store.transcript_for(tenant_id, session.id) is None

    asyncio.run(scenario())
    assert assembler.call_count == 0
    assert transcriber.call_count == 0


def test_worker_consent_gates_labels_persists_and_replays() -> None:
    tenant_id = uuid4()
    repository = InMemoryRepository()
    assembler = FakeAssembler()
    transcriber = FakeTranscriber()

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
        )

        first = await worker.process(tenant_id=tenant_id, session_id=session.id)
        replay = await worker.process(tenant_id=tenant_id, session_id=session.id)

        assert replay.id == first.id
        assert [segment.speaker_role for segment in first.segments] == [
            SpeakerRole.CLINICIAN,
            SpeakerRole.PATIENT,
        ]
        assert [segment.speaker_id for segment in first.segments] == [
            "microphone:speaker-1",
            "system_audio:speaker-1",
        ]
        async with repository.transaction(tenant_id) as store:
            persisted_session = await store.get_session(tenant_id, session.id)
            job = await store.transcription_job_for(tenant_id, session.id)
        assert persisted_session is not None
        assert persisted_session.status == SessionStatus.TRANSCRIPT_READY
        assert job is not None
        assert job.status == TranscriptionJobStatus.COMPLETED
        assert job.lease_token is None

    asyncio.run(scenario())
    assert assembler.call_count == 1
    assert transcriber.call_count == 1


def test_channel_role_prior_only_applies_to_virtual_dual_channel_capture() -> None:
    labeler = ChannelPriorRoleLabeler()
    microphone = SttSegment(
        channel=CaptureChannel.MICROPHONE,
        provider_speaker_id="speaker-1",
        start_ms=0,
        end_ms=100,
        confidence=0.9,
        content="Synthetic fixture",
    )

    assert labeler.label(microphone, CaptureModality.VIRTUAL) == SpeakerRole.CLINICIAN
    assert labeler.label(microphone, CaptureModality.IN_PERSON) == SpeakerRole.UNKNOWN


def test_revoked_consent_prevents_audio_assembly() -> None:
    tenant_id = uuid4()
    repository = InMemoryRepository()
    assembler = FakeAssembler()
    transcriber = FakeTranscriber()

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id, revoked=True)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
        )
        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session.id)
        assert exception.value.code == "consent_invalid"

    asyncio.run(scenario())
    assert assembler.call_count == 0
    assert transcriber.call_count == 0


def test_worker_failure_is_sanitized_and_retried_under_a_new_lease() -> None:
    tenant_id = uuid4()
    repository = InMemoryRepository()
    assembler = FakeAssembler()
    transcriber = FakeTranscriber(failures=1)

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
        )
        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session.id)
        assert str(exception.value) == "transcription_attempt_failed"
        assert "sensitive" not in repr(exception.value)
        async with repository.transaction(tenant_id) as store:
            retryable = await store.transcription_job_for(tenant_id, session.id)
        assert retryable is not None
        assert retryable.status == TranscriptionJobStatus.RETRYABLE
        assert retryable.attempt_count == 1

        transcript = await worker.process(tenant_id=tenant_id, session_id=session.id)
        assert transcript.stt_provider == "fixture_stt"
        async with repository.transaction(tenant_id) as store:
            completed = await store.transcription_job_for(tenant_id, session.id)
        assert completed is not None
        assert completed.status == TranscriptionJobStatus.COMPLETED
        assert completed.attempt_count == 2

    asyncio.run(scenario())


def test_worker_stops_after_three_durable_attempts() -> None:
    tenant_id = uuid4()
    repository = InMemoryRepository()
    assembler = FakeAssembler()
    transcriber = FakeTranscriber(failures=4)

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
            max_attempts=3,
        )

        for expected_attempt in (1, 2, 3):
            with pytest.raises(TranscriptionWorkerError) as exception:
                await worker.process(tenant_id=tenant_id, session_id=session.id)
            assert exception.value.code == "transcription_attempt_failed"
            async with repository.transaction(tenant_id) as store:
                job = await store.transcription_job_for(tenant_id, session.id)
            assert job is not None
            assert job.attempt_count == expected_attempt
            expected_status = (
                TranscriptionJobStatus.TERMINAL
                if expected_attempt == 3
                else TranscriptionJobStatus.RETRYABLE
            )
            assert job.status == expected_status

        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session.id)
        assert exception.value.code == "session_not_ready"

    asyncio.run(scenario())
    assert assembler.call_count == 3
    assert transcriber.call_count == 3


def test_worker_schema_violation_is_a_terminal_quality_failure() -> None:
    tenant_id = uuid4()
    repository = InMemoryRepository()
    assembler = FakeAssembler()
    transcriber = OversizedContentTranscriber()

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
        )

        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session.id)

        assert exception.value.code == "quality_gate_failed"
        async with repository.transaction(tenant_id) as store:
            persisted_session = await store.get_session(tenant_id, session.id)
            job = await store.transcription_job_for(tenant_id, session.id)
            transcript = await store.transcript_for(tenant_id, session.id)
        assert persisted_session is not None
        assert persisted_session.status == SessionStatus.FAILED
        assert job is not None
        assert job.status == TranscriptionJobStatus.TERMINAL
        assert job.last_error_code == "quality_gate_failed"
        assert transcript is None

    asyncio.run(scenario())


def test_worker_renews_lease_during_slow_transcription() -> None:
    tenant_id = uuid4()
    repository = TrackingRepository()
    assembler = FakeAssembler()
    transcriber = BlockingTranscriber()

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
            lease_duration=timedelta(milliseconds=120),
            heartbeat_interval=timedelta(milliseconds=20),
        )
        processing = asyncio.create_task(worker.process(tenant_id=tenant_id, session_id=session.id))
        await _wait_for_event_or_worker_failure(transcriber.started, processing)
        await _wait_for_event_or_worker_failure(repository.renewed, processing)

        async with repository.transaction(tenant_id) as store:
            competing_claim = await store.claim_transcription_job(
                tenant_id,
                session.id,
                job_id=uuid4(),
                lease_token=uuid4(),
                now=datetime.now(UTC),
                lease_until=datetime.now(UTC) + timedelta(milliseconds=120),
                max_attempts=3,
            )
        assert competing_claim is None

        transcriber.release.set()
        transcript = await processing
        assert transcript.session_id == session.id
        assert repository.renewal_count >= 2

    asyncio.run(scenario())


def test_worker_revalidates_exact_lease_before_speech_egress() -> None:
    tenant_id = uuid4()
    repository = InMemoryRepository()
    assembler = LeaseStealingAssembler(repository)
    transcriber = FakeTranscriber()

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
        )

        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session.id)

        assert exception.value.code == "transcription_lease_lost"

    asyncio.run(scenario())
    assert assembler.call_count == 1
    assert transcriber.call_count == 0


def test_worker_cancels_provider_work_when_lease_renewal_is_lost() -> None:
    tenant_id = uuid4()
    repository = TrackingRepository(fail_after_renewals=1)
    assembler = FakeAssembler()
    transcriber = BlockingTranscriber()

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
            lease_duration=timedelta(milliseconds=60),
            heartbeat_interval=timedelta(milliseconds=10),
        )
        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session.id)
        assert exception.value.code == "transcription_lease_lost"
        assert transcriber.cancelled
        async with repository.transaction(tenant_id) as store:
            assert await store.transcript_for(tenant_id, session.id) is None

    asyncio.run(scenario())


def test_worker_cancels_provider_work_during_shutdown() -> None:
    tenant_id = uuid4()
    repository = TrackingRepository()
    assembler = FakeAssembler()
    transcriber = BlockingTranscriber()

    async def scenario() -> None:
        session = await _seed_uploaded_session(repository, tenant_id=tenant_id)
        worker = TranscriptionWorker(
            repositories=repository,
            assembler=assembler,
            transcriber=transcriber,
            lease_duration=timedelta(seconds=1),
            heartbeat_interval=timedelta(milliseconds=500),
        )
        processing = asyncio.create_task(worker.process(tenant_id=tenant_id, session_id=session.id))
        await asyncio.wait_for(transcriber.started.wait(), timeout=1)
        processing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await processing
        assert transcriber.cancelled

    asyncio.run(scenario())
