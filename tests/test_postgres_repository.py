from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from alembic.config import Config
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.repository import IdempotencyConflictError, UploadGrantRecord
from cosmaneura_scribe.schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    SessionStatus,
    SpeakerRole,
    Transcript,
    TranscriptionJobStatus,
    TranscriptSegment,
)
from cosmaneura_scribe.settings import Settings
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command

APP_ROLE = "cosmaneura_scribe_test_app"
APP_PASSWORD = "test-only-123!"


@pytest.fixture(scope="module")
def postgres_urls() -> Iterator[tuple[str, str]]:
    admin_url = os.getenv("COSMANEURA_SCRIBE_TEST_DATABASE_URL")
    if admin_url is None:
        pytest.skip("COSMANEURA_SCRIBE_TEST_DATABASE_URL is not configured")
    parsed = make_url(admin_url)
    if not (parsed.database or "").endswith("_test"):
        pytest.skip("PostgreSQL integration tests require a database ending in _test")

    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", admin_url)
    command.downgrade(config, "base")
    command.upgrade(config, "head")
    command.downgrade(config, "0003")
    assert asyncio.run(_table_exists(admin_url, "transcription_jobs")) is False
    command.upgrade(config, "head")
    command.downgrade(config, "0001")
    assert asyncio.run(_table_exists(admin_url, "audio_upload_grants")) is False
    assert asyncio.run(_table_exists(admin_url, "idempotency_records")) is False
    assert asyncio.run(_table_exists(admin_url, "transcript_deliveries")) is False
    command.upgrade(config, "head")

    asyncio.run(_create_app_role(admin_url))
    app_url = parsed.set(username=APP_ROLE, password=APP_PASSWORD).render_as_string(
        hide_password=False
    )
    yield admin_url, app_url

    asyncio.run(_drop_app_role(admin_url))
    command.downgrade(config, "base")


async def _table_exists(database_url: str, table_name: str) -> bool:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.connect() as connection:
            found = await connection.scalar(
                text("SELECT to_regclass(:table_name) IS NOT NULL"),
                {"table_name": f"public.{table_name}"},
            )
            return bool(found)
    finally:
        await engine.dispose()


async def _create_app_role(database_url: str) -> None:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            role_exists = await connection.scalar(
                text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role)"),
                {"role": APP_ROLE},
            )
            if role_exists:
                await connection.execute(text(f"DROP OWNED BY {APP_ROLE}"))
                await connection.execute(text(f"DROP ROLE {APP_ROLE}"))
            await connection.execute(
                text(f"CREATE ROLE {APP_ROLE} LOGIN PASSWORD '{APP_PASSWORD}' NOSUPERUSER")
            )
            await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {APP_ROLE}"))
            await connection.execute(
                text(
                    f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES "
                    f"IN SCHEMA public TO {APP_ROLE}"
                )
            )
    finally:
        await engine.dispose()


async def _drop_app_role(database_url: str) -> None:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(text(f"DROP OWNED BY {APP_ROLE}"))
            await connection.execute(text(f"DROP ROLE IF EXISTS {APP_ROLE}"))
    finally:
        await engine.dispose()


def _settings(database_url: str) -> Settings:
    return Settings(
        repository_backend="postgres",
        database_url=database_url,
        database_ssl=False,
        database_pool_size=1,
        database_max_overflow=0,
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
            assert (
                await repository.claim_transcription_job(
                    tenant_id,
                    session_id,
                    job_id=uuid4(),
                    lease_token=uuid4(),
                    now=now + timedelta(seconds=1),
                    lease_until=now + timedelta(minutes=16),
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
