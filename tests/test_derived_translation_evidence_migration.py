from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

pytestmark = pytest.mark.postgres

ROOT = Path(__file__).resolve().parents[1]
DERIVED_TABLES = (
    "normalized_translation_attempts",
    "normalized_translation_reviews",
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


async def _seed_source(
    connection: AsyncConnection,
    tenant_id: UUID,
    *,
    locale: str = "es-US",
    lifetime: timedelta = timedelta(days=13),
    overlap_unknown: bool = False,
) -> tuple[UUID, UUID]:
    consent_id = uuid4()
    session_id = uuid4()
    segment_id = uuid4()
    receipt_id = uuid4()
    fingerprint = uuid4().hex + uuid4().hex
    content = f"Synthetic {locale} source content."
    unknown_content = "Synthetic unknown source."
    unknown_row = (
        ", (:tenant_id, :session_id, 1, 1, :unknown_segment_id, 1, 'unknown', "
        ":unknown_speaker_id, 'patient', :unknown_content, 500, 900, 0.40)"
        if overlap_unknown
        else ""
    )
    await connection.execute(
        text(
            """
            INSERT INTO consent_records (
                id, tenant_id, appointment_id, practitioner_id, patient_id,
                modality, participant_regions, method, all_parties_consented,
                granted_at, policy_version
            ) VALUES (
                :consent_id, :tenant_id, 'derived-appointment',
                'derived-practitioner', 'derived-patient', 'virtual', ARRAY['FL'],
                'pre_visit_form', true, statement_timestamp(), 'derived-policy-v1'
            )
            """
        ),
        {"consent_id": consent_id, "tenant_id": tenant_id},
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
                :session_id, :tenant_id, 'derived-appointment',
                'derived-practitioner', 'derived-patient', :consent_id,
                'virtual', 'created', 'external_async_transcript',
                '1.0', 'actor_derived_creator', 'en-US+es-US',
                'stt_adapter_v1', 'stt_model_v1', 'normalizer_v1'
            )
            """
        ),
        {
            "session_id": session_id,
            "tenant_id": tenant_id,
            "consent_id": consent_id,
        },
    )
    lifecycle = (
        await connection.execute(
            text(
                """
                UPDATE scribe_sessions
                SET status = 'source_received',
                    source_received_at = clock_timestamp(),
                    transcript_content_expires_at = clock_timestamp() + :lifetime,
                    current_source_transcript_version = 1
                WHERE tenant_id = :tenant_id AND id = :session_id
                RETURNING source_received_at, transcript_content_expires_at
                """
            ),
            {
                "tenant_id": tenant_id,
                "session_id": session_id,
                "lifetime": lifetime,
            },
        )
    ).one()
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
                :tenant_id, :session_id, 1, :receipt_id, '1.0', 'en-US+es-US',
                'stt_adapter_v1', 'stt_model_v1', 'normalizer_v1', 1000, :segment_count,
                :content_length, :fingerprint, :received_at, :expires_at
            )
            """
        ),
        {
            "tenant_id": tenant_id,
            "session_id": session_id,
            "receipt_id": receipt_id,
            "segment_count": 2 if overlap_unknown else 1,
            "content_length": len(content) + (len(unknown_content) if overlap_unknown else 0),
            "fingerprint": fingerprint,
            "received_at": lifecycle.source_received_at,
            "expires_at": lifecycle.transcript_content_expires_at,
        },
    )
    await connection.execute(
        text(
            f"""
            INSERT INTO normalized_source_segments (
                tenant_id, session_id, source_transcript_version, ordinal,
                source_segment_id, source_segment_version, source_locale,
                speaker_id, speaker_role, content, start_ms, end_ms,
                locale_confidence
            ) VALUES (
                :tenant_id, :session_id, 1, 0, :segment_id, 1, :locale,
                :speaker_id, 'patient', :content, 0, 1000, 0.99
            ){unknown_row}
            """
        ),
        {
            "tenant_id": tenant_id,
            "session_id": session_id,
            "segment_id": segment_id,
            "speaker_id": uuid4(),
            "unknown_segment_id": uuid4(),
            "unknown_speaker_id": uuid4(),
            "unknown_content": unknown_content,
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
            ) VALUES (
                :tenant_id, :session_id, :key, 1, :fingerprint
            )
            """
        ),
        {
            "tenant_id": tenant_id,
            "session_id": session_id,
            "key": f"derived-source-{uuid4()}",
            "fingerprint": fingerprint,
        },
    )
    return session_id, segment_id


async def _move_to_translation_pending(
    engine: AsyncEngine,
    tenant_id: UUID,
    session_id: UUID,
) -> None:
    async with engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
            {"tenant_id": str(tenant_id)},
        )
        await connection.execute(
            text(
                """
                UPDATE scribe_sessions SET status = 'translation_pending'
                WHERE tenant_id = :tenant_id AND id = :session_id
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id},
        )


def _translation_parameters(
    tenant_id: UUID,
    session_id: UUID,
    segment_id: UUID,
    *,
    version: int,
    translation_id: UUID | None = None,
    outcome: str = "succeeded",
    content: str | None = "Synthetic English translation.",
    failure_code: str | None = None,
) -> dict[str, object]:
    return {
        "tenant_id": tenant_id,
        "session_id": session_id,
        "segment_id": segment_id,
        "translation_id": translation_id or uuid4(),
        "version": version,
        "outcome": outcome,
        "content": content,
        "failure_code": failure_code,
    }


TRANSLATION_INSERT = """
    INSERT INTO normalized_translation_attempts (
        tenant_id, session_id, source_transcript_version,
        source_segment_id, source_segment_version,
        translation_id, translation_version, source_locale, target_locale,
        outcome, content, failure_code,
        translation_adapter_id, translation_model_profile_id, created_at
    ) VALUES (
        :tenant_id, :session_id, 1, :segment_id, 1,
        :translation_id, :version, 'es-US', 'en-US',
        :outcome, :content, :failure_code,
        'translation_adapter_v1', 'translation_model_v1',
        TIMESTAMPTZ '2000-01-01 00:00:00+00'
    )
    RETURNING created_at
"""


def _review_parameters(
    tenant_id: UUID,
    session_id: UUID,
    segment_id: UUID,
    translation_id: UUID,
    reviewed_at: datetime,
    *,
    translation_version: int = 1,
    review_id: UUID | None = None,
    decision: str = "accepted",
    reviewer_actor_id: str = "actor_derived_creator",
) -> dict[str, object]:
    return {
        "tenant_id": tenant_id,
        "session_id": session_id,
        "segment_id": segment_id,
        "translation_id": translation_id,
        "translation_version": translation_version,
        "review_id": review_id or uuid4(),
        "decision": decision,
        "reviewer_actor_id": reviewer_actor_id,
        "reviewed_at": reviewed_at,
    }


REVIEW_INSERT = """
    INSERT INTO normalized_translation_reviews (
        tenant_id, session_id, source_transcript_version,
        source_segment_id, source_segment_version,
        translation_id, translation_version, review_id,
        decision, reviewer_actor_id, reviewed_at
    ) VALUES (
        :tenant_id, :session_id, 1, :segment_id, 1,
        :translation_id, :translation_version, :review_id,
        :decision, :reviewer_actor_id, :reviewed_at
    )
"""


@pytest.mark.asyncio
async def test_translation_attempts_are_exact_immutable_monotonic_evidence(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    await _move_to_translation_pending(engine, tenant_id, session_id)

    first_id, second_id = uuid4(), uuid4()
    async with engine.begin() as connection:
        first_created = await connection.scalar(
            text(TRANSLATION_INSERT),
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=1,
                translation_id=first_id,
            ),
        )
        second_created = await connection.scalar(
            text(TRANSLATION_INSERT),
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=2,
                translation_id=second_id,
                outcome="failed",
                content=None,
                failure_code="provider_unavailable",
            ),
        )
        assert first_created > datetime(2020, 1, 1, tzinfo=UTC)
        assert second_created >= first_created
        await _reject(
            connection,
            TRANSLATION_INSERT,
            _translation_parameters(tenant_id, session_id, segment_id, version=4),
            "translation attempt version is not monotonic",
        )
        await _reject(
            connection,
            """
            UPDATE normalized_translation_attempts SET content = 'Synthetic replacement.'
            WHERE tenant_id = :tenant_id AND translation_id = :translation_id
            """,
            {"tenant_id": tenant_id, "translation_id": first_id},
            "normalized derived evidence is immutable",
        )
        rows = (
            await connection.execute(
                text(
                    """
                    SELECT translation_id, translation_version, outcome, content, failure_code
                    FROM normalized_translation_attempts
                    WHERE tenant_id = :tenant_id AND session_id = :session_id
                    ORDER BY translation_version
                    """
                ),
                {"tenant_id": tenant_id, "session_id": session_id},
            )
        ).all()
        assert rows == [
            (first_id, 1, "succeeded", "Synthetic English translation.", None),
            (second_id, 2, "failed", None, "provider_unavailable"),
        ]
    await engine.dispose()


@pytest.mark.asyncio
async def test_translation_constraints_reject_invalid_or_stale_evidence(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    await _move_to_translation_pending(engine, tenant_id, session_id)

    async with engine.begin() as connection:
        for parameters in (
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=1,
                outcome="succeeded",
                content=None,
            ),
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=1,
                outcome="failed",
                content="Synthetic forbidden content.",
                failure_code="provider_unavailable",
            ),
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=1,
                outcome="failed",
                content=None,
                failure_code=None,
            ),
        ):
            await _reject(connection, TRANSLATION_INSERT, parameters, "ck_translation_result")
        await _reject(
            connection,
            TRANSLATION_INSERT.replace("'es-US', 'en-US'", "'en-US', 'es-US'"),
            _translation_parameters(tenant_id, session_id, segment_id, version=1),
            "current Spanish source|ck_translation_locale_direction",
        )
        await _reject(
            connection,
            TRANSLATION_INSERT,
            _translation_parameters(
                tenant_id,
                session_id,
                uuid4(),
                version=1,
            ),
            "current Spanish source",
        )

    english_tenant = uuid4()
    async with engine.begin() as connection:
        english_session, english_segment = await _seed_source(
            connection,
            english_tenant,
            locale="en-US",
        )
    await _move_to_translation_pending(engine, english_tenant, english_session)
    async with engine.begin() as connection:
        await _reject(
            connection,
            TRANSLATION_INSERT,
            _translation_parameters(
                english_tenant,
                english_session,
                english_segment,
                version=1,
            ),
            "current Spanish source",
        )
    await engine.dispose()


@pytest.mark.asyncio
async def test_creator_review_is_exact_terminal_and_one_acceptance_wins(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    await _move_to_translation_pending(engine, tenant_id, session_id)

    first_id, second_id, failed_id = uuid4(), uuid4(), uuid4()
    async with engine.begin() as connection:
        first_created = await connection.scalar(
            text(TRANSLATION_INSERT),
            _translation_parameters(
                tenant_id, session_id, segment_id, version=1, translation_id=first_id
            ),
        )
        await connection.execute(
            text(TRANSLATION_INSERT),
            _translation_parameters(
                tenant_id, session_id, segment_id, version=2, translation_id=second_id
            ),
        )
        failed_created = await connection.scalar(
            text(TRANSLATION_INSERT),
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=3,
                translation_id=failed_id,
                outcome="failed",
                content=None,
                failure_code="provider_unavailable",
            ),
        )
    review_id = uuid4()
    reviewed_at = first_created + timedelta(seconds=1)
    async with engine.begin() as connection:
        await connection.execute(
            text(
                """
                UPDATE scribe_sessions SET status = 'review_required'
                WHERE tenant_id = :tenant_id AND id = :session_id
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id},
        )
        await _reject(
            connection,
            REVIEW_INSERT,
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                failed_id,
                failed_created + timedelta(seconds=1),
                translation_version=3,
                decision="rejected",
            ),
            "successful current evidence",
        )
        await _reject(
            connection,
            REVIEW_INSERT,
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                second_id,
                first_created - timedelta(seconds=1),
                translation_version=2,
                decision="rejected",
            ),
            "successful current evidence",
        )
        parameters = _review_parameters(
            tenant_id,
            session_id,
            segment_id,
            first_id,
            reviewed_at,
            review_id=review_id,
        )
        await connection.execute(text(REVIEW_INSERT), parameters)
        await _reject(
            connection,
            REVIEW_INSERT,
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                first_id,
                reviewed_at,
                review_id=uuid4(),
            ),
            "uq_translation_terminal_review",
        )
        await _reject(
            connection,
            REVIEW_INSERT,
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                second_id,
                reviewed_at,
                translation_version=2,
            ),
            "uq_translation_review_accepted_source",
        )
        await _reject(
            connection,
            REVIEW_INSERT,
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                second_id,
                reviewed_at,
                translation_version=2,
                decision="rejected",
                reviewer_actor_id="actor_not_creator",
            ),
            "creator session fence",
        )
        stored = (
            await connection.execute(
                text(
                    """
                    SELECT review_id, decision, reviewer_actor_id, reviewed_at
                    FROM normalized_translation_reviews
                    WHERE tenant_id = :tenant_id AND review_id = :review_id
                    """
                ),
                {"tenant_id": tenant_id, "review_id": review_id},
            )
        ).one()
        assert stored == (
            review_id,
            "accepted",
            "actor_derived_creator",
            reviewed_at,
        )
    async with engine.begin() as connection:
        await _reject(
            connection,
            REVIEW_INSERT,
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                second_id,
                reviewed_at,
                translation_version=2,
                decision="rejected",
            ),
            "accepted translation review is terminal",
        )
    async with engine.begin() as connection:
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'translation_pending' WHERE id = :id"),
            {"id": session_id},
        )
        await _reject(
            connection,
            TRANSLATION_INSERT,
            _translation_parameters(tenant_id, session_id, segment_id, version=4),
            "accepted translation cannot be replaced",
        )
    await engine.dispose()


@pytest.mark.asyncio
async def test_rejected_review_requires_retryable_translation_state(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    await _move_to_translation_pending(engine, tenant_id, session_id)
    translation_id = uuid4()
    async with engine.begin() as connection:
        created_at = await connection.scalar(
            text(TRANSLATION_INSERT),
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=1,
                translation_id=translation_id,
            ),
        )
    async with engine.begin() as connection:
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'review_required' WHERE id = :session_id"),
            {"session_id": session_id},
        )
        await connection.execute(
            text(REVIEW_INSERT),
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                translation_id,
                created_at,
                decision="rejected",
            ),
        )
        await connection.execute(
            text(
                "UPDATE scribe_sessions SET status = 'translation_pending' "
                "WHERE id = :session_id"
            ),
            {"session_id": session_id},
        )
    async with engine.begin() as connection:
        assert await connection.scalar(
            text(
                """
                SELECT decision FROM normalized_translation_reviews
                WHERE tenant_id = :tenant_id AND translation_id = :translation_id
                """
            ),
            {"tenant_id": tenant_id, "translation_id": translation_id},
        ) == "rejected"
    await engine.dispose()


@pytest.mark.asyncio
async def test_purge_marker_is_the_only_content_delete_path(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    await _move_to_translation_pending(engine, tenant_id, session_id)
    translation_id = uuid4()
    async with engine.begin() as connection:
        created_at = await connection.scalar(
            text(TRANSLATION_INSERT),
            _translation_parameters(
                tenant_id,
                session_id,
                segment_id,
                version=1,
                translation_id=translation_id,
            ),
        )
        await _reject(
            connection,
            "DELETE FROM normalized_translation_attempts WHERE translation_id = :id",
            {"id": translation_id},
            "normalized derived deletion requires the purge marker",
        )
    async with engine.begin() as connection:
        await connection.execute(
            text("UPDATE scribe_sessions SET status = 'review_required' WHERE id = :session_id"),
            {"session_id": session_id},
        )
        review_id = uuid4()
        await connection.execute(
            text(REVIEW_INSERT),
            _review_parameters(
                tenant_id,
                session_id,
                segment_id,
                translation_id,
                created_at,
                review_id=review_id,
            ),
        )
        await _reject(
            connection,
            "UPDATE normalized_translation_reviews SET decision = 'rejected' WHERE review_id = :id",
            {"id": review_id},
            "normalized derived evidence is immutable",
        )
    async with engine.begin() as connection:
        await connection.execute(
            text(
                """
                INSERT INTO external_session_terminal_events (
                    tenant_id, session_id, event_id, prior_status, failure_code,
                    principal_type, principal_id
                ) VALUES (
                    :tenant_id, :session_id, :event_id, 'review_required',
                    'retention_expired_before_handoff', 'system', 'retention_worker_v1'
                )
                """
            ),
            {
                "tenant_id": tenant_id,
                "session_id": session_id,
                "event_id": uuid4(),
            },
        )
        await connection.execute(
            text(
                """
                UPDATE scribe_sessions
                SET current_source_transcript_version = NULL,
                    content_purged_at = clock_timestamp(),
                    status = 'failed'
                WHERE tenant_id = :tenant_id AND id = :session_id
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id},
        )
        await connection.execute(
            text(
                """
                DELETE FROM normalized_source_transcripts
                WHERE tenant_id = :tenant_id AND session_id = :session_id
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id},
        )
    async with engine.begin() as connection:
        for table in (
            "normalized_source_transcripts",
            "normalized_source_segments",
            *DERIVED_TABLES,
        ):
            assert await connection.scalar(
                text(f"SELECT count(*) FROM {table} WHERE tenant_id = :tenant_id"),
                {"tenant_id": tenant_id},
            ) == 0
        await _reject(
            connection,
            TRANSLATION_INSERT,
            _translation_parameters(tenant_id, session_id, segment_id, version=2),
            "outside the live session fence",
        )
    await engine.dispose()


@pytest.mark.asyncio
async def test_deferred_database_clock_rejects_late_translation_commit(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(
            connection,
            tenant_id,
            lifetime=timedelta(seconds=2),
        )
    await _move_to_translation_pending(engine, tenant_id, session_id)

    connection = await engine.connect()
    transaction = await connection.begin()
    try:
        await connection.execute(
            text(TRANSLATION_INSERT),
            _translation_parameters(tenant_id, session_id, segment_id, version=1),
        )
        await connection.execute(text("SELECT pg_sleep(2.1)"))
        with pytest.raises(DBAPIError, match="translation attempt commit is outside"):
            await transaction.commit()
    finally:
        if transaction.is_active:
            await transaction.rollback()
        await connection.close()
    async with engine.begin() as connection:
        assert await connection.scalar(
            text(
                """
                SELECT count(*) FROM normalized_translation_attempts
                WHERE tenant_id = :tenant_id AND session_id = :session_id
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id},
        ) == 0
    await engine.dispose()


@pytest.mark.asyncio
async def test_derived_tables_force_tenant_rls_and_receive_no_runtime_grant(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, app_url = postgres_urls
    admin = create_async_engine(admin_url, connect_args={"ssl": False})
    records: list[tuple[UUID, UUID]] = []
    for tenant_id in (uuid4(), uuid4()):
        async with admin.begin() as connection:
            session_id, segment_id = await _seed_source(connection, tenant_id)
        await _move_to_translation_pending(admin, tenant_id, session_id)
        translation_id = uuid4()
        async with admin.begin() as connection:
            await connection.execute(
                text(TRANSLATION_INSERT),
                _translation_parameters(
                    tenant_id,
                    session_id,
                    segment_id,
                    version=1,
                    translation_id=translation_id,
                ),
            )
        records.append((tenant_id, translation_id))

    async with admin.begin() as connection:
        isolation = (
            await connection.execute(
                text(
                    """
                    SELECT relname, relrowsecurity, relforcerowsecurity
                    FROM pg_catalog.pg_class
                    WHERE relnamespace = 'public'::regnamespace
                      AND relname = ANY(:tables)
                    """
                ),
                {"tables": list(DERIVED_TABLES)},
            )
        ).all()
        assert set(isolation) == {(table, True, True) for table in DERIVED_TABLES}
        public_grants = (
            await connection.execute(
                text(
                    """
                    SELECT table_name, privilege_type
                    FROM information_schema.role_table_grants
                    WHERE table_schema = 'public'
                      AND table_name = ANY(:tables)
                      AND grantee = 'PUBLIC'
                    """
                ),
                {"tables": list(DERIVED_TABLES)},
            )
        ).all()
        assert public_grants == []
        for function in (
            "enforce_normalized_translation_attempt()",
            "enforce_normalized_translation_review()",
            "enforce_normalized_derived_delete_fence()",
        ):
            assert not await connection.scalar(
                text("SELECT has_function_privilege('public', :function, 'EXECUTE')"),
                {"function": f"public.{function}"},
            )
    await admin.dispose()

    app = create_async_engine(app_url, connect_args={"ssl": False})
    async with app.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
            {"tenant_id": str(records[0][0])},
        )
        assert await connection.scalar(
            text("SELECT count(*) FROM normalized_translation_attempts")
        ) == 1
        assert await connection.scalar(
            text(
                """
                SELECT count(*) FROM normalized_translation_attempts
                WHERE translation_id = :translation_id
                """
            ),
            {"translation_id": records[1][1]},
        ) == 0
    await app.dispose()

    migration = (ROOT / "alembic/versions/0012_derived_translation_evidence.py").read_text()
    bootstrap = (ROOT / "services/api/src/cosmaneura_scribe/database_bootstrap.py").read_text()
    assert "GRANT " not in migration
    assert "derived_writer_database_permissions_enabled" in bootstrap
    assert "_grant_translation_permissions" in bootstrap


def test_derived_translation_evidence_is_the_only_alembic_head() -> None:
    script = ScriptDirectory.from_config(Config("alembic.ini"))
    assert script.get_heads() == ["0019_captured_bilingual"]
    migration = (ROOT / "alembic/versions/0012_derived_translation_evidence.py").read_text()
    assert "current_database() !~ '_test$'" in migration
    assert "CREATE ROLE" not in migration
