from __future__ import annotations

# Reuse the existing synthetic SQL fixture helpers, not application-private APIs.
# pyright: reportPrivateUsage=false
from collections.abc import AsyncIterator
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from conftest import APP_ROLE
from cosmaneura_scribe.postgres_repository import PostgresRepository
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, create_async_engine
from test_bilingual_source_migration import _begin_source, _reject, _seed_consent, _seed_session
from test_derived_translation_evidence_migration import REVIEW_INSERT, _review_parameters
from test_normalized_source_authority import _legacy_root_inserts
from test_working_transcript_migration import _add_review, _add_translation, _publish, _set_status

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]
REVISION = "0019_captured_bilingual"
CAPTURE_INSERT = """
    INSERT INTO scribe_sessions (
        id, tenant_id, appointment_id, practitioner_id, patient_id, consent_record_id,
        modality, status, ingest_mode, transcript_contract_version, creator_actor_id,
        language_mode, transcription_adapter_id, transcription_model_profile_id,
        normalization_profile_id
    ) VALUES (
        :id, :tenant, 'synthetic-appointment', 'synthetic-practitioner',
        'synthetic-patient', :consent, 'virtual', :status, 'chunk_upload', '1.0',
        'actor_derived_creator', :language, :adapter, :model, :normalizer
    )
"""


@pytest_asyncio.fixture
async def database(
    postgres_urls: tuple[str, str],
) -> AsyncIterator[tuple[AsyncConnection, UUID, UUID]]:
    engine = create_async_engine(postgres_urls[0], connect_args={"ssl": False})
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                tenant = uuid4()
                consent = await _seed_consent(connection, tenant)
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant, true)"),
                    {"tenant": str(tenant)},
                )
                yield connection, tenant, consent
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


def _capture_parameters(tenant: UUID, consent: UUID) -> dict[str, object]:
    return {
        "id": uuid4(),
        "tenant": tenant,
        "consent": consent,
        "status": "created",
        "language": "en-US+es-US",
        "adapter": "azure_ai_speech",
        "model": "azure_fast_transcription_en_es_v1",
        "normalizer": "azure_phrase_en_es_evidence_v1",
    }


async def _capture(connection: AsyncConnection, tenant: UUID, consent: UUID) -> UUID:
    parameters = _capture_parameters(tenant, consent)
    await connection.execute(text(CAPTURE_INSERT), parameters)
    assert isinstance(parameters["id"], UUID)
    return parameters["id"]


async def _force(connection: AsyncConnection) -> None:
    await connection.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await connection.execute(text("SET CONSTRAINTS ALL DEFERRED"))


async def _source(
    connection: AsyncConnection, tenant: UUID, session: UUID, *, locale: str = "es-US"
) -> UUID:
    for status in ("capturing", "uploaded", "processing"):
        await _set_status(connection, tenant, session, status)
    await _begin_source(connection, tenant, session)
    segment = uuid4()
    values = {
        "tenant": tenant,
        "session": session,
        "receipt": uuid4(),
        "segment": segment,
        "speaker": uuid4(),
        "locale": locale,
        "content": "No tengo fiebre.",
    }
    await connection.execute(
        text("""
        INSERT INTO normalized_source_transcripts (
            tenant_id, session_id, source_transcript_version, source_receipt_id,
            schema_version, language_mode, transcription_adapter_id,
            transcription_model_profile_id, normalization_profile_id, duration_ms,
            segment_count, total_content_chars, request_fingerprint, received_at,
            transcript_content_expires_at
        ) SELECT tenant_id, id, 1, :receipt, transcript_contract_version, language_mode,
            transcription_adapter_id, transcription_model_profile_id, normalization_profile_id,
            1000, 1, char_length(:content), repeat('a', 64), source_received_at,
            transcript_content_expires_at
          FROM scribe_sessions WHERE tenant_id = :tenant AND id = :session
    """),
        values,
    )
    await connection.execute(
        text("""
        INSERT INTO normalized_source_segments (
            tenant_id, session_id, source_transcript_version, ordinal, source_segment_id,
            source_segment_version, source_locale, speaker_id, speaker_role, content,
            start_ms, end_ms, locale_confidence
        ) VALUES (:tenant, :session, 1, 0, :segment, 1, :locale, :speaker, 'unknown',
                  :content, 0, 1000, NULL)
    """),
        values,
    )
    await connection.execute(
        text("""
        INSERT INTO normalized_source_receipt_keys (
            tenant_id, session_id, idempotency_key, source_transcript_version, request_fingerprint
        ) VALUES (:tenant, :session, 'synthetic-captured-source-1', 1, repeat('a', 64))
    """),
        values,
    )
    await _force(connection)
    return segment


async def _migrate(connection: AsyncConnection, direction: str) -> None:
    revision = ScriptDirectory.from_config(Config("alembic.ini")).get_revision(REVISION)
    assert revision is not None

    def run(sync: Connection) -> None:
        with Operations.context(MigrationContext.configure(sync)):
            getattr(revision.module, direction)()

    await connection.run_sync(run)


@pytest.mark.parametrize(
    "field,value",
    [
        ("status", "capturing"),
        ("status", "processing"),
        ("language", "es-US"),
        ("adapter", "core_normalized_source_v1"),
        ("model", "external_transcript_micro_beta_v1"),
        ("normalizer", "en_es_us_locale_normalization_v1"),
        ("adapter", None),
    ],
)
async def test_capture_requires_complete_admitted_profile_and_created_insert(
    database: tuple[AsyncConnection, UUID, UUID],
    field: str,
    value: str | None,
) -> None:
    connection, tenant, consent = database
    parameters = _capture_parameters(tenant, consent)
    parameters[field] = value
    await _reject(connection, CAPTURE_INSERT, parameters, "must start|configuration|check")


async def test_capture_states_do_not_admit_source_shortcuts_or_modify_existing_ingest(
    database: tuple[AsyncConnection, UUID, UUID],
) -> None:
    connection, tenant, consent = database
    session = await _capture(connection, tenant, consent)
    for state in ("created", "capturing", "uploaded"):
        await _set_status(connection, tenant, session, state)
        savepoint = await connection.begin_nested()
        with pytest.raises(DBAPIError, match="invalid scribe session status transition"):
            await _begin_source(connection, tenant, session)
        await savepoint.rollback()
        for shortcut in ("transcript_ready", "handed_off", "failed"):
            await _reject(
                connection,
                "UPDATE scribe_sessions SET status = :status WHERE id = :id",
                {"status": shortcut, "id": session},
                "invalid scribe session status transition",
            )
    for column, value in (
        ("creator_actor_id", "actor_other"),
        ("language_mode", "en-US"),
        ("transcription_adapter_id", "other"),
        ("normalization_profile_id", "other"),
        ("transcription_model_profile_id", "other"),
        ("ingest_mode", "external_async_transcript"),
    ):
        await _reject(
            connection,
            f"UPDATE scribe_sessions SET {column} = :value WHERE id = :id",
            {"value": value, "id": session},
            "immutable",
        )
    external = await _seed_session(connection, tenant, consent, configured=True)
    await _reject(
        connection,
        "UPDATE scribe_sessions SET status = 'capturing' WHERE id = :id",
        {"id": external},
        "invalid scribe session status transition",
    )
    legacy = await _seed_session(
        connection, tenant, consent, configured=False, ingest_mode="chunk_upload"
    )
    await _reject(
        connection,
        "UPDATE scribe_sessions SET transcript_contract_version = '1.0' WHERE id = :id",
        {"id": legacy},
        "configuration is immutable",
    )


async def test_only_audio_and_job_roots_are_admitted_and_legacy_readers_remain_dormant(
    database: tuple[AsyncConnection, UUID, UUID],
) -> None:
    connection, tenant, consent = database
    session = await _capture(connection, tenant, consent)
    await connection.execute(text(f"SET LOCAL ROLE {APP_ROLE}"))
    for table, statement, parameters in _legacy_root_inserts(tenant, session):
        if table in {"transcripts", "transcript_deliveries"}:
            await _reject(connection, statement, parameters, "legacy child root")
        else:
            await connection.execute(text(statement), parameters)
            assert (
                await connection.scalar(
                    text(
                        f"SELECT count(*) FROM {table} "
                        "WHERE tenant_id = :tenant AND session_id = :session"
                    ),
                    {"tenant": tenant, "session": session},
                )
                == 1
            )
    await _force(connection)
    async with AsyncSession(bind=connection, join_transaction_mode="create_savepoint") as sql:
        repository = PostgresRepository(sql)
        assert await repository.get_session(tenant, session) is None
        assert await repository.get_versioned_external_session(tenant, session) is None
        assert await repository.transcript_for(tenant, session) is None


async def test_captured_spanish_source_requires_creator_review_for_ready_projection(
    database: tuple[AsyncConnection, UUID, UUID],
) -> None:
    connection, tenant, consent = database
    session = await _capture(connection, tenant, consent)
    await connection.execute(text(f"SET LOCAL ROLE {APP_ROLE}"))
    segment = await _source(connection, tenant, session)
    working = uuid4()
    await _publish(connection, tenant, session, working, 1, "translation_pending")
    await _force(connection)
    translation, created_at = await _add_translation(connection, tenant, session, segment)
    await _publish(connection, tenant, session, working, 2, "review_required")
    await _force(connection)
    premature = await connection.begin_nested()
    with pytest.raises(DBAPIError):
        await _publish(connection, tenant, session, working, 3, "transcript_ready")
        await _force(connection)
    await premature.rollback()
    await _reject(
        connection,
        REVIEW_INSERT,
        _review_parameters(
            tenant, session, segment, translation, created_at, reviewer_actor_id="actor_other"
        ),
        "creator session fence",
    )
    await _add_review(connection, tenant, session, segment, translation, created_at, "accepted")
    await _publish(connection, tenant, session, working, 3, "transcript_ready")
    await _force(connection)
    row = (
        await connection.execute(
            text("""
        SELECT session.ingest_mode, source.transcription_adapter_id,
               source.normalization_profile_id, segment.source_locale, segment.content,
               segment.speaker_role, working.content, working.resolution
        FROM scribe_sessions AS session
        JOIN normalized_source_transcripts AS source ON source.tenant_id = session.tenant_id
            AND source.session_id = session.id
        JOIN normalized_source_segments AS segment ON segment.tenant_id = session.tenant_id
            AND segment.session_id = session.id
        JOIN normalized_working_segments AS working ON working.tenant_id = session.tenant_id
            AND working.session_id = session.id AND working.working_transcript_version = 3
        WHERE session.tenant_id = :tenant AND session.id = :session
    """),
            {"tenant": tenant, "session": session},
        )
    ).one()
    assert tuple(row) == (
        "chunk_upload",
        "azure_ai_speech",
        "azure_phrase_en_es_evidence_v1",
        "es-US",
        "No tengo fiebre.",
        "unknown",
        "Synthetic English translation.",
        "spanish_translation",
    )
    await _set_status(connection, tenant, session, "handed_off")
    await _force(connection)
    await _reject(
        connection,
        "UPDATE normalized_source_segments SET content = 'changed' WHERE session_id = :id",
        {"id": session},
        "immutable",
    )


@pytest.mark.parametrize("prior", ["created", "capturing", "uploaded", "processing"])
async def test_capture_failure_requires_attributable_terminal_evidence(
    database: tuple[AsyncConnection, UUID, UUID],
    prior: str,
) -> None:
    connection, tenant, consent = database
    session = await _capture(connection, tenant, consent)
    for status in ("created", "capturing", "uploaded", "processing"):
        await _set_status(connection, tenant, session, status)
        if status == prior:
            break
    await connection.execute(
        text("""
        INSERT INTO external_session_terminal_events (
            tenant_id, session_id, event_id, prior_status, failure_code,
            principal_type, principal_id
        ) VALUES (:tenant, :session, :event, :prior, 'synthetic_failure',
                  'system', 'capture_worker_v1')
    """),
        {"tenant": tenant, "session": session, "event": uuid4(), "prior": prior},
    )
    await _set_status(connection, tenant, session, "failed")
    await _force(connection)
    await _reject(
        connection,
        "UPDATE scribe_sessions SET status = 'uploaded' WHERE id = :id",
        {"id": session},
        "invalid scribe session status transition",
    )


async def test_configured_capture_is_hidden_from_other_tenants(
    database: tuple[AsyncConnection, UUID, UUID],
) -> None:
    connection, tenant, consent = database
    session = await _capture(connection, tenant, consent)
    await connection.execute(text(f"SET LOCAL ROLE {APP_ROLE}"))
    await connection.execute(
        text("SELECT set_config('app.tenant_id', :tenant, true)"), {"tenant": str(uuid4())}
    )
    assert (
        await connection.scalar(
            text("SELECT count(*) FROM scribe_sessions WHERE id = :id"), {"id": session}
        )
        == 0
    )
    statement, parameters = next(
        (sql, args)
        for table, sql, args in _legacy_root_inserts(tenant, session)
        if table == "session_audio_keys"
    )
    await _reject(connection, statement, parameters, "legacy child root|row-level security")


@pytest.mark.parametrize(
    "condition",
    [
        "valid",
        "revoked",
        "wrong_tenant",
        "unknown_locale",
        "wrong_source",
        "wrong_expiry",
    ],
)
async def test_captured_encrypted_job_keeps_consent_source_tenant_and_retention_fences(
    database: tuple[AsyncConnection, UUID, UUID],
    condition: str,
) -> None:
    connection, tenant, consent = database
    session = await _capture(connection, tenant, consent)
    await connection.execute(text(f"SET LOCAL ROLE {APP_ROLE}"))
    segment = await _source(
        connection, tenant, session, locale="unknown" if condition == "unknown_locale" else "es-US"
    )
    if condition == "revoked":
        await connection.execute(
            text("UPDATE consent_records SET revoked_at = clock_timestamp() WHERE id = :id"),
            {"id": consent},
        )
    statement = text("""
        INSERT INTO encrypted_translation_jobs (
            tenant_id, session_id, translation_id, source_transcript_version,
            source_segment_id, source_segment_version, previous_translation_version,
            status, reserved_at, expires_at, key_version, wrapped_dek, nonce, ciphertext
        ) SELECT :job_tenant, id, :translation, :version, :segment, 1, 0, 'reserved',
            clock_timestamp(), transcript_content_expires_at + make_interval(secs => :offset),
            'synthetic_key', repeat('A', 512), decode(repeat('aa', 12), 'hex'),
            decode(repeat('aa', 17), 'hex')
          FROM scribe_sessions WHERE tenant_id = :tenant AND id = :session
    """)
    parameters = {
        "tenant": tenant,
        "session": session,
        "translation": uuid4(),
        "segment": segment,
        "job_tenant": uuid4() if condition == "wrong_tenant" else tenant,
        "version": 2 if condition == "wrong_source" else 1,
        "offset": 1 if condition == "wrong_expiry" else 0,
    }
    if condition == "valid":
        await connection.execute(statement, parameters)
        await _force(connection)
        assert (
            await connection.scalar(
                text("SELECT count(*) FROM encrypted_translation_jobs WHERE session_id = :id"),
                {"id": session},
            )
            == 1
        )
    else:
        savepoint = await connection.begin_nested()
        with pytest.raises(DBAPIError, match="fence|row-level security|foreign key"):
            await connection.execute(statement, parameters)
            await _force(connection)
        await savepoint.rollback()
        assert (
            await connection.scalar(
                text("SELECT count(*) FROM encrypted_translation_jobs WHERE session_id = :id"),
                {"id": session},
            )
            == 0
        )


async def _snapshot(connection: AsyncConnection) -> tuple[object, ...]:
    # Only invented local rows. Compare hashes in memory; do not print source content.
    data: list[object] = []
    tables = (
        (
            await connection.execute(
                text("""
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    """)
            )
        )
        .scalars()
        .all()
    )
    for table in tables:
        quoted = connection.dialect.identifier_preparer.quote(table)
        data.append(
            (
                table,
                (
                    await connection.execute(
                        text(
                            f"SELECT count(*), md5(string_agg(row_to_json(row)::text, '' "
                            f"ORDER BY row_to_json(row)::text)) FROM public.{quoted} AS row"
                        )
                    )
                ).one(),
            )
        )
    privileges = (
        await connection.execute(
            text("""
        SELECT relname, relacl::text, relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relnamespace = 'public'::regnamespace ORDER BY relname
    """)
        )
    ).all()
    functions = (
        await connection.execute(
            text("""
        SELECT proname, proacl::text, prosecdef
        FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname
    """)
        )
    ).all()
    return tuple(data), tuple(privileges), tuple(functions)


async def test_unused_migration_preserves_legacy_rows_privileges_and_replays_exactly(
    database: tuple[AsyncConnection, UUID, UUID],
) -> None:
    connection, tenant, consent = database
    await _force(connection)
    await _migrate(connection, "downgrade")
    legacy = await _seed_session(
        connection, tenant, consent, configured=False, ingest_mode="chunk_upload"
    )
    await _seed_session(connection, tenant, consent, configured=True)
    for _, statement, parameters in _legacy_root_inserts(tenant, legacy):
        await connection.execute(text(statement), parameters)
    await _force(connection)
    prior = await _snapshot(connection)
    await _migrate(connection, "upgrade")
    assert await _snapshot(connection) == prior
    upgraded_bodies = (
        await connection.execute(
            text("""
        SELECT proname, prosrc FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace ORDER BY proname
    """)
        )
    ).all()
    await _migrate(connection, "downgrade")
    assert await _snapshot(connection) == prior
    await _reject(
        connection,
        CAPTURE_INSERT,
        _capture_parameters(tenant, consent),
        "external_configuration_check",
    )
    await _migrate(connection, "upgrade")
    assert (
        await connection.execute(
            text("""
        SELECT proname, prosrc FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace ORDER BY proname
    """)
        )
    ).all() == upgraded_bodies


async def test_used_capture_refuses_downgrade_and_retains_all_data(
    database: tuple[AsyncConnection, UUID, UUID],
) -> None:
    connection, tenant, consent = database
    await _capture(connection, tenant, consent)
    await _force(connection)
    before = await _snapshot(connection)
    savepoint = await connection.begin_nested()
    with pytest.raises(DBAPIError, match="refusing captured bilingual downgrade after use"):
        await _migrate(connection, "downgrade")
    await savepoint.rollback()
    assert await _snapshot(connection) == before
