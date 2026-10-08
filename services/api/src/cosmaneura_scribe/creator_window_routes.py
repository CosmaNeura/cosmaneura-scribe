"""One recoverable first window with the ordinary component receipt identities."""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .audio_keys import AudioEncryptionKeyUnavailable
from .capture_protocol_v1 import (
    CAPTURE_LEASE_TTL_SECONDS,
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_RESERVATIONS_PER_BATCH,
    PROTOCOL_VERSION,
    RESERVATION_PLAINTEXT_BUDGET_BYTES,
    CaptureChannel,
    capture_channel_additional_data,
)
from .creator_preparation_routes import Configuration, Keys
from .creator_review_routes import Creator, Key, Runtime, Tenant
from .repository import (
    CaptureLeaseConflictError,
    CaptureReservationLimitError,
    ChunkReservationDraft,
)
from .schemas import (
    CaptureLeaseIssueRequest,
    CaptureLeaseReceipt,
    ChunkReservationBatchReceipt,
    ChunkReservationBatchRequest,
    SessionAudioKey,
    SessionAudioKeyCreate,
    SessionAudioKeyReceipt,
    SessionStatus,
)

RequestKey = Annotated[str, Field(pattern=r"^[A-Za-z0-9._:-]{8,255}$", repr=False)]
_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


class WindowBinding(SessionAudioKeyCreate):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)


class CreatorWindowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    schema_version: Literal["1.0"] = "1.0"
    binding: WindowBinding = Field(repr=False)
    bind_idempotency_key: RequestKey
    lease_idempotency_key: RequestKey
    reserve_idempotency_key: RequestKey
    channel: CaptureChannel
    reservation_count: int = Field(strict=True, ge=1, le=MAX_RESERVATIONS_PER_BATCH)

    @model_validator(mode="after")
    def distinct_keys(self):
        if (
            len(
                {
                    self.bind_idempotency_key,
                    self.lease_idempotency_key,
                    self.reserve_idempotency_key,
                }
            )
            != 3
        ):
            raise ValueError("Distinct recording request keys are required.")
        return self


class CreatorWindowReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"] = "1.0"
    binding: SessionAudioKeyReceipt = Field(repr=False)
    lease: CaptureLeaseReceipt = Field(repr=False)
    reservations: ChunkReservationBatchReceipt = Field(repr=False)


router = APIRouter(prefix="/v1/captured-sessions", tags=["configured-capture"])


def unavailable() -> HTTPException:
    return HTTPException(409, "Recording window is unavailable.", headers=_HEADERS)


def matching_key(existing: SessionAudioKey, payload: SessionAudioKeyCreate) -> bool:
    return (
        existing.key_version == payload.key_version and existing.wrapped_dek == payload.wrapped_dek
    )


@router.post("/{session_id}/recording-window", response_model=CreatorWindowReceipt)
async def prepare_creator_window(
    session_id: UUID,
    payload: CreatorWindowRequest,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    settings: Configuration,
    provider: Keys,
    response: Response,
) -> CreatorWindowReceipt:
    from .main import (
        capture_context_for_creator,
        capture_lease_response,
        capture_request_fingerprint,
        claim_capture_operation,
        get_consent_policy,
        require_capture_protocol,
        reservation_batch_response,
    )

    response.headers.update(_HEADERS)
    # No external key I/O while holding consent/session locks. An already-bound
    # immutable key needs no current-key lookup, including a replay after rotation.
    # Authorization and the binding are rechecked in the final transaction.
    key_current = False
    try:
        runtime.authorize_cohort(tenant_id)
        require_capture_protocol(settings)
        if key in {
            payload.bind_idempotency_key,
            payload.lease_idempotency_key,
            payload.reserve_idempotency_key,
        }:
            raise unavailable()
        async with runtime.repositories.transaction(tenant_id) as store:
            context = await capture_context_for_creator(
                store,
                tenant_id,
                session_id,
                get_consent_policy(),
                require_audio_key=False,
                creator_actor_id=actor,
            )
            existing = context.audio_key
            if existing is not None and not matching_key(existing, payload.binding):
                raise unavailable()
        if existing is None:
            current = await provider.get_public_key()
            key_current = (
                current.key_version == payload.binding.key_version
                and provider.versioned_key_id(payload.binding.key_version) is not None
            )
            if not key_current:
                raise unavailable()
    except AudioEncryptionKeyUnavailable:
        raise HTTPException(503, "Audio encryption key is unavailable.", headers=_HEADERS) from None
    finally:
        await provider.close()

    runtime.authorize_cohort(tenant_id)
    async with runtime.repositories.transaction(tenant_id) as store:
        outer = await claim_capture_operation(
            store,
            tenant_id,
            f"captured.recording-window:{session_id}",
            key,
            capture_request_fingerprint({"creator": actor, "request": payload}),
            uuid4(),
        )
        previous_binding = await claim_capture_operation(
            store,
            tenant_id,
            f"session.audio-key:{session_id}",
            payload.bind_idempotency_key,
            capture_request_fingerprint(payload.binding),
            session_id,
        )
        receipt_id = uuid4()
        previous_lease = await claim_capture_operation(
            store,
            tenant_id,
            f"capture.lease.issue:{session_id}",
            payload.lease_idempotency_key,
            capture_request_fingerprint(
                CaptureLeaseIssueRequest(protocol_version=PROTOCOL_VERSION)
            ),
            receipt_id,
        )
        lease = (
            None
            if previous_lease is None
            else await store.get_capture_lease_receipt(tenant_id, previous_lease)
        )
        if previous_lease is not None and (lease is None or lease.session_id != session_id):
            raise unavailable()
        lease_id = uuid4() if lease is None else lease.lease_id
        generation = 1 if lease is None else lease.generation
        reserve_request = ChunkReservationBatchRequest(
            protocol_version=PROTOCOL_VERSION,
            capture_lease_id=lease_id,
            capture_lease_generation=generation,
            channel=payload.channel,
            first_sequence_number=0,
            count=payload.reservation_count,
        )
        batch_id = uuid4()
        previous_batch = await claim_capture_operation(
            store,
            tenant_id,
            f"capture.reservations:{session_id}",
            payload.reserve_idempotency_key,
            capture_request_fingerprint(reserve_request),
            batch_id,
        )
        context = await capture_context_for_creator(
            store,
            tenant_id,
            session_id,
            get_consent_policy(),
            require_audio_key=False,
            creator_actor_id=actor,
        )
        audio_key = context.audio_key
        if audio_key is None:
            if (
                previous_binding is not None
                or not key_current
                or context.session.status != SessionStatus.CREATED
            ):
                raise unavailable()
            audio_key = SessionAudioKey(
                session_id=session_id, created_at=datetime.now(UTC), **payload.binding.model_dump()
            )
            if not await store.add_session_audio_key(tenant_id, audio_key):
                raise unavailable()
            await store.audit(
                tenant_id=tenant_id,
                action="session_audio_key.bound",
                entity_type="session_audio_key",
                entity_id=session_id,
            )
        elif not matching_key(audio_key, payload.binding):
            raise unavailable()
        if lease is None:
            if (
                context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
                or context.lease is not None
            ):
                raise unavailable()
            lease = await store.issue_capture_lease(
                tenant_id,
                session_id,
                lease_id=lease_id,
                receipt_id=receipt_id,
                duration=timedelta(seconds=CAPTURE_LEASE_TTL_SECONDS),
            )
            if lease is None:
                raise unavailable()
            await store.audit(
                tenant_id=tenant_id,
                action="capture_lease.issued",
                entity_type="capture_lease",
                entity_id=lease_id,
            )
        if previous_batch is not None:
            batch = await store.get_chunk_reservation_batch(tenant_id, previous_batch)
        else:
            if context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
                raise unavailable()
            drafts = tuple(
                ChunkReservationDraft(
                    object_id=object_id,
                    sequence_number=offset,
                    channel=payload.channel,
                    protocol_version=PROTOCOL_VERSION,
                    additional_data=capture_channel_additional_data(
                        tenant_id=tenant_id,
                        session_id=session_id,
                        object_id=object_id,
                        sequence_number=offset,
                        channel=payload.channel.value,
                    ),
                    plaintext_budget_bytes=RESERVATION_PLAINTEXT_BUDGET_BYTES,
                )
                for offset, object_id in enumerate(
                    uuid4() for _ in range(payload.reservation_count)
                )
            )
            try:
                batch = await store.create_chunk_reservation_batch(
                    tenant_id,
                    session_id,
                    batch_id=batch_id,
                    lease_id=lease.lease_id,
                    lease_generation=lease.generation,
                    requested_protocol_version=PROTOCOL_VERSION,
                    drafts=drafts,
                    maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                    maximum_chunks=MAX_CHUNKS,
                    maximum_plaintext_bytes=min(
                        MAX_AGGREGATE_PLAINTEXT_BYTES, settings.audio_assembly_max_plaintext_bytes
                    ),
                )
            except (CaptureLeaseConflictError, CaptureReservationLimitError):
                raise unavailable() from None
            await store.audit(
                tenant_id=tenant_id,
                action="audio_chunk_reservations.created",
                entity_type="audio_chunk_reservation_batch",
                entity_id=batch.id,
            )
        if (
            batch is None
            or batch.session_id != session_id
            or batch.lease_id != lease.lease_id
            or batch.lease_generation != lease.generation
        ):
            raise unavailable()
        if outer is None:
            await store.audit(
                tenant_id=tenant_id,
                action="capture_window.prepared",
                entity_type="scribe_session",
                entity_id=session_id,
            )
        runtime.authorize_cohort(tenant_id)
        result = CreatorWindowReceipt(
            binding=SessionAudioKeyReceipt(
                session_id=audio_key.session_id,
                key_version=audio_key.key_version,
                created_at=audio_key.created_at,
            ),
            lease=capture_lease_response(lease),
            reservations=reservation_batch_response(batch),
        )
    return result
