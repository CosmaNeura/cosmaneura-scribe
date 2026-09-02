from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.external_transcript_v1 import TranscriptLanguageMode
from cosmaneura_scribe.normalized_source_persistence import (
    VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID,
    VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT,
    VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID,
    VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID,
    ConfiguredExternalSessionStatus,
    VersionedExternalSessionCreate,
)
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.repository import (
    CaptureLeaseCloseReason,
    DeliveryClaimPolicy,
    DeliverySessionSyncResult,
    InMemoryRepository,
)
from cosmaneura_scribe.schemas import (
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    DeliveryStatus,
    SessionStatus,
    SpeakerRole,
    Transcript,
    TranscriptDelivery,
    TranscriptionJob,
    TranscriptionJobStatus,
    TranscriptSegment,
)
from cosmaneura_scribe.session_state_v1 import SessionIngestMode
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError


def _consent(*, revoked: bool = False) -> ConsentRecord:
    now = datetime.now(UTC)
    return ConsentRecord(
        id=uuid4(),
        appointment_id=f"synthetic-appointment-{uuid4()}",
        practitioner_id="synthetic-practitioner",
        patient_id="synthetic-patient",
        modality=CaptureModality.VIRTUAL,
        participant_regions={"FL"},
        method=ConsentMethod.PRE_VISIT_FORM,
        all_parties_consented=True,
        granted_at=now,
        policy_version="synthetic-policy-v1",
        revoked_at=now if revoked else None,
    )


def _draft(
    consent: ConsentRecord,
    *,
    patient_id: str | None = None,
) -> VersionedExternalSessionCreate:
    return VersionedExternalSessionCreate(
        id=uuid4(),
        appointment_id=consent.appointment_id,
        practitioner_id=consent.practitioner_id,
        patient_id=patient_id or consent.patient_id,
        consent_record_id=consent.id,
        modality=consent.modality,
        creator_actor_id="synthetic_core_actor",
        language_mode=TranscriptLanguageMode.ENGLISH_SPANISH,
    )


def _legacy_session(draft: VersionedExternalSessionCreate) -> CaptureSession:
    return CaptureSession(
        id=draft.id,
        appointment_id=draft.appointment_id,
        practitioner_id=draft.practitioner_id,
        patient_id=draft.patient_id,
        consent_record_id=draft.consent_record_id,
        modality=draft.modality,
        ingest_mode=SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
        status=SessionStatus.TRANSCRIPT_READY,
        created_at=datetime.now(UTC),
    )


def _legacy_transcript(session_id: UUID) -> Transcript:
    return Transcript(
        id=uuid4(),
        session_id=session_id,
        language_code="en-US",
        stt_provider="synthetic_test",
        segments=[
            TranscriptSegment(
                speaker_id="synthetic-speaker",
                speaker_role=SpeakerRole.PATIENT,
                content="Synthetic content without clinical data.",
                start_ms=0,
                end_ms=100,
            )
        ],
        created_at=datetime.now(UTC),
    )


def _legacy_delivery(session_id: UUID) -> TranscriptDelivery:
    now = datetime.now(UTC)
    return TranscriptDelivery(
        id=uuid4(),
        session_id=session_id,
        idempotency_key="synthetic-delivery-key",
        payload_sha256="a" * 64,
        status=DeliveryStatus.PENDING,
        attempt_count=0,
        created_at=now,
        updated_at=now,
    )


def test_configured_session_round_trip_lock_and_legacy_firewall(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    now = datetime.now(UTC)
    memory_job = TranscriptionJob(
        id=uuid4(),
        session_id=draft.id,
        status=TranscriptionJobStatus.PROCESSING,
        attempt_count=1,
        lease_token=uuid4(),
        lease_until=now + timedelta(minutes=15),
        created_at=now,
        updated_at=now,
    )

    async def scenario() -> None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.add_consent(tenant_id, consent)
            created = await store.create_versioned_external_session(tenant_id, draft)
            assert created is not None
            assert created.status == ConfiguredExternalSessionStatus.CREATED
            assert created.transcript_contract_version == VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT
            assert created.transcription_adapter_id == VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID
            assert (
                created.transcription_model_profile_id
                == VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID
            )
            assert created.normalization_profile_id == VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID
            assert repr(created) == "VersionedExternalSessionRecord(<protected>)"
            assert consent.patient_id not in repr(created)
            if isinstance(repository_backend.provider, InMemoryRepository):
                repository_backend.provider.transcription_jobs[(tenant_id, memory_job.id)] = (
                    memory_job
                )
                repository_backend.provider.transcription_job_by_session[
                    (tenant_id, draft.id)
                ] = memory_job.id

        async with repository_backend.provider.transaction(tenant_id) as store:
            configured = await store.get_versioned_external_session(tenant_id, draft.id)
            locked = await store.lock_versioned_external_session(tenant_id, draft.id)
            assert configured == locked
            assert configured is not None
            assert await store.get_session(tenant_id, draft.id) is None
            assert await store.lock_session(tenant_id, draft.id) is None
            assert await store.lock_capture_context(tenant_id, draft.id) is None
            assert await store.transcript_for(tenant_id, draft.id) is None
            assert await store.transcription_job_for(tenant_id, draft.id) is None
            if isinstance(repository_backend.provider, InMemoryRepository):
                assert memory_job.lease_token is not None
                assert not await store.update_transcription_job(
                    tenant_id,
                    memory_job.model_copy(update={"status": TranscriptionJobStatus.COMPLETED}),
                    expected_lease_token=memory_job.lease_token,
                )
                assert not await store.renew_transcription_job(
                    tenant_id,
                    memory_job.id,
                    lease_token=memory_job.lease_token,
                    now=now,
                    lease_until=now + timedelta(minutes=30),
                )
            assert (await store.delivery_payload_source(tenant_id, draft.id)).session is None
            assert (
                await store.synchronize_delivery_session(tenant_id, draft.id)
                == DeliverySessionSyncResult.SESSION_UNAVAILABLE
            )

            await store.update_session(tenant_id, _legacy_session(draft))
            with pytest.raises(ValueError, match="legacy session is unavailable"):
                await store.add_transcript(tenant_id, _legacy_transcript(draft.id))
            with pytest.raises(ValueError, match="legacy session is unavailable"):
                await store.add_delivery(tenant_id, _legacy_delivery(draft.id))
            assert await store.get_versioned_external_session(tenant_id, draft.id) == configured

        async with repository_backend.provider.transaction(other_tenant_id) as store:
            assert await store.get_versioned_external_session(other_tenant_id, draft.id) is None
            assert await store.lock_versioned_external_session(other_tenant_id, draft.id) is None

    repository_backend.run(scenario)


def test_configured_session_creation_requires_current_exact_tenant_consent(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    current = _consent()
    revoked = _consent(revoked=True)
    mismatch = _draft(current, patient_id="different-synthetic-patient")

    async def scenario() -> None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.add_consent(tenant_id, current)
            await store.add_consent(tenant_id, revoked)
            assert await store.create_versioned_external_session(tenant_id, mismatch) is None
            assert await store.create_versioned_external_session(tenant_id, _draft(revoked)) is None

        async with repository_backend.provider.transaction(other_tenant_id) as store:
            cross_tenant = _draft(current)
            assert (
                await store.create_versioned_external_session(other_tenant_id, cross_tenant)
                is None
            )

        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.get_versioned_external_session(tenant_id, mismatch.id) is None

    repository_backend.run(scenario)


def test_configured_session_creation_rolls_back_with_its_transaction(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)

    async def scenario() -> None:
        with pytest.raises(RuntimeError, match="synthetic rollback"):
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.add_consent(tenant_id, consent)
                assert await store.create_versioned_external_session(tenant_id, draft) is not None
                raise RuntimeError("synthetic rollback")

        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.get_versioned_external_session(tenant_id, draft.id) is None
            assert await store.get_consent(tenant_id, consent.id) is None

    repository_backend.run(scenario)


def test_configured_types_are_internal_fixed_and_distinct_from_legacy_state() -> None:
    consent = _consent()
    draft = _draft(consent)

    assert set(draft.__dataclass_fields__) == {
        "id",
        "appointment_id",
        "practitioner_id",
        "patient_id",
        "consent_record_id",
        "modality",
        "creator_actor_id",
        "language_mode",
    }
    assert repr(draft) == "VersionedExternalSessionCreate(<protected>)"
    assert ConfiguredExternalSessionStatus.SOURCE_RECEIVED.value not in {
        status.value for status in SessionStatus
    }


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_legacy_delivery_rejects_configured_session(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(postgres_settings(app_url))
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    delivery = _legacy_delivery(draft.id)
    try:
        async with provider.transaction(tenant_id) as store:
            await store.add_consent(tenant_id, consent)
            assert await store.create_versioned_external_session(tenant_id, draft) is not None

        with pytest.raises(DBAPIError, match="legacy child root requires an unconfigured session"):
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO transcript_deliveries (
                            id, tenant_id, session_id, idempotency_key, payload_sha256,
                            status, attempt_count, created_at, updated_at
                        ) VALUES (
                            :id, :tenant_id, :session_id, :idempotency_key, :payload_sha256,
                            'pending', 0, :created_at, :updated_at
                        )
                        """
                    ),
                    {"tenant_id": tenant_id, **delivery.model_dump(mode="python")},
                )

        async with provider.transaction(tenant_id) as store:
            assert await store.get_delivery(tenant_id, delivery.id) is None
            assert await store.delivery_for(tenant_id, draft.id) is None
            assert await store.claim_delivery_attempt(
                tenant_id,
                policy=DeliveryClaimPolicy(),
                delivery_id=delivery.id,
            ) is None
            assert await store.complete_delivery_failure(
                tenant_id,
                delivery.id,
                expected_attempt_count=0,
                failure_status=DeliveryStatus.RETRYABLE,
                error_code="synthetic_failure",
            ) is None
            assert await store.complete_delivery_success(
                tenant_id,
                delivery.id,
                expected_payload_sha256=delivery.payload_sha256,
                platform_transcript_id="synthetic-platform-transcript",
            ) is None

        async with provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            assert not await connection.scalar(
                text(
                    "SELECT count(*) FROM transcript_deliveries "
                    "WHERE tenant_id = :tenant_id AND id = :id"
                ),
                {"tenant_id": tenant_id, "id": delivery.id},
            )
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_legacy_worker_job_rejects_configured_session(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(postgres_settings(app_url))
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    now = datetime.now(UTC)
    lease_token = uuid4()
    job = TranscriptionJob(
        id=uuid4(),
        session_id=draft.id,
        status=TranscriptionJobStatus.PROCESSING,
        attempt_count=1,
        lease_token=lease_token,
        lease_until=now + timedelta(minutes=15),
        created_at=now,
        updated_at=now,
    )
    try:
        async with provider.transaction(tenant_id) as store:
            await store.add_consent(tenant_id, consent)
            assert await store.create_versioned_external_session(tenant_id, draft) is not None

        with pytest.raises(DBAPIError, match="legacy child root requires an unconfigured session"):
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO transcription_jobs (
                            id, tenant_id, session_id, status, attempt_count, lease_token,
                            lease_until, created_at, updated_at
                        ) VALUES (
                            :id, :tenant_id, :session_id, :status, :attempt_count, :lease_token,
                            :lease_until, :created_at, :updated_at
                        )
                        """
                    ),
                    {"tenant_id": tenant_id, **job.model_dump(mode="python")},
                )

        async with provider.transaction(tenant_id) as store:
            assert await store.transcription_job_for(tenant_id, draft.id) is None
            assert not await store.update_transcription_job(
                tenant_id,
                job.model_copy(update={"status": TranscriptionJobStatus.COMPLETED}),
                expected_lease_token=lease_token,
            )
            assert not await store.renew_transcription_job(
                tenant_id,
                job.id,
                lease_token=lease_token,
                now=now,
                lease_until=now + timedelta(minutes=30),
            )

        async with provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            assert not await connection.scalar(
                text(
                    "SELECT count(*) FROM transcription_jobs "
                    "WHERE tenant_id = :tenant_id AND id = :id"
                ),
                {"tenant_id": tenant_id, "id": job.id},
            )
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_legacy_capture_children_reject_configured_session(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(postgres_settings(app_url))
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    now = datetime.now(UTC)
    ids = {name: uuid4() for name in ("lease", "lease_receipt", "batch", "object", "auth", "chunk")}
    try:
        async with provider.transaction(tenant_id) as store:
            await store.add_consent(tenant_id, consent)
            assert await store.create_versioned_external_session(tenant_id, draft) is not None

        with pytest.raises(DBAPIError, match="legacy child root requires an unconfigured session"):
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                    WITH audio_key AS (
                        INSERT INTO session_audio_keys (
                            tenant_id, session_id, key_version, wrapped_dek, created_at
                        ) VALUES (:tenant_id, :session_id, 'synthetic-v1', :wrapped_dek, :now)
                    ), lease AS (
                        INSERT INTO capture_leases (
                            tenant_id, session_id, lease_id, generation, issued_at,
                            renewed_at, expires_at
                        ) VALUES (
                            :tenant_id, :session_id, :lease_id, 1, :now, :now, :expires_at
                        ) RETURNING tenant_id, session_id, lease_id
                    ), lease_receipt AS (
                        INSERT INTO capture_lease_receipts (
                            id, tenant_id, session_id, lease_id, generation, issued_at, expires_at
                        ) SELECT :lease_receipt_id, tenant_id, session_id, lease_id,
                                 1, :now, :expires_at FROM lease
                    ), batch AS (
                        INSERT INTO audio_chunk_reservation_batches (
                            id, tenant_id, session_id, lease_id, lease_generation,
                            requested_protocol_version, item_count, created_at,
                            capture_authorized_until
                        ) SELECT :batch_id, tenant_id, session_id, lease_id, 1,
                                 '1.0', 1, :now, :expires_at FROM lease
                        RETURNING tenant_id, session_id, id
                    ), reservation AS (
                        INSERT INTO audio_chunk_reservations (
                            object_id, tenant_id, session_id, sequence_number, channel,
                            protocol_version, additional_data, plaintext_budget_bytes, created_at
                        ) VALUES (
                            :object_id, :tenant_id, :session_id, 0, 'microphone',
                            '1.0', :additional_data, 327680, :now
                        ) RETURNING tenant_id, session_id, object_id
                    ), batch_item AS (
                        INSERT INTO audio_chunk_reservation_batch_items (
                            tenant_id, session_id, batch_id, ordinal, object_id
                        ) SELECT batch.tenant_id, batch.session_id, batch.id, 0,
                                 reservation.object_id FROM batch, reservation
                    ), upload_authorization AS (
                        INSERT INTO audio_upload_authorization_receipts (
                            id, tenant_id, session_id, reservation_object_id,
                            issued_at, expires_at
                        ) SELECT :auth_id, tenant_id, session_id, object_id,
                                 :now, :expires_at FROM reservation
                    ), finalization AS (
                        INSERT INTO capture_channel_finalizations (
                            tenant_id, session_id, channel, last_sequence_number, finalized_at
                        ) VALUES (:tenant_id, :session_id, 'microphone', 0, :now)
                    ), upload_grant AS (
                        INSERT INTO audio_upload_grants (
                            object_id, tenant_id, session_id, sequence_number, channel, expires_at
                        ) VALUES (
                            :object_id, :tenant_id, :session_id, 0, 'microphone', :expires_at
                        )
                    )
                    INSERT INTO audio_chunks (
                        id, tenant_id, session_id, sequence_number, channel, object_id,
                        sha256, ciphertext_size_bytes, registered_at,
                        reservation_object_id, protocol_version
                    ) VALUES (
                        :chunk_id, :tenant_id, :session_id, 0, 'microphone', :object_id,
                        :sha256, 1, :now, :object_id, '1.0'
                    )
                        """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "session_id": draft.id,
                        "now": now,
                        "expires_at": now + timedelta(minutes=10),
                        "wrapped_dek": "a" * 512,
                        "additional_data": b"synthetic-aad",
                        "sha256": "a" * 64,
                        **{f"{name}_id": value for name, value in ids.items()},
                    },
                )

        async with provider.transaction(tenant_id) as store:
            assert await store.get_session_audio_key(tenant_id, draft.id) is None
            assert await store.get_capture_lease(tenant_id, draft.id) is None
            assert await store.get_capture_lease_receipt(tenant_id, ids["lease_receipt"]) is None
            assert await store.get_chunk_reservation_batch(tenant_id, ids["batch"]) is None
            assert await store.get_chunk_reservation(tenant_id, draft.id, ids["object"]) is None
            usage = await store.capture_reservation_usage(tenant_id, draft.id)
            assert usage.reservation_count == usage.plaintext_budget_bytes == 0
            assert await store.get_upload_authorization_receipt(tenant_id, ids["auth"]) is None
            assert not await store.is_upload_authorization_active(tenant_id, ids["auth"])
            assert await store.get_chunk_receipt(tenant_id, draft.id, ids["object"]) is None
            assert await store.capture_finalizations_for(tenant_id, draft.id) == ()
            assert await store.get_chunk(tenant_id, ids["chunk"]) is None
            assert await store.chunks_for(tenant_id, draft.id) == []
            assert await store.get_upload_grant(tenant_id, ids["object"]) is None
            assert not await store.close_capture_lease(
                tenant_id,
                draft.id,
                expected_lease_id=ids["lease"],
                expected_generation=1,
                reason=CaptureLeaseCloseReason.CAPTURE_STOPPED,
            )
    finally:
        await provider.close()
