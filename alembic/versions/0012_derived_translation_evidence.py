"""Add dormant translation-attempt and creator-review evidence.

Revision ID: 0012
Revises: 0011
"""

from __future__ import annotations

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'"
STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '60s'"

DERIVED_TABLES = (
    "normalized_translation_attempts",
    "normalized_translation_reviews",
)


def _enable_tenant_isolation(table: str) -> None:
    op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE public.{table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"""
        CREATE POLICY {table}_tenant_isolation ON public.{table}
        USING (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        WITH CHECK (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        """
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)
    op.execute("SET LOCAL row_security = off")
    op.execute(
        """
        LOCK TABLE
            public.scribe_sessions,
            public.normalized_source_transcripts,
            public.normalized_source_segments
        IN ACCESS EXCLUSIVE MODE
        """
    )
    op.execute(
        """
        ALTER TABLE public.normalized_source_segments
        ADD CONSTRAINT uq_normalized_source_segment_exact
        UNIQUE (
            tenant_id,
            session_id,
            source_transcript_version,
            source_segment_id,
            source_segment_version
        )
        """
    )
    op.execute(
        """
        CREATE TABLE public.normalized_translation_attempts (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            source_transcript_version integer NOT NULL,
            source_segment_id uuid NOT NULL,
            source_segment_version integer NOT NULL,
            translation_id uuid NOT NULL,
            translation_version integer NOT NULL,
            source_locale varchar(16) NOT NULL,
            target_locale varchar(16) NOT NULL,
            outcome varchar(16) NOT NULL,
            content text,
            failure_code varchar(64),
            translation_adapter_id varchar(128) NOT NULL,
            translation_model_profile_id varchar(128) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            CONSTRAINT pk_normalized_translation_attempts
                PRIMARY KEY (tenant_id, translation_id),
            CONSTRAINT uq_translation_segment_version
                UNIQUE (
                    tenant_id,
                    session_id,
                    source_transcript_version,
                    source_segment_id,
                    source_segment_version,
                    translation_version
                ),
            CONSTRAINT uq_translation_exact
                UNIQUE (
                    tenant_id,
                    session_id,
                    source_transcript_version,
                    source_segment_id,
                    source_segment_version,
                    translation_id,
                    translation_version
                ),
            CONSTRAINT fk_translation_source_segment
                FOREIGN KEY (
                    tenant_id,
                    session_id,
                    source_transcript_version,
                    source_segment_id,
                    source_segment_version
                ) REFERENCES public.normalized_source_segments (
                    tenant_id,
                    session_id,
                    source_transcript_version,
                    source_segment_id,
                    source_segment_version
                ) ON DELETE CASCADE,
            CONSTRAINT ck_translation_version_positive CHECK (translation_version >= 1),
            CONSTRAINT ck_translation_locale_direction CHECK (
                source_locale = 'es-US' AND target_locale = 'en-US'
            ),
            CONSTRAINT ck_translation_outcome CHECK (outcome IN ('succeeded', 'failed')),
            CONSTRAINT ck_translation_result CHECK (
                (
                    outcome = 'succeeded'
                    AND content IS NOT NULL
                    AND char_length(content) BETWEEN 1 AND 100000
                    AND btrim(content) <> ''
                    AND failure_code IS NULL
                )
                OR (
                    outcome = 'failed'
                    AND content IS NULL
                    AND failure_code IS NOT NULL
                    AND failure_code ~ '^[a-z][a-z0-9_]{0,63}$'
                )
            ),
            CONSTRAINT ck_translation_adapter_id CHECK (
                translation_adapter_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
            ),
            CONSTRAINT ck_translation_model_profile_id CHECK (
                translation_model_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
            )
        )
        """
    )
    op.execute(
        """
        CREATE TABLE public.normalized_translation_reviews (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            source_transcript_version integer NOT NULL,
            source_segment_id uuid NOT NULL,
            source_segment_version integer NOT NULL,
            translation_id uuid NOT NULL,
            translation_version integer NOT NULL,
            review_id uuid NOT NULL,
            decision varchar(16) NOT NULL,
            reviewer_actor_id varchar(128) NOT NULL,
            reviewed_at timestamptz NOT NULL,
            CONSTRAINT pk_normalized_translation_reviews
                PRIMARY KEY (tenant_id, review_id),
            CONSTRAINT uq_translation_terminal_review
                UNIQUE (
                    tenant_id,
                    session_id,
                    source_transcript_version,
                    source_segment_id,
                    source_segment_version,
                    translation_id,
                    translation_version
                ),
            CONSTRAINT fk_review_translation_exact
                FOREIGN KEY (
                    tenant_id,
                    session_id,
                    source_transcript_version,
                    source_segment_id,
                    source_segment_version,
                    translation_id,
                    translation_version
                ) REFERENCES public.normalized_translation_attempts (
                    tenant_id,
                    session_id,
                    source_transcript_version,
                    source_segment_id,
                    source_segment_version,
                    translation_id,
                    translation_version
                ) ON DELETE CASCADE,
            CONSTRAINT ck_translation_review_decision CHECK (
                decision IN ('accepted', 'rejected')
            ),
            CONSTRAINT ck_translation_reviewer_actor CHECK (
                reviewer_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
            )
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_translation_review_accepted_source
        ON public.normalized_translation_reviews (
            tenant_id,
            session_id,
            source_transcript_version,
            source_segment_id,
            source_segment_version
        )
        WHERE decision = 'accepted'
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.reject_normalized_derived_update()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
            RAISE EXCEPTION 'normalized derived evidence is immutable'
                USING ERRCODE = '23514';
        END;
        $$
        """
    )
    for table in DERIVED_TABLES:
        op.execute(
            f"""
            CREATE TRIGGER {table}_immutable
            BEFORE UPDATE ON public.{table}
            FOR EACH ROW
            EXECUTE FUNCTION public.reject_normalized_derived_update()
            """
        )
    op.execute(
        """
        CREATE FUNCTION public.enforce_normalized_translation_attempt()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_row public.scribe_sessions%ROWTYPE;
            persisted_source_locale varchar(16);
            next_translation_version integer;
        BEGIN
            SELECT * INTO session_row
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;

            IF NOT FOUND
               OR session_row.transcript_contract_version IS DISTINCT FROM '1.0'
               OR session_row.ingest_mode IS DISTINCT FROM 'external_async_transcript'
               OR session_row.current_source_transcript_version
                    IS DISTINCT FROM NEW.source_transcript_version
               OR session_row.transcript_content_expires_at IS NULL
               OR session_row.content_purged_at IS NOT NULL
               OR clock_timestamp() >= session_row.transcript_content_expires_at
               OR session_row.status IS DISTINCT FROM 'translation_pending' THEN
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
        CREATE TRIGGER normalized_translation_attempts_session_guard
        BEFORE INSERT ON public.normalized_translation_attempts
        FOR EACH ROW
        EXECUTE FUNCTION public.enforce_normalized_translation_attempt()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_normalized_translation_attempt_precommit()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_expiry timestamptz;
            session_purged_at timestamptz;
            session_source_version integer;
            session_status text;
        BEGIN
            SELECT
                transcript_content_expires_at,
                content_purged_at,
                current_source_transcript_version,
                status
            INTO
                session_expiry,
                session_purged_at,
                session_source_version,
                session_status
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;

            IF NOT FOUND
               OR session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR session_source_version IS DISTINCT FROM NEW.source_transcript_version
               OR session_status NOT IN ('translation_pending', 'review_required')
               OR (NEW.outcome = 'failed' AND session_status <> 'translation_pending') THEN
                RAISE EXCEPTION 'translation attempt commit is outside the live session fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER normalized_translation_attempts_precommit_fence
        AFTER INSERT ON public.normalized_translation_attempts
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION public.enforce_normalized_translation_attempt_precommit()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_normalized_translation_review()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_row public.scribe_sessions%ROWTYPE;
            translation_outcome varchar(16);
            translation_created_at timestamptz;
        BEGIN
            SELECT * INTO session_row
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;

            IF NOT FOUND
               OR session_row.transcript_contract_version IS DISTINCT FROM '1.0'
               OR session_row.ingest_mode IS DISTINCT FROM 'external_async_transcript'
               OR session_row.current_source_transcript_version
                    IS DISTINCT FROM NEW.source_transcript_version
               OR session_row.transcript_content_expires_at IS NULL
               OR session_row.content_purged_at IS NOT NULL
               OR clock_timestamp() >= session_row.transcript_content_expires_at
               OR session_row.status IS DISTINCT FROM 'review_required'
               OR NEW.reviewer_actor_id IS DISTINCT FROM session_row.creator_actor_id THEN
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
        CREATE TRIGGER normalized_translation_reviews_session_guard
        BEFORE INSERT ON public.normalized_translation_reviews
        FOR EACH ROW
        EXECUTE FUNCTION public.enforce_normalized_translation_review()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_normalized_translation_review_precommit()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_expiry timestamptz;
            session_purged_at timestamptz;
            session_source_version integer;
            session_status text;
        BEGIN
            SELECT
                transcript_content_expires_at,
                content_purged_at,
                current_source_transcript_version,
                status
            INTO
                session_expiry,
                session_purged_at,
                session_source_version,
                session_status
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;

            IF NOT FOUND
               OR session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR session_source_version IS DISTINCT FROM NEW.source_transcript_version
               OR (
                   NEW.decision = 'accepted'
                   AND session_status NOT IN ('review_required', 'transcript_ready')
               )
               OR (
                   NEW.decision = 'rejected'
                   AND session_status IS DISTINCT FROM 'translation_pending'
               ) THEN
                RAISE EXCEPTION 'translation review commit is outside the live session fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER normalized_translation_reviews_precommit_fence
        AFTER INSERT ON public.normalized_translation_reviews
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION public.enforce_normalized_translation_review_precommit()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_normalized_derived_delete_fence()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            purge_marker timestamptz;
            session_found boolean;
        BEGIN
            SELECT content_purged_at, true
            INTO purge_marker, session_found
            FROM public.scribe_sessions
            WHERE tenant_id = OLD.tenant_id AND id = OLD.session_id
            FOR UPDATE;
            IF COALESCE(session_found, false) AND purge_marker IS NULL THEN
                RAISE EXCEPTION 'normalized derived deletion requires the purge marker'
                    USING ERRCODE = '23514';
            END IF;
            RETURN OLD;
        END;
        $$
        """
    )
    for table in reversed(DERIVED_TABLES):
        op.execute(
            f"""
            CREATE TRIGGER {table}_delete_fence
            BEFORE DELETE ON public.{table}
            FOR EACH ROW
            EXECUTE FUNCTION public.enforce_normalized_derived_delete_fence()
            """
        )
    for table in DERIVED_TABLES:
        _enable_tenant_isolation(table)
        op.execute(f"REVOKE ALL PRIVILEGES ON TABLE public.{table} FROM PUBLIC")
    for function in (
        "reject_normalized_derived_update",
        "enforce_normalized_translation_attempt",
        "enforce_normalized_translation_attempt_precommit",
        "enforce_normalized_translation_review",
        "enforce_normalized_translation_review_precommit",
        "enforce_normalized_derived_delete_fence",
    ):
        op.execute(f"REVOKE ALL PRIVILEGES ON FUNCTION public.{function}() FROM PUBLIC")


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)
    op.execute("SET LOCAL row_security = off")
    op.execute(
        """
        DO $$
        BEGIN
            IF current_database() !~ '_test$' THEN
                RAISE EXCEPTION
                    'refusing derived translation evidence downgrade outside a disposable '
                    'test database'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    op.execute(
        """
        LOCK TABLE
            public.scribe_sessions,
            public.normalized_source_transcripts,
            public.normalized_source_segments,
            public.normalized_translation_attempts,
            public.normalized_translation_reviews
        IN ACCESS EXCLUSIVE MODE
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM public.normalized_translation_attempts)
               OR EXISTS (SELECT 1 FROM public.normalized_translation_reviews) THEN
                RAISE EXCEPTION
                    'refusing to remove derived translation evidence while rows exist'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    for table in reversed(DERIVED_TABLES):
        op.execute(
            f"DROP POLICY IF EXISTS {table}_tenant_isolation ON public.{table}"
        )
        op.execute(f"ALTER TABLE public.{table} DISABLE ROW LEVEL SECURITY")
        op.execute(f"DROP TRIGGER IF EXISTS {table}_delete_fence ON public.{table}")
        op.execute(f"DROP TRIGGER IF EXISTS {table}_immutable ON public.{table}")
    op.execute(
        "DROP TRIGGER IF EXISTS normalized_translation_reviews_precommit_fence "
        "ON public.normalized_translation_reviews"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS normalized_translation_reviews_session_guard "
        "ON public.normalized_translation_reviews"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS normalized_translation_attempts_precommit_fence "
        "ON public.normalized_translation_attempts"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS normalized_translation_attempts_session_guard "
        "ON public.normalized_translation_attempts"
    )
    for function in (
        "enforce_normalized_derived_delete_fence",
        "enforce_normalized_translation_review_precommit",
        "enforce_normalized_translation_review",
        "enforce_normalized_translation_attempt_precommit",
        "enforce_normalized_translation_attempt",
        "reject_normalized_derived_update",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS public.{function}()")
    op.execute("DROP TABLE IF EXISTS public.normalized_translation_reviews")
    op.execute("DROP TABLE IF EXISTS public.normalized_translation_attempts")
    op.execute(
        "ALTER TABLE public.normalized_source_segments "
        "DROP CONSTRAINT IF EXISTS uq_normalized_source_segment_exact"
    )
