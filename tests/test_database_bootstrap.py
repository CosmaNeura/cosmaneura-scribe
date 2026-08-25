from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from cosmaneura_scribe import database_bootstrap
from cosmaneura_scribe.settings import Settings
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

RUNTIME_ROLE = "cosmaneura_scribe_bootstrap_runtime"
WORKER_ROLE = "cosmaneura_scribe_bootstrap_worker"
RECONCILER_ROLE = "cosmaneura_scribe_bootstrap_reconciler"


class _Begin(AbstractAsyncContextManager["_Connection"]):
    def __init__(self, connection: _Connection) -> None:
        self._connection = connection

    async def __aenter__(self) -> _Connection:
        return self._connection

    async def __aexit__(self, *args: object) -> None:
        return None


class _Connection:
    def __init__(self, scalar_results: list[object] | None = None) -> None:
        self.executed: list[tuple[str, dict[str, object] | None]] = []
        self.scalar_parameters: list[dict[str, object]] = []
        self.scalar_results = scalar_results or []
        self.dialect = SimpleNamespace(
            identifier_preparer=SimpleNamespace(quote=lambda value: f'"{value}"')
        )

    async def scalar(self, _: object, parameters: dict[str, object]) -> object | None:
        self.scalar_parameters.append(parameters)
        return self.scalar_results.pop(0) if self.scalar_results else None

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
        database_delivery_reconciler_principal_name="scribe-delivery-reconciler",
        database_delivery_reconciler_principal_object_id=uuid4(),
    )


def _postgres_settings(database_url: str) -> Settings:
    database_name = make_url(database_url).database
    assert database_name is not None
    return Settings(
        repository_backend="postgres",
        database_url=database_url,
        database_name=database_name,
        database_ssl=False,
        database_runtime_principal_name=RUNTIME_ROLE,
        database_runtime_principal_object_id=uuid4(),
        database_transcription_principal_name=WORKER_ROLE,
        database_transcription_principal_object_id=uuid4(),
        database_delivery_reconciler_principal_name=RECONCILER_ROLE,
        database_delivery_reconciler_principal_object_id=uuid4(),
    )


async def _role_table_privileges(
    connection: AsyncConnection,
    role_name: str,
) -> set[tuple[str, str]]:
    rows = await connection.execute(
        text(
            """
            SELECT relation.relname, privileges.privilege_type
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privileges
            WHERE namespace.nspname = 'public'
              AND relation.relkind IN ('r', 'p')
              AND relation.relacl IS NOT NULL
              AND privileges.grantee = (
                SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :role_name
              )
            """
        ),
        {"role_name": role_name},
    )
    return {(str(row.relname), str(row.privilege_type).upper()) for row in rows}


async def _role_column_privileges(
    connection: AsyncConnection,
    role_name: str,
) -> set[tuple[str, str, str]]:
    rows = await connection.execute(
        text(
            """
            SELECT relation.relname, attribute.attname, privileges.privilege_type
            FROM pg_catalog.pg_attribute AS attribute
            JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privileges
            WHERE namespace.nspname = 'public'
              AND relation.relkind IN ('r', 'p')
              AND attribute.attacl IS NOT NULL
              AND privileges.grantee = (
                SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :role_name
              )
            """
        ),
        {"role_name": role_name},
    )
    return {
        (str(row.relname), str(row.attname), str(row.privilege_type).upper())
        for row in rows
    }


@pytest.mark.asyncio
async def test_bootstrap_maps_both_dedicated_entra_principals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection(scalar_results=[None, False, None, False, None, False])
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._ensure_database_principals(_settings())

    assert [item["role_name"] for item in connection.scalar_parameters] == [
        "scribe-runtime",
        "scribe-runtime",
        "scribe-transcription",
        "scribe-transcription",
        "scribe-delivery-reconciler",
        "scribe-delivery-reconciler",
    ]
    create_parameters = [
        parameters
        for statement, parameters in connection.executed
        if "pgaadauth_create_principal_with_oid" in statement
    ]
    assert [item["role_name"] for item in create_parameters if item is not None] == [
        "scribe-runtime",
        "scribe-transcription",
        "scribe-delivery-reconciler",
    ]
    assert provider.closed is True


@pytest.mark.asyncio
async def test_bootstrap_rejects_an_application_role_that_was_not_created(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection(scalar_results=[None, None])
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    with pytest.raises(RuntimeError, match="was not created"):
        await database_bootstrap._ensure_database_principals(_settings())

    assert provider.closed is True


@pytest.mark.asyncio
async def test_bootstrap_rejects_an_rls_bypassing_application_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection(scalar_results=[None, True])
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    with pytest.raises(RuntimeError, match="unsafe privileges"):
        await database_bootstrap._ensure_database_principals(_settings())

    assert provider.closed is True


@pytest.mark.asyncio
async def test_default_privileges_deny_implicit_future_application_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection()
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._deny_implicit_future_permissions(_settings())

    statements = [statement for statement, _ in connection.executed]
    assert statements[:5] == [
        'REVOKE CONNECT, TEMPORARY ON DATABASE "cosmaneura_scribe" FROM PUBLIC',
        "REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC",
        "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC",
        "REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC",
    ]
    assert statements[5:] == [
        "ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", "scribe-delivery-reconciler"',
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", "scribe-delivery-reconciler"',
        "ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", "scribe-delivery-reconciler"',
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", "scribe-delivery-reconciler"',
        "ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON ROUTINES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", "scribe-delivery-reconciler"',
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON ROUTINES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", "scribe-delivery-reconciler"',
    ]
    assert all("GRANT" not in statement for statement in statements)
    assert provider.closed is True


@pytest.mark.asyncio
async def test_runtime_permissions_revoke_stale_access_before_exact_grants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection()
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._grant_runtime_permissions(_settings())

    statements = [statement for statement, _ in connection.executed]
    assert statements[:5] == [
        'REVOKE ALL PRIVILEGES ON DATABASE "cosmaneura_scribe" FROM "scribe-runtime"',
        'REVOKE ALL PRIVILEGES ON SCHEMA public FROM "scribe-runtime"',
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "scribe-runtime"',
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "scribe-runtime"',
        'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM "scribe-runtime"',
    ]
    grants = "\n".join(statements[5:])
    assert "session_audio_keys" in grants
    assert "capture_leases" in grants
    assert "audio_chunk_reservations" in grants
    assert "audio_upload_authorization_receipts" in grants
    assert "GRANT UPDATE (generation, renewed_at, expires_at, closed_at, close_reason)" in grants
    assert "GRANT UPDATE (revoked_at) ON consent_records" in grants
    assert "GRANT INSERT ON audit_events" in grants
    assert "DELETE" not in grants
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
    assert statements[3:5] == [
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "scribe-transcription"',
        'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM "scribe-transcription"',
    ]
    assert all("GRANT" not in statement for statement in statements[:3])
    grants = "\n".join(statements)
    assert "GRANT SELECT ON consent_records, audio_chunks, session_audio_keys" in grants
    assert "GRANT UPDATE (revoked_at) ON consent_records" not in grants
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


@pytest.mark.asyncio
async def test_delivery_reconciler_receives_only_approved_column_permissions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection()
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._grant_delivery_reconciler_permissions(_settings())

    statements = [" ".join(statement.split()) for statement, _ in connection.executed]
    assert statements[:5] == [
        'REVOKE ALL PRIVILEGES ON DATABASE "cosmaneura_scribe" '
        'FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON SCHEMA public FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public '
        'FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public '
        'FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public '
        'FROM "scribe-delivery-reconciler"',
    ]
    grants = "\n".join(statements[5:])
    assert "GRANT SELECT (id, tenant_id, appointment_id" in grants
    assert "ON consent_records" in grants
    assert "ON scribe_sessions" in grants
    assert "ON transcripts" in grants
    assert "ON transcript_deliveries" in grants
    assert "GRANT UPDATE (revoked_at) ON consent_records" not in grants
    assert "GRANT UPDATE (status, attempt_count, platform_transcript_id" in grants
    assert "GRANT UPDATE (status) ON scribe_sessions" in grants
    assert "GRANT INSERT (id, tenant_id, action, entity_type, entity_id)" in grants
    for forbidden in (
        "audio_chunks",
        "audio_upload_grants",
        "session_audio_keys",
        "idempotency_records",
        "transcription_jobs",
        "GRANT DELETE",
        "GRANT INSERT ON transcript_deliveries",
        "GRANT UPDATE ON transcripts",
    ):
        assert forbidden not in grants
    assert provider.closed is True


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_bootstrap_converges_exact_grants_and_denies_future_objects(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    settings = _postgres_settings(admin_url)
    engine = create_async_engine(admin_url, connect_args={"ssl": False})

    runtime_expected = (
        {
            (table_name, privilege)
            for table_name in (
                "consent_records",
                "audio_chunks",
                "audio_upload_grants",
                "session_audio_keys",
                "transcripts",
                "idempotency_records",
                "capture_leases",
                "capture_lease_receipts",
                "audio_chunk_reservation_batches",
                "audio_chunk_reservations",
                "audio_chunk_reservation_batch_items",
                "audio_upload_authorization_receipts",
                "capture_channel_finalizations",
            )
            for privilege in ("SELECT", "INSERT")
        }
        | {
            (table_name, privilege)
            for table_name in ("scribe_sessions", "transcript_deliveries", "transcription_jobs")
            for privilege in ("SELECT", "INSERT", "UPDATE")
        }
        | {("audit_events", "INSERT")}
    )
    runtime_column_expected = {
        ("consent_records", "revoked_at", "UPDATE"),
        *(("capture_leases", column, "UPDATE") for column in (
            "generation",
            "renewed_at",
            "expires_at",
            "closed_at",
            "close_reason",
        )),
    }
    worker_column_expected: set[tuple[str, str, str]] = set()
    worker_expected = {
        (table_name, "SELECT")
        for table_name in (
            "consent_records",
            "audio_chunks",
            "session_audio_keys",
            "transcripts",
            "scribe_sessions",
            "transcription_jobs",
        )
    } | {
        ("transcripts", "INSERT"),
        ("scribe_sessions", "UPDATE"),
        ("transcription_jobs", "INSERT"),
        ("transcription_jobs", "UPDATE"),
        ("audit_events", "INSERT"),
    }
    reconciler_expected = {
        ("consent_records", column, "SELECT")
        for column in (
            "id",
            "tenant_id",
            "appointment_id",
            "practitioner_id",
            "patient_id",
            "modality",
            "all_parties_consented",
            "revoked_at",
        )
    } | {
        ("scribe_sessions", column, "SELECT")
        for column in (
            "id",
            "tenant_id",
            "appointment_id",
            "practitioner_id",
            "patient_id",
            "consent_record_id",
            "modality",
            "status",
        )
    } | {
        ("transcripts", column, "SELECT")
        for column in ("id", "tenant_id", "session_id", "segments")
    } | {
        ("transcript_deliveries", column, "SELECT")
        for column in (
            "id",
            "tenant_id",
            "session_id",
            "idempotency_key",
            "payload_sha256",
            "status",
            "attempt_count",
            "platform_transcript_id",
            "last_error_code",
            "updated_at",
        )
    } | {
        ("transcript_deliveries", column, "UPDATE")
        for column in (
            "status",
            "attempt_count",
            "platform_transcript_id",
            "last_error_code",
            "updated_at",
        )
    } | {
        ("scribe_sessions", "status", "UPDATE"),
    } | {
        ("audit_events", column, "INSERT")
        for column in ("id", "tenant_id", "action", "entity_type", "entity_id")
    }

    async def drop_probe_objects_and_roles(connection: AsyncConnection) -> None:
        await connection.execute(text("DROP TABLE IF EXISTS bootstrap_future_privilege_probe"))
        await connection.execute(text("DROP FUNCTION IF EXISTS bootstrap_future_function()"))
        await connection.execute(text("DROP PROCEDURE IF EXISTS bootstrap_future_procedure()"))
        for role_name in (RUNTIME_ROLE, WORKER_ROLE, RECONCILER_ROLE):
            exists = await connection.scalar(
                text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role_name)"),
                {"role_name": role_name},
            )
            if exists:
                await connection.execute(text(f"DROP OWNED BY {role_name}"))
                await connection.execute(text(f"DROP ROLE {role_name}"))

    try:
        async with engine.begin() as connection:
            await drop_probe_objects_and_roles(connection)
            await connection.execute(text(f"CREATE ROLE {RUNTIME_ROLE} NOLOGIN"))
            await connection.execute(text(f"CREATE ROLE {WORKER_ROLE} NOLOGIN"))
            await connection.execute(text(f"CREATE ROLE {RECONCILER_ROLE} NOLOGIN"))
            await connection.execute(
                text(
                    f"GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public "
                    f"TO {RUNTIME_ROLE}, {WORKER_ROLE}, {RECONCILER_ROLE}"
                )
            )

        await database_bootstrap._deny_implicit_future_permissions(settings)
        await database_bootstrap._grant_runtime_permissions(settings)
        await database_bootstrap._grant_transcription_permissions(settings)
        await database_bootstrap._grant_delivery_reconciler_permissions(settings)

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    """
                    CREATE TABLE bootstrap_future_privilege_probe (
                      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
                    )
                    """
                )
            )
            await connection.execute(
                text(
                    """
                    CREATE FUNCTION bootstrap_future_function()
                    RETURNS integer LANGUAGE sql AS 'SELECT 1'
                    """
                )
            )
            await connection.execute(
                text(
                    """
                    CREATE PROCEDURE bootstrap_future_procedure()
                    LANGUAGE sql AS 'SELECT 1'
                    """
                )
            )

            assert await _role_table_privileges(connection, RUNTIME_ROLE) == runtime_expected
            assert (
                await _role_column_privileges(connection, RUNTIME_ROLE)
                == runtime_column_expected
            )
            assert await _role_table_privileges(connection, WORKER_ROLE) == worker_expected
            assert (
                await _role_column_privileges(connection, WORKER_ROLE)
                == worker_column_expected
            )
            assert await _role_table_privileges(connection, RECONCILER_ROLE) == set()
            assert (
                await _role_column_privileges(connection, RECONCILER_ROLE)
                == reconciler_expected
            )

            sequence_name = await connection.scalar(
                text(
                    "SELECT pg_get_serial_sequence('public.bootstrap_future_privilege_probe', 'id')"
                )
            )
            assert isinstance(sequence_name, str)
            for role_name in (RUNTIME_ROLE, WORKER_ROLE, RECONCILER_ROLE):
                assert not await connection.scalar(
                    text(
                        "SELECT has_table_privilege("
                        ":role_name, 'public.bootstrap_future_privilege_probe', 'SELECT')"
                    ),
                    {"role_name": role_name},
                )
                assert not await connection.scalar(
                    text("SELECT has_sequence_privilege(:role_name, :sequence_name, 'USAGE')"),
                    {"role_name": role_name, "sequence_name": sequence_name},
                )
                assert not await connection.scalar(
                    text(
                        "SELECT has_function_privilege("
                        ":role_name, 'public.bootstrap_future_function()', 'EXECUTE')"
                    ),
                    {"role_name": role_name},
                )
                assert not await connection.scalar(
                    text(
                        "SELECT has_function_privilege("
                        ":role_name, 'public.bootstrap_future_procedure()', 'EXECUTE')"
                    ),
                    {"role_name": role_name},
                )
    finally:
        async with engine.begin() as connection:
            await drop_probe_objects_and_roles(connection)
        await engine.dispose()
