from __future__ import annotations

import asyncio
import copy
from collections.abc import AsyncGenerator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from types import MappingProxyType
from typing import Protocol
from uuid import UUID

from .capture_protocol_v1 import (
    CAPTURE_LEASE_TTL_SECONDS,
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_RESERVATIONS_PER_BATCH,
    PROTOCOL_VERSION,
    RESERVATION_PLAINTEXT_BUDGET_BYTES,
)
from .normalized_source_persistence import (
    VersionedExternalSessionCreate,
    VersionedExternalSessionRecord,
    build_versioned_external_session_record,
    consent_authorizes_versioned_session,
)
from .schemas import (
    AudioChunk,
    AuditEvent,
    CaptureChannel,
    CaptureSession,
    ConsentRecord,
    DeliveryAttempt,
    DeliveryConsentSource,
    DeliveryPayloadSource,
    DeliverySessionSource,
    DeliveryStatus,
    DeliveryTranscriptSource,
    SessionAudioKey,
    SessionStatus,
    Transcript,
    TranscriptDelivery,
    TranscriptionJob,
    TranscriptionJobStatus,
)
from .session_state_v1 import SessionIngestMode, can_transition_session


class IdempotencyConflictError(ValueError):
    """The same idempotency key was used for a different request."""


class IdempotencyClaimUnavailableError(RuntimeError):
    """A concurrent idempotency claim could not yet be observed safely."""


class DeliverySuccessConflictError(RuntimeError):
    """A remote success disagrees with the delivery receipt's durable binding."""


class CaptureIngestModeError(ValueError):
    """An audio-capture mutation was attempted for a non-capture session."""


class CaptureLeaseConflictError(RuntimeError):
    """A capture lease could not be issued or renewed under the expected fence."""


class CaptureReservationLimitError(RuntimeError):
    """A reservation batch would exceed a server-owned capture limit."""


class CaptureFinalizationError(RuntimeError):
    """A capture cannot be finalized with the registered channel sequences."""


MAXIMUM_CAPTURE_LEASE_DURATION = timedelta(seconds=CAPTURE_LEASE_TTL_SECONDS)


def _capture_expiry(now: datetime, duration: timedelta) -> datetime:
    if duration <= timedelta(0) or duration > MAXIMUM_CAPTURE_LEASE_DURATION:
        raise ValueError("capture authorization duration must be between zero and 15 minutes")
    return now + duration


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


class CaptureLeaseCloseReason(StrEnum):
    SESSION_COMPLETED = "session_completed"
    CONSENT_REVOKED = "consent_revoked"
    CAPTURE_STOPPED = "capture_stopped"
    SESSION_FAILED = "session_failed"


@dataclass(frozen=True)
class CaptureLeaseRecord:
    lease_id: UUID
    session_id: UUID
    generation: int
    issued_at: datetime
    renewed_at: datetime
    expires_at: datetime
    closed_at: datetime | None = None
    close_reason: CaptureLeaseCloseReason | None = None


@dataclass(frozen=True)
class CaptureLeaseReceipt:
    id: UUID
    lease_id: UUID
    session_id: UUID
    generation: int
    issued_at: datetime
    expires_at: datetime


@dataclass(frozen=True)
class CaptureContext:
    session: CaptureSession
    consent: ConsentRecord
    audio_key: SessionAudioKey | None
    lease: CaptureLeaseRecord | None


@dataclass(frozen=True)
class ChunkReservationDraft:
    object_id: UUID
    sequence_number: int
    channel: CaptureChannel
    protocol_version: str
    additional_data: bytes = field(repr=False)
    plaintext_budget_bytes: int


@dataclass(frozen=True)
class ChunkReservationRecord:
    object_id: UUID
    session_id: UUID
    sequence_number: int
    channel: CaptureChannel
    protocol_version: str
    additional_data: bytes = field(repr=False)
    plaintext_budget_bytes: int
    created_at: datetime


@dataclass(frozen=True)
class ChunkReservationBatch:
    id: UUID
    session_id: UUID
    lease_id: UUID
    lease_generation: int
    requested_protocol_version: str
    created_at: datetime
    capture_authorized_until: datetime
    reservations: tuple[ChunkReservationRecord, ...] = field(repr=False)


@dataclass(frozen=True)
class UploadAuthorizationReceipt:
    id: UUID
    session_id: UUID
    reservation_object_id: UUID
    issued_at: datetime
    expires_at: datetime


@dataclass(frozen=True)
class ChunkReceipt:
    reservation: ChunkReservationRecord
    registration: AudioChunk | None = field(default=None, repr=False)


@dataclass(frozen=True)
class CaptureReservationUsage:
    reservation_count: int
    plaintext_budget_bytes: int
    next_sequence_numbers: Mapping[CaptureChannel, int] = field(
        default_factory=lambda: MappingProxyType({})
    )


@dataclass(frozen=True)
class CaptureChannelFinalizationDraft:
    channel: CaptureChannel
    last_sequence_number: int


@dataclass(frozen=True)
class CaptureChannelFinalization:
    session_id: UUID
    channel: CaptureChannel
    last_sequence_number: int
    finalized_at: datetime


@dataclass(frozen=True)
class AudioAssemblyManifest:
    audio_key: SessionAudioKey
    chunks: tuple[AudioChunk, ...] = field(repr=False)


@dataclass(frozen=True)
class DeliveryClaimPolicy:
    pending_timeout: timedelta = timedelta(minutes=5)
    retry_delay: timedelta = timedelta(minutes=1)

    def __post_init__(self) -> None:
        if self.pending_timeout <= timedelta(0) or self.retry_delay <= timedelta(0):
            raise ValueError("delivery claim delays must be positive")


@dataclass(frozen=True)
class DeliverySuccessCompletion:
    delivery: DeliveryAttempt
    changed: bool


@dataclass(frozen=True)
class ConsentRevocationResult:
    consent: ConsentRecord
    changed: bool


class DeliverySessionSyncResult(StrEnum):
    SYNCHRONIZED = "synchronized"
    ALREADY_SYNCHRONIZED = "already_synchronized"
    SESSION_UNAVAILABLE = "session_unavailable"
    SESSION_STATE_CONFLICT = "session_state_conflict"


class Repository(Protocol):
    async def get_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
    ) -> IdempotencyRecord | None: ...

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

    async def lock_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None: ...

    async def add_consent(self, tenant_id: UUID, consent: ConsentRecord) -> None: ...

    async def revoke_consent(
        self,
        tenant_id: UUID,
        consent_id: UUID,
    ) -> ConsentRevocationResult | None: ...

    async def get_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None: ...

    async def lock_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None: ...

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None: ...

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None: ...

    async def create_versioned_external_session(
        self,
        tenant_id: UUID,
        draft: VersionedExternalSessionCreate,
    ) -> VersionedExternalSessionRecord | None: ...

    async def get_versioned_external_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> VersionedExternalSessionRecord | None: ...

    async def lock_versioned_external_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> VersionedExternalSessionRecord | None: ...

    async def get_session_audio_key(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> SessionAudioKey | None: ...

    async def add_session_audio_key(
        self,
        tenant_id: UUID,
        audio_key: SessionAudioKey,
    ) -> bool: ...

    async def lock_capture_context(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureContext | None: ...

    async def get_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureLeaseRecord | None: ...

    async def get_capture_lease_receipt(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> CaptureLeaseReceipt | None: ...

    async def issue_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        lease_id: UUID,
        receipt_id: UUID,
        duration: timedelta,
    ) -> CaptureLeaseReceipt | None: ...

    async def renew_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        expected_lease_id: UUID,
        expected_generation: int,
        receipt_id: UUID,
        duration: timedelta,
    ) -> CaptureLeaseReceipt | None: ...

    async def close_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        expected_lease_id: UUID,
        expected_generation: int,
        reason: CaptureLeaseCloseReason,
    ) -> bool: ...

    async def get_chunk_reservation_batch(
        self,
        tenant_id: UUID,
        batch_id: UUID,
    ) -> ChunkReservationBatch | None: ...

    async def create_chunk_reservation_batch(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        batch_id: UUID,
        lease_id: UUID,
        lease_generation: int,
        requested_protocol_version: str,
        drafts: tuple[ChunkReservationDraft, ...],
        maximum_batch_size: int,
        maximum_chunks: int,
        maximum_plaintext_bytes: int,
    ) -> ChunkReservationBatch: ...

    async def get_chunk_reservation(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
    ) -> ChunkReservationRecord | None: ...

    async def capture_reservation_usage(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureReservationUsage: ...

    async def get_upload_authorization_receipt(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> UploadAuthorizationReceipt | None: ...

    async def is_upload_authorization_active(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> bool: ...

    async def add_upload_authorization_receipt(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
        *,
        receipt_id: UUID,
        duration: timedelta,
    ) -> UploadAuthorizationReceipt | None: ...

    async def get_chunk_receipt(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
    ) -> ChunkReceipt | None: ...

    async def add_reserved_chunk(
        self,
        tenant_id: UUID,
        chunk: AudioChunk,
        *,
        protocol_version: str,
    ) -> bool: ...

    async def finalize_capture_channels(
        self,
        tenant_id: UUID,
        session_id: UUID,
        declarations: tuple[CaptureChannelFinalizationDraft, ...],
    ) -> tuple[CaptureChannelFinalization, ...]: ...

    async def capture_finalizations_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> tuple[CaptureChannelFinalization, ...]: ...

    async def get_audio_assembly_manifest(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        job_id: UUID,
        lease_token: UUID,
        now: datetime,
    ) -> AudioAssemblyManifest | None: ...

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

    async def get_delivery_attempt(
        self, tenant_id: UUID, delivery_id: UUID
    ) -> DeliveryAttempt | None: ...

    async def delivery_for(
        self, tenant_id: UUID, session_id: UUID
    ) -> TranscriptDelivery | None: ...

    async def add_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None: ...

    async def claim_delivery_attempt(
        self,
        tenant_id: UUID,
        *,
        policy: DeliveryClaimPolicy,
        delivery_id: UUID | None = None,
        excluded_delivery_ids: frozenset[UUID] = frozenset(),
    ) -> DeliveryAttempt | None: ...

    async def delivery_payload_source(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> DeliveryPayloadSource: ...

    async def synchronize_delivery_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> DeliverySessionSyncResult: ...

    async def complete_delivery_failure(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
        *,
        expected_attempt_count: int,
        failure_status: DeliveryStatus,
        error_code: str,
    ) -> DeliveryAttempt | None: ...

    async def complete_delivery_success(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
        *,
        expected_payload_sha256: str,
        platform_transcript_id: str,
    ) -> DeliverySuccessCompletion | None: ...

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
    versioned_external_sessions: dict[
        tuple[UUID, UUID], VersionedExternalSessionRecord
    ] = field(default_factory=lambda: {})
    session_audio_keys: dict[tuple[UUID, UUID], SessionAudioKey] = field(default_factory=lambda: {})
    capture_leases: dict[tuple[UUID, UUID], CaptureLeaseRecord] = field(
        default_factory=lambda: {}
    )
    capture_lease_receipts: dict[tuple[UUID, UUID], CaptureLeaseReceipt] = field(
        default_factory=lambda: {}
    )
    chunk_reservations: dict[tuple[UUID, UUID], ChunkReservationRecord] = field(
        default_factory=lambda: {}
    )
    chunk_reservation_batches: dict[tuple[UUID, UUID], ChunkReservationBatch] = field(
        default_factory=lambda: {}
    )
    upload_authorization_receipts: dict[tuple[UUID, UUID], UploadAuthorizationReceipt] = field(
        default_factory=lambda: {}
    )
    capture_finalizations: dict[
        tuple[UUID, UUID, CaptureChannel], CaptureChannelFinalization
    ] = field(default_factory=lambda: {})
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
                copy.deepcopy(self.versioned_external_sessions),
                copy.deepcopy(self.session_audio_keys),
                copy.deepcopy(self.capture_leases),
                copy.deepcopy(self.capture_lease_receipts),
                copy.deepcopy(self.chunk_reservations),
                copy.deepcopy(self.chunk_reservation_batches),
                copy.deepcopy(self.upload_authorization_receipts),
                copy.deepcopy(self.capture_finalizations),
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
                    self.versioned_external_sessions,
                    self.session_audio_keys,
                    self.capture_leases,
                    self.capture_lease_receipts,
                    self.chunk_reservations,
                    self.chunk_reservation_batches,
                    self.upload_authorization_receipts,
                    self.capture_finalizations,
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

    async def get_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
    ) -> IdempotencyRecord | None:
        return self.idempotency.get((tenant_id, operation, key))

    async def get_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None:
        return self.consents.get((tenant_id, consent_id))

    async def lock_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None:
        # The in-memory transaction lock already serializes consent reads and mutations.
        return await self.get_consent(tenant_id, consent_id)

    async def add_consent(self, tenant_id: UUID, consent: ConsentRecord) -> None:
        self.consents[(tenant_id, consent.id)] = consent

    async def revoke_consent(
        self,
        tenant_id: UUID,
        consent_id: UUID,
    ) -> ConsentRevocationResult | None:
        row_key = (tenant_id, consent_id)
        current = self.consents.get(row_key)
        if current is None:
            return None
        changed = current.revoked_at is None
        now = datetime.now(UTC)
        revoked = current.model_copy(update={"revoked_at": now}) if changed else current
        self.consents[row_key] = revoked
        for lease_key, lease in tuple(self.capture_leases.items()):
            session = self.sessions.get(lease_key)
            if (
                lease_key[0] == tenant_id
                and session is not None
                and session.consent_record_id == consent_id
                and lease.closed_at is None
                and lease.expires_at > now
            ):
                self.capture_leases[lease_key] = CaptureLeaseRecord(
                    lease_id=lease.lease_id,
                    session_id=lease.session_id,
                    generation=lease.generation,
                    issued_at=lease.issued_at,
                    renewed_at=lease.renewed_at,
                    expires_at=lease.expires_at,
                    closed_at=now,
                    close_reason=CaptureLeaseCloseReason.CONSENT_REVOKED,
                )
        return ConsentRevocationResult(consent=revoked, changed=changed)

    async def get_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        return self.sessions.get((tenant_id, session_id))

    async def lock_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        # The in-memory transaction lock already serializes all mutations.
        return await self.get_session(tenant_id, session_id)

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self.lock_consent(tenant_id, session.consent_record_id)
        if (tenant_id, session.id) in self.versioned_external_sessions:
            raise ValueError("scribe session identifier is already in use")
        self.sessions[(tenant_id, session.id)] = session

    def _require_chunk_upload_session(self, tenant_id: UUID, session_id: UUID) -> None:
        if (tenant_id, session_id) in self.versioned_external_sessions:
            raise CaptureIngestModeError("session does not accept audio chunk capture")
        session = self.sessions.get((tenant_id, session_id))
        if (
            session is not None
            and session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self.lock_consent(tenant_id, session.consent_record_id)
        if (tenant_id, session.id) in self.versioned_external_sessions:
            return
        current = self.sessions.get((tenant_id, session.id))
        if current is not None:
            if current.ingest_mode != session.ingest_mode:
                raise ValueError("scribe session ingest mode is immutable")
            if not can_transition_session(
                current.status,
                session.status,
                ingest_mode=current.ingest_mode,
            ):
                raise ValueError(
                    f"invalid scribe session status transition: "
                    f"{current.status.value} -> {session.status.value}"
                )
        self.sessions[(tenant_id, session.id)] = session

    async def create_versioned_external_session(
        self,
        tenant_id: UUID,
        draft: VersionedExternalSessionCreate,
    ) -> VersionedExternalSessionRecord | None:
        consent = await self.lock_consent(tenant_id, draft.consent_record_id)
        if not consent_authorizes_versioned_session(consent, draft):
            return None
        row_key = (tenant_id, draft.id)
        if row_key in self.sessions or row_key in self.versioned_external_sessions:
            raise ValueError("scribe session identifier is already in use")
        record = build_versioned_external_session_record(
            draft,
            created_at=datetime.now(UTC),
        )
        self.versioned_external_sessions[row_key] = record
        return record

    async def get_versioned_external_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> VersionedExternalSessionRecord | None:
        return self.versioned_external_sessions.get((tenant_id, session_id))

    async def lock_versioned_external_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> VersionedExternalSessionRecord | None:
        # The provider transaction lock is the in-memory session fence.
        record = self.versioned_external_sessions.get((tenant_id, session_id))
        if record is None:
            return None
        await self.lock_consent(tenant_id, record.consent_record_id)
        locked = self.versioned_external_sessions.get((tenant_id, session_id))
        if locked is None or locked.consent_record_id != record.consent_record_id:
            return None
        return locked

    async def get_session_audio_key(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> SessionAudioKey | None:
        if (tenant_id, session_id) not in self.sessions:
            return None
        return self.session_audio_keys.get((tenant_id, session_id))

    async def add_session_audio_key(
        self,
        tenant_id: UUID,
        audio_key: SessionAudioKey,
    ) -> bool:
        self._require_chunk_upload_session(tenant_id, audio_key.session_id)
        row_key = (tenant_id, audio_key.session_id)
        if row_key in self.session_audio_keys:
            return False
        self.session_audio_keys[row_key] = audio_key
        return True

    async def lock_capture_context(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureContext | None:
        # The in-memory transaction lock is the canonical consent/session lock.
        session = self.sessions.get((tenant_id, session_id))
        if session is None:
            return None
        consent = self.consents.get((tenant_id, session.consent_record_id))
        if consent is None:
            return None
        return CaptureContext(
            session=session,
            consent=consent,
            audio_key=self.session_audio_keys.get((tenant_id, session_id)),
            lease=self.capture_leases.get((tenant_id, session_id)),
        )

    async def get_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureLeaseRecord | None:
        if (tenant_id, session_id) not in self.sessions:
            return None
        return self.capture_leases.get((tenant_id, session_id))

    async def get_capture_lease_receipt(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> CaptureLeaseReceipt | None:
        receipt = self.capture_lease_receipts.get((tenant_id, receipt_id))
        if receipt is None or (tenant_id, receipt.session_id) not in self.sessions:
            return None
        return receipt

    async def issue_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        lease_id: UUID,
        receipt_id: UUID,
        duration: timedelta,
    ) -> CaptureLeaseReceipt | None:
        row_key = (tenant_id, session_id)
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or row_key in self.capture_leases
        ):
            return None
        now = datetime.now(UTC)
        expires_at = _capture_expiry(now, duration)
        lease = CaptureLeaseRecord(
            lease_id=lease_id,
            session_id=session_id,
            generation=1,
            issued_at=now,
            renewed_at=now,
            expires_at=expires_at,
        )
        receipt = CaptureLeaseReceipt(
            id=receipt_id,
            lease_id=lease_id,
            session_id=session_id,
            generation=1,
            issued_at=now,
            expires_at=expires_at,
        )
        self.capture_leases[row_key] = lease
        self.capture_lease_receipts[(tenant_id, receipt_id)] = receipt
        return receipt

    async def renew_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        expected_lease_id: UUID,
        expected_generation: int,
        receipt_id: UUID,
        duration: timedelta,
    ) -> CaptureLeaseReceipt | None:
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        current = context.lease if context is not None else None
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or current is None
            or current.lease_id != expected_lease_id
            or current.generation != expected_generation
            or current.closed_at is not None
        ):
            return None
        now = datetime.now(UTC)
        expires_at = _capture_expiry(now, duration)
        renewed = CaptureLeaseRecord(
            lease_id=current.lease_id,
            session_id=current.session_id,
            generation=current.generation + 1,
            issued_at=current.issued_at,
            renewed_at=now,
            expires_at=expires_at,
        )
        receipt = CaptureLeaseReceipt(
            id=receipt_id,
            lease_id=renewed.lease_id,
            session_id=renewed.session_id,
            generation=renewed.generation,
            issued_at=now,
            expires_at=expires_at,
        )
        self.capture_leases[(tenant_id, session_id)] = renewed
        self.capture_lease_receipts[(tenant_id, receipt_id)] = receipt
        return receipt

    async def close_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        expected_lease_id: UUID,
        expected_generation: int,
        reason: CaptureLeaseCloseReason,
    ) -> bool:
        current = self.capture_leases.get((tenant_id, session_id))
        if (
            (tenant_id, session_id) not in self.sessions
            or current is None
            or current.lease_id != expected_lease_id
            or current.generation != expected_generation
            or current.closed_at is not None
        ):
            return False
        self.capture_leases[(tenant_id, session_id)] = CaptureLeaseRecord(
            lease_id=current.lease_id,
            session_id=current.session_id,
            generation=current.generation,
            issued_at=current.issued_at,
            renewed_at=current.renewed_at,
            expires_at=current.expires_at,
            closed_at=datetime.now(UTC),
            close_reason=reason,
        )
        return True

    async def get_chunk_reservation_batch(
        self,
        tenant_id: UUID,
        batch_id: UUID,
    ) -> ChunkReservationBatch | None:
        batch = self.chunk_reservation_batches.get((tenant_id, batch_id))
        if batch is None or (tenant_id, batch.session_id) not in self.sessions:
            return None
        return batch

    async def create_chunk_reservation_batch(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        batch_id: UUID,
        lease_id: UUID,
        lease_generation: int,
        requested_protocol_version: str,
        drafts: tuple[ChunkReservationDraft, ...],
        maximum_batch_size: int,
        maximum_chunks: int,
        maximum_plaintext_bytes: int,
    ) -> ChunkReservationBatch:
        if (
            not drafts
            or maximum_batch_size < 1
            or len(drafts) > maximum_batch_size
            or maximum_batch_size > MAX_RESERVATIONS_PER_BATCH
            or maximum_chunks < 1
            or maximum_chunks > MAX_CHUNKS
            or maximum_plaintext_bytes < 1
            or maximum_plaintext_bytes > MAX_AGGREGATE_PLAINTEXT_BYTES
        ):
            raise CaptureReservationLimitError
        positions = {(draft.channel, draft.sequence_number) for draft in drafts}
        if len(positions) != len(drafts):
            raise CaptureReservationLimitError
        if requested_protocol_version != PROTOCOL_VERSION or any(
            draft.protocol_version != PROTOCOL_VERSION
            or draft.sequence_number < 0
            or draft.sequence_number >= MAX_CHUNKS
            or not 1 <= len(draft.additional_data) <= 1_024
            or draft.plaintext_budget_bytes != RESERVATION_PLAINTEXT_BUDGET_BYTES
            for draft in drafts
        ):
            raise CaptureReservationLimitError

        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        lease = context.lease if context is not None else None
        now = datetime.now(UTC)
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or lease is None
            or lease.lease_id != lease_id
            or lease.generation != lease_generation
            or lease.closed_at is not None
            or lease.expires_at <= now
        ):
            raise CaptureLeaseConflictError

        existing_positions = {
            (reservation.channel, reservation.sequence_number)
            for (row_tenant, _), reservation in self.chunk_reservations.items()
            if row_tenant == tenant_id and reservation.session_id == session_id
        }
        next_by_channel = {
            channel: (
                max(
                    (
                        sequence
                        for current_channel, sequence in existing_positions
                        if current_channel == channel
                    ),
                    default=-1,
                )
                + 1
            )
            for channel in CaptureChannel
        }
        for channel in CaptureChannel:
            requested_new = sorted(
                draft.sequence_number
                for draft in drafts
                if draft.channel == channel
                and (channel, draft.sequence_number) not in existing_positions
            )
            if requested_new != list(
                range(next_by_channel[channel], next_by_channel[channel] + len(requested_new))
            ):
                raise CaptureReservationLimitError

        canonical: list[ChunkReservationRecord] = []
        new_drafts: list[ChunkReservationDraft] = []
        for draft in drafts:
            existing = next(
                (
                    reservation
                    for (row_tenant, _), reservation in self.chunk_reservations.items()
                    if row_tenant == tenant_id
                    and reservation.session_id == session_id
                    and reservation.sequence_number == draft.sequence_number
                    and reservation.channel == draft.channel
                ),
                None,
            )
            if existing is not None:
                canonical.append(existing)
                continue
            object_collision = self.chunk_reservations.get((tenant_id, draft.object_id))
            if object_collision is not None:
                raise CaptureReservationLimitError
            new_drafts.append(draft)
            canonical.append(
                ChunkReservationRecord(
                    object_id=draft.object_id,
                    session_id=session_id,
                    sequence_number=draft.sequence_number,
                    channel=draft.channel,
                    protocol_version=draft.protocol_version,
                    additional_data=draft.additional_data,
                    plaintext_budget_bytes=draft.plaintext_budget_bytes,
                    created_at=now,
                )
            )

        usage = await self.capture_reservation_usage(tenant_id, session_id)
        if usage.reservation_count + len(new_drafts) > maximum_chunks or (
            usage.plaintext_budget_bytes
            + sum(draft.plaintext_budget_bytes for draft in new_drafts)
            > maximum_plaintext_bytes
        ):
            raise CaptureReservationLimitError
        for record in canonical:
            self.chunk_reservations.setdefault((tenant_id, record.object_id), record)
        batch = ChunkReservationBatch(
            id=batch_id,
            session_id=session_id,
            lease_id=lease_id,
            lease_generation=lease_generation,
            requested_protocol_version=requested_protocol_version,
            created_at=now,
            capture_authorized_until=lease.expires_at,
            reservations=tuple(canonical),
        )
        self.chunk_reservation_batches[(tenant_id, batch_id)] = batch
        return batch

    async def get_chunk_reservation(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
    ) -> ChunkReservationRecord | None:
        reservation = self.chunk_reservations.get((tenant_id, object_id))
        if (
            (tenant_id, session_id) not in self.sessions
            or reservation is None
            or reservation.session_id != session_id
        ):
            return None
        return reservation

    async def capture_reservation_usage(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureReservationUsage:
        if (tenant_id, session_id) not in self.sessions:
            return CaptureReservationUsage(
                reservation_count=0,
                plaintext_budget_bytes=0,
                next_sequence_numbers=MappingProxyType(
                    {channel: 0 for channel in CaptureChannel}
                ),
            )
        reservations = [
            reservation
            for (row_tenant, _), reservation in self.chunk_reservations.items()
            if row_tenant == tenant_id and reservation.session_id == session_id
        ]
        return CaptureReservationUsage(
            reservation_count=len(reservations),
            plaintext_budget_bytes=sum(
                reservation.plaintext_budget_bytes for reservation in reservations
            ),
            next_sequence_numbers=MappingProxyType(
                {
                    channel: (
                        max(
                            (
                                reservation.sequence_number
                                for reservation in reservations
                                if reservation.channel == channel
                            ),
                            default=-1,
                        )
                        + 1
                    )
                    for channel in CaptureChannel
                }
            ),
        )

    async def get_upload_authorization_receipt(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> UploadAuthorizationReceipt | None:
        receipt = self.upload_authorization_receipts.get((tenant_id, receipt_id))
        if receipt is None or (tenant_id, receipt.session_id) not in self.sessions:
            return None
        return receipt

    async def is_upload_authorization_active(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> bool:
        receipt = await self.get_upload_authorization_receipt(tenant_id, receipt_id)
        return receipt is not None and receipt.expires_at > datetime.now(UTC)

    async def add_upload_authorization_receipt(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
        *,
        receipt_id: UUID,
        duration: timedelta,
    ) -> UploadAuthorizationReceipt | None:
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        reservation = await self.get_chunk_reservation(tenant_id, session_id, object_id)
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or context.lease is None
            or context.lease.closed_at is not None
            or reservation is None
            or any(
                row_tenant == tenant_id and chunk.object_id == object_id
                for (row_tenant, _), chunk in self.chunks.items()
            )
        ):
            return None
        now = datetime.now(UTC)
        if any(
            row_tenant == tenant_id
            and receipt.reservation_object_id == object_id
            and receipt.expires_at > now
            for (row_tenant, _), receipt in self.upload_authorization_receipts.items()
        ):
            return None
        receipt = UploadAuthorizationReceipt(
            id=receipt_id,
            session_id=session_id,
            reservation_object_id=object_id,
            issued_at=now,
            expires_at=_capture_expiry(now, duration),
        )
        self.upload_authorization_receipts[(tenant_id, receipt_id)] = receipt
        return receipt

    async def get_chunk_receipt(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
    ) -> ChunkReceipt | None:
        reservation = await self.get_chunk_reservation(tenant_id, session_id, object_id)
        if reservation is None:
            return None
        registration = next(
            (
                chunk
                for (row_tenant, _), chunk in self.chunks.items()
                if row_tenant == tenant_id and chunk.object_id == object_id
            ),
            None,
        )
        return ChunkReceipt(reservation=reservation, registration=registration)

    async def add_reserved_chunk(
        self,
        tenant_id: UUID,
        chunk: AudioChunk,
        *,
        protocol_version: str,
    ) -> bool:
        context = await self.lock_capture_context(tenant_id, chunk.session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        reservation = await self.get_chunk_reservation(
            tenant_id, chunk.session_id, chunk.object_id
        )
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or context.lease is None
            or context.lease.closed_at is not None
            or reservation is None
            or reservation.sequence_number != chunk.sequence_number
            or reservation.channel != chunk.channel
            or reservation.protocol_version != protocol_version
            or not any(
                row_tenant == tenant_id
                and receipt.reservation_object_id == chunk.object_id
                for (row_tenant, _), receipt in self.upload_authorization_receipts.items()
            )
        ):
            return False
        if any(
            row_tenant == tenant_id
            and (
                current.object_id == chunk.object_id
                or (
                    current.session_id == chunk.session_id
                    and current.sequence_number == chunk.sequence_number
                    and current.channel == chunk.channel
                )
            )
            for (row_tenant, _), current in self.chunks.items()
        ):
            return False
        self.chunks[(tenant_id, chunk.id)] = chunk
        return True

    async def finalize_capture_channels(
        self,
        tenant_id: UUID,
        session_id: UUID,
        declarations: tuple[CaptureChannelFinalizationDraft, ...],
    ) -> tuple[CaptureChannelFinalization, ...]:
        if not declarations or len({item.channel for item in declarations}) != len(declarations):
            raise CaptureFinalizationError
        declared = {item.channel: item.last_sequence_number for item in declarations}
        if any(last < 0 or last >= MAX_CHUNKS for last in declared.values()):
            raise CaptureFinalizationError
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        existing = await self.capture_finalizations_for(tenant_id, session_id)
        if existing:
            if {
                item.channel: item.last_sequence_number for item in existing
            } != declared:
                raise CaptureFinalizationError
            return existing

        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status != SessionStatus.CAPTURING
            or context.lease is None
            or context.lease.closed_at is not None
        ):
            raise CaptureFinalizationError
        chunks = await self.chunks_for(tenant_id, session_id)
        grouped: dict[CaptureChannel, list[int]] = {}
        for chunk in chunks:
            reservation = await self.get_chunk_reservation(
                tenant_id, session_id, chunk.object_id
            )
            if (
                reservation is None
                or reservation.sequence_number != chunk.sequence_number
                or reservation.channel != chunk.channel
            ):
                raise CaptureFinalizationError
            grouped.setdefault(chunk.channel, []).append(chunk.sequence_number)
        if set(grouped) != set(declared):
            raise CaptureFinalizationError
        for channel, last_sequence_number in declared.items():
            if sorted(grouped[channel]) != list(range(last_sequence_number + 1)):
                raise CaptureFinalizationError

        now = datetime.now(UTC)
        result = tuple(
            CaptureChannelFinalization(
                session_id=session_id,
                channel=channel,
                last_sequence_number=declared[channel],
                finalized_at=now,
            )
            for channel in CaptureChannel
            if channel in declared
        )
        for item in result:
            self.capture_finalizations[(tenant_id, session_id, item.channel)] = item
        return result

    async def capture_finalizations_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> tuple[CaptureChannelFinalization, ...]:
        if (tenant_id, session_id) not in self.sessions:
            return ()
        return tuple(
            self.capture_finalizations[(tenant_id, session_id, channel)]
            for channel in CaptureChannel
            if (tenant_id, session_id, channel) in self.capture_finalizations
        )

    async def get_audio_assembly_manifest(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        job_id: UUID,
        lease_token: UUID,
        now: datetime,
    ) -> AudioAssemblyManifest | None:
        session = self.sessions.get((tenant_id, session_id))
        job = self.transcription_jobs.get((tenant_id, job_id))
        audio_key = self.session_audio_keys.get((tenant_id, session_id))
        if (
            session is None
            or session.status != SessionStatus.PROCESSING
            or job is None
            or job.session_id != session_id
            or job.status != TranscriptionJobStatus.PROCESSING
            or job.lease_token != lease_token
            or job.lease_until is None
            or job.lease_until <= now
            or audio_key is None
        ):
            return None
        return AudioAssemblyManifest(
            audio_key=audio_key,
            chunks=tuple(await self.chunks_for(tenant_id, session_id)),
        )

    async def get_chunk(self, tenant_id: UUID, chunk_id: UUID) -> AudioChunk | None:
        chunk = self.chunks.get((tenant_id, chunk_id))
        if chunk is None or (tenant_id, chunk.session_id) not in self.sessions:
            return None
        return chunk

    async def add_chunk(self, tenant_id: UUID, chunk: AudioChunk) -> None:
        self._require_chunk_upload_session(tenant_id, chunk.session_id)
        self.chunks[(tenant_id, chunk.id)] = chunk

    async def chunks_for(self, tenant_id: UUID, session_id: UUID) -> list[AudioChunk]:
        if (tenant_id, session_id) not in self.sessions:
            return []
        return sorted(
            (
                chunk
                for (row_tenant, _), chunk in self.chunks.items()
                if row_tenant == tenant_id and chunk.session_id == session_id
            ),
            key=lambda chunk: (chunk.sequence_number, chunk.channel),
        )

    async def get_upload_grant(self, tenant_id: UUID, object_id: UUID) -> UploadGrantRecord | None:
        grant = self.upload_grants.get((tenant_id, object_id))
        if grant is None or (tenant_id, grant.session_id) not in self.sessions:
            return None
        return grant

    async def add_upload_grant(self, tenant_id: UUID, grant: UploadGrantRecord) -> None:
        self._require_chunk_upload_session(tenant_id, grant.session_id)
        self.upload_grants[(tenant_id, grant.object_id)] = grant

    async def get_transcript(self, tenant_id: UUID, transcript_id: UUID) -> Transcript | None:
        transcript = self.transcripts.get((tenant_id, transcript_id))
        if transcript is None or (tenant_id, transcript.session_id) not in self.sessions:
            return None
        return transcript

    async def add_transcript(self, tenant_id: UUID, transcript: Transcript) -> None:
        if (tenant_id, transcript.session_id) not in self.sessions:
            raise ValueError("legacy session is unavailable for transcript persistence")
        self.transcripts[(tenant_id, transcript.id)] = transcript
        self.transcript_by_session[(tenant_id, transcript.session_id)] = transcript.id

    async def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        if (tenant_id, session_id) not in self.sessions:
            return None
        transcript_id = self.transcript_by_session.get((tenant_id, session_id))
        if transcript_id is None:
            return None
        return self.transcripts[(tenant_id, transcript_id)]

    async def transcription_job_for(
        self, tenant_id: UUID, session_id: UUID
    ) -> TranscriptionJob | None:
        if (tenant_id, session_id) not in self.sessions:
            return None
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
        self._require_chunk_upload_session(tenant_id, session_id)
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
            or (tenant_id, current.session_id) not in self.sessions
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
            or (tenant_id, current.session_id) not in self.sessions
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
        delivery = self.deliveries.get((tenant_id, delivery_id))
        if delivery is None or (tenant_id, delivery.session_id) not in self.sessions:
            return None
        return delivery

    async def get_delivery_attempt(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
    ) -> DeliveryAttempt | None:
        delivery = await self.get_delivery(tenant_id, delivery_id)
        return (
            DeliveryAttempt.model_validate(delivery.model_dump())
            if delivery is not None
            else None
        )

    async def delivery_for(self, tenant_id: UUID, session_id: UUID) -> TranscriptDelivery | None:
        if (tenant_id, session_id) not in self.sessions:
            return None
        delivery_id = self.delivery_by_session.get((tenant_id, session_id))
        if delivery_id is None:
            return None
        return self.deliveries[(tenant_id, delivery_id)]

    async def add_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None:
        if (tenant_id, delivery.session_id) not in self.sessions:
            raise ValueError("legacy session is unavailable for delivery persistence")
        self.deliveries[(tenant_id, delivery.id)] = delivery
        self.delivery_by_session[(tenant_id, delivery.session_id)] = delivery.id

    async def claim_delivery_attempt(
        self,
        tenant_id: UUID,
        *,
        policy: DeliveryClaimPolicy,
        delivery_id: UUID | None = None,
        excluded_delivery_ids: frozenset[UUID] = frozenset(),
    ) -> DeliveryAttempt | None:
        now = datetime.now(UTC)
        candidates = sorted(
            (
                delivery
                for (row_tenant, row_id), delivery in self.deliveries.items()
                if row_tenant == tenant_id
                and (tenant_id, delivery.session_id) in self.sessions
                and (delivery_id is None or row_id == delivery_id)
                and row_id not in excluded_delivery_ids
                and (
                    (
                        delivery.status == DeliveryStatus.PENDING
                        and (
                            delivery.attempt_count == 0
                            or delivery.updated_at <= now - policy.pending_timeout
                        )
                    )
                    or (
                        delivery.status == DeliveryStatus.RETRYABLE
                        and delivery.updated_at <= now - policy.retry_delay
                    )
                )
            ),
            key=lambda delivery: (delivery.updated_at, delivery.id),
        )
        if not candidates:
            return None
        current = candidates[0]
        claimed = current.model_copy(
            update={
                "status": DeliveryStatus.PENDING,
                "attempt_count": current.attempt_count + 1,
                "last_error_code": None,
                "updated_at": now,
            }
        )
        self.deliveries[(tenant_id, current.id)] = claimed
        await self.audit(
            tenant_id=tenant_id,
            action="transcript.delivery_attempted",
            entity_type="transcript_delivery",
            entity_id=claimed.id,
        )
        return DeliveryAttempt.model_validate(claimed.model_dump())

    async def delivery_payload_source(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> DeliveryPayloadSource:
        session = self.sessions.get((tenant_id, session_id))
        if session is None:
            return DeliveryPayloadSource()
        consent = self.consents.get((tenant_id, session.consent_record_id))
        transcript_id = self.transcript_by_session.get((tenant_id, session_id))
        transcript = (
            self.transcripts.get((tenant_id, transcript_id)) if transcript_id is not None else None
        )
        return DeliveryPayloadSource(
            session=DeliverySessionSource.model_validate(
                session.model_dump(exclude={"created_at"})
            ),
            consent=(
                DeliveryConsentSource.model_validate(
                    consent.model_dump(
                        include={
                            "id",
                            "appointment_id",
                            "practitioner_id",
                            "patient_id",
                            "modality",
                            "all_parties_consented",
                            "revoked_at",
                        }
                    )
                )
                if consent is not None
                else None
            ),
            transcript=(
                DeliveryTranscriptSource.model_validate(
                    transcript.model_dump(include={"id", "session_id", "segments"})
                )
                if transcript is not None
                else None
            ),
        )

    async def synchronize_delivery_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> DeliverySessionSyncResult:
        session = self.sessions.get((tenant_id, session_id))
        if session is None:
            return DeliverySessionSyncResult.SESSION_UNAVAILABLE
        await self.lock_consent(tenant_id, session.consent_record_id)
        if session.status == SessionStatus.HANDED_OFF:
            return DeliverySessionSyncResult.ALREADY_SYNCHRONIZED
        if not can_transition_session(session.status, SessionStatus.HANDED_OFF):
            return DeliverySessionSyncResult.SESSION_STATE_CONFLICT
        self.sessions[(tenant_id, session_id)] = session.model_copy(
            update={"status": SessionStatus.HANDED_OFF}
        )
        await self.audit(
            tenant_id=tenant_id,
            action="transcript.delivery_session_synchronized",
            entity_type="scribe_session",
            entity_id=session_id,
        )
        return DeliverySessionSyncResult.SYNCHRONIZED

    async def complete_delivery_failure(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
        *,
        expected_attempt_count: int,
        failure_status: DeliveryStatus,
        error_code: str,
    ) -> DeliveryAttempt | None:
        if failure_status not in {DeliveryStatus.RETRYABLE, DeliveryStatus.TERMINAL}:
            raise ValueError("delivery failure status must be retryable or terminal")
        current = await self.get_delivery(tenant_id, delivery_id)
        if (
            current is None
            or current.status != DeliveryStatus.PENDING
            or current.attempt_count != expected_attempt_count
        ):
            return None
        failed = current.model_copy(
            update={
                "status": failure_status,
                "last_error_code": error_code,
                "updated_at": datetime.now(UTC),
            }
        )
        self.deliveries[(tenant_id, delivery_id)] = failed
        return DeliveryAttempt.model_validate(failed.model_dump())

    async def complete_delivery_success(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
        *,
        expected_payload_sha256: str,
        platform_transcript_id: str,
    ) -> DeliverySuccessCompletion | None:
        current = await self.get_delivery(tenant_id, delivery_id)
        if current is None:
            return None
        if current.payload_sha256 != expected_payload_sha256:
            raise DeliverySuccessConflictError("delivery_success_conflict")
        if current.status == DeliveryStatus.DELIVERED:
            if current.platform_transcript_id != platform_transcript_id:
                raise DeliverySuccessConflictError("delivery_success_conflict")
            return DeliverySuccessCompletion(
                delivery=DeliveryAttempt.model_validate(current.model_dump()),
                changed=False,
            )
        delivered = current.model_copy(
            update={
                "status": DeliveryStatus.DELIVERED,
                "platform_transcript_id": platform_transcript_id,
                "last_error_code": None,
                "updated_at": datetime.now(UTC),
            }
        )
        self.deliveries[(tenant_id, delivery_id)] = delivered
        return DeliverySuccessCompletion(
            delivery=DeliveryAttempt.model_validate(delivered.model_dump()),
            changed=True,
        )

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
