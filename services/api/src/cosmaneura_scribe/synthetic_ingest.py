from __future__ import annotations

from threading import RLock
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class SyntheticIngestConflictError(ValueError):
    """Raised when a session ID is reused with different synthetic content."""


class SyntheticIngestSession(BaseModel):
    """A non-production ingest fixture held only for the life of this process."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: UUID
    tenant_id: UUID
    status: str = Field(min_length=1, max_length=64)
    transcript_text: str | None = Field(default=None, max_length=100_000, repr=False)


class SyntheticIngestStore:
    """Tenant-scoped, process-local storage for synthetic preview sessions."""

    def __init__(self) -> None:
        self._sessions: dict[tuple[UUID, UUID], SyntheticIngestSession] = {}
        self._lock = RLock()

    def persist(
        self,
        *,
        tenant_id: UUID | None,
        session_id: UUID | None,
        status: str,
        transcript_text: str | None = None,
    ) -> SyntheticIngestSession:
        if tenant_id is None:
            raise ValueError("tenant_id is required")
        if session_id is None:
            raise ValueError("session_id is required")
        if not status.strip():
            raise ValueError("status is required")

        session = SyntheticIngestSession(
            id=session_id,
            tenant_id=tenant_id,
            status=status,
            transcript_text=transcript_text,
        )
        with self._lock:
            key = (session.tenant_id, session.id)
            existing = self._sessions.get(key)
            if existing is not None:
                if existing != session:
                    raise SyntheticIngestConflictError(
                        "synthetic session already exists with different content"
                    )
                return existing
            self._sessions[key] = session
        return session

    def get(
        self,
        *,
        tenant_id: UUID | None,
        session_id: UUID | None,
    ) -> SyntheticIngestSession | None:
        if tenant_id is None:
            raise ValueError("tenant_id is required")
        if session_id is None:
            raise ValueError("session_id is required")

        with self._lock:
            return self._sessions.get((tenant_id, session_id))


synthetic_ingest_store = SyntheticIngestStore()


def persist_synthetic_ingest(
    *,
    tenant_id: UUID | None,
    session_id: UUID | None,
    status: str,
    transcript_text: str | None = None,
    store: SyntheticIngestStore = synthetic_ingest_store,
) -> SyntheticIngestSession:
    return store.persist(
        tenant_id=tenant_id,
        session_id=session_id,
        status=status,
        transcript_text=transcript_text,
    )


def get_synthetic_ingest(
    *,
    tenant_id: UUID | None,
    session_id: UUID | None,
    store: SyntheticIngestStore = synthetic_ingest_store,
) -> SyntheticIngestSession | None:
    return store.get(tenant_id=tenant_id, session_id=session_id)
