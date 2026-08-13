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
    Transcript,
)


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

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        self.sessions[(tenant_id, session.id)] = session

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None:
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
