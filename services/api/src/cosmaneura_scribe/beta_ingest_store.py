from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from threading import RLock
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class BetaIngestStatus(StrEnum):
    READY_FOR_REVIEW = "ready_for_review"
    PROCESSING = "processing"


class BetaTranscriptSegment(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    speaker: Literal["Clinician", "Participant"]
    offset_ms: int = Field(ge=0)
    duration_ms: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=500)


class BetaTranscript(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    language_code: Literal["en-US"] = "en-US"
    segments: tuple[BetaTranscriptSegment, ...]


class BetaIngest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID
    tenant_id: UUID
    status: BetaIngestStatus
    created_at: datetime
    transcript: BetaTranscript | None = None


@dataclass(frozen=True)
class BetaAuditEvent:
    tenant_id: UUID
    action: Literal["beta_preview.synthetic_ingest_created"]
    entity_id: UUID
    occurred_at: datetime


@dataclass(frozen=True)
class BetaIngestCreateResult:
    ingest: BetaIngest
    created: bool


@dataclass(frozen=True)
class _IdempotencyRecord:
    include_transcript: bool
    ingest_id: UUID


class BetaIdempotencyConflictError(RuntimeError):
    """Raised when a tenant reuses a key for a different synthetic request."""


def _synthetic_transcript() -> BetaTranscript:
    return BetaTranscript(
        segments=(
            BetaTranscriptSegment(
                speaker="Clinician",
                offset_ms=0,
                duration_ms=4_200,
                text="Thanks for testing the local Scribe Beta review flow.",
            ),
            BetaTranscriptSegment(
                speaker="Participant",
                offset_ms=4_600,
                duration_ms=5_100,
                text="This synthetic visit confirms that the ingest persisted locally.",
            ),
            BetaTranscriptSegment(
                speaker="Clinician",
                offset_ms=10_100,
                duration_ms=4_500,
                text="The transcript is ready for a safe, local review.",
            ),
        )
    )


class BetaIngestStore:
    """Process-local, tenant-scoped persistence for synthetic Beta sessions only."""

    def __init__(
        self,
        *,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], UUID] | None = None,
    ) -> None:
        self._clock = clock or (lambda: datetime.now(UTC))
        self._id_factory = id_factory or uuid4
        self._records: dict[UUID, dict[UUID, BetaIngest]] = {}
        self._idempotency: dict[tuple[UUID, str], _IdempotencyRecord] = {}
        self._audit_events: list[BetaAuditEvent] = []
        self._lock = RLock()

    def create_synthetic(
        self,
        *,
        tenant_id: UUID,
        idempotency_key: str,
        include_transcript: bool,
    ) -> BetaIngestCreateResult:
        normalized_key = idempotency_key.strip()
        if len(normalized_key) < 8:
            raise ValueError("idempotency_key must contain at least eight characters")

        with self._lock:
            idempotency_record = self._idempotency.get((tenant_id, normalized_key))
            if idempotency_record is not None:
                if idempotency_record.include_transcript != include_transcript:
                    raise BetaIdempotencyConflictError
                ingest = self._records[tenant_id][idempotency_record.ingest_id]
                return BetaIngestCreateResult(ingest=ingest, created=False)

            now = self._clock()
            if now.tzinfo is None or now.utcoffset() is None:
                raise ValueError("clock must return a timezone-aware datetime")
            ingest_id = self._id_factory()
            transcript = _synthetic_transcript() if include_transcript else None
            ingest = BetaIngest(
                id=ingest_id,
                tenant_id=tenant_id,
                status=(
                    BetaIngestStatus.READY_FOR_REVIEW
                    if transcript is not None
                    else BetaIngestStatus.PROCESSING
                ),
                created_at=now.astimezone(UTC),
                transcript=transcript,
            )
            self._records.setdefault(tenant_id, {})[ingest_id] = ingest
            self._idempotency[(tenant_id, normalized_key)] = _IdempotencyRecord(
                include_transcript=include_transcript,
                ingest_id=ingest_id,
            )
            self._audit_events.append(
                BetaAuditEvent(
                    tenant_id=tenant_id,
                    action="beta_preview.synthetic_ingest_created",
                    entity_id=ingest_id,
                    occurred_at=now.astimezone(UTC),
                )
            )
            return BetaIngestCreateResult(ingest=ingest, created=True)

    def get(self, *, tenant_id: UUID, ingest_id: UUID) -> BetaIngest | None:
        with self._lock:
            return self._records.get(tenant_id, {}).get(ingest_id)

    def list_for_tenant(self, *, tenant_id: UUID) -> tuple[BetaIngest, ...]:
        with self._lock:
            records = self._records.get(tenant_id, {}).values()
            return tuple(
                sorted(records, key=lambda record: (record.created_at, record.id), reverse=True)
            )

    def audit_events_for_tenant(self, *, tenant_id: UUID) -> tuple[BetaAuditEvent, ...]:
        with self._lock:
            return tuple(event for event in self._audit_events if event.tenant_id == tenant_id)
