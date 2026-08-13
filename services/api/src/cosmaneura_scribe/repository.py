from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

from .schemas import AudioChunk, AuditEvent, CaptureSession, ConsentRecord, Transcript


@dataclass(frozen=True)
class IdempotencyRecord:
    request_fingerprint: str
    entity_id: UUID


@dataclass
class InMemoryRepository:
    consents: dict[tuple[UUID, UUID], ConsentRecord] = field(default_factory=lambda: {})
    sessions: dict[tuple[UUID, UUID], CaptureSession] = field(default_factory=lambda: {})
    chunks: dict[tuple[UUID, UUID], AudioChunk] = field(default_factory=lambda: {})
    transcripts: dict[tuple[UUID, UUID], Transcript] = field(default_factory=lambda: {})
    transcript_by_session: dict[tuple[UUID, UUID], UUID] = field(default_factory=lambda: {})
    idempotency: dict[tuple[UUID, str, str], IdempotencyRecord] = field(default_factory=lambda: {})
    audit_events: list[AuditEvent] = field(default_factory=lambda: [])

    def chunks_for(self, tenant_id: UUID, session_id: UUID) -> list[AudioChunk]:
        return sorted(
            (
                chunk
                for (row_tenant, _), chunk in self.chunks.items()
                if row_tenant == tenant_id and chunk.session_id == session_id
            ),
            key=lambda chunk: (chunk.sequence_number, chunk.channel),
        )

    def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        transcript_id = self.transcript_by_session.get((tenant_id, session_id))
        if transcript_id is None:
            return None
        return self.transcripts[(tenant_id, transcript_id)]

    def audit(self, *, tenant_id: UUID, action: str, entity_type: str, entity_id: UUID) -> None:
        self.audit_events.append(
            AuditEvent(
                tenant_id=tenant_id,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                occurred_at=datetime.now(UTC),
            )
        )
