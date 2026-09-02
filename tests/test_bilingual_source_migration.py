from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]

ROOT = Path(__file__).resolve().parents[1]
NEW_TABLES = (
    "external_session_terminal_events",
    "normalized_source_transcripts",
    "normalized_source_segments",
    "normalized_source_receipt_keys",
)


async def _reject(
    connection: AsyncConnection,
    statement: str,
    parameters: dict[str, object],
    match: str,
) -> None:
    savepoint = await connection.begin_nested()
    with pytest.raises(DBAPIError, match=match):
        await connection.execute(text(statement), parameters)
    await savepoint.rollback()


async def _check_edges(
    connection: AsyncConnection,
    session_id: UUID,
    allowed: tuple[str, ...],
    blocked: tuple[str, ...],
) -> None:
    statement = "UPDATE scribe_sessions SET status = :status WHERE id = :id"
    for status in allowed:
        savepoint = await connection.begin_nested()
        await connection.execute(text(statement), {"status": status, "id": session_id})
        await savepoint.rollback()
    for status in blocked:
        await _reject(connection, statement, {"status": status, "id": session_id}, "invalid scribe")


async def _seed_consent(connection: AsyncConnection, tenant_id: UUID) -> UUID:
    consent_id = uuid4()
    await connection.execute(
        text(
            """
            INSERT INTO consent_records (
                id, tenant_id, appointment_id, practitioner_id, patient_id,
                modality, participant_regions, method, all_parties_consented,
                granted_at, policy_version
            ) VALUES (
                :id, :tenant_id, 'synthetic-appointment', 'synthetic-practitioner',
                'synthetic-patient', 'virtual', ARRAY['FL'], 'pre_visit_form', true,
                statement_timestamp(), 'synthetic-policy-v1'
            )
            """
        ),
        {"id": consent_id, "tenant_id": tenant_id},
    )
    return consent_id


async def _seed_session(
    connection: AsyncConnection,
    tenant_id: UUID,
    consent_id: UUID,
    *,
    configured: bool,
    ingest_mode: str = "external_async_transcript",
    language_mode: str = "en-US+es-US",
    status: str = "created",
) -> UUID:
    session_id = uuid4()
    configuration: dict[str, str | None] = {
        "contract": "1.0",
        "creator": "actor_synthetic_creator",
        "language": language_mode,
        "adapter": "stt_adapter_v1",
        "model": "stt_model_v1",
        "normalizer": "normalizer_v1",
    }
    if not configured:
        configuration = dict.fromkeys(configuration)
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
                :id, :tenant_id, 'synthetic-appointment', 'synthetic-practitioner',
                'synthetic-patient', :consent_id, 'virtual', :status, :ingest_mode,
                :contract, :creator, :language, :adapter, :model, :normalizer
            )
            """
        ),
        {
            "id": session_id,
            "tenant_id": tenant_id,
            "consent_id": consent_id,
            "status": status,
            "ingest_mode": ingest_mode,
            **configuration,
        },
    )
    return session_id


async def _begin_source(
    connection: AsyncConnection,
    tenant_id: UUID,
    session_id: UUID,
    *,
    lifetime: timedelta = timedelta(days=13),
) -> tuple[object, object]:
    row = (
        await connection.execute(
            text(
                """
                UPDATE scribe_sessions
                SET status = 'source_received',
                    source_received_at = TIMESTAMPTZ '2000-01-01 00:00:00+00',
                    transcript_content_expires_at = statement_timestamp() + :lifetime,
                    current_source_transcript_version = 1
                WHERE tenant_id = :tenant_id AND id = :session_id
                RETURNING source_received_at, transcript_content_expires_at
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id, "lifetime": lifetime},
        )
    ).one()
    return row.source_received_at, row.transcript_content_expires_at


async def _insert_source(
    connection: AsyncConnection,
    tenant_id: UUID,
    session_id: UUID,
    received_at: object,
    expires_at: object,
    *,
    content: str = "Synthetic bilingual source text.",
    locale: str = "es-US",
    fingerprint: str = "a" * 64,
    key: str = "synthetic-source-key-0001",
    declared_segment_count: int = 1,
    declared_content_chars: int | None = None,
    version: int = 1,
) -> UUID:
    receipt_id = uuid4()
    await connection.execute(
        text(
            """
            INSERT INTO normalized_source_transcripts (
                tenant_id, session_id, source_transcript_version, source_receipt_id,
                schema_version, language_mode, transcription_adapter_id,
                transcription_model_profile_id, normalization_profile_id,
                duration_ms, segment_count, total_content_chars, request_fingerprint,
                received_at, transcript_content_expires_at
            ) VALUES (
                :tenant_id, :session_id, :version, :receipt_id, '1.0', 'en-US+es-US',
                'stt_adapter_v1', 'stt_model_v1', 'normalizer_v1',
                1000, :segment_count, :content_length, :fingerprint, :received_at, :expires_at
            )
            """
        ),
        {
            "tenant_id": tenant_id,
            "session_id": session_id,
            "receipt_id": receipt_id,
            "version": version,
            "segment_count": declared_segment_count,
            "content_length": declared_content_chars or len(content),
            "fingerprint": fingerprint,
            "received_at": received_at,
            "expires_at": expires_at,
        },
    )
    await connection.execute(
        text(
            """
            INSERT INTO normalized_source_segments (
                tenant_id, session_id, source_transcript_version, ordinal,
                source_segment_id, source_segment_version, source_locale, speaker_id,
                speaker_role, content, start_ms, end_ms, locale_confidence
            ) VALUES (
                :tenant_id, :session_id, :version, 0, :segment_id, 1, :locale,
                :speaker_id, 'patient', :content, 0, 1000, 0.95
            )
            """
        ),
        {
            "tenant_id": tenant_id,
            "session_id": session_id,
            "segment_id": uuid4(),
            "version": version,
            "speaker_id": uuid4(),
            "locale": locale,
            "content": content,
        },
    )
    await connection.execute(
        text(
            """
            INSERT INTO normalized_source_receipt_keys (
                tenant_id, session_id, idempotency_key,
                source_transcript_version, request_fingerprint
            ) VALUES (:tenant_id, :session_id, :key, :version, :fingerprint)
            """
        ),
        {
            "tenant_id": tenant_id,
            "session_id": session_id,
            "key": key,
            "version": version,
            "fingerprint": fingerprint,
        },
    )
    return receipt_id


async def test_configuration_is_all_or_none_external_and_insert_only(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        consent_id = await _seed_consent(connection, tenant_id)
        legacy_id = await _seed_session(connection, tenant_id, consent_id, configured=False)
        fields = (
            await connection.execute(
                text(
                    """
                    SELECT transcript_contract_version, creator_actor_id, language_mode,
                           transcription_adapter_id, transcription_model_profile_id,
                           normalization_profile_id
                    FROM scribe_sessions WHERE tenant_id = :tenant AND id = :session
                    """
                ),
                {"tenant": tenant_id, "session": legacy_id},
            )
        ).one()
        assert all(value is None for value in fields)

        await _reject(
            connection,
            """
            INSERT INTO scribe_sessions (
                id, tenant_id, appointment_id, practitioner_id, patient_id,
                consent_record_id, modality, status, ingest_mode,
                transcript_contract_version
            ) VALUES (
                :id, :tenant, 'synthetic-appointment', 'synthetic-practitioner',
                'synthetic-patient', :consent, 'virtual', 'created',
                'external_async_transcript', '1.0'
            )
            """,
            {"id": uuid4(), "tenant": tenant_id, "consent": consent_id},
            "scribe_sessions_external_configuration_check",
        )
        await _reject(
            connection,
            "UPDATE scribe_sessions SET status = 'source_received' WHERE id = :id",
            {"id": legacy_id},
            "scribe_sessions_external_status_scope_check|invalid scribe session",
        )

        configured_id = await _seed_session(connection, tenant_id, consent_id, configured=True)
        await _reject(
            connection,
            "UPDATE scribe_sessions SET status = 'source_received' WHERE id = :id",
            {"id": configured_id},
            "scribe_sessions_external_lifecycle_check",
        )
        await _reject(
            connection,
            "UPDATE scribe_sessions SET creator_actor_id = 'actor_changed' WHERE id = :id",
            {"id": configured_id},
            "configuration is immutable",
        )
        await _reject(
            connection,
            "UPDATE scribe_sessions SET status = 'transcript_ready' WHERE id = :id",
            {"id": configured_id},
            "invalid scribe session status transition",
        )
    await engine.dispose()


async def test_correction_can_return_to_an_older_noncurrent_fingerprint(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        consent_id = await _seed_consent(connection, tenant_id)
        session_id = await _seed_session(connection, tenant_id, consent_id, configured=True)
        received_at, expires_at = await _begin_source(connection, tenant_id, session_id)
        await _insert_source(
            connection,
            tenant_id,
            session_id,
            received_at,
            expires_at,
            fingerprint="a" * 64,
            key="source-version-key-0001",
        )
    for version, fingerprint, prior_status, allowed, blocked in (
        (
            2,
            "b" * 64,
            "quality_blocked",
            ("quality_blocked",),
            ("translation_pending", "review_required", "transcript_ready", "handed_off"),
        ),
        (
            3,
            "a" * 64,
            "transcript_ready",
            ("transcript_ready", "handed_off"),
            ("translation_pending", "review_required", "quality_blocked", "uploaded"),
        ),
    ):
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE scribe_sessions SET status = :status WHERE id = :id"),
                {"status": prior_status, "id": session_id},
            )
            await _check_edges(connection, session_id, allowed, blocked)
        async with engine.begin() as connection:
            received_at = await connection.scalar(
                text(
                    """
                    UPDATE scribe_sessions
                    SET status = 'source_received',
                        current_source_transcript_version = :version
                    WHERE tenant_id = :tenant AND id = :session
                    RETURNING clock_timestamp()
                    """
                ),
                {"version": version, "tenant": tenant_id, "session": session_id},
            )
            await _insert_source(
                connection,
                tenant_id,
                session_id,
                received_at,
                expires_at,
                fingerprint=fingerprint,
                key=f"source-version-key-{version:04d}",
                version=version,
            )
    async with engine.begin() as connection:
        for status in ("transcript_ready", "handed_off"):
            await connection.execute(
                text("UPDATE scribe_sessions SET status = :status WHERE id = :id"),
                {"status": status, "id": session_id},
            )
        await _check_edges(
            connection,
            session_id,
            ("handed_off",),
            ("source_received", "translation_pending", "review_required", "failed", "uploaded"),
        )
        assert (
            await connection.scalar(
                text(
                    "SELECT count(*) FROM normalized_source_transcripts "
                    "WHERE tenant_id = :tenant AND session_id = :session"
                ),
                {"tenant": tenant_id, "session": session_id},
            )
            == 3
        )
    await engine.dispose()


async def test_versioned_state_graph_and_terminal_evidence_are_discriminated(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        consent_id = await _seed_consent(connection, tenant_id)
        legacy_id = await _seed_session(connection, tenant_id, consent_id, configured=False)
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'transcript_ready' WHERE id = :id"),
            {"id": legacy_id},
        )

        session_id = await _seed_session(connection, tenant_id, consent_id, configured=True)
        received_at, expires_at = await _begin_source(connection, tenant_id, session_id)
        await _insert_source(connection, tenant_id, session_id, received_at, expires_at)
    async with engine.begin() as connection:
        await _check_edges(
            connection,
            session_id,
            ("source_received", "translation_pending", "quality_blocked", "transcript_ready"),
            ("created", "capturing", "uploaded", "processing", "review_required", "handed_off"),
        )
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'translation_pending' WHERE id = :id"),
            {"id": session_id},
        )
        await _check_edges(
            connection,
            session_id,
            ("translation_pending", "review_required"),
            ("quality_blocked", "transcript_ready", "handed_off", "uploaded"),
        )
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'review_required' WHERE id = :id"),
            {"id": session_id},
        )
        await _check_edges(
            connection,
            session_id,
            ("review_required", "translation_pending", "transcript_ready"),
            ("quality_blocked", "handed_off", "uploaded"),
        )
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'translation_pending' WHERE id = :id"),
            {"id": session_id},
        )
        await _reject(
            connection,
            "UPDATE scribe_sessions SET status = 'source_received' WHERE id = :id",
            {"id": session_id},
            "corrected source requires the next source version",
        )
        await _reject(
            connection,
            "UPDATE scribe_sessions SET status = 'failed' WHERE id = :id",
            {"id": session_id},
            "invalid scribe session status transition",
        )
        await connection.execute(
            text(
                """
                INSERT INTO external_session_terminal_events (
                    tenant_id, session_id, event_id, prior_status, failure_code,
                    principal_type, principal_id
                ) VALUES (
                    :tenant, :session, :event, 'translation_pending',
                    'irrecoverable_integrity_failure', 'operator', 'actor_operator'
                )
                """
            ),
            {"tenant": tenant_id, "session": session_id, "event": uuid4()},
        )
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'failed' WHERE id = :id"),
            {"id": session_id},
        )
        await _reject(
            connection,
            "UPDATE scribe_sessions SET status = 'uploaded' WHERE id = :id",
            {"id": session_id},
            "invalid scribe session status transition",
        )
        await _reject(
            connection,
            """
            INSERT INTO normalized_source_receipt_keys (
                tenant_id, session_id, idempotency_key,
                source_transcript_version, request_fingerprint
            ) VALUES (:tenant, :session, 'post-failure-key-0001', 1, :fingerprint)
            """,
            {"tenant": tenant_id, "session": session_id, "fingerprint": "a" * 64},
            "outside the live session fence",
        )
        await _reject(
            connection,
            "DELETE FROM external_session_terminal_events WHERE session_id = :id",
            {"id": session_id},
            "normalized source evidence is immutable",
        )
    await engine.dispose()


async def test_source_is_immutable_purge_cascades_content_and_retains_tombstone(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        consent_id = await _seed_consent(connection, tenant_id)
        session_id = await _seed_session(connection, tenant_id, consent_id, configured=True)
        received_at, expires_at = await _begin_source(connection, tenant_id, session_id)
        receipt_id = await _insert_source(
            connection, tenant_id, session_id, received_at, expires_at
        )
        await connection.execute(
            text(
                """
                SET CONSTRAINTS
                    normalized_source_transcripts_complete,
                    normalized_source_transcripts_precommit_fence,
                    normalized_source_receipt_keys_precommit_fence
                IMMEDIATE
                """
            )
        )
        receipt = (
            await connection.execute(
                text(
                    """
                    SELECT source_receipt_id, source_transcript_version, received_at,
                           transcript_content_expires_at
                    FROM normalized_source_transcripts
                    WHERE tenant_id = :tenant AND session_id = :session
                    """
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one()
        assert receipt == (receipt_id, 1, received_at, expires_at)

        await _reject(
            connection,
            """
            UPDATE normalized_source_segments SET content = 'Synthetic replacement.'
            WHERE tenant_id = :tenant AND session_id = :session
            """,
            {"tenant": tenant_id, "session": session_id},
            "normalized source evidence is immutable",
        )
        await _reject(
            connection,
            "DELETE FROM normalized_source_transcripts "
            "WHERE tenant_id = :tenant AND session_id = :session",
            {"tenant": tenant_id, "session": session_id},
            "deletion requires the purge marker",
        )

        await connection.execute(
            text(
                """
                INSERT INTO external_session_terminal_events (
                    tenant_id, session_id, event_id, prior_status, failure_code,
                    principal_type, principal_id
                ) VALUES (
                    :tenant, :session, :event, 'source_received',
                    'retention_expired_before_handoff', 'system', 'retention_worker_v1'
                )
                """
            ),
            {"tenant": tenant_id, "session": session_id, "event": uuid4()},
        )
        await connection.execute(
            text(
                """
                UPDATE scribe_sessions
                SET status = 'failed',
                    content_purged_at = TIMESTAMPTZ '2000-01-01 00:00:00+00',
                    current_source_transcript_version = NULL
                WHERE tenant_id = :tenant AND id = :session
                """
            ),
            {"tenant": tenant_id, "session": session_id},
        )
        await _reject(
            connection,
            "SET CONSTRAINTS scribe_sessions_external_precommit IMMEDIATE",
            {},
            "completed purge cannot retain normalized source content",
        )
        await _reject(
            connection,
            """
            INSERT INTO normalized_source_receipt_keys (
                tenant_id, session_id, idempotency_key,
                source_transcript_version, request_fingerprint
            ) VALUES (:tenant, :session, 'post-purge-key-0001', 1, :fingerprint)
            """,
            {"tenant": tenant_id, "session": session_id, "fingerprint": "a" * 64},
            "outside the live session fence",
        )
        await connection.execute(
            text(
                "DELETE FROM normalized_source_transcripts "
                "WHERE tenant_id = :tenant AND session_id = :session"
            ),
            {"tenant": tenant_id, "session": session_id},
        )
        for table in (
            "normalized_source_transcripts",
            "normalized_source_segments",
            "normalized_source_receipt_keys",
        ):
            count = await connection.scalar(
                text(f"SELECT count(*) FROM {table} WHERE tenant_id = :tenant"),
                {"tenant": tenant_id},
            )
            assert count == 0
        tombstone = (
            await connection.execute(
                text(
                    """
                    SELECT source_received_at, transcript_content_expires_at,
                           content_purged_at, current_source_transcript_version, status
                    FROM scribe_sessions WHERE tenant_id = :tenant AND id = :session
                    """
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one()
        assert tombstone.source_received_at == received_at
        assert tombstone.transcript_content_expires_at == expires_at
        assert tombstone.content_purged_at is not None
        assert tombstone.current_source_transcript_version is None
        assert tombstone.status == "failed"
    await engine.dispose()


async def test_aggregate_bounds_and_tenant_rls_are_database_enforced(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, app_url = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    with pytest.raises(DBAPIError, match="expired versioned external session cannot commit"):
        async with engine.begin() as connection:
            expiring_tenant = uuid4()
            consent_id = await _seed_consent(connection, expiring_tenant)
            session_id = await _seed_session(
                connection, expiring_tenant, consent_id, configured=True
            )
            received_at, expires_at = await _begin_source(
                connection, expiring_tenant, session_id, lifetime=timedelta(seconds=1)
            )
            await _insert_source(connection, expiring_tenant, session_id, received_at, expires_at)
            await connection.execute(text("SELECT pg_sleep(1.1)"))
    with pytest.raises(DBAPIError, match="scribe_sessions_current_source_transcript_fkey"):
        async with engine.begin() as connection:
            orphan_tenant = uuid4()
            consent_id = await _seed_consent(connection, orphan_tenant)
            session_id = await _seed_session(connection, orphan_tenant, consent_id, configured=True)
            await _begin_source(connection, orphan_tenant, session_id)
    with pytest.raises(DBAPIError, match="aggregate is incomplete or out of bounds"):
        async with engine.begin() as connection:
            bad_tenant = uuid4()
            consent_id = await _seed_consent(connection, bad_tenant)
            session_id = await _seed_session(connection, bad_tenant, consent_id, configured=True)
            received_at, expires_at = await _begin_source(connection, bad_tenant, session_id)
            await _insert_source(
                connection,
                bad_tenant,
                session_id,
                received_at,
                expires_at,
                declared_segment_count=2,
            )
            await _reject(
                connection,
                """
                INSERT INTO normalized_source_segments (
                    tenant_id, session_id, source_transcript_version, ordinal,
                    source_segment_id, source_segment_version, source_locale, speaker_id,
                    speaker_role, content, start_ms, end_ms, locale_confidence
                ) SELECT tenant_id, session_id, source_transcript_version, 1,
                    source_segment_id, 2, source_locale, speaker_id, speaker_role,
                    content, start_ms, end_ms, locale_confidence
                FROM normalized_source_segments
                WHERE tenant_id = :tenant AND session_id = :session
                """,
                {"tenant": bad_tenant, "session": session_id},
                "duplicate key value violates unique constraint",
            )

    tenant_ids = (uuid4(), uuid4())
    session_ids: list[UUID] = []
    for index, tenant_id in enumerate(tenant_ids):
        async with engine.begin() as connection:
            consent_id = await _seed_consent(connection, tenant_id)
            session_id = await _seed_session(connection, tenant_id, consent_id, configured=True)
            received_at, expires_at = await _begin_source(connection, tenant_id, session_id)
            await _insert_source(
                connection,
                tenant_id,
                session_id,
                received_at,
                expires_at,
                fingerprint=f"{index + 1}" * 64,
                key=f"synthetic-source-key-{index:04d}",
            )
            session_ids.append(session_id)

    app_engine = create_async_engine(app_url, connect_args={"ssl": False})
    async with app_engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant, true)"),
            {"tenant": str(tenant_ids[0])},
        )
        visible = await connection.scalar(
            text("SELECT count(*) FROM normalized_source_transcripts")
        )
        assert visible == 1
        assert (
            await connection.scalar(
                text(
                    "SELECT count(*) FROM normalized_source_transcripts "
                    "WHERE session_id = :other_session"
                ),
                {"other_session": session_ids[1]},
            )
            == 0
        )
    await app_engine.dispose()

    migration = (ROOT / "alembic/versions/0009_bilingual_source_storage.py").read_text()
    bootstrap = (ROOT / "services/api/src/cosmaneura_scribe/database_bootstrap.py").read_text()
    assert "GRANT " not in migration
    assert "external_session_terminal_events" not in bootstrap
    assert all(table in bootstrap for table in NEW_TABLES[1:])
    async with engine.begin() as connection:
        assert not await connection.scalar(
            text(
                "SELECT has_function_privilege("
                "'public', 'enforce_normalized_source_header()', 'EXECUTE')"
            )
        )
    await engine.dispose()
