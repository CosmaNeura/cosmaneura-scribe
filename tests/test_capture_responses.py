from datetime import UTC, datetime, timedelta
from uuid import UUID

from cosmaneura_scribe.capture_protocol_v1 import (
    PROTOCOL_VERSION,
    CaptureChannel,
    base64url_encode,
)
from cosmaneura_scribe.capture_responses import (
    capture_lease_response,
    chunk_receipt_response,
    reservation_batch_response,
    reservation_response,
)
from cosmaneura_scribe.repository import (
    CaptureLeaseReceipt,
    ChunkReceipt,
    ChunkReservationBatch,
    ChunkReservationRecord,
)
from cosmaneura_scribe.schemas import AudioChunk

NOW = datetime(2026, 8, 26, tzinfo=UTC)
SESSION_ID = UUID(int=1)
LEASE_ID = UUID(int=2)
OBJECT_ID = UUID(int=3)


def _reservation(
    *,
    object_id: UUID = OBJECT_ID,
    sequence_number: int = 4,
) -> ChunkReservationRecord:
    return ChunkReservationRecord(
        object_id=object_id,
        session_id=SESSION_ID,
        sequence_number=sequence_number,
        channel=CaptureChannel.MIXED,
        protocol_version=PROTOCOL_VERSION,
        additional_data=b"synthetic-associated-data",
        plaintext_budget_bytes=32,
        created_at=NOW,
    )


def test_capture_lease_response_maps_every_public_field() -> None:
    record = CaptureLeaseReceipt(
        id=UUID(int=4),
        lease_id=LEASE_ID,
        session_id=SESSION_ID,
        generation=2,
        issued_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
    )

    response = capture_lease_response(record)

    assert response.protocol_version == PROTOCOL_VERSION
    assert response.receipt_id == record.id
    assert response.lease_id == record.lease_id
    assert response.session_id == record.session_id
    assert response.generation == record.generation
    assert response.issued_at == record.issued_at
    assert response.expires_at == record.expires_at


def test_reservation_and_batch_responses_preserve_order_and_encode_aad() -> None:
    first = _reservation()
    second = _reservation(object_id=UUID(int=7), sequence_number=5)
    batch = ChunkReservationBatch(
        id=UUID(int=5),
        session_id=SESSION_ID,
        lease_id=LEASE_ID,
        lease_generation=2,
        requested_protocol_version=PROTOCOL_VERSION,
        created_at=NOW,
        capture_authorized_until=NOW + timedelta(minutes=5),
        reservations=(first, second),
    )

    reservation = reservation_response(first)
    response = reservation_batch_response(batch)

    assert reservation.protocol_version == PROTOCOL_VERSION
    assert reservation.object_id == first.object_id
    assert reservation.session_id == first.session_id
    assert reservation.channel == first.channel
    assert reservation.sequence_number == first.sequence_number
    assert reservation.additional_authenticated_data == base64url_encode(first.additional_data)
    assert reservation.created_at == first.created_at
    assert response.protocol_version == PROTOCOL_VERSION
    assert response.batch_id == batch.id
    assert response.session_id == batch.session_id
    assert response.capture_authorized_until == batch.capture_authorized_until
    assert response.reservations == (
        reservation,
        reservation_response(second),
    )


def test_chunk_receipt_response_distinguishes_reserved_and_registered() -> None:
    reservation = _reservation()

    reserved = chunk_receipt_response(ChunkReceipt(reservation=reservation))

    assert reserved.state == "reserved"
    assert reserved.registration is None

    registration = AudioChunk(
        id=UUID(int=6),
        session_id=SESSION_ID,
        sequence_number=reservation.sequence_number,
        channel=reservation.channel,
        object_id=reservation.object_id,
        sha256="a" * 64,
        ciphertext_size_bytes=64,
        registered_at=NOW,
    )
    registered = chunk_receipt_response(
        ChunkReceipt(reservation=reservation, registration=registration)
    )

    assert registered.state == "registered"
    assert registered.reservation == reservation_response(reservation)
    assert registered.registration is not None
    assert registered.registration.chunk_id == registration.id
    assert registered.registration.sha256 == registration.sha256
    assert registered.registration.ciphertext_size_bytes == registration.ciphertext_size_bytes
    assert registered.registration.registered_at == registration.registered_at
