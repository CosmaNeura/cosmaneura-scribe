"""One atomic creator-authorized continuation window, with ordinary receipt identities."""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

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
from .creator_review_routes import Creator, Key, Runtime, Tenant
from .repository import (
    CaptureLeaseConflictError,
    CaptureReservationLimitError,
    ChunkReservationDraft,
)
from .schemas import (
    CaptureLeaseReceipt,
    CaptureLeaseRenewRequest,
    ChunkReservationBatchReceipt,
    ChunkReservationBatchRequest,
    SessionStatus,
)
from .settings import Settings, get_settings


class CreatorContinuationRequestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    schema_version: Literal["1.0"]
    channel: Literal["microphone", "mixed"]
    first_sequence_number: int = Field(ge=0, lt=MAX_CHUNKS, strict=True)
    previous_lease_id: UUID = Field(repr=False)
    previous_lease_generation: int = Field(ge=1, strict=True)
    renew_idempotency_key: str = Field(min_length=8, max_length=255, repr=False)
    reservation_idempotency_key: str = Field(min_length=8, max_length=255, repr=False)

    @field_validator("renew_idempotency_key", "reservation_idempotency_key")
    @classmethod
    def printable_key(cls, value: str) -> str:
        try:
            value.encode("utf-8")
        except UnicodeError:
            raise ValueError("Idempotency keys require valid printable text.") from None
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Idempotency keys require valid printable text.")
        return value


class CreatorContinuationReceiptV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    schema_version: Literal["1.0"] = "1.0"
    lease: CaptureLeaseReceipt = Field(repr=False)
    reservations: ChunkReservationBatchReceipt = Field(repr=False)


router = APIRouter(prefix="/v1/captured-sessions", tags=["configured-capture"])
Configuration = Annotated[Settings, Depends(get_settings)]
_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


@router.post("/{session_id}/continuation-window", response_model=CreatorContinuationReceiptV1)
async def prepare_creator_continuation(
    session_id: UUID,
    payload: CreatorContinuationRequestV1,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    settings: Configuration,
    response: Response,
) -> CreatorContinuationReceiptV1:
    from .main import (
        capture_context_for_creator,
        capture_lease_response,
        capture_request_fingerprint,
        claim_capture_operation,
        get_consent_policy,
        require_capture_protocol,
        reservation_batch_response,
    )

    runtime.authorize_cohort(tenant_id)
    require_capture_protocol(settings)
    response.headers.update(_HEADERS)
    async with runtime.repositories.transaction(tenant_id) as store:
        outer = await claim_capture_operation(
            store,
            tenant_id,
            f"captured.continuation-window:{session_id}",
            key,
            capture_request_fingerprint({"creator": actor, "request": payload}),
            uuid4(),
        )
        reservation_operation = f"capture.reservations:{session_id}"
        prior_reservation = await store.get_idempotency(
            tenant_id=tenant_id,
            operation=reservation_operation,
            key=payload.reservation_idempotency_key,
        )
        previous_batch = (
            None
            if prior_reservation is None
            else await store.get_chunk_reservation_batch(tenant_id, prior_reservation.entity_id)
        )
        if previous_batch is not None:
            count = len(previous_batch.reservations)
        else:
            usage = await store.capture_reservation_usage(tenant_id, session_id)
            next_position = usage.next_sequence_numbers.get(CaptureChannel(payload.channel), 0)
            existing_count = min(
                MAX_RESERVATIONS_PER_BATCH, max(0, next_position - payload.first_sequence_number)
            )
            remaining = max(
                0,
                min(MAX_AGGREGATE_PLAINTEXT_BYTES, settings.audio_assembly_max_plaintext_bytes)
                - usage.plaintext_budget_bytes,
            )
            capacity = min(
                max(0, MAX_CHUNKS - usage.reservation_count),
                remaining // RESERVATION_PLAINTEXT_BUDGET_BYTES,
            )
            count = min(
                MAX_RESERVATIONS_PER_BATCH,
                MAX_CHUNKS - payload.first_sequence_number,
                existing_count + capacity,
            )
        # No receipt/limit information leaves before the same fresh creator,
        # consent and key checks as ordinary operations. A zero-capacity attempt
        # acquires no component claim and performs no renewal.
        if count < 1 or (outer is not None and previous_batch is None):
            await capture_context_for_creator(
                store, tenant_id, session_id, get_consent_policy(), creator_actor_id=actor
            )
            raise HTTPException(409, "Continuation window is unavailable.", headers=_HEADERS)
        renew_request = CaptureLeaseRenewRequest(
            protocol_version=PROTOCOL_VERSION, expected_generation=payload.previous_lease_generation
        )
        reserve_request = ChunkReservationBatchRequest(
            protocol_version=PROTOCOL_VERSION,
            capture_lease_id=payload.previous_lease_id,
            capture_lease_generation=payload.previous_lease_generation + 1,
            channel=CaptureChannel(payload.channel),
            first_sequence_number=payload.first_sequence_number,
            count=count,
        )
        lease_receipt_id, batch_id = uuid4(), uuid4()
        # Claim ordinary component identities before consent/session locks. On
        # a lost reply, the saved batch freezes count even after budget usage
        # changes. Individual legacy receipt recovery uses these same hashes.
        prior_lease_id = await claim_capture_operation(
            store,
            tenant_id,
            f"capture.lease.renew:{session_id}:{payload.previous_lease_id}",
            payload.renew_idempotency_key,
            capture_request_fingerprint(renew_request),
            lease_receipt_id,
        )
        prior_batch_id = await claim_capture_operation(
            store,
            tenant_id,
            reservation_operation,
            payload.reservation_idempotency_key,
            capture_request_fingerprint(reserve_request),
            batch_id,
        )
        context = await capture_context_for_creator(
            store, tenant_id, session_id, get_consent_policy(), creator_actor_id=actor
        )
        if context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
            raise HTTPException(409, "Session is not accepting capture.", headers=_HEADERS)
        if prior_lease_id is not None:
            lease = await store.get_capture_lease_receipt(tenant_id, prior_lease_id)
        else:
            lease = await store.renew_capture_lease(
                tenant_id,
                session_id,
                expected_lease_id=payload.previous_lease_id,
                expected_generation=payload.previous_lease_generation,
                receipt_id=lease_receipt_id,
                duration=timedelta(seconds=CAPTURE_LEASE_TTL_SECONDS),
            )
        if (
            lease is None
            or lease.session_id != session_id
            or lease.lease_id != payload.previous_lease_id
            or lease.generation != payload.previous_lease_generation + 1
        ):
            raise HTTPException(409, "Capture lease renewal was rejected.", headers=_HEADERS)
        if prior_batch_id is not None:
            batch = await store.get_chunk_reservation_batch(tenant_id, prior_batch_id)
        else:
            drafts = tuple(
                ChunkReservationDraft(
                    object_id=object_id,
                    sequence_number=payload.first_sequence_number + offset,
                    channel=CaptureChannel(payload.channel),
                    protocol_version=PROTOCOL_VERSION,
                    additional_data=capture_channel_additional_data(
                        tenant_id=tenant_id,
                        session_id=session_id,
                        object_id=object_id,
                        sequence_number=payload.first_sequence_number + offset,
                        channel=payload.channel,
                    ),
                    plaintext_budget_bytes=RESERVATION_PLAINTEXT_BUDGET_BYTES,
                )
                for offset, object_id in enumerate(uuid4() for _ in range(count))
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
                raise HTTPException(
                    409, "Continuation window is unavailable.", headers=_HEADERS
                ) from None
        if (
            batch is None
            or batch.session_id != session_id
            or batch.lease_id != lease.lease_id
            or batch.lease_generation != lease.generation
        ):
            raise HTTPException(409, "Continuation receipt is unavailable.", headers=_HEADERS)
        if prior_lease_id is None:
            await store.audit(
                tenant_id=tenant_id,
                action="capture_lease.renewed",
                entity_type="capture_lease",
                entity_id=lease.lease_id,
            )
        if prior_batch_id is None:
            await store.audit(
                tenant_id=tenant_id,
                action="audio_chunk_reservations.created",
                entity_type="audio_chunk_reservation_batch",
                entity_id=batch.id,
            )
        if outer is None:
            await store.audit(
                tenant_id=tenant_id,
                action="capture_continuation.prepared",
                entity_type="scribe_session",
                entity_id=session_id,
            )
        result = CreatorContinuationReceiptV1(
            lease=capture_lease_response(lease), reservations=reservation_batch_response(batch)
        )
    return result
