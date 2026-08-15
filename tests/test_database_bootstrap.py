from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from cosmaneura_scribe import database_bootstrap
from cosmaneura_scribe.settings import Settings


class _Begin(AbstractAsyncContextManager["_Connection"]):
    def __init__(self, connection: _Connection) -> None:
        self._connection = connection

    async def __aenter__(self) -> _Connection:
        return self._connection

    async def __aexit__(self, *args: object) -> None:
        return None


class _Connection:
    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, object] | None]] = []
        self.scalar_parameters: list[dict[str, object]] = []
        self.dialect = SimpleNamespace(
            identifier_preparer=SimpleNamespace(quote=lambda value: f'"{value}"')
        )

    async def scalar(self, _: object, parameters: dict[str, object]) -> None:
        self.scalar_parameters.append(parameters)
        return None

    async def execute(
        self,
        statement: object,
        parameters: dict[str, object] | None = None,
    ) -> None:
        self.executed.append((str(statement), parameters))


class _Provider:
    def __init__(self, connection: _Connection) -> None:
        self.engine = SimpleNamespace(begin=lambda: _Begin(connection))
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def _settings() -> Settings:
    return Settings(
        repository_backend="postgres",
        database_url="postgresql+asyncpg://test:test@localhost/scribe",
        database_ssl=False,
        database_runtime_principal_name="scribe-runtime",
        database_runtime_principal_object_id=uuid4(),
        database_transcription_principal_name="scribe-transcription",
        database_transcription_principal_object_id=uuid4(),
    )


@pytest.mark.asyncio
async def test_bootstrap_maps_both_dedicated_entra_principals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection()
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._ensure_database_principals(_settings())

    assert [item["role_name"] for item in connection.scalar_parameters] == [
        "scribe-runtime",
        "scribe-transcription",
    ]
    create_parameters = [
        parameters
        for statement, parameters in connection.executed
        if "pgaadauth_create_principal_with_oid" in statement
    ]
    assert [item["role_name"] for item in create_parameters if item is not None] == [
        "scribe-runtime",
        "scribe-transcription",
    ]
    assert provider.closed is True


@pytest.mark.asyncio
async def test_transcription_principal_receives_only_worker_table_permissions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection()
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._grant_transcription_permissions(_settings())

    statements = [statement for statement, _ in connection.executed]
    assert statements[:3] == [
        'REVOKE ALL PRIVILEGES ON DATABASE "cosmaneura_scribe" FROM "scribe-transcription"',
        'REVOKE ALL PRIVILEGES ON SCHEMA public FROM "scribe-transcription"',
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "scribe-transcription"',
    ]
    assert all("GRANT" not in statement for statement in statements[:3])
    grants = "\n".join(statements)
    assert "GRANT SELECT ON consent_records, audio_chunks, session_audio_keys" in grants
    assert "GRANT INSERT ON transcripts" in grants
    assert "GRANT SELECT, UPDATE ON scribe_sessions" in grants
    assert "GRANT SELECT, INSERT, UPDATE ON transcription_jobs" in grants
    assert "GRANT INSERT ON audit_events" in grants
    for forbidden in (
        "audio_upload_grants",
        "idempotency_records",
        "transcript_deliveries",
        "DELETE",
        "CREATE",
        "ALTER",
        "DROP",
    ):
        assert forbidden not in grants
    assert provider.closed is True
