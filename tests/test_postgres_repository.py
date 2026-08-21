from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.postgres_repository import PostgresRepository, build_postgres_provider
from cosmaneura_scribe.repository import (
    IdempotencyClaimUnavailableError,
    IdempotencyConflictError,
    UploadGrantRecord,
)
from cosmaneura_scribe.schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    SessionIngestMode,
    SessionStatus,
    SpeakerRole,
    Transcript,
    TranscriptionJobStatus,
    TranscriptSegment,
)
from cosmaneura_scribe.session_state_v1 import can_transition_session
from cosmaneura_scribe.settings import Settings
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine


def _settings(database_url: str) -> Settings:
    return Settings(
        repository_backend="postgres",
        database_url=database_url,
        database_ssl=False,
        database_pool_size=1,
        database_max_overflow=0,
    )


class EmptyIdempotencyResult:
    def scalar_one_or_none(self) -> None:
        return None

    def mappings(self) -> EmptyIdempotencyResult:
        return self

    def one_or_none(self) -> None:
        return None


class EmptyIdempotencySession:
    async def execute(self, *_: object, **__: object) -> EmptyIdempotencyResult:
        return EmptyIdempotencyResult()


@pytest.mark.asyncio
async def test_missing_concurrent_idempotency_row_is_a_typed_retryable_outcome() -> None:
    repository = PostgresRepository(EmptyIdempotencySession())  # type: ignore[arg-type]

    with pytest.raises(IdempotencyClaimUnavailableError):
        await repository.claim_idempotency(
            tenant_id=uuid4(),
            operation="consent.create",
            key="concurrent-visibility-gap-0001",
            request_fingerprint="a" * 64,
            entity_id=uuid4(),
        )


@pytest.mark.postgres
def test_repository_persists_across_provider_restart_and_isolates_tenants(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    consent_id = uuid4()
    session_id = uuid4()
    object_id = uuid4()
    chunk_id = uuid4()
    transcript_id = uuid4()
    job_id = uuid4()
    lease_token = uuid4()
    now = datetime.now(UTC)

    consent = ConsentRecord(
        id=consent_id,
        appointment_id="appointment-integration",
        practitioner_id="practitioner-integration",
        patient_id="patient-integration",
        modality=CaptureModality.VIRTUAL,
        participant_regions={"FL", "OH"},
        method=ConsentMethod.PRE_VISIT_FORM,
        all_parties_consented=True,
        granted_at=now,
        policy_version="all-party-v1",
    )
    session = CaptureSession(
        id=session_id,
        appointment_id=consent.appointment_id,
        practitioner_id=consent.practitioner_id,
        patient_id=consent.patient_id,
        consent_record_id=consent.id,
        modality=consent.modality,
        status=SessionStatus.CREATED,
        created_at=now,
    )
    grant = UploadGrantRecord(
        object_id=object_id,
        session_id=session_id,
        sequence_number=0,
        channel=CaptureChannel.MICROPHONE,
        expires_at=now + timedelta(minutes=15),
    )
    chunk = AudioChunk(
        id=chunk_id,
        session_id=session_id,
        sequence_number=0,
        channel=CaptureChannel.MICROPHONE,
        object_id=object_id,
        sha256="a" * 64,
        ciphertext_size_bytes=4096,
        registered_at=now,
    )
    transcript = Transcript(
        id=transcript_id,
        session_id=session_id,
        language_code="en-US",
        stt_provider="azure_speech",
        segments=[
            TranscriptSegment(
                speaker_id="channel-mic",
                speaker_role=SpeakerRole.CLINICIAN,
                content="De-identified integration fixture.",
                start_ms=0,
                end_ms=1000,
                confidence=0.99,
            )
        ],
        created_at=now,
    )

    async def scenario() -> None:
        first = build_postgres_provider(_settings(app_url))
        async with first.transaction(tenant_id) as repository:
            assert (
                await repository.claim_idempotency(
                    tenant_id=tenant_id,
                    operation="consent.create",
                    key="integration-key-0001",
                    request_fingerprint="b" * 64,
                    entity_id=consent_id,
                )
                is None
            )
            await repository.add_consent(tenant_id, consent)
            await repository.add_session(tenant_id, session)
            await repository.add_upload_grant(tenant_id, grant)
            await repository.add_chunk(tenant_id, chunk)
            await repository.update_session(
                tenant_id, session.model_copy(update={"status": SessionStatus.CAPTURING})
            )
            await repository.update_session(
                tenant_id, session.model_copy(update={"status": SessionStatus.UPLOADED})
            )
            job = await repository.claim_transcription_job(
                tenant_id,
                session_id,
                job_id=job_id,
                lease_token=lease_token,
                now=now,
                lease_until=now + timedelta(minutes=15),
                max_attempts=3,
            )
            assert job is not None
            assert await repository.renew_transcription_job(
                tenant_id,
                job.id,
                lease_token=lease_token,
                now=now + timedelta(minutes=14),
                lease_until=now + timedelta(minutes=29),
            )
            assert (
                await repository.claim_transcription_job(
                    tenant_id,
                    session_id,
                    job_id=uuid4(),
                    lease_token=uuid4(),
                    now=now + timedelta(minutes=16),
                    lease_until=now + timedelta(minutes=31),
                    max_attempts=3,
                )
                is None
            )
            await repository.update_session(
                tenant_id, session.model_copy(update={"status": SessionStatus.PROCESSING})
            )
            assert await repository.update_transcription_job(
                tenant_id,
                job.model_copy(
                    update={
                        "status": TranscriptionJobStatus.COMPLETED,
                        "lease_token": None,
                        "lease_until": None,
                        "updated_at": now,
                    }
                ),
                expected_lease_token=lease_token,
            )
            await repository.add_transcript(tenant_id, transcript)
            await repository.update_session(
                tenant_id,
                session.model_copy(update={"status": SessionStatus.TRANSCRIPT_READY}),
            )
            await repository.audit(
                tenant_id=tenant_id,
                action="transcript.created",
                entity_type="transcript",
                entity_id=transcript_id,
            )
        await first.close()

        restarted = build_postgres_provider(_settings(app_url))
        async with restarted.transaction(tenant_id) as repository:
            persisted = await repository.transcript_for(tenant_id, session_id)
            assert persisted == transcript
            persisted_job = await repository.transcription_job_for(tenant_id, session_id)
            assert persisted_job is not None
            assert persisted_job.status == TranscriptionJobStatus.COMPLETED
            replay_id = await repository.claim_idempotency(
                tenant_id=tenant_id,
                operation="consent.create",
                key="integration-key-0001",
                request_fingerprint="b" * 64,
                entity_id=uuid4(),
            )
            assert replay_id == consent_id
            with pytest.raises(IdempotencyConflictError):
                await repository.claim_idempotency(
                    tenant_id=tenant_id,
                    operation="consent.create",
                    key="integration-key-0001",
                    request_fingerprint="c" * 64,
                    entity_id=uuid4(),
                )
        async with restarted.transaction(other_tenant_id) as repository:
            assert await repository.get_consent(other_tenant_id, consent_id) is None
            assert await repository.transcript_for(other_tenant_id, session_id) is None
            assert await repository.transcription_job_for(other_tenant_id, session_id) is None
        await restarted.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_repository_consent_revocation_is_atomic_idempotent_and_tenant_scoped(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    consent_id = uuid4()
    granted_at = datetime.now(UTC)
    revoked_at = granted_at + timedelta(minutes=1)
    consent = ConsentRecord(
        id=consent_id,
        appointment_id="appointment-revocation",
        practitioner_id="practitioner-revocation",
        patient_id="patient-revocation",
        modality=CaptureModality.VIRTUAL,
        participant_regions={"FL"},
        method=ConsentMethod.PRE_VISIT_FORM,
        all_parties_consented=True,
        granted_at=granted_at,
        policy_version="all-party-v1",
    )

    async def scenario() -> None:
        provider = build_postgres_provider(_settings(app_url))
        try:
            async with provider.transaction(tenant_id) as repository:
                await repository.add_consent(tenant_id, consent)
            async with provider.transaction(other_tenant_id) as repository:
                assert (
                    await repository.revoke_consent(
                        other_tenant_id,
                        consent_id,
                        revoked_at=revoked_at,
                    )
                    is None
                )
            async with provider.transaction(tenant_id) as repository:
                first = await repository.revoke_consent(
                    tenant_id,
                    consent_id,
                    revoked_at=revoked_at,
                )
                assert first is not None
                assert first.changed is True
                assert first.consent.revoked_at == revoked_at
            async with provider.transaction(tenant_id) as repository:
                replay = await repository.revoke_consent(
                    tenant_id,
                    consent_id,
                    revoked_at=revoked_at + timedelta(minutes=1),
                )
                assert replay is not None
                assert replay.changed is False
                assert replay.consent.revoked_at == revoked_at
            engine = create_async_engine(app_url, connect_args={"ssl": False})
            try:
                with pytest.raises(DBAPIError, match="consent revocation is immutable"):
                    async with engine.begin() as connection:
                        await connection.execute(
                            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                            {"tenant_id": str(tenant_id)},
                        )
                        await connection.execute(
                            text(
                                """
                                UPDATE consent_records
                                SET revoked_at = NULL
                                WHERE tenant_id = :tenant_id AND id = :id
                                """
                            ),
                            {"tenant_id": tenant_id, "id": consent_id},
                        )
            finally:
                await engine.dispose()
        finally:
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_python_session_transition_table_matches_the_database_trigger(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    consent_id = uuid4()

    async def scenario() -> None:
        engine = create_async_engine(app_url, connect_args={"ssl": False})
        try:
            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO consent_records (
                            id, tenant_id, appointment_id, practitioner_id, patient_id,
                            modality, participant_regions, method, all_parties_consented,
                            granted_at, policy_version
                        ) VALUES (
                            :id, :tenant_id, 'appointment-transition-table',
                            'practitioner-transition-table', 'patient-transition-table',
                            'virtual', ARRAY['FL'], 'pre_visit_form', true, now(), 'all-party-v1'
                        )
                        """
                    ),
                    {"id": consent_id, "tenant_id": tenant_id},
                )

            async def attempt_transition(
                session_id: UUID,
                old_status: SessionStatus,
                new_status: SessionStatus,
            ) -> None:
                async with engine.begin() as connection:
                    await connection.execute(
                        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                        {"tenant_id": str(tenant_id)},
                    )
                    await connection.execute(
                        text(
                            """
                            INSERT INTO scribe_sessions (
                                id, tenant_id, appointment_id, practitioner_id,
                                patient_id, consent_record_id, modality, status
                            ) VALUES (
                                :id, :tenant_id, 'appointment-transition-table',
                                'practitioner-transition-table',
                                'patient-transition-table', :consent_id,
                                'virtual', :old_status
                            )
                            """
                        ),
                        {
                            "id": session_id,
                            "tenant_id": tenant_id,
                            "consent_id": consent_id,
                            "old_status": old_status.value,
                        },
                    )
                    await connection.execute(
                        text(
                            """
                            UPDATE scribe_sessions
                            SET status = :new_status
                            WHERE tenant_id = :tenant_id AND id = :id
                            """
                        ),
                        {
                            "id": session_id,
                            "tenant_id": tenant_id,
                            "new_status": new_status.value,
                        },
                    )

            for old_status in SessionStatus:
                for new_status in SessionStatus:
                    session_id = uuid4()
                    if can_transition_session(old_status, new_status):
                        await attempt_transition(session_id, old_status, new_status)
                    else:
                        with pytest.raises(
                            DBAPIError,
                            match="invalid scribe session status transition",
                        ):
                            await attempt_transition(session_id, old_status, new_status)
        finally:
            await engine.dispose()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_database_guards_external_transcript_transition_and_immutable_ingest_mode(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    consent_id = uuid4()

    async def add_session_and_transition(
        *,
        ingest_mode: SessionIngestMode,
        mutate_mode: bool = False,
    ) -> None:
        engine = create_async_engine(app_url, connect_args={"ssl": False})
        session_id = uuid4()
        try:
            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO scribe_sessions (
                            id, tenant_id, appointment_id, practitioner_id,
                            patient_id, consent_record_id, modality, ingest_mode, status
                        ) VALUES (
                            :id, :tenant_id, 'appointment-external-transition',
                            'practitioner-external-transition',
                            'patient-external-transition', :consent_id,
                            'virtual', :ingest_mode, 'created'
                        )
                        """
                    ),
                    {
                        "id": session_id,
                        "tenant_id": tenant_id,
                        "consent_id": consent_id,
                        "ingest_mode": ingest_mode.value,
                    },
                )
                if mutate_mode:
                    await connection.execute(
                        text(
                            """
                            UPDATE scribe_sessions
                            SET ingest_mode = 'external_async_transcript'
                            WHERE tenant_id = :tenant_id AND id = :id
                            """
                        ),
                        {"tenant_id": tenant_id, "id": session_id},
                    )
                else:
                    await connection.execute(
                        text(
                            """
                            UPDATE scribe_sessions
                            SET status = 'transcript_ready'
                            WHERE tenant_id = :tenant_id AND id = :id
                            """
                        ),
                        {"tenant_id": tenant_id, "id": session_id},
                    )
        finally:
            await engine.dispose()

    async def scenario() -> None:
        engine = create_async_engine(app_url, connect_args={"ssl": False})
        try:
            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO consent_records (
                            id, tenant_id, appointment_id, practitioner_id, patient_id,
                            modality, participant_regions, method, all_parties_consented,
                            granted_at, policy_version
                        ) VALUES (
                            :id, :tenant_id, 'appointment-external-transition',
                            'practitioner-external-transition', 'patient-external-transition',
                            'virtual', ARRAY['FL'], 'pre_visit_form', true,
                            now(), 'all-party-v1'
                        )
                        """
                    ),
                    {"id": consent_id, "tenant_id": tenant_id},
                )
        finally:
            await engine.dispose()

        await add_session_and_transition(
            ingest_mode=SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT
        )
        with pytest.raises(DBAPIError, match="invalid scribe session status transition"):
            await add_session_and_transition(ingest_mode=SessionIngestMode.CHUNK_UPLOAD)
        with pytest.raises(DBAPIError, match="scribe session ingest mode is immutable"):
            await add_session_and_transition(
                ingest_mode=SessionIngestMode.CHUNK_UPLOAD,
                mutate_mode=True,
            )

    asyncio.run(scenario())


@pytest.mark.postgres
def test_database_enforces_rls_transitions_and_append_only_audit(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    consent_id = uuid4()
    session_id = uuid4()

    async def scenario() -> None:
        engine = create_async_engine(app_url, connect_args={"ssl": False})
        try:
            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO consent_records (
                            id, tenant_id, appointment_id, practitioner_id, patient_id,
                            modality, participant_regions, method, all_parties_consented,
                            granted_at, policy_version
                        ) VALUES (
                            :id, :tenant_id, 'appointment-db-guard', 'practitioner-db-guard',
                            'patient-db-guard', 'virtual', ARRAY['FL'], 'pre_visit_form',
                            true, now(), 'all-party-v1'
                        )
                        """
                    ),
                    {"id": consent_id, "tenant_id": tenant_id},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO scribe_sessions (
                            id, tenant_id, appointment_id, practitioner_id, patient_id,
                            consent_record_id, modality, status
                        ) VALUES (
                            :id, :tenant_id, 'appointment-db-guard', 'practitioner-db-guard',
                            'patient-db-guard', :consent_id, 'virtual', 'created'
                        )
                        """
                    ),
                    {"id": session_id, "tenant_id": tenant_id, "consent_id": consent_id},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO audit_events (id, tenant_id, action, entity_type, entity_id)
                        VALUES (:id, :tenant_id, 'test.created', 'test', :entity_id)
                        """
                    ),
                    {"id": uuid4(), "tenant_id": tenant_id, "entity_id": uuid4()},
                )

            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(uuid4())},
                )
                assert await connection.scalar(text("SELECT count(*) FROM consent_records")) == 0
                assert await connection.scalar(text("SELECT count(*) FROM audit_events")) == 0

            with pytest.raises(DBAPIError, match="invalid scribe session status transition"):
                async with engine.begin() as connection:
                    await connection.execute(
                        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                        {"tenant_id": str(tenant_id)},
                    )
                    await connection.execute(
                        text(
                            """
                            UPDATE scribe_sessions SET status = 'handed_off'
                            WHERE id = :id
                            """
                        ),
                        {"id": session_id},
                    )

            with pytest.raises(DBAPIError, match="audit events are append-only"):
                async with engine.begin() as connection:
                    await connection.execute(
                        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                        {"tenant_id": str(tenant_id)},
                    )
                    await connection.execute(text("DELETE FROM audit_events"))
        finally:
            await engine.dispose()

    asyncio.run(scenario())
