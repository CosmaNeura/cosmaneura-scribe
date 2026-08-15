from __future__ import annotations

import asyncio
import copy
from collections.abc import AsyncGenerator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

from .schemas import (
    AudioChunk,
    AuditEvent,
    CaptureChannel,
    CaptureSession,
    ConsentRecord,
    SessionStatus,
    Transcript,
    TranscriptDelivery,
    TranscriptionJob,
    TranscriptionJobStatus,
)
from .session_state_v1 import can_transition_session


class IdempotencyConflictError(ValueError):
    """The same idempotency key was used for a different request."""


@dataclass(frozen=True)
class IdempotencyRecord:
    request_fingerprint: str
    entity_id: UUID


@dataclass(frozen=True)
class UploadGrantRecord:
    object_id: UUID
    session_id: UUID
    sequence_number: int
    channel: CaptureChannel
    expires_at: datetime


class Repository(Protocol):
    async def claim_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
        request_fingerprint: str,
        entity_id: UUID,
    ) -> UUID | None: ...

    async def get_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None: ...

    async def add_consent(self, tenant_id: UUID, consent: ConsentRecord) -> None: ...

    async def get_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None: ...

    async def lock_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None: ...

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None: ...

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None: ...

    async def get_chunk(self, tenant_id: UUID, chunk_id: UUID) -> AudioChunk | None: ...

    async def add_chunk(self, tenant_id: UUID, chunk: AudioChunk) -> None: ...

    async def chunks_for(self, tenant_id: UUID, session_id: UUID) -> list[AudioChunk]: ...

    async def get_upload_grant(
        self, tenant_id: UUID, object_id: UUID
    ) -> UploadGrantRecord | None: ...

    async def add_upload_grant(self, tenant_id: UUID, grant: UploadGrantRecord) -> None: ...

    async def get_transcript(self, tenant_id: UUID, transcript_id: UUID) -> Transcript | None: ...

    async def add_transcript(self, tenant_id: UUID, transcript: Transcript) -> None: ...

    async def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None: ...

    async def transcription_job_for(
        self, tenant_id: UUID, session_id: UUID
    ) -> TranscriptionJob | None: ...

    async def claim_transcription_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        job_id: UUID,
        lease_token: UUID,
        now: datetime,
        lease_until: datetime,
        max_attempts: int,
    ) -> TranscriptionJob | None: ...

    async def update_transcription_job(
        self,
        tenant_id: UUID,
        job: TranscriptionJob,
        *,
        expected_lease_token: UUID,
    ) -> bool: ...

    async def renew_transcription_job(
        self,
        tenant_id: UUID,
        job_id: UUID,
        *,
        lease_token: UUID,
        now: datetime,
        lease_until: datetime,
    ) -> bool: ...

    async def get_delivery(
        self, tenant_id: UUID, delivery_id: UUID
    ) -> TranscriptDelivery | None: ...

    async def delivery_for(
        self, tenant_id: UUID, session_id: UUID
    ) -> TranscriptDelivery | None: ...

    async def add_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None: ...

    async def update_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None: ...

    async def audit(
        self, *, tenant_id: UUID, action: str, entity_type: str, entity_id: UUID
    ) -> None: ...


class RepositoryProvider(Protocol):
    def transaction(self, tenant_id: UUID) -> AbstractAsyncContextManager[Repository]: ...

    async def health(self) -> None: ...

    async def close(self) -> None: ...


@dataclass
class InMemoryRepository:
    consents: dict[tuple[UUID, UUID], ConsentRecord] = field(default_factory=lambda: {})
    sessions: dict[tuple[UUID, UUID], CaptureSession] = field(default_factory=lambda: {})
    chunks: dict[tuple[UUID, UUID], AudioChunk] = field(default_factory=lambda: {})
    upload_grants: dict[tuple[UUID, UUID], UploadGrantRecord] = field(default_factory=lambda: {})
    transcripts: dict[tuple[UUID, UUID], Transcript] = field(default_factory=lambda: {})
    transcript_by_session: dict[tuple[UUID, UUID], UUID] = field(default_factory=lambda: {})
    transcription_jobs: dict[tuple[UUID, UUID], TranscriptionJob] = field(
        default_factory=lambda: {}
    )
    transcription_job_by_session: dict[tuple[UUID, UUID], UUID] = field(default_factory=lambda: {})
    deliveries: dict[tuple[UUID, UUID], TranscriptDelivery] = field(default_factory=lambda: {})
    delivery_by_session: dict[tuple[UUID, UUID], UUID] = field(default_factory=lambda: {})
    idempotency: dict[tuple[UUID, str, str], IdempotencyRecord] = field(default_factory=lambda: {})
    audit_events: list[AuditEvent] = field(default_factory=lambda: [])
    _transaction_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        del tenant_id
        async with self._transaction_lock:
            snapshot = (
                copy.deepcopy(self.consents),
                copy.deepcopy(self.sessions),
                copy.deepcopy(self.chunks),
                copy.deepcopy(self.upload_grants),
                copy.deepcopy(self.transcripts),
                copy.deepcopy(self.transcript_by_session),
                copy.deepcopy(self.transcription_jobs),
                copy.deepcopy(self.transcription_job_by_session),
                copy.deepcopy(self.deliveries),
                copy.deepcopy(self.delivery_by_session),
                copy.deepcopy(self.idempotency),
                copy.deepcopy(self.audit_events),
            )
            try:
                yield self
            except BaseException:
                (
                    self.consents,
                    self.sessions,
                    self.chunks,
                    self.upload_grants,
                    self.transcripts,
                    self.transcript_by_session,
                    self.transcription_jobs,
                    self.transcription_job_by_session,
                    self.deliveries,
                    self.delivery_by_session,
                    self.idempotency,
                    self.audit_events,
                ) = snapshot
                raise

    async def health(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def claim_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
        request_fingerprint: str,
        entity_id: UUID,
    ) -> UUID | None:
        record_key = (tenant_id, operation, key)
        previous = self.idempotency.get(record_key)
        if previous is None:
            self.idempotency[record_key] = IdempotencyRecord(request_fingerprint, entity_id)
            return None
        if previous.request_fingerprint != request_fingerprint:
            raise IdempotencyConflictError
        return previous.entity_id

    async def get_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None:
        return self.consents.get((tenant_id, consent_id))

    async def add_consent(self, tenant_id: UUID, consent: ConsentRecord) -> None:
        self.consents[(tenant_id, consent.id)] = consent

    async def get_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        return self.sessions.get((tenant_id, session_id))

    async def lock_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        # The in-memory transaction lock already serializes all mutations.
        return await self.get_session(tenant_id, session_id)

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        self.sessions[(tenant_id, session.id)] = session

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        current = self.sessions.get((tenant_id, session.id))
        if current is not None and not can_transition_session(current.status, session.status):
            raise ValueError(
                f"invalid scribe session status transition: "
                f"{current.status.value} -> {session.status.value}"
            )
        self.sessions[(tenant_id, session.id)] = session

    async def get_chunk(self, tenant_id: UUID, chunk_id: UUID) -> AudioChunk | None:
        return self.chunks.get((tenant_id, chunk_id))

    async def add_chunk(self, tenant_id: UUID, chunk: AudioChunk) -> None:
        self.chunks[(tenant_id, chunk.id)] = chunk

    async def chunks_for(self, tenant_id: UUID, session_id: UUID) -> list[AudioChunk]:
        return sorted(
            (
                chunk
                for (row_tenant, _), chunk in self.chunks.items()
                if row_tenant == tenant_id and chunk.session_id == session_id
            ),
            key=lambda chunk: (chunk.sequence_number, chunk.channel),
        )

    async def get_upload_grant(self, tenant_id: UUID, object_id: UUID) -> UploadGrantRecord | None:
        return self.upload_grants.get((tenant_id, object_id))

    async def add_upload_grant(self, tenant_id: UUID, grant: UploadGrantRecord) -> None:
        self.upload_grants[(tenant_id, grant.object_id)] = grant

    async def get_transcript(self, tenant_id: UUID, transcript_id: UUID) -> Transcript | None:
        return self.transcripts.get((tenant_id, transcript_id))

    async def add_transcript(self, tenant_id: UUID, transcript: Transcript) -> None:
        self.transcripts[(tenant_id, transcript.id)] = transcript
        self.transcript_by_session[(tenant_id, transcript.session_id)] = transcript.id

    async def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        transcript_id = self.transcript_by_session.get((tenant_id, session_id))
        if transcript_id is None:
            return None
        return self.transcripts[(tenant_id, transcript_id)]

    async def transcription_job_for(
        self, tenant_id: UUID, session_id: UUID
    ) -> TranscriptionJob | None:
        job_id = self.transcription_job_by_session.get((tenant_id, session_id))
        if job_id is None:
            return None
        return self.transcription_jobs[(tenant_id, job_id)]

    async def claim_transcription_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        job_id: UUID,
        lease_token: UUID,
        now: datetime,
        lease_until: datetime,
        max_attempts: int,
    ) -> TranscriptionJob | None:
        current = await self.transcription_job_for(tenant_id, session_id)
        if current is not None:
            session = await self.get_session(tenant_id, session_id)
            recovering_terminal = (
                current.status == TranscriptionJobStatus.TERMINAL
                and session is not None
                and session.status == SessionStatus.UPLOADED
            )
            eligible_retry = current.status == TranscriptionJobStatus.RETRYABLE or (
                current.status == TranscriptionJobStatus.PROCESSING
                and current.lease_until is not None
                and current.lease_until <= now
            )
            if not recovering_terminal and (
                not eligible_retry or current.attempt_count >= max_attempts
            ):
                return None
            job_id = current.id
            created_at = current.created_at
            attempt_count = 1 if recovering_terminal else current.attempt_count + 1
        else:
            created_at = now
            attempt_count = 1

        claimed = TranscriptionJob(
            id=job_id,
            session_id=session_id,
            status=TranscriptionJobStatus.PROCESSING,
            attempt_count=attempt_count,
            lease_token=lease_token,
            lease_until=lease_until,
            last_error_code=None,
            created_at=created_at,
            updated_at=now,
        )
        self.transcription_jobs[(tenant_id, job_id)] = claimed
        self.transcription_job_by_session[(tenant_id, session_id)] = job_id
        return claimed

    async def update_transcription_job(
        self,
        tenant_id: UUID,
        job: TranscriptionJob,
        *,
        expected_lease_token: UUID,
    ) -> bool:
        current = self.transcription_jobs.get((tenant_id, job.id))
        if (
            current is None
            or current.status != TranscriptionJobStatus.PROCESSING
            or current.lease_token != expected_lease_token
        ):
            return False
        self.transcription_jobs[(tenant_id, job.id)] = job
        return True

    async def renew_transcription_job(
        self,
        tenant_id: UUID,
        job_id: UUID,
        *,
        lease_token: UUID,
        now: datetime,
        lease_until: datetime,
    ) -> bool:
        current = self.transcription_jobs.get((tenant_id, job_id))
        if (
            current is None
            or current.status != TranscriptionJobStatus.PROCESSING
            or current.lease_token != lease_token
            or current.lease_until is None
            or current.lease_until <= now
        ):
            return False
        self.transcription_jobs[(tenant_id, job_id)] = current.model_copy(
            update={"lease_until": lease_until, "updated_at": now}
        )
        return True

    async def get_delivery(self, tenant_id: UUID, delivery_id: UUID) -> TranscriptDelivery | None:
        return self.deliveries.get((tenant_id, delivery_id))

    async def delivery_for(self, tenant_id: UUID, session_id: UUID) -> TranscriptDelivery | None:
        delivery_id = self.delivery_by_session.get((tenant_id, session_id))
        if delivery_id is None:
            return None
        return self.deliveries[(tenant_id, delivery_id)]

    async def add_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None:
        self.deliveries[(tenant_id, delivery.id)] = delivery
        self.delivery_by_session[(tenant_id, delivery.session_id)] = delivery.id

    async def update_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None:
        self.deliveries[(tenant_id, delivery.id)] = delivery

    async def audit(
        self, *, tenant_id: UUID, action: str, entity_type: str, entity_id: UUID
    ) -> None:
        self.audit_events.append(
            AuditEvent(
                tenant_id=tenant_id,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                occurred_at=datetime.now(UTC),
            )
        )
