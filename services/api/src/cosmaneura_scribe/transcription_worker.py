from __future__ import annotations

from collections.abc import Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Protocol
from uuid import UUID, uuid4

from .consent import ConsentError, ConsentPolicy
from .repository import Repository, RepositoryProvider
from .schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    SessionCreate,
    SessionStatus,
    SpeakerRole,
    Transcript,
    TranscriptionJob,
    TranscriptionJobStatus,
    TranscriptSegment,
)
from .transcription import (
    AudioTrack,
    SpeechToTextProvider,
    SttResult,
    SttSegment,
    TranscriptionRequest,
)


@dataclass(frozen=True)
class AudioAssemblyRequest:
    tenant_id: UUID
    session_id: UUID
    chunks: tuple[AudioChunk, ...] = field(repr=False)


class AudioTrackAssembler(Protocol):
    def assemble(
        self, request: AudioAssemblyRequest
    ) -> AbstractAsyncContextManager[tuple[AudioTrack, ...]]: ...


class SpeakerRoleLabeler(Protocol):
    def label(self, segment: SttSegment, modality: CaptureModality) -> SpeakerRole: ...


class TranscriptQualityGate(Protocol):
    def validate(self, result: SttResult, segments: Sequence[TranscriptSegment]) -> None: ...


class ChannelPriorRoleLabeler:
    """Use capture topology only where it provides a strong role prior."""

    def label(self, segment: SttSegment, modality: CaptureModality) -> SpeakerRole:
        if modality != CaptureModality.VIRTUAL:
            return SpeakerRole.UNKNOWN
        if segment.channel == CaptureChannel.MICROPHONE:
            return SpeakerRole.CLINICIAN
        if segment.channel == CaptureChannel.SYSTEM_AUDIO:
            return SpeakerRole.PATIENT
        return SpeakerRole.UNKNOWN


class BasicTranscriptQualityGate:
    def __init__(self, *, max_segments: int = 10_000, max_duration_ms: int = 86_400_000) -> None:
        self._max_segments = max_segments
        self._max_duration_ms = max_duration_ms

    def validate(self, result: SttResult, segments: Sequence[TranscriptSegment]) -> None:
        if not segments or len(segments) > self._max_segments:
            raise TranscriptionQualityError
        if result.duration_ms <= 0 or result.duration_ms > self._max_duration_ms:
            raise TranscriptionQualityError
        if any(segment.end_ms > result.duration_ms for segment in segments):
            raise TranscriptionQualityError
        starts = [segment.start_ms for segment in segments]
        if starts != sorted(starts):
            raise TranscriptionQualityError


class TranscriptionQualityError(ValueError):
    """A provider result failed metadata-only quality checks."""


class TranscriptionWorkerError(RuntimeError):
    """Sanitized worker failure that is safe for operational logs."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class TranscriptionWorker:
    def __init__(
        self,
        *,
        repositories: RepositoryProvider,
        assembler: AudioTrackAssembler,
        transcriber: SpeechToTextProvider,
        consent_policy: ConsentPolicy | None = None,
        role_labeler: SpeakerRoleLabeler | None = None,
        quality_gate: TranscriptQualityGate | None = None,
        lease_duration: timedelta = timedelta(minutes=15),
        max_attempts: int = 3,
    ) -> None:
        if lease_duration <= timedelta(0):
            raise ValueError("lease_duration must be positive")
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        self._repositories = repositories
        self._assembler = assembler
        self._transcriber = transcriber
        self._consent_policy = consent_policy or ConsentPolicy()
        self._role_labeler = role_labeler or ChannelPriorRoleLabeler()
        self._quality_gate = quality_gate or BasicTranscriptQualityGate()
        self._lease_duration = lease_duration
        self._max_attempts = max_attempts

    async def process(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        language_code: str = "en-US",
    ) -> Transcript:
        try:
            return await self._process(
                tenant_id=tenant_id,
                session_id=session_id,
                language_code=language_code,
            )
        except TranscriptionWorkerError:
            raise
        except Exception:
            raise TranscriptionWorkerError("transcription_worker_unavailable") from None

    async def _process(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        language_code: str,
    ) -> Transcript:
        now = datetime.now(UTC)
        lease_token = uuid4()
        async with self._repositories.transaction(tenant_id) as store:
            session = await self._session_for_processing(store, tenant_id, session_id)
            existing = await store.transcript_for(tenant_id, session_id)
            if existing is not None:
                return existing
            if session.status not in {SessionStatus.UPLOADED, SessionStatus.PROCESSING}:
                raise TranscriptionWorkerError("transcript_state_inconsistent")
            try:
                await self._validate_consent(store, tenant_id, session)
            except ConsentError:
                raise TranscriptionWorkerError("consent_invalid") from None
            chunks = tuple(await store.chunks_for(tenant_id, session_id))
            if not chunks:
                raise TranscriptionWorkerError("audio_chunks_missing")
            job = await store.claim_transcription_job(
                tenant_id,
                session_id,
                job_id=uuid4(),
                lease_token=lease_token,
                now=now,
                lease_until=now + self._lease_duration,
                max_attempts=self._max_attempts,
            )
            if job is None:
                raise TranscriptionWorkerError("transcription_job_unavailable")
            if session.status == SessionStatus.UPLOADED:
                await store.update_session(
                    tenant_id,
                    session.model_copy(update={"status": SessionStatus.PROCESSING}),
                )
            await store.audit(
                tenant_id=tenant_id,
                action="transcription_job.claimed",
                entity_type="transcription_job",
                entity_id=job.id,
            )

        try:
            result = await self._assemble_and_transcribe(
                tenant_id=tenant_id,
                session=session,
                chunks=chunks,
                language_code=language_code,
            )
            transcript = self._to_transcript(session, result)
            self._quality_gate.validate(result, transcript.segments)
            return await self._persist_success(
                tenant_id=tenant_id,
                session_id=session_id,
                job=job,
                lease_token=lease_token,
                transcript=transcript,
            )
        except ConsentError:
            await self._record_failure(
                tenant_id=tenant_id,
                session_id=session_id,
                job=job,
                lease_token=lease_token,
                code="consent_invalid",
                terminal=True,
            )
            raise TranscriptionWorkerError("consent_invalid") from None
        except TranscriptionQualityError:
            await self._record_failure(
                tenant_id=tenant_id,
                session_id=session_id,
                job=job,
                lease_token=lease_token,
                code="quality_gate_failed",
                terminal=True,
            )
            raise TranscriptionWorkerError("quality_gate_failed") from None
        except TranscriptionWorkerError:
            raise
        except Exception:
            await self._record_failure(
                tenant_id=tenant_id,
                session_id=session_id,
                job=job,
                lease_token=lease_token,
                code="transcription_attempt_failed",
                terminal=False,
            )
            raise TranscriptionWorkerError("transcription_attempt_failed") from None

    async def _assemble_and_transcribe(
        self,
        *,
        tenant_id: UUID,
        session: CaptureSession,
        chunks: tuple[AudioChunk, ...],
        language_code: str,
    ) -> SttResult:
        async with self._assembler.assemble(
            AudioAssemblyRequest(
                tenant_id=tenant_id,
                session_id=session.id,
                chunks=chunks,
            )
        ) as assembled_tracks:
            await self._revalidate_before_transcription(tenant_id, session.id)
            return await self._transcriber.transcribe(
                TranscriptionRequest(
                    session_id=session.id,
                    consent_record_id=session.consent_record_id,
                    language_code=language_code,
                    tracks=assembled_tracks,
                )
            )

    async def _revalidate_before_transcription(self, tenant_id: UUID, session_id: UUID) -> None:
        async with self._repositories.transaction(tenant_id) as store:
            session = await self._session_for_processing(store, tenant_id, session_id)
            if session.status != SessionStatus.PROCESSING:
                raise TranscriptionWorkerError("transcription_lease_lost")
            await self._validate_consent(store, tenant_id, session)

    async def _persist_success(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        job: TranscriptionJob,
        lease_token: UUID,
        transcript: Transcript,
    ) -> Transcript:
        now = datetime.now(UTC)
        async with self._repositories.transaction(tenant_id) as store:
            session = await self._session_for_processing(store, tenant_id, session_id)
            if session.status != SessionStatus.PROCESSING:
                raise TranscriptionWorkerError("transcription_lease_lost")
            await self._validate_consent(store, tenant_id, session)
            completed = job.model_copy(
                update={
                    "status": TranscriptionJobStatus.COMPLETED,
                    "lease_token": None,
                    "lease_until": None,
                    "last_error_code": None,
                    "updated_at": now,
                }
            )
            if not await store.update_transcription_job(
                tenant_id,
                completed,
                expected_lease_token=lease_token,
            ):
                raise TranscriptionWorkerError("transcription_lease_lost")
            await store.add_transcript(tenant_id, transcript)
            await store.update_session(
                tenant_id,
                session.model_copy(update={"status": SessionStatus.TRANSCRIPT_READY}),
            )
            await store.audit(
                tenant_id=tenant_id,
                action="transcript.created",
                entity_type="transcript",
                entity_id=transcript.id,
            )
            return transcript

    async def _record_failure(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        job: TranscriptionJob,
        lease_token: UUID,
        code: str,
        terminal: bool,
    ) -> None:
        now = datetime.now(UTC)
        is_terminal = terminal or job.attempt_count >= self._max_attempts
        status = (
            TranscriptionJobStatus.TERMINAL if is_terminal else TranscriptionJobStatus.RETRYABLE
        )
        failed = job.model_copy(
            update={
                "status": status,
                "lease_token": None,
                "lease_until": None,
                "last_error_code": code,
                "updated_at": now,
            }
        )
        async with self._repositories.transaction(tenant_id) as store:
            if not await store.update_transcription_job(
                tenant_id,
                failed,
                expected_lease_token=lease_token,
            ):
                raise TranscriptionWorkerError("transcription_lease_lost")
            if is_terminal:
                session = await store.lock_session(tenant_id, session_id)
                if session is not None and session.status == SessionStatus.PROCESSING:
                    await store.update_session(
                        tenant_id,
                        session.model_copy(update={"status": SessionStatus.FAILED}),
                    )
            await store.audit(
                tenant_id=tenant_id,
                action=(
                    "transcription_job.failed"
                    if is_terminal
                    else "transcription_job.retry_scheduled"
                ),
                entity_type="transcription_job",
                entity_id=job.id,
            )

    async def _session_for_processing(
        self,
        store: Repository,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureSession:
        session = await store.lock_session(tenant_id, session_id)
        if session is None:
            raise TranscriptionWorkerError("session_unavailable")
        if session.status not in {
            SessionStatus.UPLOADED,
            SessionStatus.PROCESSING,
            SessionStatus.TRANSCRIPT_READY,
            SessionStatus.HANDED_OFF,
        }:
            raise TranscriptionWorkerError("session_not_ready")
        return session

    async def _validate_consent(
        self,
        store: Repository,
        tenant_id: UUID,
        session: CaptureSession,
    ) -> None:
        consent = await store.get_consent(tenant_id, session.consent_record_id)
        if consent is None:
            raise ConsentError
        self._consent_policy.validate_session(
            consent,
            SessionCreate(
                appointment_id=session.appointment_id,
                practitioner_id=session.practitioner_id,
                patient_id=session.patient_id,
                consent_record_id=session.consent_record_id,
                modality=session.modality,
            ),
        )

    def _to_transcript(self, session: CaptureSession, result: SttResult) -> Transcript:
        segments = [
            TranscriptSegment(
                speaker_id=f"{segment.channel.value}:{segment.provider_speaker_id}",
                speaker_role=self._role_labeler.label(segment, session.modality),
                content=segment.content,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                confidence=segment.confidence,
            )
            for segment in result.segments
        ]
        return Transcript(
            id=uuid4(),
            session_id=session.id,
            language_code=result.language_code,
            stt_provider=result.provider,
            segments=segments,
            created_at=datetime.now(UTC),
        )
