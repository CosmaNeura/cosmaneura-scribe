from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
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
