from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.capture_protocol_v1 import (
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_RESERVATIONS_PER_BATCH,
    PROTOCOL_VERSION,
    RESERVATION_PLAINTEXT_BUDGET_BYTES,
)
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.repository import (
    CaptureChannelFinalizationDraft,
    CaptureFinalizationError,
    CaptureLeaseCloseReason,
    CaptureReservationLimitError,
    ChunkReservationDraft,
)
from cosmaneura_scribe.schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    SessionAudioKey,
    SessionStatus,
)
from cosmaneura_scribe.settings import Settings
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine


def _consent_and_session() -> tuple[ConsentRecord, CaptureSession, SessionAudioKey]:
    now = datetime.now(UTC)
    consent = ConsentRecord(
        id=uuid4(),
        appointment_id=f"appointment-{uuid4()}",
        practitioner_id="practitioner-capture-repository",
        patient_id="patient-capture-repository",
        modality=CaptureModality.IN_PERSON,
        participant_regions={"FL"},
        method=ConsentMethod.VERBAL_ATTESTATION,
        all_parties_consented=True,
        granted_at=now,
        policy_version="all-party-v1",
    )
    session = CaptureSession(
        id=uuid4(),
        appointment_id=consent.appointment_id,
        practitioner_id=consent.practitioner_id,
        patient_id=consent.patient_id,
        consent_record_id=consent.id,
        modality=consent.modality,
        status=SessionStatus.CREATED,
        created_at=now,
    )
    audio_key = SessionAudioKey(
        session_id=session.id,
        key_version="capture-repository-key-v1",
        wrapped_dek="A" * 512,
        created_at=now,
    )
    return consent, session, audio_key


async def _seed_capture(repository_backend: RepositoryBackend) -> tuple[UUID, CaptureSession]:
    tenant_id = uuid4()
    consent, session, audio_key = _consent_and_session()
    async with repository_backend.provider.transaction(tenant_id) as store:
        await store.add_consent(tenant_id, consent)
        await store.add_session(tenant_id, session)
        assert await store.add_session_audio_key(tenant_id, audio_key)
    return tenant_id, session


def _draft(
    *,
    sequence_number: int,
    channel: CaptureChannel = CaptureChannel.MICROPHONE,
    object_id: UUID | None = None,
    budget: int = RESERVATION_PLAINTEXT_BUDGET_BYTES,
) -> ChunkReservationDraft:
    object_id = object_id or uuid4()
    return ChunkReservationDraft(
        object_id=object_id,
        sequence_number=sequence_number,
        channel=channel,
        protocol_version=PROTOCOL_VERSION,
        additional_data=(
            f"capture-aad:{channel.value}:{sequence_number}:{object_id}".encode("ascii")
        ),
        plaintext_budget_bytes=budget,
    )


@pytest.mark.parametrize("lease_duration", [timedelta(minutes=15)])
def test_capture_lease_receipts_are_fenced_and_immutable_across_backends(
    repository_backend: RepositoryBackend,
    lease_duration: timedelta,
) -> None:
    async def scenario() -> None:
        tenant_id, session = await _seed_capture(repository_backend)
        lease_id = uuid4()
        first_receipt_id = uuid4()
        renewal_receipt_id = uuid4()
        async with repository_backend.provider.transaction(tenant_id) as store:
            context = await store.lock_capture_context(tenant_id, session.id)
            assert context is not None
            assert context.audio_key is not None
            first = await store.issue_capture_lease(
                tenant_id,
                session.id,
                lease_id=lease_id,
                receipt_id=first_receipt_id,
                duration=lease_duration,
            )
            assert first is not None
            assert first.generation == 1

        async with repository_backend.provider.transaction(tenant_id) as store:
            persisted_first = await store.get_capture_lease_receipt(
                tenant_id, first_receipt_id
            )
            assert persisted_first == first
            renewal = await store.renew_capture_lease(
                tenant_id,
                session.id,
                expected_lease_id=lease_id,
                expected_generation=1,
                receipt_id=renewal_receipt_id,
                duration=lease_duration,
            )
            assert renewal is not None
            assert renewal.generation == 2
            assert (
                await store.renew_capture_lease(
                    tenant_id,
                    session.id,
                    expected_lease_id=lease_id,
                    expected_generation=1,
                    receipt_id=uuid4(),
                    duration=lease_duration,
                )
                is None
            )
            assert await store.close_capture_lease(
                tenant_id,
                session.id,
                expected_lease_id=lease_id,
                expected_generation=2,
                reason=CaptureLeaseCloseReason.CAPTURE_STOPPED,
            )

        async with repository_backend.provider.transaction(tenant_id) as store:
            lease = await store.get_capture_lease(tenant_id, session.id)
            assert lease is not None
            assert lease.generation == 2
            assert lease.close_reason == CaptureLeaseCloseReason.CAPTURE_STOPPED
            assert (
                await store.renew_capture_lease(
                    tenant_id,
                    session.id,
                    expected_lease_id=lease_id,
                    expected_generation=2,
                    receipt_id=uuid4(),
                    duration=lease_duration,
                )
                is None
            )

    repository_backend.run(scenario)


def test_reservation_batches_converge_positions_and_enforce_continuity(
    repository_backend: RepositoryBackend,
) -> None:
    async def scenario() -> None:
        tenant_id, session = await _seed_capture(repository_backend)
        lease_id = uuid4()
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.issue_capture_lease(
                tenant_id,
                session.id,
                lease_id=lease_id,
                receipt_id=uuid4(),
                duration=timedelta(minutes=15),
            )
        first_drafts = (_draft(sequence_number=0), _draft(sequence_number=1))
        async with repository_backend.provider.transaction(tenant_id) as store:
            first = await store.create_chunk_reservation_batch(
                tenant_id,
                session.id,
                batch_id=uuid4(),
                lease_id=lease_id,
                lease_generation=1,
                requested_protocol_version=PROTOCOL_VERSION,
                drafts=first_drafts,
                maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                maximum_chunks=MAX_CHUNKS,
                maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
            )

        overlap = _draft(sequence_number=1)
        suffix = _draft(sequence_number=2)
        async with repository_backend.provider.transaction(tenant_id) as store:
            second = await store.create_chunk_reservation_batch(
                tenant_id,
                session.id,
                batch_id=uuid4(),
                lease_id=lease_id,
                lease_generation=1,
                requested_protocol_version=PROTOCOL_VERSION,
                drafts=(overlap, suffix),
                maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                maximum_chunks=MAX_CHUNKS,
                maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
            )
            assert second.reservations[0].object_id == first.reservations[1].object_id
            assert second.reservations[0].additional_data == first.reservations[1].additional_data
            assert second.reservations[1].object_id == suffix.object_id
            usage = await store.capture_reservation_usage(tenant_id, session.id)
            assert usage.reservation_count == 3
            assert usage.next_sequence_numbers[CaptureChannel.MICROPHONE] == 3
            assert usage.next_sequence_numbers[CaptureChannel.SYSTEM_AUDIO] == 0

        async with repository_backend.provider.transaction(tenant_id) as store:
            with pytest.raises(CaptureReservationLimitError):
                await store.create_chunk_reservation_batch(
                    tenant_id,
                    session.id,
                    batch_id=uuid4(),
                    lease_id=lease_id,
                    lease_generation=1,
                    requested_protocol_version=PROTOCOL_VERSION,
                    drafts=(_draft(sequence_number=4),),
                    maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                    maximum_chunks=MAX_CHUNKS,
                    maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
                )
            with pytest.raises(CaptureReservationLimitError):
                await store.create_chunk_reservation_batch(
                    tenant_id,
                    session.id,
                    batch_id=uuid4(),
                    lease_id=lease_id,
                    lease_generation=1,
                    requested_protocol_version=PROTOCOL_VERSION,
                    drafts=(
                        _draft(
                            sequence_number=3,
                            budget=RESERVATION_PLAINTEXT_BUDGET_BYTES - 1,
                        ),
                    ),
                    maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                    maximum_chunks=MAX_CHUNKS,
                    maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
                )

        other_tenant = uuid4()
        async with repository_backend.provider.transaction(other_tenant) as store:
            assert (
                await store.get_chunk_reservation(
                    other_tenant, session.id, first.reservations[0].object_id
                )
                is None
            )

    repository_backend.run(scenario)


def test_receipt_registration_and_finalization_fail_closed(
    repository_backend: RepositoryBackend,
) -> None:
    async def scenario() -> None:
        tenant_id, session = await _seed_capture(repository_backend)
        lease_id = uuid4()
        draft = _draft(sequence_number=0)
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.issue_capture_lease(
                tenant_id,
                session.id,
                lease_id=lease_id,
                receipt_id=uuid4(),
                duration=timedelta(minutes=15),
            )
            batch = await store.create_chunk_reservation_batch(
                tenant_id,
                session.id,
                batch_id=uuid4(),
                lease_id=lease_id,
                lease_generation=1,
                requested_protocol_version=PROTOCOL_VERSION,
                drafts=(draft,),
                maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                maximum_chunks=MAX_CHUNKS,
                maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
            )
            short_authorization = await store.add_upload_authorization_receipt(
                tenant_id,
                session.id,
                batch.reservations[0].object_id,
                receipt_id=uuid4(),
                duration=timedelta(milliseconds=250),
            )
            assert short_authorization is not None
            assert await store.is_upload_authorization_active(
                tenant_id, short_authorization.id
            )
            assert not await store.is_upload_authorization_active(tenant_id, uuid4())
            assert (
                await store.add_upload_authorization_receipt(
                    tenant_id,
                    session.id,
                    batch.reservations[0].object_id,
                    receipt_id=uuid4(),
                    duration=timedelta(minutes=15),
                )
                is None
            )
            await asyncio.sleep(0.3)
            assert not await store.is_upload_authorization_active(
                tenant_id, short_authorization.id
            )
            authorization = await store.add_upload_authorization_receipt(
                tenant_id,
                session.id,
                batch.reservations[0].object_id,
                receipt_id=uuid4(),
                duration=timedelta(minutes=15),
            )
            assert authorization is not None

            chunk = AudioChunk(
                id=uuid4(),
                session_id=session.id,
                sequence_number=0,
                channel=CaptureChannel.MICROPHONE,
                object_id=batch.reservations[0].object_id,
                sha256="a" * 64,
                ciphertext_size_bytes=1_024,
                registered_at=datetime.now(UTC),
            )
            assert await store.add_reserved_chunk(
                tenant_id, chunk, protocol_version=PROTOCOL_VERSION
            )
            await store.update_session(
                tenant_id, session.model_copy(update={"status": SessionStatus.CAPTURING})
            )
            receipt = await store.get_chunk_receipt(
                tenant_id, session.id, chunk.object_id
            )
            assert receipt is not None
            assert receipt.registration == chunk
            assert (
                await store.add_upload_authorization_receipt(
                    tenant_id,
                    session.id,
                    chunk.object_id,
                    receipt_id=uuid4(),
                    duration=timedelta(minutes=15),
                )
                is None
            )
            finalizations = await store.finalize_capture_channels(
                tenant_id,
                session.id,
                (
                    CaptureChannelFinalizationDraft(
                        channel=CaptureChannel.MICROPHONE,
                        last_sequence_number=0,
                    ),
                ),
            )
            assert len(finalizations) == 1
            assert finalizations[0].last_sequence_number == 0

    repository_backend.run(scenario)


def test_finalization_rejects_a_registered_sequence_hole(
    repository_backend: RepositoryBackend,
) -> None:
    async def scenario() -> None:
        tenant_id, session = await _seed_capture(repository_backend)
        async with repository_backend.provider.transaction(tenant_id) as store:
            # This exercises the finalization invariant independently of reservations.
            await store.add_chunk(
                tenant_id,
                AudioChunk(
                    id=uuid4(),
                    session_id=session.id,
                    sequence_number=1,
                    channel=CaptureChannel.MICROPHONE,
                    object_id=uuid4(),
                    sha256="b" * 64,
                    ciphertext_size_bytes=1_024,
                    registered_at=datetime.now(UTC),
                ),
            )
            await store.update_session(
                tenant_id, session.model_copy(update={"status": SessionStatus.CAPTURING})
            )
            with pytest.raises(CaptureFinalizationError):
                await store.finalize_capture_channels(
                    tenant_id,
                    session.id,
                    (
                        CaptureChannelFinalizationDraft(
                            channel=CaptureChannel.MICROPHONE,
                            last_sequence_number=1,
                        ),
                    ),
                )

    repository_backend.run(scenario)


@pytest.mark.postgres
def test_postgres_capture_reservations_converge_across_concurrent_transactions(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(
        Settings(
            repository_backend="postgres",
            database_url=app_url,
            database_ssl=False,
            database_pool_size=4,
            database_max_overflow=0,
        )
    )
    backend = RepositoryBackend(name="postgres", provider=provider)

    async def scenario() -> None:
        try:
            tenant_id, session = await _seed_capture(backend)
            lease_id = uuid4()
            async with provider.transaction(tenant_id) as store:
                assert await store.issue_capture_lease(
                    tenant_id,
                    session.id,
                    lease_id=lease_id,
                    receipt_id=uuid4(),
                    duration=timedelta(minutes=15),
                )

            async def reserve(draft: ChunkReservationDraft):
                async with provider.transaction(tenant_id) as store:
                    return await store.create_chunk_reservation_batch(
                        tenant_id,
                        session.id,
                        batch_id=uuid4(),
                        lease_id=lease_id,
                        lease_generation=1,
                        requested_protocol_version=PROTOCOL_VERSION,
                        drafts=(draft,),
                        maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                        maximum_chunks=MAX_CHUNKS,
                        maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
                    )

            first, second = await asyncio.gather(
                reserve(_draft(sequence_number=0)),
                reserve(_draft(sequence_number=0)),
            )
            assert first.reservations[0].object_id == second.reservations[0].object_id
            async with provider.transaction(tenant_id) as store:
                usage = await store.capture_reservation_usage(tenant_id, session.id)
                assert usage.reservation_count == 1
        finally:
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_capture_tables_force_rls_and_reject_metadata_updates(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    engine = create_async_engine(app_url, connect_args={"ssl": False})
    other_tenant = uuid4()

    async def scenario() -> None:
        try:
            provider = build_postgres_provider(
                Settings(
                    repository_backend="postgres",
                    database_url=app_url,
                    database_ssl=False,
                )
            )
            backend = RepositoryBackend(name="postgres", provider=provider)
            tenant_id, session = await _seed_capture(backend)
            lease_id = uuid4()
            async with provider.transaction(tenant_id) as store:
                assert await store.issue_capture_lease(
                    tenant_id,
                    session.id,
                    lease_id=lease_id,
                    receipt_id=uuid4(),
                    duration=timedelta(minutes=15),
                )
                batch = await store.create_chunk_reservation_batch(
                    tenant_id,
                    session.id,
                    batch_id=uuid4(),
                    lease_id=lease_id,
                    lease_generation=1,
                    requested_protocol_version=PROTOCOL_VERSION,
                    drafts=(_draft(sequence_number=0),),
                    maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                    maximum_chunks=MAX_CHUNKS,
                    maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
                )
            await provider.close()

            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(other_tenant)},
                )
                assert await connection.scalar(
                    text("SELECT count(*) FROM audio_chunk_reservations")
                ) == 0

            with pytest.raises(DBAPIError, match="capture metadata is immutable"):
                async with engine.begin() as connection:
                    await connection.execute(
                        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                        {"tenant_id": str(tenant_id)},
                    )
                    await connection.execute(
                        text(
                            "UPDATE audio_chunk_reservations "
                            "SET plaintext_budget_bytes = plaintext_budget_bytes + 1 "
                            "WHERE object_id = :object_id"
                        ),
                        {"object_id": batch.reservations[0].object_id},
                    )
        finally:
            await engine.dispose()

    asyncio.run(scenario())
