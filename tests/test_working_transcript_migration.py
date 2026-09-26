from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from test_derived_translation_evidence_migration import (
    REVIEW_INSERT,
    TRANSLATION_INSERT,
    _review_parameters,
    _seed_source,
    _translation_parameters,
)

pytestmark = pytest.mark.postgres
ROOT = Path(__file__).resolve().parents[1]
WORKING_TABLES = (
    "normalized_working_transcripts",
    "normalized_working_translation_inputs",
    "normalized_working_review_inputs",
    "normalized_working_segments",
    "normalized_working_blockers",
)


async def _set_status(
    connection: AsyncConnection, tenant_id: UUID, session_id: UUID, status: str
) -> None:
    await connection.execute(
        text(
            "UPDATE scribe_sessions SET status = :status "
            "WHERE tenant_id = :tenant_id AND id = :session_id"
        ),
        {"tenant_id": tenant_id, "session_id": session_id, "status": status},
    )


async def _add_translation(
    connection: AsyncConnection,
    tenant_id: UUID,
    session_id: UUID,
    segment_id: UUID,
    *,
    version: int = 1,
    outcome: str = "succeeded",
) -> tuple[UUID, datetime]:
    translation_id = uuid4()
    created_at = await connection.scalar(
        text(TRANSLATION_INSERT),
        _translation_parameters(
            tenant_id,
            session_id,
            segment_id,
            version=version,
            translation_id=translation_id,
            outcome=outcome,
            content="Synthetic English translation." if outcome == "succeeded" else None,
            failure_code=None if outcome == "succeeded" else "adapter_unavailable",
        ),
    )
    return translation_id, created_at


async def _add_review(
    connection: AsyncConnection,
    tenant_id: UUID,
    session_id: UUID,
    segment_id: UUID,
    translation_id: UUID,
    created_at: datetime,
    decision: str,
) -> UUID:
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
            decision=decision,
        ),
    )
    return review_id


async def _publish(
    connection: AsyncConnection,
    tenant_id: UUID,
    session_id: UUID,
    working_id: UUID,
    version: int,
    status: str,
    *,
    corruption: str | None = None,
) -> None:
    values = {"tenant": tenant_id, "session": session_id, "working": working_id, "version": version}
    await connection.execute(
        text(
            """
            UPDATE scribe_sessions SET working_transcript_id = :working,
                current_working_transcript_version = :version, status = :status
            WHERE tenant_id = :tenant AND id = :session
            """
        ),
        {**values, "status": status},
    )
    if corruption != "missing_input":
        await connection.execute(
            text(
                """
                INSERT INTO normalized_working_translation_inputs
                SELECT tenant_id, session_id, :version, source_transcript_version,
                       source_segment_id, source_segment_version,
                       translation_id, translation_version
                FROM normalized_translation_attempts
                WHERE tenant_id = :tenant AND session_id = :session
                  AND source_transcript_version = 1
                """
            ),
            values,
        )
        await connection.execute(
            text(
                """
                INSERT INTO normalized_working_review_inputs
                SELECT tenant_id, session_id, :version, source_transcript_version,
                       source_segment_id, source_segment_version,
                       translation_id, translation_version, review_id
                FROM normalized_translation_reviews
                WHERE tenant_id = :tenant AND session_id = :session
                  AND source_transcript_version = 1
                """
            ),
            values,
        )
    segment_filter = "AND false" if corruption == "missing_segment" else ""
    bad_content = (
        "'Synthetic altered working content.'"
        if corruption == "bad_content"
        else "source.content"
    )
    await connection.execute(
        text(
            f"""
            INSERT INTO normalized_working_segments (
                tenant_id, session_id, working_transcript_version, ordinal,
                source_transcript_version, source_segment_id, source_segment_version,
                source_locale, speaker_id, speaker_role, start_ms, end_ms,
                resolution, content, translation_id, translation_version,
                translation_review_id
            )
            SELECT source.tenant_id, source.session_id, :version, source.ordinal,
                   source.source_transcript_version, source.source_segment_id,
                   source.source_segment_version, source.source_locale, source.speaker_id,
                   source.speaker_role, source.start_ms, source.end_ms,
                   CASE WHEN source.source_locale = 'en-US' THEN 'english_source'
                        WHEN accepted.review_id IS NOT NULL THEN 'spanish_translation'
                        ELSE 'unresolved' END,
                   CASE WHEN source.source_locale = 'en-US' THEN {bad_content}
                        WHEN accepted.review_id IS NOT NULL THEN translation.content END,
                   translation.translation_id, translation.translation_version,
                   accepted.review_id
            FROM normalized_source_segments AS source
            LEFT JOIN normalized_translation_reviews AS accepted
              ON accepted.tenant_id = source.tenant_id
             AND accepted.session_id = source.session_id
             AND accepted.source_transcript_version = source.source_transcript_version
             AND accepted.source_segment_id = source.source_segment_id
             AND accepted.source_segment_version = source.source_segment_version
             AND accepted.decision = 'accepted'
            LEFT JOIN normalized_translation_attempts AS translation
              ON translation.tenant_id = accepted.tenant_id
             AND translation.translation_id = accepted.translation_id
            WHERE source.tenant_id = :tenant AND source.session_id = :session
              AND source.source_transcript_version = 1 {segment_filter}
            """
        ),
        values,
    )
    blocker_offset = 1 if corruption == "gapped_blocker" else 0
    await connection.execute(
        text(
            """
            WITH facts AS (
                SELECT source.*,
                       max(end_ms) OVER (
                           ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ) AS prior_max_end
                FROM normalized_source_segments AS source
                WHERE tenant_id = :tenant AND session_id = :session
                  AND source_transcript_version = 1
            ), unordered AS (
                SELECT ordinal AS source_ordinal, source_segment_id,
                       source_segment_version, 0 AS code_order, 'source_overlap' AS code
                FROM facts WHERE start_ms < prior_max_end
                UNION ALL
                SELECT source.ordinal, source.source_segment_id, source.source_segment_version, 1,
                       CASE WHEN source.source_locale = 'unknown' THEN 'source_locale_unknown'
                            WHEN EXISTS (
                                SELECT 1 FROM normalized_translation_reviews AS review
                                WHERE review.tenant_id = source.tenant_id
                                  AND review.session_id = source.session_id
                                  AND review.source_segment_id = source.source_segment_id
                                  AND review.decision = 'accepted'
                            ) THEN NULL
                            WHEN latest.translation_id IS NULL THEN 'translation_missing'
                            WHEN latest.outcome = 'failed' THEN 'translation_failed'
                            WHEN latest_review.decision = 'rejected'
                                THEN 'translation_retry_required'
                            ELSE 'translation_review_required' END
                FROM facts AS source
                LEFT JOIN LATERAL (
                    SELECT attempt.translation_id, attempt.translation_version,
                           attempt.outcome
                    FROM normalized_translation_attempts AS attempt
                    WHERE attempt.tenant_id = source.tenant_id
                      AND attempt.session_id = source.session_id
                      AND attempt.source_segment_id = source.source_segment_id
                    ORDER BY attempt.translation_version DESC LIMIT 1
                ) AS latest ON true
                LEFT JOIN normalized_translation_reviews AS latest_review
                  ON latest_review.tenant_id = source.tenant_id
                 AND latest_review.translation_id = latest.translation_id
                 AND latest_review.translation_version = latest.translation_version
                WHERE source.source_locale IN ('es-US', 'unknown')
            )
            INSERT INTO normalized_working_blockers
            SELECT :tenant, :session, :version,
                   row_number() OVER (ORDER BY source_ordinal, code_order) - 1 + :offset,
                   1, source_segment_id, source_segment_version, code
            FROM unordered WHERE code IS NOT NULL
            """
        ),
        {**values, "offset": blocker_offset},
    )
    if corruption == "extra_blocker":
        await connection.execute(
            text(
                """
                INSERT INTO normalized_working_blockers
                SELECT :tenant, :session, :version, 0, 1,
                       source_segment_id, source_segment_version, 'translation_missing'
                FROM normalized_source_segments
                WHERE tenant_id = :tenant AND session_id = :session AND ordinal = 0
                """
            ),
            values,
        )
    counts = (
        await connection.execute(
            text(
                """
                SELECT
                    (SELECT count(*) FROM normalized_source_segments
                     WHERE tenant_id = :tenant AND session_id = :session),
                    (SELECT count(*) FROM normalized_working_blockers
                     WHERE tenant_id = :tenant AND session_id = :session
                       AND working_transcript_version = :version),
                    (SELECT count(*) FROM normalized_working_translation_inputs
                     WHERE tenant_id = :tenant AND session_id = :session
                       AND working_transcript_version = :version),
                    (SELECT count(*) FROM normalized_working_review_inputs
                     WHERE tenant_id = :tenant AND session_id = :session
                       AND working_transcript_version = :version),
                    (SELECT COALESCE(sum(char_length(content)), 0)
                     FROM normalized_working_segments
                     WHERE tenant_id = :tenant AND session_id = :session
                       AND working_transcript_version = :version)
                """
            ),
            values,
        )
    ).one()
    await connection.execute(
        text(
            """
            INSERT INTO normalized_working_transcripts (
                tenant_id, session_id, working_transcript_id, working_transcript_version,
                source_transcript_version, schema_version, segment_count, blocker_count,
                translation_input_count, review_input_count,
                total_content_chars, working_fingerprint
            ) VALUES (
                :tenant, :session, :working, :version, 1, '1.0',
                :segments, :blockers, :translations, :reviews, :characters, :fingerprint
            )
            """
        ),
        {
            **values,
            "segments": counts[0],
            "blockers": counts[1],
            "translations": counts[2],
            "reviews": counts[3],
            "characters": counts[4],
            "fingerprint": f"{version:064x}",
        },
    )


@pytest.mark.asyncio
async def test_ready_projection_preserves_exact_selected_and_complete_input_lineage(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id, working_id = uuid4(), uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "translation_pending")
        translation_id, created_at = await _add_translation(
            connection, tenant_id, session_id, segment_id
        )
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "review_required")
        review_id = await _add_review(
            connection, tenant_id, session_id, segment_id, translation_id, created_at, "accepted"
        )
    async with engine.begin() as connection:
        await _publish(connection, tenant_id, session_id, working_id, 1, "transcript_ready")
    async with engine.begin() as connection:
        row = (
            await connection.execute(
                text(
                    """
                    SELECT session.working_transcript_id,
                           session.current_working_transcript_version,
                           working.segment_count, working.blocker_count,
                           working.translation_input_count, working.review_input_count,
                           segment.translation_id, segment.translation_review_id
                    FROM scribe_sessions AS session
                    JOIN normalized_working_transcripts AS working
                      ON working.tenant_id = session.tenant_id
                     AND working.session_id = session.id
                    JOIN normalized_working_segments AS segment
                      ON segment.tenant_id = working.tenant_id
                     AND segment.session_id = working.session_id
                     AND segment.working_transcript_version = working.working_transcript_version
                    WHERE session.tenant_id = :tenant AND session.id = :session
                    """
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one()
        assert row == (working_id, 1, 1, 0, 1, 1, translation_id, review_id)
        for statement, match in (
            ("UPDATE normalized_working_segments SET content = 'Replacement.'", "immutable"),
            ("DELETE FROM normalized_working_transcripts", "requires the purge marker"),
        ):
            savepoint = await connection.begin_nested()
            with pytest.raises(DBAPIError, match=match):
                await connection.execute(text(statement))
            await savepoint.rollback()
    async with engine.begin() as connection:
        pointer = await connection.scalar(
            text(
                "UPDATE scribe_sessions SET status = 'handed_off' "
                "WHERE tenant_id = :tenant AND id = :session "
                "RETURNING current_working_transcript_version"
            ),
            {"tenant": tenant_id, "session": session_id},
        )
        assert pointer == 1
    with pytest.raises(DBAPIError, match="current working projection|live session fence"):
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE scribe_sessions SET current_source_transcript_version = NULL, "
                     "content_purged_at = clock_timestamp() "
                     "WHERE tenant_id = :tenant AND id = :session"),
                {"tenant": tenant_id, "session": session_id},
            )
    await engine.dispose()


@pytest.mark.asyncio
async def test_overlap_and_unknown_have_complete_canonical_blockers(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, _ = await _seed_source(
            connection, tenant_id, locale="en-US", overlap_unknown=True
        )
    async with engine.begin() as connection:
        await _publish(connection, tenant_id, session_id, uuid4(), 1, "quality_blocked")
    async with engine.begin() as connection:
        assert (
            await connection.execute(
                text(
                    "SELECT ordinal, code FROM normalized_working_blockers "
                    "WHERE tenant_id = :tenant AND session_id = :session ORDER BY ordinal"
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).all() == [(0, "source_overlap"), (1, "source_locale_unknown")]
    await engine.dispose()


@pytest.mark.asyncio
async def test_rejected_and_latest_failed_inputs_are_bound_across_versions(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id, working_id = uuid4(), uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "translation_pending")
        translation_id, created_at = await _add_translation(
            connection, tenant_id, session_id, segment_id
        )
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "review_required")
        await _add_review(
            connection, tenant_id, session_id, segment_id, translation_id, created_at, "rejected"
        )
        await _set_status(connection, tenant_id, session_id, "translation_pending")
    async with engine.begin() as connection:
        await _publish(connection, tenant_id, session_id, working_id, 1, "translation_pending")
    with pytest.raises(DBAPIError, match="current working projection omits"):
        async with engine.begin() as connection:
            await _add_translation(
                connection, tenant_id, session_id, segment_id, version=2, outcome="failed"
            )
    async with engine.begin() as connection:
        await _add_translation(
            connection, tenant_id, session_id, segment_id, version=2, outcome="failed"
        )
        await _publish(connection, tenant_id, session_id, working_id, 2, "translation_pending")
    async with engine.begin() as connection:
        row = (
            await connection.execute(
                text(
                    """
                    SELECT translation_input_count, review_input_count,
                           (SELECT array_agg(code ORDER BY working_transcript_version)
                            FROM normalized_working_blockers
                            WHERE tenant_id = :tenant AND session_id = :session)
                    FROM normalized_working_transcripts
                    WHERE tenant_id = :tenant AND session_id = :session
                      AND working_transcript_version = 2
                    """
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one()
        assert row == (2, 1, ["translation_retry_required", "translation_failed"])
        await connection.execute(
            text(
                "INSERT INTO external_session_terminal_events "
                "(tenant_id, session_id, event_id, prior_status, failure_code, "
                "principal_type, principal_id) VALUES (:tenant, :session, :event, "
                "'translation_pending', 'irrecoverable_integrity_failure', "
                "'operator', 'actor_operator')"
            ),
            {"tenant": tenant_id, "session": session_id, "event": uuid4()},
        )
        pointer = await connection.scalar(
            text(
                "UPDATE scribe_sessions SET status = 'failed' "
                "WHERE tenant_id = :tenant AND id = :session "
                "RETURNING current_working_transcript_version"
            ),
            {"tenant": tenant_id, "session": session_id},
        )
        assert pointer == 2
    await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("corruption", "status"),
    [
        ("missing_segment", "transcript_ready"),
        ("bad_content", "transcript_ready"),
        ("extra_blocker", "quality_blocked"),
        ("gapped_blocker", "quality_blocked"),
    ],
)
async def test_incomplete_or_forged_projection_fails(
    postgres_urls: tuple[str, str], corruption: str, status: str
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        if corruption == "gapped_blocker":
            session_id, _ = await _seed_source(
                connection, tenant_id, locale="en-US", overlap_unknown=True
            )
        else:
            session_id, _ = await _seed_source(connection, tenant_id, locale="en-US")
    with pytest.raises(DBAPIError, match="aggregate|lineage|blocker|readiness"):
        async with engine.begin() as connection:
            await _publish(
                connection, tenant_id, session_id, uuid4(), 1, status, corruption=corruption
            )
    await engine.dispose()


@pytest.mark.asyncio
async def test_missing_membership_and_version_gap_fail(postgres_urls: tuple[str, str]) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id, working_id = uuid4(), uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "translation_pending")
        await _add_translation(connection, tenant_id, session_id, segment_id)
    with pytest.raises(DBAPIError, match="aggregate"):
        async with engine.begin() as connection:
            await _publish(
                connection,
                tenant_id,
                session_id,
                working_id,
                1,
                "review_required",
                corruption="missing_input",
            )
    async with engine.begin() as connection:
        await _publish(connection, tenant_id, session_id, working_id, 1, "review_required")
    with pytest.raises(DBAPIError, match="working header is outside"):
        async with engine.begin() as connection:
            await _publish(connection, tenant_id, session_id, working_id, 3, "review_required")
    await engine.dispose()


@pytest.mark.asyncio
async def test_database_clock_and_purge_remove_every_working_artifact(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    expiring_tenant = uuid4()
    async with engine.begin() as connection:
        expiring_session, _ = await _seed_source(
            connection, expiring_tenant, locale="en-US", lifetime=timedelta(seconds=1)
        )
    connection = await engine.connect()
    transaction = await connection.begin()
    try:
        await _publish(
            connection, expiring_tenant, expiring_session, uuid4(), 1, "transcript_ready"
        )
        await connection.execute(text("SELECT pg_sleep(1.1)"))
        with pytest.raises(DBAPIError, match="outside the live current fence"):
            await connection.execute(
                text("SET CONSTRAINTS normalized_working_transcripts_complete IMMEDIATE")
            )
    finally:
        if transaction.is_active:
            await transaction.rollback()
        await connection.close()

    late_tenant = uuid4()
    async with engine.begin() as connection:
        late_session, _ = await _seed_source(
            connection, late_tenant, locale="en-US", lifetime=timedelta(seconds=2)
        )
    async with engine.begin() as connection:
        await _publish(connection, late_tenant, late_session, uuid4(), 1, "transcript_ready")
    async with engine.begin() as connection:
        await _set_status(connection, late_tenant, late_session, "handed_off")
    with pytest.raises(DBAPIError, match="expired versioned external|live session fence"):
        async with engine.begin() as connection:
            await connection.execute(text("SELECT pg_sleep(2.1)"))
            await connection.execute(
                text("UPDATE scribe_sessions SET status = status "
                     "WHERE tenant_id = :tenant AND id = :session"),
                {"tenant": late_tenant, "session": late_session},
            )

    tenant_id, working_id = uuid4(), uuid4()
    async with engine.begin() as connection:
        session_id, _ = await _seed_source(connection, tenant_id)
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "translation_pending")
        await _publish(connection, tenant_id, session_id, working_id, 1, "translation_pending")
    async with engine.begin() as connection:
        await connection.execute(
            text(
                """
                INSERT INTO external_session_terminal_events (
                    tenant_id, session_id, event_id, prior_status, failure_code,
                    principal_type, principal_id
                ) VALUES (
                    :tenant, :session, :event, 'translation_pending',
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
                SET current_source_transcript_version = NULL,
                    current_working_transcript_version = NULL,
                    content_purged_at = clock_timestamp(), status = 'failed'
                WHERE tenant_id = :tenant AND id = :session
                """
            ),
            {"tenant": tenant_id, "session": session_id},
        )
        await connection.execute(
            text(
                """
                DELETE FROM normalized_source_transcripts
                WHERE tenant_id = :tenant AND session_id = :session
                """
            ),
            {"tenant": tenant_id, "session": session_id},
        )
    async with engine.begin() as connection:
        for table in WORKING_TABLES:
            assert await connection.scalar(
                text(f"SELECT count(*) FROM {table} WHERE tenant_id = :tenant"),
                {"tenant": tenant_id},
            ) == 0
        assert (
            await connection.execute(
                text(
                    "SELECT working_transcript_id, current_working_transcript_version "
                    "FROM scribe_sessions WHERE tenant_id = :tenant AND id = :session"
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one() == (working_id, None)
    await engine.dispose()


@pytest.mark.asyncio
async def test_working_tables_force_rls_and_have_no_new_grants(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    async with engine.begin() as connection:
        isolation = (
            await connection.execute(
                text(
                    "SELECT relname, relrowsecurity, relforcerowsecurity "
                    "FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace "
                    "AND relname = ANY(:tables)"
                ),
                {"tables": list(WORKING_TABLES)},
            )
        ).all()
        assert set(isolation) == {(table, True, True) for table in WORKING_TABLES}
        assert (
            await connection.execute(
                text(
                    "SELECT table_name FROM information_schema.role_table_grants "
                    "WHERE table_schema = 'public' AND table_name = ANY(:tables) "
                    "AND grantee = 'PUBLIC'"
                ),
                {"tables": list(WORKING_TABLES)},
            )
        ).all() == []
    await engine.dispose()
    migration = (ROOT / "alembic/versions/0013_working_transcript_storage.py").read_text()
    bootstrap = (ROOT / "services/api/src/cosmaneura_scribe/database_bootstrap.py").read_text()
    assert "GRANT " not in migration
    assert "derived_writer_database_permissions_enabled" in bootstrap
    assert "_grant_working_transcript_permissions" in bootstrap


def test_working_transcript_storage_is_the_only_alembic_head() -> None:
    script = ScriptDirectory.from_config(Config("alembic.ini"))
    assert len(script.get_heads()) == 1
    assert "0013" in {item.revision for item in script.walk_revisions()}
    migration = (ROOT / "alembic/versions/0013_working_transcript_storage.py").read_text()
    assert "current_database() !~ '_test$'" in migration
    assert "CREATE ROLE" not in migration
