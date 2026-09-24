from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from dataclasses import dataclass
from functools import partial
from typing import Annotated, Any
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from anyio.from_thread import BlockingPortal
from cosmaneura_scribe.main import app, get_repository_provider
from cosmaneura_scribe.postgres_repository import (
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import InMemoryRepository, RepositoryProvider
from cosmaneura_scribe.schemas import (
    CaptureSession,
    Transcript,
    TranscriptDelivery,
    TranscriptionJob,
)
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings
from fastapi import Header
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command

APP_ROLE = "cosmaneura_scribe_test_app"
APP_PASSWORD = "test-only-123!"


def verified_test_tenant(
    tenant_id: Annotated[UUID, Header(alias="X-Tenant-ID")],
) -> UUID:
    return tenant_id


def postgres_settings(database_url: str) -> Settings:
    return Settings(
        repository_backend="postgres",
        database_url=database_url,
        database_ssl=False,
        database_pool_size=1,
        database_max_overflow=0,
    )


@dataclass
class RepositoryBackend:
    name: str
    provider: RepositoryProvider
    portal: BlockingPortal | None = None

    def run(self, function: Any, *args: object, **kwargs: object) -> Any:
        operation = partial(function, *args, **kwargs)
        if self.portal is not None:
            return self.portal.call(operation)
        return asyncio.run(operation())

    def audit_actions(self, tenant_id: UUID) -> list[str]:
        return [str(event["action"]) for event in self.audit_events(tenant_id)]

    def audit_events(self, tenant_id: UUID) -> list[dict[str, object]]:
        return self.run(self._audit_events, tenant_id)

    async def _audit_events(self, tenant_id: UUID) -> list[dict[str, object]]:
        if isinstance(self.provider, InMemoryRepository):
            return [
                event.model_dump(mode="python")
                for event in self.provider.audit_events
                if event.tenant_id == tenant_id
            ]
        if not isinstance(self.provider, PostgresRepositoryProvider):
            raise TypeError(f"Unsupported repository provider: {type(self.provider)!r}")
        async with self.provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            rows = await connection.execute(
                text(
                    "SELECT tenant_id, action, entity_type, entity_id, occurred_at "
                    "FROM audit_events ORDER BY occurred_at, id"
                )
            )
            return [dict(row) for row in rows.mappings()]

    def delivery_for(self, tenant_id: UUID, session_id: UUID) -> TranscriptDelivery | None:
        return self.run(self._delivery_for, tenant_id, session_id)

    async def _delivery_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> TranscriptDelivery | None:
        async with self.provider.transaction(tenant_id) as repository:
            return await repository.delivery_for(tenant_id, session_id)

    def session_for(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        return self.run(self._session_for, tenant_id, session_id)

    async def _session_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureSession | None:
        async with self.provider.transaction(tenant_id) as repository:
            return await repository.get_session(tenant_id, session_id)

    def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        return self.run(self._transcript_for, tenant_id, session_id)

    async def _transcript_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> Transcript | None:
        async with self.provider.transaction(tenant_id) as repository:
            return await repository.transcript_for(tenant_id, session_id)

    def transcription_job_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> TranscriptionJob | None:
        return self.run(self._transcription_job_for, tenant_id, session_id)

    async def _transcription_job_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> TranscriptionJob | None:
        async with self.provider.transaction(tenant_id) as repository:
            return await repository.transcription_job_for(tenant_id, session_id)


@pytest.fixture(scope="session")
def postgres_urls() -> Iterator[tuple[str, str]]:
    admin_url = os.getenv("COSMANEURA_SCRIBE_TEST_DATABASE_URL")
    if admin_url is None:
        if os.getenv("CI"):
            pytest.fail("CI must configure COSMANEURA_SCRIBE_TEST_DATABASE_URL")
        pytest.skip("COSMANEURA_SCRIBE_TEST_DATABASE_URL is not configured")
    parsed = make_url(admin_url)
    if not (parsed.database or "").endswith("_test"):
        if os.getenv("CI"):
            pytest.fail("CI PostgreSQL integration database name must end in _test")
        pytest.skip("PostgreSQL integration tests require a database ending in _test")

    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", admin_url)
    # Native source history is expand-only from 0020 onward. The test owner must
    # supply a fresh disposable database instead of downgrading retained history.
    if asyncio.run(_table_exists(admin_url, "alembic_version")):
        pytest.fail("PostgreSQL integration tests require a fresh disposable _test database")
    command.upgrade(config, "0007")
    probe_tenant_id, probe_consent_id, probe_session_id = asyncio.run(
        _seed_pre_ingest_mode_session(admin_url)
    )
    command.upgrade(config, "0010")
    assert (
        asyncio.run(_session_ingest_mode(admin_url, probe_tenant_id, probe_session_id))
        == "chunk_upload"
    )
    guard_probe_session_id = asyncio.run(
        _seed_versioned_legacy_child(admin_url, probe_tenant_id, probe_consent_id)
    )
    with pytest.raises(DBAPIError, match="refusing legacy child guard"):
        command.upgrade(config, "0019")
    asyncio.run(
        _delete_versioned_legacy_child(
            admin_url,
            probe_tenant_id,
            guard_probe_session_id,
        )
    )
    command.upgrade(config, "0019")
    bilingual_probe_session_id = asyncio.run(
        _seed_versioned_external_session(admin_url, probe_tenant_id, probe_consent_id)
    )
    with pytest.raises(DBAPIError, match="bilingual source storage after it has been used"):
        command.downgrade(config, "0008")
    asyncio.run(_delete_session(admin_url, probe_tenant_id, bilingual_probe_session_id))
    command.downgrade(config, "0008")
    assert asyncio.run(_table_exists(admin_url, "normalized_source_transcripts")) is False
    assert asyncio.run(_column_exists(admin_url, "scribe_sessions", "language_mode")) is False
    command.upgrade(config, "0019")
    external_probe_session_id = asyncio.run(
        _seed_external_ingest_session(admin_url, probe_tenant_id, probe_consent_id)
    )
    with pytest.raises(DBAPIError, match="refusing to remove ingest_mode"):
        command.downgrade(config, "0007")
    asyncio.run(_delete_session(admin_url, probe_tenant_id, external_probe_session_id))
    command.downgrade(config, "0007")
    assert asyncio.run(_column_exists(admin_url, "scribe_sessions", "ingest_mode")) is False
    command.upgrade(config, "0019")
    command.downgrade(config, "0006")
    for table_name in (
        "capture_leases",
        "capture_lease_receipts",
        "audio_chunk_reservation_batches",
        "audio_chunk_reservations",
        "audio_chunk_reservation_batch_items",
        "audio_upload_authorization_receipts",
        "capture_channel_finalizations",
    ):
        assert asyncio.run(_table_exists(admin_url, table_name)) is False
    assert asyncio.run(_column_exists(admin_url, "audio_chunks", "reservation_object_id")) is False
    assert asyncio.run(_column_exists(admin_url, "audio_chunks", "protocol_version")) is False
    command.upgrade(config, "0019")
    command.downgrade(config, "0005")
    assert asyncio.run(_table_exists(admin_url, "session_audio_keys")) is False
    command.upgrade(config, "0019")
    command.downgrade(config, "0003")
    assert asyncio.run(_table_exists(admin_url, "transcription_jobs")) is False
    command.upgrade(config, "0019")
    command.downgrade(config, "0001")
    assert asyncio.run(_table_exists(admin_url, "audio_upload_grants")) is False
    assert asyncio.run(_table_exists(admin_url, "idempotency_records")) is False
    assert asyncio.run(_table_exists(admin_url, "transcript_deliveries")) is False
    command.upgrade(config, "head")
    with pytest.raises(
        RuntimeError, match="expand recovery retains immutable source retirement history"
    ):
        command.downgrade(config, "0019")

    asyncio.run(_create_app_role(admin_url))
    app_url = parsed.set(username=APP_ROLE, password=APP_PASSWORD).render_as_string(
        hide_password=False
    )
    yield admin_url, app_url

    asyncio.run(_drop_app_role(admin_url))
    # The caller retires this disposable database; no migration downgrade is
    # evidence that capture/source history can be discarded in a real release.


@pytest.fixture(
    params=[
        pytest.param("memory", id="memory"),
        pytest.param("postgres", id="postgres", marks=pytest.mark.postgres),
    ]
)
def repository_backend(request: pytest.FixtureRequest) -> RepositoryBackend:
    if request.param == "memory":
        provider: RepositoryProvider = InMemoryRepository()
    else:
        _, app_url = request.getfixturevalue("postgres_urls")
        provider = build_postgres_provider(postgres_settings(app_url))
    return RepositoryBackend(name=request.param, provider=provider)


@pytest.fixture
def app_client(repository_backend: RepositoryBackend) -> Iterator[TestClient]:
    app.dependency_overrides[get_repository_provider] = lambda: repository_backend.provider
    try:
        with TestClient(app, raise_server_exceptions=False) as test_client:
            repository_backend.portal = test_client.portal
            yield test_client
            test_client.portal.call(repository_backend.provider.close)
            repository_backend.portal = None
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def client(app_client: TestClient) -> Iterator[TestClient]:
    app.dependency_overrides[get_verified_tenant_id] = verified_test_tenant
    yield app_client


@pytest.fixture
def strict_client(repository_backend: RepositoryBackend) -> Iterator[TestClient]:
    app.dependency_overrides[get_repository_provider] = lambda: repository_backend.provider
    app.dependency_overrides[get_verified_tenant_id] = verified_test_tenant
    try:
        with TestClient(app) as test_client:
            repository_backend.portal = test_client.portal
            yield test_client
            test_client.portal.call(repository_backend.provider.close)
            repository_backend.portal = None
    finally:
        app.dependency_overrides.clear()


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


async def _column_exists(database_url: str, table_name: str, column_name: str) -> bool:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.connect() as connection:
            found = await connection.scalar(
                text(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = :table_name
                          AND column_name = :column_name
                    )
                    """
                ),
                {"table_name": table_name, "column_name": column_name},
            )
            return bool(found)
    finally:
        await engine.dispose()


async def _seed_pre_ingest_mode_session(database_url: str) -> tuple[UUID, UUID, UUID]:
    tenant_id = uuid4()
    consent_id = uuid4()
    session_id = uuid4()
    engine = create_async_engine(database_url, connect_args={"ssl": False})
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
                        :id, :tenant_id, 'migration-probe-appointment',
                        'migration-probe-practitioner', 'migration-probe-patient',
                        'virtual', ARRAY['FL'], 'pre_visit_form', true,
                        now(), 'migration-probe-v1'
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
                        :id, :tenant_id, 'migration-probe-appointment',
                        'migration-probe-practitioner', 'migration-probe-patient',
                        :consent_id, 'virtual', 'created'
                    )
                    """
                ),
                {
                    "id": session_id,
                    "tenant_id": tenant_id,
                    "consent_id": consent_id,
                },
            )
    finally:
        await engine.dispose()
    return tenant_id, consent_id, session_id


async def _seed_external_ingest_session(
    database_url: str,
    tenant_id: UUID,
    consent_id: UUID,
) -> UUID:
    session_id = uuid4()
    engine = create_async_engine(database_url, connect_args={"ssl": False})
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
                        id, tenant_id, appointment_id, practitioner_id, patient_id,
                        consent_record_id, modality, status, ingest_mode
                    ) VALUES (
                        :id, :tenant_id, 'migration-guard-appointment',
                        'migration-guard-practitioner', 'migration-guard-patient',
                        :consent_id, 'virtual', 'created', 'external_async_transcript'
                    )
                    """
                ),
                {
                    "id": session_id,
                    "tenant_id": tenant_id,
                    "consent_id": consent_id,
                },
            )
    finally:
        await engine.dispose()
    return session_id


async def _seed_versioned_external_session(
    database_url: str,
    tenant_id: UUID,
    consent_id: UUID,
) -> UUID:
    session_id = uuid4()
    engine = create_async_engine(database_url, connect_args={"ssl": False})
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
                        id, tenant_id, appointment_id, practitioner_id, patient_id,
                        consent_record_id, modality, status, ingest_mode,
                        transcript_contract_version, creator_actor_id, language_mode,
                        transcription_adapter_id, transcription_model_profile_id,
                        normalization_profile_id
                    ) VALUES (
                        :id, :tenant_id, 'migration-versioned-appointment',
                        'migration-probe-practitioner', 'migration-probe-patient',
                        :consent_id, 'virtual', 'created', 'external_async_transcript',
                        '1.0', 'actor_migration_probe', 'en-US+es-US',
                        'stt_adapter_v1', 'stt_model_v1', 'normalizer_v1'
                    )
                    """
                ),
                {"id": session_id, "tenant_id": tenant_id, "consent_id": consent_id},
            )
    finally:
        await engine.dispose()
    return session_id


async def _seed_versioned_legacy_child(
    database_url: str,
    tenant_id: UUID,
    consent_id: UUID,
) -> UUID:
    session_id = await _seed_versioned_external_session(
        database_url,
        tenant_id,
        consent_id,
    )
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO audio_upload_grants (
                        object_id, tenant_id, session_id, sequence_number, channel, expires_at
                    ) VALUES (
                        :object_id, :tenant_id, :session_id, 0, 'microphone',
                        statement_timestamp() + INTERVAL '5 minutes'
                    )
                    """
                ),
                {"object_id": uuid4(), "tenant_id": tenant_id, "session_id": session_id},
            )
    finally:
        await engine.dispose()
    return session_id


async def _delete_versioned_legacy_child(
    database_url: str,
    tenant_id: UUID,
    session_id: UUID,
) -> None:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            await connection.execute(
                text(
                    "DELETE FROM audio_upload_grants "
                    "WHERE tenant_id = :tenant_id AND session_id = :session_id"
                ),
                {"tenant_id": tenant_id, "session_id": session_id},
            )
            await connection.execute(
                text(
                    "DELETE FROM scribe_sessions WHERE tenant_id = :tenant_id AND id = :session_id"
                ),
                {"tenant_id": tenant_id, "session_id": session_id},
            )
    finally:
        await engine.dispose()


async def _delete_session(
    database_url: str,
    tenant_id: UUID,
    session_id: UUID,
) -> None:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            await connection.execute(
                text(
                    """
                    DELETE FROM scribe_sessions
                    WHERE tenant_id = :tenant_id AND id = :session_id
                    """
                ),
                {"tenant_id": tenant_id, "session_id": session_id},
            )
    finally:
        await engine.dispose()


async def _clear_sessions_for_disposable_downgrade(database_url: str) -> None:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(text("TRUNCATE TABLE scribe_sessions CASCADE"))
    finally:
        await engine.dispose()


async def _session_ingest_mode(
    database_url: str,
    tenant_id: UUID,
    session_id: UUID,
) -> str | None:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            return await connection.scalar(
                text(
                    """
                    SELECT ingest_mode FROM scribe_sessions
                    WHERE tenant_id = :tenant_id AND id = :session_id
                    """
                ),
                {"tenant_id": tenant_id, "session_id": session_id},
            )
    finally:
        await engine.dispose()


async def _create_app_role(database_url: str) -> None:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            database_name = await connection.scalar(text("SELECT current_database()"))
            assert isinstance(database_name, str)
            database = connection.dialect.identifier_preparer.quote(database_name)
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
            await connection.execute(text(f"GRANT CONNECT ON DATABASE {database} TO {APP_ROLE}"))
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
