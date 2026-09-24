from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe import database_bootstrap
from cosmaneura_scribe.derived_writer_transactions import (
    commit_creator_translation_review_and_publish,
    commit_translation_attempt_and_publish,
)
from cosmaneura_scribe.external_transcript_v1 import SourceLocale
from cosmaneura_scribe.normalized_source_persistence import (
    VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID,
    VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID,
    VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID,
    ConfiguredExternalSessionStatus,
    NormalizedSourceAcceptanceDisposition,
)
from cosmaneura_scribe.postgres_repository import (
    PostgresRepository,
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import Repository, RepositoryProvider
from cosmaneura_scribe.settings import Settings
from cosmaneura_scribe.translation_attempt_persistence import (
    TranslationAttemptWriteDisposition,
)
from cosmaneura_scribe.translation_review_persistence import (
    TranslationReviewWriteDisposition,
)
from cosmaneura_scribe.working_transcript_persistence import (
    WorkingTranscriptPublishDisposition,
)
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from test_normalized_source_persistence import (
    _request,
)
from test_translation_attempt_persistence import _command
from test_translation_review_persistence import _review_command

RUNTIME_ROLE = "cosmaneura_scribe_bootstrap_runtime"
WORKER_ROLE = "cosmaneura_scribe_bootstrap_worker"
TRANSLATION_ROLE = "cosmaneura_scribe_bootstrap_translation"
RECONCILER_ROLE = "cosmaneura_scribe_bootstrap_reconciler"
FOREIGN_GRANTOR_ROLE = "cosmaneura_scribe_bootstrap_foreign_grantor"
FOREIGN_DEFAULT_OWNER_ROLE = "cosmaneura_scribe_bootstrap_foreign_default_owner"


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
        self.scalar_statements: list[str] = []
        self.scalar_parameters: list[dict[str, object]] = []
        self.scalar_results = scalar_results or []
        self.dialect = SimpleNamespace(
            identifier_preparer=SimpleNamespace(quote=lambda value: f'"{value}"')
        )

    async def scalar(self, statement: object, parameters: dict[str, object]) -> object | None:
        self.scalar_statements.append(str(statement))
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


class _RoleScopedProvider:
    """Exercise repository transactions as one exact NOLOGIN application role."""

    def __init__(self, delegate: PostgresRepositoryProvider, role_name: str) -> None:
        self._delegate = delegate
        self._role_name = role_name

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        async with self._delegate.transaction(tenant_id) as store:
            assert isinstance(store, PostgresRepository)
            await store._session.execute(text(f"SET LOCAL ROLE {self._role_name}"))
            yield store

    async def health(self) -> None:
        await self._delegate.health()

    async def close(self) -> None:
        return None


class _LoseFirstCommitAcknowledgement:
    def __init__(self, delegate: RepositoryProvider) -> None:
        self._delegate = delegate
        self.transaction_calls = 0

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        self.transaction_calls += 1
        async with self._delegate.transaction(tenant_id) as store:
            yield store
        if self.transaction_calls == 1:
            raise DBAPIError(
                "COMMIT",
                {"protected": "not-rendered"},
                RuntimeError("synthetic lost acknowledgement"),
                True,
            )

    async def health(self) -> None:
        await self._delegate.health()

    async def close(self) -> None:
        return None


def _settings(*, derived_permissions_enabled: bool = False) -> Settings:
    return Settings(
        repository_backend="postgres",
        database_url="postgresql+asyncpg://test:test@localhost/scribe",
        database_ssl=False,
        derived_writer_database_permissions_enabled=derived_permissions_enabled,
        database_runtime_principal_name="scribe-runtime",
        database_runtime_principal_object_id=uuid4(),
        database_transcription_principal_name="scribe-transcription",
        database_transcription_principal_object_id=uuid4(),
        database_translation_principal_name="scribe-translation",
        database_translation_principal_object_id=uuid4(),
        database_delivery_reconciler_principal_name="scribe-delivery-reconciler",
        database_delivery_reconciler_principal_object_id=uuid4(),
    )


def _postgres_settings(
    database_url: str,
    *,
    derived_permissions_enabled: bool = False,
) -> Settings:
    database_name = make_url(database_url).database
    assert database_name is not None
    return Settings(
        repository_backend="postgres",
        database_url=database_url,
        database_name=database_name,
        database_ssl=False,
        derived_writer_database_permissions_enabled=derived_permissions_enabled,
        database_runtime_principal_name=RUNTIME_ROLE,
        database_runtime_principal_object_id=uuid4(),
        database_transcription_principal_name=WORKER_ROLE,
        database_transcription_principal_object_id=uuid4(),
        database_translation_principal_name=TRANSLATION_ROLE,
        database_translation_principal_object_id=uuid4(),
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
    return {(str(row.relname), str(row.attname), str(row.privilege_type).upper()) for row in rows}


async def _role_sequence_privileges(
    connection: AsyncConnection,
    role_name: str,
) -> set[tuple[str, str]]:
    rows = await connection.execute(
        text(
            """
            SELECT relation.relname, candidate.privilege_type
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE'])
              AS candidate(privilege_type)
            WHERE namespace.nspname = 'public'
              AND relation.relkind = 'S'
              AND has_sequence_privilege(
                    :role_name, relation.oid, candidate.privilege_type
                  )
            """
        ),
        {"role_name": role_name},
    )
    return {(str(row.relname), str(row.privilege_type)) for row in rows}


async def _role_executable_routines(
    connection: AsyncConnection,
    role_name: str,
) -> set[str]:
    rows = await connection.execute(
        text(
            """
            SELECT procedure.oid::regprocedure::text AS signature
            FROM pg_catalog.pg_proc AS procedure
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND has_function_privilege(:role_name, procedure.oid, 'EXECUTE')
            """
        ),
        {"role_name": role_name},
    )
    return {str(row.signature) for row in rows}


def _sqlstate(error: DBAPIError) -> str | None:
    for candidate in (
        error.orig,
        getattr(error.orig, "__cause__", None),
        getattr(error.orig, "__context__", None),
    ):
        value = getattr(candidate, "sqlstate", None)
        if isinstance(value, str):
            return value
    return None


def _column_acl(
    table_name: str,
    privilege: str,
    columns: set[str] | tuple[str, ...],
) -> set[tuple[str, str, str]]:
    return {(table_name, column, privilege) for column in columns}


def _working_transcript_column_acl() -> set[tuple[str, str, str]]:
    working_transcript_select = (
        "tenant_id",
        "session_id",
        "working_transcript_id",
        "working_transcript_version",
        "source_transcript_version",
        "translation_input_count",
        "review_input_count",
        "working_fingerprint",
        "created_at",
    )
    working_transcript_insert = (
        "tenant_id",
        "session_id",
        "working_transcript_id",
        "working_transcript_version",
        "source_transcript_version",
        "schema_version",
        "segment_count",
        "blocker_count",
        "translation_input_count",
        "review_input_count",
        "total_content_chars",
        "working_fingerprint",
    )
    working_input_select = ("tenant_id", "session_id", "working_transcript_version")
    translation_input_insert = (
        "tenant_id",
        "session_id",
        "working_transcript_version",
        "source_transcript_version",
        "source_segment_id",
        "source_segment_version",
        "translation_id",
        "translation_version",
    )
    review_input_insert = translation_input_insert + ("review_id",)
    working_segment_columns = (
        "tenant_id",
        "session_id",
        "working_transcript_version",
        "ordinal",
        "source_transcript_version",
        "source_segment_id",
        "source_segment_version",
        "source_locale",
        "speaker_id",
        "speaker_role",
        "start_ms",
        "end_ms",
        "resolution",
        "content",
        "translation_id",
        "translation_version",
        "translation_review_id",
    )
    working_blocker_select = (
        "tenant_id",
        "session_id",
        "working_transcript_version",
        "ordinal",
        "source_segment_id",
        "source_segment_version",
        "code",
    )
    working_blocker_insert = working_blocker_select[:4] + (
        "source_transcript_version",
        *working_blocker_select[4:],
    )
    return (
        _column_acl("normalized_working_transcripts", "SELECT", working_transcript_select)
        | _column_acl("normalized_working_transcripts", "INSERT", working_transcript_insert)
        | _column_acl("normalized_working_translation_inputs", "SELECT", working_input_select)
        | _column_acl("normalized_working_translation_inputs", "INSERT", translation_input_insert)
        | _column_acl("normalized_working_review_inputs", "SELECT", working_input_select)
        | _column_acl("normalized_working_review_inputs", "INSERT", review_input_insert)
        | _column_acl("normalized_working_segments", "SELECT", working_segment_columns)
        | _column_acl("normalized_working_segments", "INSERT", working_segment_columns)
        | _column_acl("normalized_working_blockers", "SELECT", working_blocker_select)
        | _column_acl("normalized_working_blockers", "INSERT", working_blocker_insert)
    )


@pytest.mark.asyncio
async def test_bootstrap_maps_all_dedicated_entra_principals_and_rejects_unsafe_roles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection(scalar_results=[None, False, False] * 4)
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._ensure_database_principals(_settings())

    assert [item["role_name"] for item in connection.scalar_parameters] == [
        role
        for role in (
            "scribe-runtime",
            "scribe-transcription",
            "scribe-delivery-reconciler",
            "scribe-translation",
        )
        for _ in range(3)
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
        "scribe-translation",
    ]
    safety_queries = "\n".join(connection.scalar_statements)
    assert "rolreplication" in safety_queries
    assert "pg_auth_members" in safety_queries
    assert "pg_database" in safety_queries
    assert provider.closed is True


@pytest.mark.asyncio
async def test_bootstrap_removes_only_new_role_creator_grants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection(scalar_results=[None, True, False] + [None, False, False] * 3)
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await database_bootstrap._ensure_database_principals(_settings())

    revocations = [statement for statement, _ in connection.executed if "REVOKE" in statement]
    assert revocations == ['REVOKE "scribe-runtime" FROM CURRENT_USER']
    creator_queries = [query for query in connection.scalar_statements if "admin_option" in query]
    assert len(creator_queries) == 4
    assert all("NOT membership.inherit_option" in query for query in creator_queries)
    assert all("NOT membership.set_option" in query for query in creator_queries)
    assert provider.closed is True


@pytest.mark.asyncio
async def test_bootstrap_rejects_an_application_role_that_was_not_created(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection(scalar_results=[None, False, None])
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    with pytest.raises(RuntimeError, match="was not created"):
        await database_bootstrap._ensure_database_principals(_settings())

    assert provider.closed is True


@pytest.mark.asyncio
async def test_bootstrap_rejects_an_rls_bypassing_application_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection(scalar_results=[None, False, True])
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    with pytest.raises(RuntimeError, match="unsafe privileges"):
        await database_bootstrap._ensure_database_principals(_settings())

    assert provider.closed is True


@pytest.mark.asyncio
async def test_bootstrap_rejects_public_object_ownership_for_every_application_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    safe_connection = _Connection(scalar_results=[False, False, False, False])
    safe_provider = _Provider(safe_connection)
    monkeypatch.setattr(
        database_bootstrap,
        "build_postgres_provider",
        lambda _: safe_provider,
    )

    await database_bootstrap._ensure_no_database_principal_public_ownership(_settings())

    assert [item["role_name"] for item in safe_connection.scalar_parameters] == [
        "scribe-runtime",
        "scribe-transcription",
        "scribe-delivery-reconciler",
        "scribe-translation",
    ]
    ownership_query = "\n".join(safe_connection.scalar_statements)
    for catalog in ("pg_namespace", "pg_class", "pg_proc", "pg_type", "pg_shdepend"):
        assert catalog in ownership_query
    assert safe_provider.closed is True

    unsafe_connection = _Connection(scalar_results=[True])
    unsafe_provider = _Provider(unsafe_connection)
    monkeypatch.setattr(
        database_bootstrap,
        "build_postgres_provider",
        lambda _: unsafe_provider,
    )
    with pytest.raises(RuntimeError, match="own"):
        await database_bootstrap._ensure_no_database_principal_public_ownership(_settings())
    assert unsafe_provider.closed is True


@pytest.mark.asyncio
async def test_bootstrap_checks_principals_and_ownership_before_migrating_or_granting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def recorder(name: str):
        async def record(_: Settings) -> None:
            calls.append(name)

        return record

    monkeypatch.setattr(database_bootstrap, "_ensure_database_principals", recorder("roles"))
    monkeypatch.setattr(
        database_bootstrap,
        "_ensure_no_database_principal_public_ownership",
        recorder("ownership"),
    )
    monkeypatch.setattr(
        database_bootstrap,
        "_deny_implicit_future_permissions",
        recorder("defaults"),
    )
    monkeypatch.setattr(database_bootstrap, "upgrade_database", recorder("migrations"))
    monkeypatch.setattr(database_bootstrap, "_grant_runtime_permissions", recorder("runtime"))
    monkeypatch.setattr(
        database_bootstrap,
        "_grant_transcription_permissions",
        recorder("transcription"),
    )
    monkeypatch.setattr(
        database_bootstrap,
        "_grant_delivery_reconciler_permissions",
        recorder("reconciler"),
    )
    monkeypatch.setattr(
        database_bootstrap,
        "_grant_translation_permissions",
        recorder("translation"),
    )

    await database_bootstrap.bootstrap_database(_settings())

    assert calls == [
        "roles",
        "ownership",
        "defaults",
        "migrations",
        "runtime",
        "transcription",
        "reconciler",
        "translation",
    ]


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
        'REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, "scribe-runtime", '
        '"scribe-transcription", "scribe-delivery-reconciler", "scribe-translation"',
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC",
        "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC",
        "REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC",
    ]
    assert statements[5:] == [
        "ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", '
        '"scribe-delivery-reconciler", "scribe-translation"',
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", '
        '"scribe-delivery-reconciler", "scribe-translation"',
        "ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", '
        '"scribe-delivery-reconciler", "scribe-translation"',
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", '
        '"scribe-delivery-reconciler", "scribe-translation"',
        "ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON ROUTINES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", '
        '"scribe-delivery-reconciler", "scribe-translation"',
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON ROUTINES "
        'FROM PUBLIC, "scribe-runtime", "scribe-transcription", '
        '"scribe-delivery-reconciler", "scribe-translation"',
    ]
    assert all("GRANT" not in statement for statement in statements)
    default_acl_query = "\n".join(connection.scalar_statements)
    assert "pg_default_acl" in default_acl_query
    assert "aclexplode" in default_acl_query
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
    assert (
        "GRANT SELECT, INSERT ON normalized_source_transcripts, "
        "normalized_source_segments, normalized_source_receipt_keys"
    ) in grants
    assert "GRANT UPDATE (generation, renewed_at, expires_at, closed_at, close_reason)" in grants
    assert "GRANT UPDATE (revoked_at) ON consent_records" in grants
    assert "GRANT SELECT (id, tenant_id, appointment_id" in grants
    assert "GRANT INSERT (id, tenant_id, appointment_id" in grants
    assert (
        "GRANT UPDATE (status, source_received_at, transcript_content_expires_at, "
        "current_source_transcript_version) ON scribe_sessions"
    ) in grants
    assert "GRANT SELECT, INSERT, UPDATE ON scribe_sessions" not in grants
    for readable_lifecycle_column in (
        "source_received_at",
        "transcript_content_expires_at",
        "content_purged_at",
        "current_source_transcript_version",
    ):
        assert readable_lifecycle_column in grants
    assert "UPDATE (content_purged_at" not in grants
    assert "content_purged_at, current_source_transcript_version) ON scribe_sessions" in grants
    assert "working_transcript_id" not in grants
    assert "current_working_transcript_version" not in grants
    assert "normalized_working_" not in grants
    assert "normalized_translation_attempts" not in grants
    assert "normalized_translation_reviews" not in grants
    assert "external_session_terminal_events" not in grants
    assert "GRANT INSERT ON audit_events" in grants
    assert "DELETE" not in grants
    assert provider.closed is True


@pytest.mark.parametrize(
    ("grant_function", "allowed_insert", "denied_insert"),
    (
        (
            "_grant_runtime_permissions",
            "normalized_translation_reviews",
            "normalized_translation_attempts",
        ),
        (
            "_grant_translation_permissions",
            "normalized_translation_attempts",
            "normalized_translation_reviews",
        ),
    ),
)
@pytest.mark.asyncio
async def test_enabled_derived_writer_grants_keep_evidence_authority_split(
    monkeypatch: pytest.MonkeyPatch,
    grant_function: str,
    allowed_insert: str,
    denied_insert: str,
) -> None:
    connection = _Connection()
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)

    await getattr(database_bootstrap, grant_function)(_settings(derived_permissions_enabled=True))

    grants = [
        " ".join(statement.split())
        for statement, _ in connection.executed
        if statement.lstrip().startswith("GRANT")
    ]
    assert any(
        statement.startswith("GRANT INSERT") and allowed_insert in statement
        for statement in grants
    )
    assert not any(
        statement.startswith("GRANT INSERT") and denied_insert in statement
        for statement in grants
    )
    assert any("ON normalized_working_transcripts TO" in statement for statement in grants)
    assert any(
        "GRANT UPDATE (" in statement and "ON scribe_sessions TO" in statement
        for statement in grants
    )
    assert provider.closed is True


@pytest.mark.asyncio
async def test_translation_permissions_are_revoke_only_until_the_gate_is_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _Connection()
    provider = _Provider(connection)
    monkeypatch.setattr(database_bootstrap, "build_postgres_provider", lambda _: provider)
    settings = _settings()
    object_id = settings.database_translation_principal_object_id
    assert object_id is not None

    await database_bootstrap._grant_translation_permissions(settings)

    statements = [" ".join(statement.split()) for statement, _ in connection.executed]
    assert statements[:5] == [
        'REVOKE ALL PRIVILEGES ON DATABASE "cosmaneura_scribe" FROM "scribe-translation"',
        'REVOKE ALL PRIVILEGES ON SCHEMA public FROM "scribe-translation"',
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "scribe-translation"',
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "scribe-translation"',
        'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM "scribe-translation"',
    ]
    policy_name = f'scribe_translation_scope_{object_id.hex}'
    assert statements[5:7] == [
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '60s'",
    ]
    assert statements[7] == (
        f'DROP POLICY IF EXISTS "{policy_name}" ON public.scribe_sessions'
    )
    assert statements[8].startswith(
        f'CREATE POLICY "{policy_name}" ON public.scribe_sessions AS RESTRICTIVE '
        'FOR ALL TO "scribe-translation"'
    )
    for scope_term in (
        "ingest_mode = 'external_async_transcript'",
        "transcript_contract_version = '1.0'",
        "'translation_pending'",
        "'review_required'",
        "'transcript_ready'",
    ):
        assert statements[8].count(scope_term) == 2
    assert not any(statement.startswith("GRANT") for statement in statements)
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
    assert "GRANT SELECT (id, tenant_id, appointment_id" in grants
    assert "GRANT UPDATE (status) ON scribe_sessions" in grants
    assert "GRANT SELECT, UPDATE ON scribe_sessions" not in grants
    for configured_column in (
        "creator_actor_id",
        "language_mode",
        "transcription_adapter_id",
        "transcription_model_profile_id",
        "normalization_profile_id",
        "source_received_at",
        "transcript_content_expires_at",
        "content_purged_at",
        "current_source_transcript_version",
    ):
        assert configured_column not in grants
    assert "GRANT SELECT, INSERT, UPDATE ON transcription_jobs" in grants
    assert "GRANT INSERT ON audit_events" in grants
    for forbidden in (
        "audio_upload_grants",
        "idempotency_records",
        "normalized_translation_attempts",
        "normalized_translation_reviews",
        "normalized_working_",
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
        'REVOKE ALL PRIVILEGES ON DATABASE "cosmaneura_scribe" FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON SCHEMA public FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "scribe-delivery-reconciler"',
        'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM "scribe-delivery-reconciler"',
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
    configured_tenant_id = uuid4()
    configured_consent_id = uuid4()
    configured_session_id = uuid4()
    legacy_session_id = uuid4()
    retired_translation_policy_name = f"scribe_translation_scope_{uuid4().hex}"
    application_roles = (RUNTIME_ROLE, WORKER_ROLE, TRANSLATION_ROLE, RECONCILER_ROLE)

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
                "normalized_source_transcripts",
                "normalized_source_segments",
                "normalized_source_receipt_keys",
                "source_start_attempts",
                "source_start_retirements",
            )
            for privilege in ("SELECT", "INSERT")
        }
        | {
            (table_name, privilege)
            for table_name in ("transcript_deliveries", "transcription_jobs")
            for privilege in ("SELECT", "INSERT", "UPDATE")
        }
        | {("audit_events", "INSERT")}
    )
    runtime_session_insert_columns = {
        "id",
        "tenant_id",
        "appointment_id",
        "practitioner_id",
        "patient_id",
        "consent_record_id",
        "modality",
        "ingest_mode",
        "status",
        "created_at",
        "transcript_contract_version",
        "creator_actor_id",
        "language_mode",
        "transcription_adapter_id",
        "transcription_model_profile_id",
        "normalization_profile_id",
    }
    runtime_session_select_columns = runtime_session_insert_columns | {
        "source_received_at",
        "transcript_content_expires_at",
        "content_purged_at",
        "current_source_transcript_version",
    }
    runtime_column_expected = {
        ("consent_records", "revoked_at", "UPDATE"),
        *(("source_start_attempts", column, "UPDATE") for column in (
            "state", "issued_at", "expires_at", "stopped_at"
        )),
        *(
            ("capture_leases", column, "UPDATE")
            for column in (
                "generation",
                "renewed_at",
                "expires_at",
                "closed_at",
                "close_reason",
            )
        ),
        *(("scribe_sessions", column, "SELECT") for column in runtime_session_select_columns),
        *(("scribe_sessions", column, "INSERT") for column in runtime_session_insert_columns),
        *(
            ("scribe_sessions", column, "UPDATE")
            for column in (
                "status",
                "source_received_at",
                "transcript_content_expires_at",
                "current_source_transcript_version",
            )
        ),
    }
    translation_attempt_columns = (
        "tenant_id",
        "session_id",
        "source_transcript_version",
        "source_segment_id",
        "source_segment_version",
        "translation_id",
        "translation_version",
        "source_locale",
        "target_locale",
        "outcome",
        "content",
        "failure_code",
        "translation_adapter_id",
        "translation_model_profile_id",
    )
    translation_review_columns = (
        "tenant_id",
        "session_id",
        "source_transcript_version",
        "source_segment_id",
        "source_segment_version",
        "translation_id",
        "translation_version",
        "review_id",
        "decision",
        "reviewer_actor_id",
        "reviewed_at",
    )
    runtime_enabled_column_expected = (
        runtime_column_expected
        | _column_acl(
            "scribe_sessions",
            "SELECT",
            ("working_transcript_id", "current_working_transcript_version"),
        )
        | _column_acl(
            "scribe_sessions",
            "UPDATE",
            ("working_transcript_id", "current_working_transcript_version"),
        )
        | _column_acl(
            "normalized_translation_attempts",
            "SELECT",
            translation_attempt_columns + ("created_at",),
        )
        | _column_acl("normalized_translation_reviews", "SELECT", translation_review_columns)
        | _column_acl("normalized_translation_reviews", "INSERT", translation_review_columns)
        | _working_transcript_column_acl()
    )
    translation_session_columns = runtime_session_select_columns | {
        "working_transcript_id",
        "current_working_transcript_version",
    }
    translation_column_expected = (
        _column_acl(
            "consent_records",
            "SELECT",
            (
                "id",
                "tenant_id",
                "appointment_id",
                "practitioner_id",
                "patient_id",
                "modality",
                "participant_regions",
                "method",
                "all_parties_consented",
                "granted_at",
                "evidence_object_id",
                "policy_version",
                "revoked_at",
            ),
        )
        | _column_acl("scribe_sessions", "SELECT", translation_session_columns)
        | _column_acl(
            "scribe_sessions",
            "UPDATE",
            (
                "status",
                "working_transcript_id",
                "current_working_transcript_version",
            ),
        )
        | _column_acl(
            "normalized_source_transcripts",
            "SELECT",
            (
                "tenant_id",
                "session_id",
                "source_transcript_version",
                "source_receipt_id",
                "schema_version",
                "language_mode",
                "transcription_adapter_id",
                "transcription_model_profile_id",
                "normalization_profile_id",
                "duration_ms",
                "request_fingerprint",
                "received_at",
                "transcript_content_expires_at",
            ),
        )
        | _column_acl(
            "normalized_source_segments",
            "SELECT",
            (
                "tenant_id",
                "session_id",
                "source_transcript_version",
                "ordinal",
                "source_segment_id",
                "source_segment_version",
                "source_locale",
                "speaker_id",
                "speaker_role",
                "content",
                "start_ms",
                "end_ms",
                "locale_confidence",
            ),
        )
        | _column_acl(
            "normalized_translation_attempts",
            "SELECT",
            translation_attempt_columns + ("created_at",),
        )
        | _column_acl("normalized_translation_attempts", "INSERT", translation_attempt_columns)
        | _column_acl("normalized_translation_reviews", "SELECT", translation_review_columns)
        | _working_transcript_column_acl()
        | _column_acl(
            "audit_events",
            "INSERT",
            ("id", "tenant_id", "action", "entity_type", "entity_id"),
        )
    )
    worker_session_columns = {
        "id",
        "tenant_id",
        "appointment_id",
        "practitioner_id",
        "patient_id",
        "consent_record_id",
        "modality",
        "ingest_mode",
        "status",
        "created_at",
        "transcript_contract_version",
    }
    worker_column_expected = {
        *(("scribe_sessions", column, "SELECT") for column in worker_session_columns),
        ("scribe_sessions", "status", "UPDATE"),
    }
    worker_expected = {
        (table_name, "SELECT")
        for table_name in (
            "consent_records",
            "audio_chunks",
            "session_audio_keys",
            "transcripts",
            "transcription_jobs",
        )
    } | {
        ("transcripts", "INSERT"),
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
            "transcript_contract_version",
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
        database_name = connection.dialect.identifier_preparer.quote(settings.database_name)
        await connection.execute(text(f"ALTER DATABASE {database_name} OWNER TO CURRENT_USER"))
        await connection.execute(text("ALTER SCHEMA public OWNER TO pg_database_owner"))
        await connection.execute(text("DROP TABLE IF EXISTS bootstrap_ownership_probe"))
        await connection.execute(text("DROP COLLATION IF EXISTS bootstrap_ownership_probe"))
        await connection.execute(text("DROP TABLE IF EXISTS bootstrap_future_privilege_probe"))
        await connection.execute(text("DROP FUNCTION IF EXISTS bootstrap_future_function()"))
        await connection.execute(text("DROP PROCEDURE IF EXISTS bootstrap_future_procedure()"))
        for role_name in (FOREIGN_GRANTOR_ROLE, FOREIGN_DEFAULT_OWNER_ROLE, *application_roles):
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
            await connection.execute(text(f"CREATE ROLE {TRANSLATION_ROLE} NOLOGIN"))
            await connection.execute(text(f"CREATE ROLE {RECONCILER_ROLE} NOLOGIN"))
            await connection.execute(text(f"CREATE ROLE {FOREIGN_GRANTOR_ROLE} NOLOGIN"))
            await connection.execute(text(f"CREATE ROLE {FOREIGN_DEFAULT_OWNER_ROLE} NOLOGIN"))
            await connection.execute(
                text(
                    f"CREATE POLICY {retired_translation_policy_name} "
                    "ON public.scribe_sessions AS RESTRICTIVE FOR ALL "
                    f"TO {TRANSLATION_ROLE} USING (true) WITH CHECK (true)"
                )
            )
            await connection.execute(text("CREATE TABLE bootstrap_ownership_probe (id integer)"))
            await connection.execute(
                text(f"ALTER TABLE bootstrap_ownership_probe OWNER TO {RUNTIME_ROLE}")
            )

        with pytest.raises(RuntimeError, match="owns database objects"):
            await database_bootstrap._ensure_no_database_principal_public_ownership(settings)

        async with engine.begin() as connection:
            await connection.execute(
                text("ALTER TABLE bootstrap_ownership_probe OWNER TO CURRENT_USER")
            )
            await connection.execute(text("DROP TABLE bootstrap_ownership_probe"))
            await connection.execute(text('CREATE COLLATION bootstrap_ownership_probe FROM "C"'))
            await connection.execute(
                text(f"ALTER COLLATION bootstrap_ownership_probe OWNER TO {RUNTIME_ROLE}")
            )

        with pytest.raises(RuntimeError, match="owns database objects"):
            await database_bootstrap._ensure_no_database_principal_public_ownership(settings)

        async with engine.begin() as connection:
            await connection.execute(
                text("ALTER COLLATION bootstrap_ownership_probe OWNER TO CURRENT_USER")
            )
            await connection.execute(text("DROP COLLATION bootstrap_ownership_probe"))
            await connection.execute(
                text(
                    f"GRANT SELECT, UPDATE (content) ON normalized_translation_attempts "
                    f"TO {FOREIGN_GRANTOR_ROLE} WITH GRANT OPTION"
                )
            )
            await connection.execute(
                text(f"GRANT EXECUTE ON FUNCTION reject_audit_event_mutation() "
                     f"TO {FOREIGN_GRANTOR_ROLE} WITH GRANT OPTION")
            )
            await connection.execute(
                text("GRANT USAGE ON SCHEMA public TO " + FOREIGN_GRANTOR_ROLE)
            )
            await connection.execute(text(f"SET ROLE {FOREIGN_GRANTOR_ROLE}"))
            await connection.execute(
                text(
                    f"GRANT SELECT, UPDATE (content) ON normalized_translation_attempts "
                    f"TO {TRANSLATION_ROLE}"
                )
            )
            await connection.execute(
                text("GRANT EXECUTE ON FUNCTION reject_audit_event_mutation() TO PUBLIC")
            )
            await connection.execute(text("RESET ROLE"))

        with pytest.raises(RuntimeError, match="surviving direct ACL"):
            await database_bootstrap._grant_translation_permissions(settings)
        with pytest.raises(RuntimeError, match="direct ACL remains for PUBLIC"):
            await database_bootstrap._deny_implicit_future_permissions(settings)

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    f"REVOKE SELECT, UPDATE (content) ON normalized_translation_attempts "
                    f"FROM {FOREIGN_GRANTOR_ROLE} CASCADE"
                )
            )
            await connection.execute(
                text(f"REVOKE EXECUTE ON FUNCTION reject_audit_event_mutation() "
                     f"FROM {FOREIGN_GRANTOR_ROLE} CASCADE")
            )
            await connection.execute(text(f"SET ROLE {FOREIGN_DEFAULT_OWNER_ROLE}"))
            await connection.execute(
                text(
                    f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES "
                    f"TO {TRANSLATION_ROLE}"
                )
            )
            await connection.execute(text("RESET ROLE"))

        with pytest.raises(RuntimeError, match="default privileges remain"):
            await database_bootstrap._deny_implicit_future_permissions(settings)

        async with engine.begin() as connection:
            database = connection.dialect.identifier_preparer.quote(settings.database_name)
            await connection.execute(text(f"SET ROLE {FOREIGN_DEFAULT_OWNER_ROLE}"))
            await connection.execute(
                text(
                    f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES "
                    f"FROM {TRANSLATION_ROLE}"
                )
            )
            await connection.execute(text("RESET ROLE"))
            await connection.execute(
                text("GRANT CREATE ON SCHEMA public TO " + FOREIGN_GRANTOR_ROLE)
            )

        with pytest.raises(RuntimeError, match="public-schema CREATE"):
            await database_bootstrap._deny_implicit_future_permissions(settings)

        async with engine.begin() as connection:
            await connection.execute(
                text("REVOKE CREATE ON SCHEMA public FROM " + FOREIGN_GRANTOR_ROLE)
            )
            await connection.execute(text("ALTER SCHEMA public OWNER TO CURRENT_USER"))
            await connection.execute(
                text(f"ALTER DATABASE {database} OWNER TO {FOREIGN_GRANTOR_ROLE}")
            )
            await connection.execute(text(f"SET ROLE {FOREIGN_GRANTOR_ROLE}"))
            await connection.execute(
                text(f"REVOKE CONNECT, TEMPORARY ON DATABASE {database} FROM PUBLIC")
            )
            await connection.execute(text("RESET ROLE"))

        check_defaults = database_bootstrap._ensure_no_application_default_privileges
        async with engine.begin() as connection:
            with pytest.raises(RuntimeError, match="public-schema CREATE"):
                await check_defaults(connection, application_roles)

        async with engine.begin() as connection:
            await connection.execute(
                text(f"ALTER DATABASE {database} OWNER TO CURRENT_USER")
            )
            await connection.execute(text("ALTER SCHEMA public OWNER TO pg_database_owner"))
            await database_bootstrap._ensure_no_database_principal_public_ownership(settings)
            await connection.execute(
                text(f"GRANT TEMPORARY ON DATABASE {database} TO {', '.join(application_roles)}")
            )
            await connection.execute(
                text(f"GRANT CREATE ON SCHEMA public TO {', '.join(application_roles)}")
            )
            await connection.execute(
                text(
                    f"GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public "
                    f"TO {', '.join(application_roles)}"
                )
            )
            await connection.execute(
                text(
                    f"GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public "
                    f"TO {', '.join(application_roles)}"
                )
            )
            await connection.execute(
                text(
                    f"GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public "
                    f"TO {', '.join(application_roles)}"
                )
            )
            await connection.execute(
                text(
                    "GRANT UPDATE (content) ON normalized_translation_attempts TO "
                    + ", ".join(application_roles)
                )
            )

        for _ in range(2):
            await database_bootstrap._deny_implicit_future_permissions(settings)
            await database_bootstrap._grant_runtime_permissions(settings)
            await database_bootstrap._grant_transcription_permissions(settings)
            await database_bootstrap._grant_translation_permissions(settings)
            await database_bootstrap._grant_delivery_reconciler_permissions(settings)

        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(configured_tenant_id)},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO consent_records (
                        id, tenant_id, appointment_id, practitioner_id, patient_id,
                        modality, participant_regions, method, all_parties_consented,
                        granted_at, policy_version
                    ) VALUES (
                        :id, :tenant_id, 'bootstrap-appointment', 'bootstrap-practitioner',
                        'bootstrap-patient', 'virtual', ARRAY['FL'], 'pre_visit_form', true,
                        statement_timestamp(), 'bootstrap-policy-v1'
                    )
                    """
                ),
                {"id": configured_consent_id, "tenant_id": configured_tenant_id},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO scribe_sessions (
                        id, tenant_id, appointment_id, practitioner_id, patient_id,
                        consent_record_id, modality, ingest_mode, status
                    ) VALUES (
                        :id, :tenant_id, 'legacy-appointment', 'legacy-practitioner',
                        'legacy-patient', :consent_id, 'virtual', 'chunk_upload', 'created'
                    )
                    """
                ),
                {
                    "id": legacy_session_id,
                    "tenant_id": configured_tenant_id,
                    "consent_id": configured_consent_id,
                },
            )

        # Commit as the exact runtime role. This catches deferred-trigger reads that
        # accidentally require source-anchor columns outside Packet 1's grant.
        async with engine.begin() as connection:
            await connection.execute(text(f"SET LOCAL ROLE {RUNTIME_ROLE}"))
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(configured_tenant_id)},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO scribe_sessions (
                        id, tenant_id, appointment_id, practitioner_id, patient_id,
                        consent_record_id, modality, ingest_mode, status,
                        transcript_contract_version, creator_actor_id, language_mode,
                        transcription_adapter_id, transcription_model_profile_id,
                        normalization_profile_id
                    ) VALUES (
                        :id, :tenant_id, 'bootstrap-appointment', 'bootstrap-practitioner',
                        'bootstrap-patient', :consent_id, 'virtual',
                        'external_async_transcript', 'created', '1.0', 'bootstrap_actor',
                        'en-US+es-US', :adapter_id, :model_profile_id, :normalization_profile_id
                    )
                    """
                ),
                {
                    "id": configured_session_id,
                    "tenant_id": configured_tenant_id,
                    "consent_id": configured_consent_id,
                    "adapter_id": VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID,
                    "model_profile_id": VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID,
                    "normalization_profile_id": VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID,
                },
            )

        # The runtime retains legacy-table INSERT for existing capture routes,
        # but direct SQL cannot attach those rows to a configured session.
        with pytest.raises(DBAPIError, match="legacy child root requires an unconfigured session"):
            async with engine.begin() as connection:
                await connection.execute(text(f"SET LOCAL ROLE {RUNTIME_ROLE}"))
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(configured_tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO audio_upload_grants (
                            object_id, tenant_id, session_id,
                            sequence_number, channel, expires_at
                        ) VALUES (
                            :object_id, :tenant_id, :session_id, 0, 'microphone',
                            statement_timestamp() + INTERVAL '5 minutes'
                        )
                        """
                    ),
                    {
                        "object_id": uuid4(),
                        "tenant_id": configured_tenant_id,
                        "session_id": configured_session_id,
                    },
                )

        # Exercise the complete future receiver write/read shape as the existing
        # runtime role, then roll it back so this privilege proof remains dormant.
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                await connection.execute(text(f"SET LOCAL ROLE {RUNTIME_ROLE}"))
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(configured_tenant_id)},
                )
                anchors = (
                    await connection.execute(
                        text(
                            """
                            UPDATE scribe_sessions
                            SET status = 'source_received',
                                source_received_at = clock_timestamp(),
                                transcript_content_expires_at =
                                    clock_timestamp() + INTERVAL '1 day',
                                current_source_transcript_version = 1
                            WHERE tenant_id = :tenant_id AND id = :session_id
                            RETURNING source_received_at, transcript_content_expires_at
                            """
                        ),
                        {
                            "tenant_id": configured_tenant_id,
                            "session_id": configured_session_id,
                        },
                    )
                ).one()
                receipt_id = uuid4()
                await connection.execute(
                    text(
                        """
                        INSERT INTO normalized_source_transcripts (
                            tenant_id, session_id, source_transcript_version,
                            source_receipt_id, schema_version, language_mode,
                            transcription_adapter_id, transcription_model_profile_id,
                            normalization_profile_id, duration_ms, segment_count,
                            total_content_chars, request_fingerprint, received_at,
                            transcript_content_expires_at
                        ) VALUES (
                            :tenant_id, :session_id, 1, :receipt_id, '1.0',
                            'en-US+es-US', :adapter_id, :model_profile_id,
                            :normalization_profile_id, 1000, 1, 16, :fingerprint,
                            :received_at, :expires_at
                        )
                        """
                    ),
                    {
                        "tenant_id": configured_tenant_id,
                        "session_id": configured_session_id,
                        "receipt_id": receipt_id,
                        "adapter_id": VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID,
                        "model_profile_id": VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID,
                        "normalization_profile_id": VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID,
                        "fingerprint": "a" * 64,
                        "received_at": anchors.source_received_at,
                        "expires_at": anchors.transcript_content_expires_at,
                    },
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO normalized_source_segments (
                            tenant_id, session_id, source_transcript_version, ordinal,
                            source_segment_id, source_segment_version, source_locale,
                            speaker_id, speaker_role, content, start_ms, end_ms,
                            locale_confidence
                        ) VALUES (
                            :tenant_id, :session_id, 1, 0, :segment_id, 1, 'es-US',
                            :speaker_id, 'patient', 'Texto sintetico.',
                            0, 1000, 0.99
                        )
                        """
                    ),
                    {
                        "tenant_id": configured_tenant_id,
                        "session_id": configured_session_id,
                        "segment_id": uuid4(),
                        "speaker_id": uuid4(),
                    },
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO normalized_source_receipt_keys (
                            tenant_id, session_id, idempotency_key,
                            source_transcript_version, request_fingerprint
                        ) VALUES (
                            :tenant_id, :session_id, 'bootstrap-source-key', 1, :fingerprint
                        )
                        """
                    ),
                    {
                        "tenant_id": configured_tenant_id,
                        "session_id": configured_session_id,
                        "fingerprint": "a" * 64,
                    },
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO audit_events (id, tenant_id, action, entity_type, entity_id)
                        VALUES (
                            :id, :tenant_id, 'normalized_source.accepted',
                            'normalized_source_receipt', :receipt_id
                        )
                        """
                    ),
                    {
                        "id": uuid4(),
                        "tenant_id": configured_tenant_id,
                        "receipt_id": receipt_id,
                    },
                )
                await connection.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
                assert (
                    await connection.scalar(
                        text(
                            "SELECT count(*) FROM normalized_source_segments "
                            "WHERE tenant_id = :tenant_id AND session_id = :session_id"
                        ),
                        {
                            "tenant_id": configured_tenant_id,
                            "session_id": configured_session_id,
                        },
                    )
                    == 1
                )
            finally:
                await transaction.rollback()

        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                await connection.execute(text(f"SET LOCAL ROLE {RUNTIME_ROLE}"))
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(configured_tenant_id)},
                )
                forbidden = (
                    "UPDATE scribe_sessions SET content_purged_at = clock_timestamp() "
                    "WHERE tenant_id = :tenant_id AND id = :session_id",
                    "DELETE FROM normalized_source_transcripts "
                    "WHERE tenant_id = :tenant_id AND session_id = :session_id",
                    "INSERT INTO external_session_terminal_events ("
                    "tenant_id, session_id, event_id, prior_status, failure_code, "
                    "principal_type, principal_id) VALUES ("
                    ":tenant_id, :session_id, :event_id, 'created', "
                    "'irrecoverable_integrity_failure', 'system', 'bootstrap_probe')",
                )
                for statement in forbidden:
                    savepoint = await connection.begin_nested()
                    with pytest.raises(DBAPIError, match="permission denied"):
                        await connection.execute(
                            text(statement),
                            {
                                "tenant_id": configured_tenant_id,
                                "session_id": configured_session_id,
                                "event_id": uuid4(),
                            },
                        )
                    await savepoint.rollback()
            finally:
                await transaction.rollback()

        async with engine.begin() as connection:
            worker_snapshot = (
                await _role_table_privileges(connection, WORKER_ROLE),
                await _role_column_privileges(connection, WORKER_ROLE),
            )
            reconciler_snapshot = (
                await _role_table_privileges(connection, RECONCILER_ROLE),
                await _role_column_privileges(connection, RECONCILER_ROLE),
            )
            assert worker_snapshot == (worker_expected, worker_column_expected)
            assert reconciler_snapshot == (set(), reconciler_expected)
            assert await _role_table_privileges(connection, TRANSLATION_ROLE) == set()
            assert await _role_column_privileges(connection, TRANSLATION_ROLE) == set()
            translation_object_id = settings.database_translation_principal_object_id
            assert translation_object_id is not None
            translation_policy_name = (
                f"scribe_translation_scope_{translation_object_id.hex}"
            )
            translation_policy = (
                await connection.execute(
                    text(
                        """
                        SELECT permissive, cmd, roles, qual, with_check
                        FROM pg_catalog.pg_policies
                        WHERE schemaname = 'public' AND tablename = 'scribe_sessions'
                          AND policyname = :policy_name
                        """
                    ),
                    {"policy_name": translation_policy_name},
                )
            ).one()
            assert tuple(translation_policy[:3]) == (
                "RESTRICTIVE",
                "ALL",
                [TRANSLATION_ROLE],
            )
            for expression in (
                str(translation_policy.qual),
                str(translation_policy.with_check),
            ):
                for scope_value in (
                    "external_async_transcript", "1.0", "translation_pending",
                    "review_required", "transcript_ready",
                ):
                    assert scope_value in expression
            assert await connection.scalar(
                text(
                    "SELECT EXISTS ("
                    "SELECT 1 FROM pg_catalog.pg_policy "
                    "WHERE polrelid = 'public.scribe_sessions'::regclass "
                    "AND polname = :policy_name)"
                ),
                {"policy_name": retired_translation_policy_name},
            )

        enabled_settings = settings.model_copy(
            update={"derived_writer_database_permissions_enabled": True}
        )
        for _ in range(2):
            await database_bootstrap._deny_implicit_future_permissions(enabled_settings)
            await database_bootstrap._grant_runtime_permissions(enabled_settings)
            await database_bootstrap._grant_transcription_permissions(enabled_settings)
            await database_bootstrap._grant_translation_permissions(enabled_settings)
            await database_bootstrap._grant_delivery_reconciler_permissions(enabled_settings)

        immutable_tables = (
            "normalized_source_transcripts",
            "normalized_source_segments",
            "normalized_source_receipt_keys",
            "normalized_translation_attempts",
            "normalized_translation_reviews",
            "normalized_working_transcripts",
            "normalized_working_translation_inputs",
            "normalized_working_review_inputs",
            "normalized_working_segments",
            "normalized_working_blockers",
        )
        async with engine.begin() as connection:
            assert await _role_table_privileges(connection, RUNTIME_ROLE) == runtime_expected
            assert (
                await _role_column_privileges(connection, RUNTIME_ROLE)
                == runtime_enabled_column_expected
            )
            assert await _role_table_privileges(connection, TRANSLATION_ROLE) == set()
            assert (
                await _role_column_privileges(connection, TRANSLATION_ROLE)
                == translation_column_expected
            )
            assert (
                await _role_table_privileges(connection, WORKER_ROLE),
                await _role_column_privileges(connection, WORKER_ROLE),
            ) == worker_snapshot
            assert (
                await _role_table_privileges(connection, RECONCILER_ROLE),
                await _role_column_privileges(connection, RECONCILER_ROLE),
            ) == reconciler_snapshot
            for role_name in application_roles:
                assert await connection.scalar(
                    text(
                        "SELECT has_database_privilege(:role_name, current_database(), 'CONNECT')"
                    ),
                    {"role_name": role_name},
                )
                assert await connection.scalar(
                    text("SELECT has_schema_privilege(:role_name, 'public', 'USAGE')"),
                    {"role_name": role_name},
                )
                assert not await connection.scalar(
                    text(
                        "SELECT has_database_privilege(:role_name, current_database(), 'TEMPORARY')"
                    ),
                    {"role_name": role_name},
                )
                assert not await connection.scalar(
                    text("SELECT has_schema_privilege(:role_name, 'public', 'CREATE')"),
                    {"role_name": role_name},
                )
                assert await _role_sequence_privileges(connection, role_name) == set()
                assert await _role_executable_routines(connection, role_name) == set()
            for role_name in (RUNTIME_ROLE, TRANSLATION_ROLE):
                for table_name in immutable_tables:
                    for privilege in (
                        "UPDATE",
                        "DELETE",
                        "TRUNCATE",
                        "REFERENCES",
                        "TRIGGER",
                    ):
                        assert not await connection.scalar(
                            text("SELECT has_table_privilege(:role_name, :table_name, :privilege)"),
                            {
                                "role_name": role_name,
                                "table_name": f"public.{table_name}",
                                "privilege": privilege,
                            },
                        )
            assert not await connection.scalar(
                text(
                    "SELECT has_table_privilege("
                    ":role_name, 'public.normalized_translation_attempts', 'INSERT')"
                ),
                {"role_name": RUNTIME_ROLE},
            )
            assert not await connection.scalar(
                text(
                    "SELECT has_table_privilege("
                    ":role_name, 'public.normalized_translation_reviews', 'INSERT')"
                ),
                {"role_name": TRANSLATION_ROLE},
            )
            assert await connection.scalar(
                text(
                    "SELECT has_column_privilege("
                    ":role_name, 'public.normalized_translation_reviews', "
                    "'review_id', 'INSERT')"
                ),
                {"role_name": RUNTIME_ROLE},
            )
            assert not await connection.scalar(
                text(
                    "SELECT has_column_privilege("
                    ":role_name, 'public.normalized_translation_attempts', "
                    "'translation_id', 'INSERT')"
                ),
                {"role_name": RUNTIME_ROLE},
            )
            assert await connection.scalar(
                text(
                    "SELECT has_column_privilege("
                    ":role_name, 'public.normalized_translation_attempts', "
                    "'translation_id', 'INSERT')"
                ),
                {"role_name": TRANSLATION_ROLE},
            )
            assert not await connection.scalar(
                text(
                    "SELECT has_column_privilege("
                    ":role_name, 'public.normalized_translation_reviews', "
                    "'review_id', 'INSERT')"
                ),
                {"role_name": TRANSLATION_ROLE},
            )
            rls_rows = (
                await connection.execute(
                    text(
                        """
                        SELECT relname, relrowsecurity, relforcerowsecurity
                        FROM pg_catalog.pg_class
                        WHERE relnamespace = 'public'::regnamespace
                          AND relname = ANY(:table_names)
                        """
                    ),
                    {"table_names": list(immutable_tables)},
                )
            ).all()
            assert set(rls_rows) == {(table_name, True, True) for table_name in immutable_tables}
            await connection.execute(text(f"SET LOCAL ROLE {TRANSLATION_ROLE}"))
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(configured_tenant_id)},
            )
            assert await connection.scalar(
                text("SELECT count(*) FROM scribe_sessions WHERE id = :id"),
                {"id": legacy_session_id},
            ) == 0
            hidden_update = await connection.execute(
                text("UPDATE scribe_sessions SET status = 'capturing' WHERE id = :id RETURNING id"),
                {"id": legacy_session_id},
            )
            assert hidden_update.scalar_one_or_none() is None
            await connection.execute(text("RESET ROLE"))
            assert await connection.scalar(
                text("SELECT status FROM scribe_sessions WHERE id = :id"),
                {"id": legacy_session_id},
            ) == "created"

        repository_provider = build_postgres_provider(enabled_settings)
        try:
            runtime_provider = _RoleScopedProvider(repository_provider, RUNTIME_ROLE)
            translation_provider = _RoleScopedProvider(repository_provider, TRANSLATION_ROLE)
            async with runtime_provider.transaction(configured_tenant_id) as store:
                accepted = await store.accept_normalized_source_transcript(
                    configured_tenant_id,
                    configured_session_id,
                    idempotency_key="packet-b-source-v1",
                    request=_request(),
                )
                initial_working = await store.publish_current_working_transcript(
                    configured_tenant_id,
                    configured_session_id,
                )
            assert accepted is not None
            assert accepted.disposition == NormalizedSourceAcceptanceDisposition.ACCEPTED
            assert initial_working is not None
            assert initial_working.disposition == WorkingTranscriptPublishDisposition.PUBLISHED
            assert initial_working.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING

            async with runtime_provider.transaction(configured_tenant_id) as store:
                corrected = await store.accept_normalized_source_transcript(
                    configured_tenant_id,
                    configured_session_id,
                    idempotency_key="packet-b-source-v2",
                    request=_request(spanish_content="Contenido sintetico corregido."),
                )
                assert isinstance(store, PostgresRepository)
                corrected_pointer = (
                    await store._session.execute(
                        text(
                            "SELECT working_transcript_id, "
                            "current_working_transcript_version FROM scribe_sessions "
                            "WHERE tenant_id = :tenant_id AND id = :session_id"
                        ),
                        {
                            "tenant_id": configured_tenant_id,
                            "session_id": configured_session_id,
                        },
                    )
                ).one()
                replacement_working = await store.publish_current_working_transcript(
                    configured_tenant_id,
                    configured_session_id,
                )
                source = await store.get_current_normalized_source_transcript(
                    configured_tenant_id,
                    configured_session_id,
                )
            assert corrected is not None
            assert corrected.disposition == NormalizedSourceAcceptanceDisposition.CORRECTED
            assert corrected_pointer.working_transcript_id == initial_working.working_transcript_id
            assert corrected_pointer.current_working_transcript_version is None
            assert replacement_working is not None
            assert replacement_working.disposition == WorkingTranscriptPublishDisposition.REPLACED
            assert replacement_working.working_transcript_id == (
                initial_working.working_transcript_id
            )
            assert replacement_working.working_transcript_version == 2
            assert source is not None and source.source_transcript_version == 2
            spanish_segment = next(
                segment
                for segment in source.segments
                if segment.source_locale == SourceLocale.SPANISH_US
            )

            ambiguous_attempt_provider = _LoseFirstCommitAcknowledgement(translation_provider)
            attempt = await commit_translation_attempt_and_publish(
                ambiguous_attempt_provider,
                configured_tenant_id,
                configured_session_id,
                _command(
                    2,
                    spanish_segment.source_segment_id,
                    spanish_segment.source_segment_version,
                ),
            )
            assert attempt is not None
            assert attempt.disposition == TranslationAttemptWriteDisposition.REPLAYED
            assert attempt.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED
            assert attempt.current_working_transcript.working_transcript_version == 3
            assert ambiguous_attempt_provider.transaction_calls == 2

            ambiguous_review_provider = _LoseFirstCommitAcknowledgement(runtime_provider)
            review = await commit_creator_translation_review_and_publish(
                ambiguous_review_provider,
                configured_tenant_id,
                configured_session_id,
                _review_command(
                    2,
                    spanish_segment.source_segment_id,
                    spanish_segment.source_segment_version,
                    attempt.translation_id,
                    attempt.translation_version,
                    "bootstrap_actor",
                ),
            )
            assert review is not None
            assert review.disposition == TranslationReviewWriteDisposition.REPLAYED
            assert review.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
            assert review.current_working_transcript.working_transcript_version == 4
            assert ambiguous_review_provider.transaction_calls == 2
        finally:
            await repository_provider.close()

        with pytest.raises(DBAPIError) as terminal_update_denied:
            async with engine.begin() as connection:
                await connection.execute(text(f"SET LOCAL ROLE {TRANSLATION_ROLE}"))
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(configured_tenant_id)},
                )
                await connection.execute(
                    text("UPDATE scribe_sessions SET status = 'handed_off' WHERE id = :id"),
                    {"id": configured_session_id},
                )
        assert _sqlstate(terminal_update_denied.value) == "42501"

        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(configured_tenant_id)},
            )
            assert await connection.scalar(
                text("SELECT status FROM scribe_sessions WHERE id = :id"),
                {"id": configured_session_id},
            ) == "transcript_ready"
            counts = (
                await connection.execute(
                    text(
                        """
                        SELECT
                          (SELECT count(*) FROM normalized_source_transcripts
                           WHERE tenant_id = :tenant_id AND session_id = :session_id),
                          (SELECT count(*) FROM normalized_translation_attempts
                           WHERE tenant_id = :tenant_id AND session_id = :session_id),
                          (SELECT count(*) FROM normalized_translation_reviews
                           WHERE tenant_id = :tenant_id AND session_id = :session_id),
                          (SELECT count(*) FROM normalized_working_transcripts
                           WHERE tenant_id = :tenant_id AND session_id = :session_id),
                          (SELECT count(DISTINCT working_transcript_id)
                           FROM normalized_working_transcripts
                           WHERE tenant_id = :tenant_id AND session_id = :session_id)
                        """
                    ),
                    {
                        "tenant_id": configured_tenant_id,
                        "session_id": configured_session_id,
                    },
                )
            ).one()
            assert tuple(counts) == (2, 1, 1, 4, 1)

        other_tenant_id = uuid4()
        for role_name in (RUNTIME_ROLE, TRANSLATION_ROLE):
            with pytest.raises(DBAPIError) as rls_denied:
                async with engine.begin() as connection:
                    await connection.execute(text(f"SET LOCAL ROLE {role_name}"))
                    await connection.execute(
                        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                        {"tenant_id": str(other_tenant_id)},
                    )
                    assert (
                        await connection.scalar(
                            text(
                                "SELECT count(*) FROM scribe_sessions "
                                "WHERE tenant_id = :tenant_id AND id = :session_id"
                            ),
                            {
                                "tenant_id": configured_tenant_id,
                                "session_id": configured_session_id,
                            },
                        )
                        == 0
                    )
                    await connection.execute(
                        text(
                            "INSERT INTO audit_events "
                            "(id, tenant_id, action, entity_type, entity_id) VALUES "
                            "(:id, :tenant_id, 'bootstrap.rls_probe', 'session', :session_id)"
                        ),
                        {
                            "id": uuid4(),
                            "tenant_id": configured_tenant_id,
                            "session_id": configured_session_id,
                        },
                    )
            assert _sqlstate(rls_denied.value) == "42501"

        forbidden_inserts = (
            (RUNTIME_ROLE, "normalized_translation_attempts"),
            (TRANSLATION_ROLE, "normalized_translation_reviews"),
            (TRANSLATION_ROLE, "normalized_source_transcripts"),
        )
        for role_name, table_name in forbidden_inserts:
            with pytest.raises(DBAPIError) as denied:
                async with engine.begin() as connection:
                    await connection.execute(text(f"SET LOCAL ROLE {role_name}"))
                    await connection.execute(
                        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                        {"tenant_id": str(configured_tenant_id)},
                    )
                    await connection.execute(
                        text(f"INSERT INTO {table_name} (tenant_id) VALUES (:tenant_id)"),
                        {"tenant_id": configured_tenant_id},
                    )
            assert _sqlstate(denied.value) == "42501"

        for _ in range(2):
            await database_bootstrap._deny_implicit_future_permissions(settings)
            await database_bootstrap._grant_runtime_permissions(settings)
            await database_bootstrap._grant_transcription_permissions(settings)
            await database_bootstrap._grant_translation_permissions(settings)
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
                await _role_column_privileges(connection, RUNTIME_ROLE) == runtime_column_expected
            )
            assert (
                await _role_table_privileges(connection, WORKER_ROLE),
                await _role_column_privileges(connection, WORKER_ROLE),
            ) == worker_snapshot
            assert await _role_table_privileges(connection, TRANSLATION_ROLE) == set()
            assert await _role_column_privileges(connection, TRANSLATION_ROLE) == set()
            assert (
                await _role_table_privileges(connection, RECONCILER_ROLE),
                await _role_column_privileges(connection, RECONCILER_ROLE),
            ) == reconciler_snapshot
            for role_name in application_roles:
                expected_connectivity = role_name != TRANSLATION_ROLE
                assert (
                    bool(
                        await connection.scalar(
                            text(
                                "SELECT has_database_privilege("
                                ":role_name, current_database(), 'CONNECT')"
                            ),
                            {"role_name": role_name},
                        )
                    )
                    is expected_connectivity
                )
                assert not await connection.scalar(
                    text(
                        "SELECT has_database_privilege(:role_name, current_database(), 'TEMPORARY')"
                    ),
                    {"role_name": role_name},
                )
                assert (
                    bool(
                        await connection.scalar(
                            text("SELECT has_schema_privilege(:role_name, 'public', 'USAGE')"),
                            {"role_name": role_name},
                        )
                    )
                    is expected_connectivity
                )
                assert not await connection.scalar(
                    text("SELECT has_schema_privilege(:role_name, 'public', 'CREATE')"),
                    {"role_name": role_name},
                )
                assert await _role_sequence_privileges(connection, role_name) == set()
                assert await _role_executable_routines(connection, role_name) == set()
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    assert not await connection.scalar(
                        text(
                            "SELECT has_table_privilege("
                            ":role_name, 'public.external_session_terminal_events', :privilege)"
                        ),
                        {"role_name": role_name, "privilege": privilege},
                    )
            for table_name in (
                "normalized_source_transcripts",
                "normalized_source_segments",
                "normalized_source_receipt_keys",
            ):
                for privilege in ("UPDATE", "DELETE"):
                    assert not await connection.scalar(
                        text("SELECT has_table_privilege(:role_name, :table_name, :privilege)"),
                        {
                            "role_name": RUNTIME_ROLE,
                            "table_name": f"public.{table_name}",
                            "privilege": privilege,
                        },
                    )
                for role_name in (WORKER_ROLE, TRANSLATION_ROLE, RECONCILER_ROLE):
                    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                        assert not await connection.scalar(
                            text("SELECT has_table_privilege(:role_name, :table_name, :privilege)"),
                            {
                                "role_name": role_name,
                                "table_name": f"public.{table_name}",
                                "privilege": privilege,
                            },
                        )

            sequence_name = await connection.scalar(
                text(
                    "SELECT pg_get_serial_sequence('public.bootstrap_future_privilege_probe', 'id')"
                )
            )
            assert isinstance(sequence_name, str)
            for role_name in application_roles:
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
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(configured_tenant_id)},
            )
            await connection.execute(
                text("DELETE FROM scribe_sessions WHERE id = :id AND tenant_id = :tenant_id"),
                {"id": configured_session_id, "tenant_id": configured_tenant_id},
            )
            await connection.execute(
                text("DELETE FROM scribe_sessions WHERE id = :id AND tenant_id = :tenant_id"),
                {"id": legacy_session_id, "tenant_id": configured_tenant_id},
            )
            await connection.execute(
                text("DELETE FROM consent_records WHERE id = :id AND tenant_id = :tenant_id"),
                {"id": configured_consent_id, "tenant_id": configured_tenant_id},
            )
            await drop_probe_objects_and_roles(connection)
        await engine.dispose()
