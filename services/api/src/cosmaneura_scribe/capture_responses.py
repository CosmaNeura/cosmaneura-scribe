from .capture_protocol_v1 import PROTOCOL_VERSION, base64url_encode
from .repository import (
    CaptureLeaseReceipt as CaptureLeaseReceiptRecord,
)
from .repository import (
    ChunkReceipt as ChunkReceiptRecord,
)
from .repository import (
    ChunkReservationBatch as ChunkReservationBatchRecord,
)
from .repository import ChunkReservationRecord
from .schemas import (
    CaptureLeaseReceipt,
    ChunkReceipt,
    ChunkRegistrationMetadata,
    ChunkReservation,
    ChunkReservationBatchReceipt,
)


def capture_lease_response(record: CaptureLeaseReceiptRecord) -> CaptureLeaseReceipt:
    return CaptureLeaseReceipt(
        protocol_version=PROTOCOL_VERSION,
        receipt_id=record.id,
        lease_id=record.lease_id,
        session_id=record.session_id,
        generation=record.generation,
        issued_at=record.issued_at,
        expires_at=record.expires_at,
    )


def reservation_response(record: ChunkReservationRecord) -> ChunkReservation:
    return ChunkReservation(
        protocol_version=PROTOCOL_VERSION,
        object_id=record.object_id,
        session_id=record.session_id,
        channel=record.channel,
        sequence_number=record.sequence_number,
        additional_authenticated_data=base64url_encode(record.additional_data),
        created_at=record.created_at,
    )


def reservation_batch_response(
    record: ChunkReservationBatchRecord,
) -> ChunkReservationBatchReceipt:
    return ChunkReservationBatchReceipt(
        protocol_version=PROTOCOL_VERSION,
        batch_id=record.id,
        session_id=record.session_id,
        capture_authorized_until=record.capture_authorized_until,
        reservations=tuple(reservation_response(item) for item in record.reservations),
    )


def chunk_receipt_response(record: ChunkReceiptRecord) -> ChunkReceipt:
    registration = (
        ChunkRegistrationMetadata(
            chunk_id=record.registration.id,
            sha256=record.registration.sha256,
            ciphertext_size_bytes=record.registration.ciphertext_size_bytes,
            registered_at=record.registration.registered_at,
        )
        if record.registration is not None
        else None
    )
    return ChunkReceipt(
        reservation=reservation_response(record.reservation),
        state="registered" if registration is not None else "reserved",
        registration=registration,
    )
