from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

import pytest
from alembic.config import Config
from cosmaneura_scribe.main import app, get_repository_provider
from cosmaneura_scribe.postgres_repository import (
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import InMemoryRepository, RepositoryProvider
from cosmaneura_scribe.schemas import TranscriptDelivery
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings
from fastapi import Header
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
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


@dataclass(frozen=True)
class RepositoryBackend:
    name: str
    provider: RepositoryProvider

    def audit_actions(self, tenant_id: UUID) -> list[str]:
        return [str(event["action"]) for event in self.audit_events(tenant_id)]

    def audit_events(self, tenant_id: UUID) -> list[dict[str, object]]:
        return asyncio.run(self._audit_events(tenant_id))

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
        return asyncio.run(self._delivery_for(tenant_id, session_id))

    async def _delivery_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> TranscriptDelivery | None:
        async with self.provider.transaction(tenant_id) as repository:
            return await repository.delivery_for(tenant_id, session_id)


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
            yield test_client
            test_client.portal.call(repository_backend.provider.close)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def client(app_client: TestClient) -> Iterator[TestClient]:
    app.dependency_overrides[get_verified_tenant_id] = verified_test_tenant
    yield app_client


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
