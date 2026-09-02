"""Harden dormant derived and working projection trigger reads.

Revision ID: 0014
Revises: 0013

Recovery deliberately retains these narrower, schema-shape-safe function definitions. A
downgrade to 0013 changes only the Alembic revision marker; the functions remain compatible
with 0013 and are replaced idempotently if 0014 is applied again. Restoring the broad-read
definitions would reintroduce an unnecessary privilege and schema-shape dependency.
"""

from __future__ import annotations

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None

LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'"
STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '60s'"

PROJECTION_TABLES = (
    "scribe_sessions",
    "normalized_source_transcripts",
    "normalized_source_segments",
    "normalized_translation_attempts",
    "normalized_translation_reviews",
    "normalized_working_transcripts",
    "normalized_working_translation_inputs",
    "normalized_working_review_inputs",
    "normalized_working_segments",
    "normalized_working_blockers",
)

HARDENED_FUNCTIONS = (
    "enforce_normalized_translation_attempt",
    "enforce_normalized_translation_review",
    "enforce_working_child_insert",
    "enforce_working_header_insert",
    "enforce_working_transcript_complete",
)


def _lock_projection_tables() -> None:
    op.execute(
        "LOCK TABLE "
        + ", ".join(f"public.{table}" for table in PROJECTION_TABLES)
        + " IN ACCESS EXCLUSIVE MODE"
    )


def _replace_hardened_functions() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.enforce_normalized_translation_attempt()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_contract text;
            session_ingest text;
            session_source_version integer;
            session_expiry timestamptz;
            session_purged_at timestamptz;
            session_status text;
            persisted_source_locale varchar(16);
            next_translation_version integer;
        BEGIN
            SELECT transcript_contract_version, ingest_mode,
                   current_source_transcript_version, transcript_content_expires_at,
                   content_purged_at, status
            INTO session_contract, session_ingest, session_source_version,
                 session_expiry, session_purged_at, session_status
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;

            IF NOT FOUND
               OR session_contract IS DISTINCT FROM '1.0'
               OR session_ingest IS DISTINCT FROM 'external_async_transcript'
               OR session_source_version IS DISTINCT FROM NEW.source_transcript_version
               OR session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR session_status IS DISTINCT FROM 'translation_pending' THEN
                RAISE EXCEPTION 'translation attempt is outside the live session fence'
                    USING ERRCODE = '23514';
            END IF;

            SELECT source_locale INTO persisted_source_locale
            FROM public.normalized_source_segments
            WHERE tenant_id = NEW.tenant_id
              AND session_id = NEW.session_id
              AND source_transcript_version = NEW.source_transcript_version
              AND source_segment_id = NEW.source_segment_id
              AND source_segment_version = NEW.source_segment_version;
            IF NOT FOUND
               OR persisted_source_locale IS DISTINCT FROM 'es-US'
               OR NEW.source_locale IS DISTINCT FROM persisted_source_locale
               OR NEW.target_locale IS DISTINCT FROM 'en-US' THEN
                RAISE EXCEPTION 'translation attempt does not match a current Spanish source'
                    USING ERRCODE = '23514';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM public.normalized_translation_reviews
                WHERE tenant_id = NEW.tenant_id
                  AND session_id = NEW.session_id
                  AND source_transcript_version = NEW.source_transcript_version
                  AND source_segment_id = NEW.source_segment_id
                  AND source_segment_version = NEW.source_segment_version
                  AND decision = 'accepted'
            ) THEN
                RAISE EXCEPTION 'accepted translation cannot be replaced for this source'
                    USING ERRCODE = '23514';
            END IF;

            SELECT COALESCE(max(translation_version), 0) + 1
            INTO next_translation_version
            FROM public.normalized_translation_attempts
            WHERE tenant_id = NEW.tenant_id
              AND session_id = NEW.session_id
              AND source_transcript_version = NEW.source_transcript_version
              AND source_segment_id = NEW.source_segment_id
              AND source_segment_version = NEW.source_segment_version;
            IF NEW.translation_version IS DISTINCT FROM next_translation_version THEN
                RAISE EXCEPTION 'translation attempt version is not monotonic'
                    USING ERRCODE = '23514';
            END IF;

            NEW.created_at := clock_timestamp();
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.enforce_normalized_translation_review()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_contract text;
            session_ingest text;
            session_source_version integer;
            session_expiry timestamptz;
            session_purged_at timestamptz;
            session_status text;
            session_creator_actor_id varchar(128);
            translation_outcome varchar(16);
            translation_created_at timestamptz;
        BEGIN
            SELECT transcript_contract_version, ingest_mode,
                   current_source_transcript_version, transcript_content_expires_at,
                   content_purged_at, status, creator_actor_id
            INTO session_contract, session_ingest, session_source_version,
                 session_expiry, session_purged_at, session_status,
                 session_creator_actor_id
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;

            IF NOT FOUND
               OR session_contract IS DISTINCT FROM '1.0'
               OR session_ingest IS DISTINCT FROM 'external_async_transcript'
               OR session_source_version IS DISTINCT FROM NEW.source_transcript_version
               OR session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR session_status IS DISTINCT FROM 'review_required'
               OR NEW.reviewer_actor_id IS DISTINCT FROM session_creator_actor_id THEN
                RAISE EXCEPTION 'translation review is outside the creator session fence'
                    USING ERRCODE = '23514';
            END IF;

            IF NEW.decision = 'rejected' AND EXISTS (
                SELECT 1
                FROM public.normalized_translation_reviews
                WHERE tenant_id = NEW.tenant_id
                  AND session_id = NEW.session_id
                  AND source_transcript_version = NEW.source_transcript_version
                  AND source_segment_id = NEW.source_segment_id
                  AND source_segment_version = NEW.source_segment_version
                  AND decision = 'accepted'
            ) THEN
                RAISE EXCEPTION 'accepted translation review is terminal for this source'
                    USING ERRCODE = '23514';
            END IF;

            SELECT outcome, created_at
            INTO translation_outcome, translation_created_at
            FROM public.normalized_translation_attempts
            WHERE tenant_id = NEW.tenant_id
              AND session_id = NEW.session_id
              AND source_transcript_version = NEW.source_transcript_version
              AND source_segment_id = NEW.source_segment_id
              AND source_segment_version = NEW.source_segment_version
              AND translation_id = NEW.translation_id
              AND translation_version = NEW.translation_version;
            IF NOT FOUND
               OR translation_outcome IS DISTINCT FROM 'succeeded'
               OR NEW.reviewed_at < translation_created_at THEN
                RAISE EXCEPTION 'translation review does not match successful current evidence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.enforce_working_child_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_contract text;
            session_ingest text;
            session_source_version integer;
            session_working_version integer;
            session_expiry timestamptz;
            session_purged_at timestamptz;
            session_status text;
        BEGIN
            SELECT transcript_contract_version, ingest_mode,
                   current_source_transcript_version, current_working_transcript_version,
                   transcript_content_expires_at, content_purged_at, status
            INTO session_contract, session_ingest, session_source_version,
                 session_working_version, session_expiry, session_purged_at,
                 session_status
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            IF NOT FOUND
               OR session_contract IS DISTINCT FROM '1.0'
               OR session_ingest IS DISTINCT FROM 'external_async_transcript'
               OR session_source_version IS DISTINCT FROM NEW.source_transcript_version
               OR session_working_version IS DISTINCT FROM NEW.working_transcript_version
               OR session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR session_status IN ('handed_off', 'failed')
               OR EXISTS (
                   SELECT 1 FROM public.normalized_working_transcripts AS working
                   WHERE working.tenant_id = NEW.tenant_id
                     AND working.session_id = NEW.session_id
                     AND working.working_transcript_version = NEW.working_transcript_version
               ) THEN
                RAISE EXCEPTION 'working child write is outside an unsealed live session fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.enforce_working_header_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_contract text;
            session_ingest text;
            session_working_id uuid;
            session_working_version integer;
            session_source_version integer;
            session_expiry timestamptz;
            session_purged_at timestamptz;
            session_status text;
            session_found boolean;
            next_version integer;
        BEGIN
            SELECT transcript_contract_version, ingest_mode, working_transcript_id,
                   current_working_transcript_version, current_source_transcript_version,
                   transcript_content_expires_at, content_purged_at, status
            INTO session_contract, session_ingest, session_working_id,
                 session_working_version, session_source_version, session_expiry,
                 session_purged_at, session_status
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            session_found := FOUND;
            SELECT COALESCE(max(working_transcript_version), 0) + 1
            INTO next_version
            FROM public.normalized_working_transcripts
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id;
            IF NOT COALESCE(session_found, false)
               OR session_contract IS DISTINCT FROM '1.0'
               OR session_ingest IS DISTINCT FROM 'external_async_transcript'
               OR session_working_id IS DISTINCT FROM NEW.working_transcript_id
               OR session_working_version IS DISTINCT FROM NEW.working_transcript_version
               OR session_source_version IS DISTINCT FROM NEW.source_transcript_version
               OR NEW.working_transcript_version IS DISTINCT FROM next_version
               OR session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR session_status NOT IN (
                   'translation_pending', 'review_required',
                   'quality_blocked', 'transcript_ready'
               ) THEN
                RAISE EXCEPTION 'working header is outside the live current session fence'
                    USING ERRCODE = '23514';
            END IF;
            NEW.created_at := clock_timestamp();
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.enforce_working_transcript_complete()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_status text;
            session_source_version integer;
            session_working_id uuid;
            session_working_version integer;
            session_expiry timestamptz;
            session_purged_at timestamptz;
            actual_segments integer;
            actual_blockers integer;
            actual_translation_inputs integer;
            actual_review_inputs integer;
            actual_content_chars bigint;
            source_segments integer;
            invalid_rows boolean;
            expected_status text;
        BEGIN
            SELECT status, current_source_transcript_version, working_transcript_id,
                   current_working_transcript_version, transcript_content_expires_at,
                   content_purged_at
            INTO session_status, session_source_version, session_working_id,
                 session_working_version, session_expiry, session_purged_at
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            IF NOT FOUND
               OR session_source_version IS DISTINCT FROM NEW.source_transcript_version
               OR session_working_id IS DISTINCT FROM NEW.working_transcript_id
               OR session_working_version IS DISTINCT FROM NEW.working_transcript_version
               OR session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry THEN
                RAISE EXCEPTION 'working transcript commit is outside the live current fence'
                    USING ERRCODE = '23514';
            END IF;

            SELECT count(*), COALESCE(sum(char_length(content)), 0)
            INTO actual_segments, actual_content_chars
            FROM public.normalized_working_segments
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND working_transcript_version = NEW.working_transcript_version;
            SELECT count(*) INTO actual_blockers
            FROM public.normalized_working_blockers
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND working_transcript_version = NEW.working_transcript_version;
            SELECT count(*) INTO actual_translation_inputs
            FROM public.normalized_working_translation_inputs
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND working_transcript_version = NEW.working_transcript_version;
            SELECT count(*) INTO actual_review_inputs
            FROM public.normalized_working_review_inputs
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND working_transcript_version = NEW.working_transcript_version;
            SELECT count(*) INTO source_segments
            FROM public.normalized_source_segments
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND source_transcript_version = NEW.source_transcript_version;

            IF actual_segments IS DISTINCT FROM NEW.segment_count
               OR source_segments IS DISTINCT FROM NEW.segment_count
               OR actual_blockers IS DISTINCT FROM NEW.blocker_count
               OR actual_translation_inputs IS DISTINCT FROM NEW.translation_input_count
               OR actual_review_inputs IS DISTINCT FROM NEW.review_input_count
               OR actual_content_chars IS DISTINCT FROM NEW.total_content_chars
               OR actual_translation_inputs IS DISTINCT FROM (
                   SELECT count(*) FROM public.normalized_translation_attempts
                   WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
                     AND source_transcript_version = NEW.source_transcript_version
               )
               OR actual_review_inputs IS DISTINCT FROM (
                   SELECT count(*) FROM public.normalized_translation_reviews
                   WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
                     AND source_transcript_version = NEW.source_transcript_version
               ) THEN
                RAISE EXCEPTION 'working transcript aggregate is incomplete'
                    USING ERRCODE = '23514';
            END IF;

            WITH working_version AS (
                SELECT tenant_id, session_id, source_transcript_version, ordinal,
                       source_segment_id, source_segment_version, source_locale,
                       speaker_id, speaker_role, start_ms, end_ms, resolution,
                       content, translation_id, translation_version,
                       translation_review_id
                FROM public.normalized_working_segments
                WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
                  AND working_transcript_version = NEW.working_transcript_version
            )
            SELECT EXISTS (
                SELECT 1
                FROM public.normalized_source_segments AS source
                FULL JOIN working_version AS working
                  ON working.tenant_id = source.tenant_id
                 AND working.session_id = source.session_id
                 AND working.source_transcript_version = source.source_transcript_version
                 AND working.ordinal = source.ordinal
                LEFT JOIN public.normalized_translation_attempts AS translation
                  ON translation.tenant_id = working.tenant_id
                 AND translation.session_id = working.session_id
                 AND translation.source_transcript_version = working.source_transcript_version
                 AND translation.source_segment_id = working.source_segment_id
                 AND translation.source_segment_version = working.source_segment_version
                 AND translation.translation_id = working.translation_id
                 AND translation.translation_version = working.translation_version
                LEFT JOIN public.normalized_translation_reviews AS review
                  ON review.tenant_id = working.tenant_id
                 AND review.review_id = working.translation_review_id
                WHERE COALESCE(source.tenant_id, working.tenant_id) = NEW.tenant_id
                  AND COALESCE(source.session_id, working.session_id) = NEW.session_id
                  AND COALESCE(
                      source.source_transcript_version,
                      working.source_transcript_version
                  ) = NEW.source_transcript_version
                  AND (
                      source.source_segment_id IS NULL
                      OR working.source_segment_id IS NULL
                      OR working.source_segment_id IS DISTINCT FROM source.source_segment_id
                      OR working.source_segment_version IS DISTINCT FROM
                         source.source_segment_version
                      OR working.source_locale IS DISTINCT FROM source.source_locale
                      OR working.speaker_id IS DISTINCT FROM source.speaker_id
                      OR working.speaker_role IS DISTINCT FROM source.speaker_role
                      OR working.start_ms IS DISTINCT FROM source.start_ms
                      OR working.end_ms IS DISTINCT FROM source.end_ms
                      OR (
                          working.resolution = 'english_source'
                          AND working.content IS DISTINCT FROM source.content
                      )
                      OR (
                          working.resolution = 'spanish_translation'
                          AND (
                              translation.outcome IS DISTINCT FROM 'succeeded'
                              OR working.content IS DISTINCT FROM translation.content
                              OR review.decision IS DISTINCT FROM 'accepted'
                              OR review.session_id IS DISTINCT FROM working.session_id
                              OR review.source_transcript_version
                                   IS DISTINCT FROM working.source_transcript_version
                              OR review.source_segment_id
                                   IS DISTINCT FROM working.source_segment_id
                              OR review.source_segment_version
                                   IS DISTINCT FROM working.source_segment_version
                              OR review.translation_id IS DISTINCT FROM working.translation_id
                              OR review.translation_version
                                   IS DISTINCT FROM working.translation_version
                          )
                      )
                      OR (
                          source.source_locale = 'en-US'
                          AND working.resolution <> 'english_source'
                      )
                      OR (
                          source.source_locale = 'unknown'
                          AND working.resolution <> 'unresolved'
                      )
                      OR (
                          source.source_locale = 'es-US'
                          AND working.resolution = 'unresolved'
                          AND EXISTS (
                              SELECT 1
                              FROM public.normalized_translation_reviews AS accepted
                              WHERE accepted.tenant_id = source.tenant_id
                                AND accepted.session_id = source.session_id
                                AND accepted.source_transcript_version =
                                    source.source_transcript_version
                                AND accepted.source_segment_id = source.source_segment_id
                                AND accepted.source_segment_version = source.source_segment_version
                                AND accepted.decision = 'accepted'
                          )
                      )
                  )
            ) INTO invalid_rows;
            IF invalid_rows THEN
                RAISE EXCEPTION 'working segment lineage or content is invalid'
                    USING ERRCODE = '23514';
            END IF;

            WITH source_facts AS (
                SELECT tenant_id, session_id, source_transcript_version, ordinal,
                       source_segment_id, source_segment_version, source_locale,
                       start_ms,
                       max(end_ms) OVER (
                           ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ) AS prior_max_end
                FROM public.normalized_source_segments
                WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
                  AND source_transcript_version = NEW.source_transcript_version
            ), expected_unordered AS (
                SELECT ordinal AS source_ordinal, source_segment_id,
                       source_segment_version, 0 AS code_order,
                       'source_overlap'::text AS code
                FROM source_facts WHERE start_ms < prior_max_end
                UNION ALL
                SELECT source.ordinal, source.source_segment_id,
                       source.source_segment_version, 1,
                       CASE
                           WHEN source.source_locale = 'unknown' THEN 'source_locale_unknown'
                           WHEN EXISTS (
                               SELECT 1 FROM public.normalized_translation_reviews AS accepted
                               WHERE accepted.tenant_id = source.tenant_id
                                 AND accepted.session_id = source.session_id
                                 AND accepted.source_transcript_version =
                                     source.source_transcript_version
                                 AND accepted.source_segment_id = source.source_segment_id
                                 AND accepted.source_segment_version = source.source_segment_version
                                 AND accepted.decision = 'accepted'
                           ) THEN NULL
                           WHEN latest.translation_id IS NULL THEN 'translation_missing'
                           WHEN latest.outcome = 'failed' THEN 'translation_failed'
                           WHEN latest_review.decision = 'rejected'
                               THEN 'translation_retry_required'
                           ELSE 'translation_review_required'
                       END
                FROM source_facts AS source
                LEFT JOIN LATERAL (
                    SELECT attempt.translation_id, attempt.translation_version,
                           attempt.outcome
                    FROM public.normalized_translation_attempts AS attempt
                    WHERE attempt.tenant_id = source.tenant_id
                      AND attempt.session_id = source.session_id
                      AND attempt.source_transcript_version = source.source_transcript_version
                      AND attempt.source_segment_id = source.source_segment_id
                      AND attempt.source_segment_version = source.source_segment_version
                    ORDER BY attempt.translation_version DESC LIMIT 1
                ) AS latest ON true
                LEFT JOIN public.normalized_translation_reviews AS latest_review
                  ON latest_review.tenant_id = source.tenant_id
                 AND latest_review.translation_id = latest.translation_id
                 AND latest_review.translation_version = latest.translation_version
                WHERE source.source_locale IN ('es-US', 'unknown')
            ), expected AS (
                SELECT row_number() OVER (ORDER BY source_ordinal, code_order) - 1 AS ordinal,
                       source_segment_id, source_segment_version, code
                FROM expected_unordered WHERE code IS NOT NULL
            ), actual AS (
                SELECT ordinal, source_segment_id, source_segment_version, code
                FROM public.normalized_working_blockers
                WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
                  AND working_transcript_version = NEW.working_transcript_version
            )
            SELECT EXISTS (
                (
                    SELECT ordinal, source_segment_id, source_segment_version, code
                    FROM expected
                    EXCEPT
                    SELECT ordinal, source_segment_id, source_segment_version, code
                    FROM actual
                )
                UNION ALL
                (
                    SELECT ordinal, source_segment_id, source_segment_version, code
                    FROM actual
                    EXCEPT
                    SELECT ordinal, source_segment_id, source_segment_version, code
                    FROM expected
                )
            ) INTO invalid_rows;
            IF invalid_rows THEN
                RAISE EXCEPTION 'working blocker projection is incomplete'
                    USING ERRCODE = '23514';
            END IF;

            SELECT CASE
                       WHEN bool_or(code IN ('source_overlap', 'source_locale_unknown'))
                           THEN 'quality_blocked'
                       WHEN bool_or(code IN (
                           'translation_missing', 'translation_failed',
                           'translation_retry_required'
                       )) THEN 'translation_pending'
                       WHEN bool_or(code = 'translation_review_required')
                           THEN 'review_required'
                       ELSE 'transcript_ready'
                   END
            INTO expected_status
            FROM public.normalized_working_blockers
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND working_transcript_version = NEW.working_transcript_version;
            IF session_status IS DISTINCT FROM expected_status THEN
                RAISE EXCEPTION 'working readiness does not match session state'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )


def _revoke_public_routine_privileges() -> None:
    for function in HARDENED_FUNCTIONS:
        op.execute(f"REVOKE ALL PRIVILEGES ON FUNCTION public.{function}() FROM PUBLIC")


def _apply_forward_retained_hardening() -> None:
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)
    op.execute("SET LOCAL row_security = off")
    _lock_projection_tables()
    _replace_hardened_functions()
    _revoke_public_routine_privileges()


def upgrade() -> None:
    _apply_forward_retained_hardening()


def downgrade() -> None:
    # This compatible hardening is intentionally retained at revision 0013. Replacing it with
    # the prior broad reads would weaken the privilege boundary and recreate schema-shape risk.
    op.execute(
        """
        DO $$
        BEGIN
            IF current_database() !~ '_test$' THEN
                RAISE EXCEPTION
                    'refusing projection downgrade outside a disposable test database'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    _apply_forward_retained_hardening()
