"""Add dormant English working-transcript storage.

Revision ID: 0013
Revises: 0012
"""

from __future__ import annotations

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'"
STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '60s'"

WORKING_TABLES = (
    "normalized_working_transcripts",
    "normalized_working_translation_inputs",
    "normalized_working_review_inputs",
    "normalized_working_segments",
    "normalized_working_blockers",
)
WORKING_CHILD_TABLES = WORKING_TABLES[1:]


def _enable_tenant_isolation(table: str) -> None:
    op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE public.{table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"""
        CREATE POLICY {table}_tenant_isolation ON public.{table}
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
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
            public.normalized_source_segments,
            public.normalized_translation_attempts,
            public.normalized_translation_reviews
        IN ACCESS EXCLUSIVE MODE
        """
    )
    op.execute(
        """
        ALTER TABLE public.scribe_sessions
        ADD COLUMN working_transcript_id uuid,
        ADD COLUMN current_working_transcript_version integer,
        ADD CONSTRAINT scribe_sessions_working_projection_check CHECK (
            (
                transcript_contract_version IS NULL
                AND working_transcript_id IS NULL
                AND current_working_transcript_version IS NULL
            )
            OR (
                transcript_contract_version = '1.0'
                AND (
                    current_working_transcript_version IS NULL
                    OR (
                        working_transcript_id IS NOT NULL
                        AND current_working_transcript_version >= 1
                        AND content_purged_at IS NULL
                    )
                )
            )
        ) NOT VALID
        """
    )
    op.execute(
        "ALTER TABLE public.scribe_sessions "
        "VALIDATE CONSTRAINT scribe_sessions_working_projection_check"
    )
    # Keep the existing runtime's column-scoped SELECT grant sufficient after adding columns.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.enforce_normalized_source_header()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_contract text; session_ingest text; session_language text;
            session_adapter text; session_model text; session_normalizer text;
            session_status text; session_source_version integer;
            session_received_at timestamptz; session_expiry timestamptz;
            session_purged_at timestamptz;
        BEGIN
            SELECT transcript_contract_version, ingest_mode, language_mode,
                   transcription_adapter_id, transcription_model_profile_id,
                   normalization_profile_id, status, current_source_transcript_version,
                   source_received_at, transcript_content_expires_at, content_purged_at
            INTO session_contract, session_ingest, session_language, session_adapter,
                 session_model, session_normalizer, session_status, session_source_version,
                 session_received_at, session_expiry, session_purged_at
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            IF NEW.source_transcript_version = 1 THEN
                NEW.received_at := session_received_at;
            ELSE
                NEW.received_at := clock_timestamp();
            END IF;
            IF session_contract IS DISTINCT FROM '1.0'
               OR session_ingest IS DISTINCT FROM 'external_async_transcript'
               OR NEW.language_mode IS DISTINCT FROM session_language
               OR NEW.transcription_adapter_id IS DISTINCT FROM session_adapter
               OR NEW.transcription_model_profile_id IS DISTINCT FROM session_model
               OR NEW.normalization_profile_id IS DISTINCT FROM session_normalizer
               OR session_status IS DISTINCT FROM 'source_received'
               OR NEW.source_transcript_version IS DISTINCT FROM session_source_version
               OR NEW.transcript_content_expires_at IS DISTINCT FROM session_expiry
               OR session_purged_at IS NOT NULL OR clock_timestamp() >= session_expiry
               OR (NEW.source_transcript_version = 1
                   AND NEW.received_at IS DISTINCT FROM session_received_at)
               OR (NEW.source_transcript_version > 1 AND NOT EXISTS (
                   SELECT 1 FROM public.normalized_source_transcripts AS prior_source
                   WHERE prior_source.tenant_id = NEW.tenant_id
                     AND prior_source.session_id = NEW.session_id
                     AND prior_source.source_transcript_version =
                         NEW.source_transcript_version - 1
               ))
               OR NEW.received_at < session_received_at THEN
                RAISE EXCEPTION 'normalized source header does not match a live session fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_scribe_sessions_working_transcript_id
        ON public.scribe_sessions (tenant_id, working_transcript_id)
        WHERE working_transcript_id IS NOT NULL
        """
    )
    op.execute(
        """
        ALTER TABLE public.normalized_translation_reviews
        ADD CONSTRAINT uq_normalized_translation_review_exact
        UNIQUE (
            tenant_id, session_id, source_transcript_version,
            source_segment_id, source_segment_version,
            translation_id, translation_version, review_id
        )
        """
    )
    op.execute(
        """
        CREATE TABLE public.normalized_working_transcripts (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            working_transcript_id uuid NOT NULL,
            working_transcript_version integer NOT NULL,
            source_transcript_version integer NOT NULL,
            schema_version varchar(16) NOT NULL,
            segment_count smallint NOT NULL,
            blocker_count smallint NOT NULL,
            translation_input_count integer NOT NULL,
            review_input_count integer NOT NULL,
            total_content_chars integer NOT NULL,
            working_fingerprint char(64) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            CONSTRAINT pk_normalized_working_transcripts
                PRIMARY KEY (tenant_id, session_id, working_transcript_version),
            CONSTRAINT uq_normalized_working_transcript_identity_version
                UNIQUE (tenant_id, working_transcript_id, working_transcript_version),
            CONSTRAINT fk_working_transcript_session
                FOREIGN KEY (tenant_id, session_id)
                REFERENCES public.scribe_sessions (tenant_id, id) ON DELETE CASCADE,
            CONSTRAINT fk_working_transcript_source
                FOREIGN KEY (tenant_id, session_id, source_transcript_version)
                REFERENCES public.normalized_source_transcripts (
                    tenant_id, session_id, source_transcript_version
                ) ON DELETE CASCADE,
            CONSTRAINT ck_working_transcript_version CHECK (working_transcript_version >= 1),
            CONSTRAINT ck_working_transcript_schema CHECK (schema_version = '1.0'),
            CONSTRAINT ck_working_transcript_segment_count
                CHECK (segment_count BETWEEN 1 AND 10000),
            CONSTRAINT ck_working_transcript_blocker_count
                CHECK (blocker_count BETWEEN 0 AND 20000),
            CONSTRAINT ck_working_transcript_translation_input_count
                CHECK (translation_input_count BETWEEN 0 AND 10000),
            CONSTRAINT ck_working_transcript_review_input_count
                CHECK (review_input_count BETWEEN 0 AND 10000),
            CONSTRAINT ck_working_transcript_content_size
                CHECK (total_content_chars BETWEEN 0 AND 200000),
            CONSTRAINT ck_working_transcript_fingerprint
                CHECK (working_fingerprint ~ '^[a-f0-9]{64}$')
        )
        """
    )
    op.execute(
        """
        CREATE TABLE public.normalized_working_translation_inputs (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            working_transcript_version integer NOT NULL,
            source_transcript_version integer NOT NULL,
            source_segment_id uuid NOT NULL,
            source_segment_version integer NOT NULL,
            translation_id uuid NOT NULL,
            translation_version integer NOT NULL,
            CONSTRAINT pk_normalized_working_translation_inputs
                PRIMARY KEY (
                    tenant_id, session_id, working_transcript_version, translation_id
                ),
            CONSTRAINT uq_normalized_working_translation_input_exact
                UNIQUE (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version
                ),
            CONSTRAINT fk_working_translation_input_header
                FOREIGN KEY (tenant_id, session_id, working_transcript_version)
                REFERENCES public.normalized_working_transcripts (
                    tenant_id, session_id, working_transcript_version
                ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CONSTRAINT fk_working_translation_input_exact
                FOREIGN KEY (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version,
                    translation_id, translation_version
                ) REFERENCES public.normalized_translation_attempts (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version,
                    translation_id, translation_version
                ) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        """
        CREATE TABLE public.normalized_working_review_inputs (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            working_transcript_version integer NOT NULL,
            source_transcript_version integer NOT NULL,
            source_segment_id uuid NOT NULL,
            source_segment_version integer NOT NULL,
            translation_id uuid NOT NULL,
            translation_version integer NOT NULL,
            review_id uuid NOT NULL,
            CONSTRAINT pk_normalized_working_review_inputs
                PRIMARY KEY (tenant_id, session_id, working_transcript_version, review_id),
            CONSTRAINT uq_normalized_working_review_input_exact
                UNIQUE (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version, review_id
                ),
            CONSTRAINT fk_working_review_input_header
                FOREIGN KEY (tenant_id, session_id, working_transcript_version)
                REFERENCES public.normalized_working_transcripts (
                    tenant_id, session_id, working_transcript_version
                ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CONSTRAINT fk_working_review_input_translation_membership
                FOREIGN KEY (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version
                ) REFERENCES public.normalized_working_translation_inputs (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version
                ) ON DELETE CASCADE,
            CONSTRAINT fk_working_review_input_exact
                FOREIGN KEY (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version,
                    translation_id, translation_version, review_id
                ) REFERENCES public.normalized_translation_reviews (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version,
                    translation_id, translation_version, review_id
                ) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        """
        CREATE TABLE public.normalized_working_segments (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            working_transcript_version integer NOT NULL,
            ordinal smallint NOT NULL,
            source_transcript_version integer NOT NULL,
            source_segment_id uuid NOT NULL,
            source_segment_version integer NOT NULL,
            source_locale varchar(16) NOT NULL,
            speaker_id uuid NOT NULL,
            speaker_role varchar(16) NOT NULL,
            start_ms integer NOT NULL,
            end_ms integer NOT NULL,
            resolution varchar(32) NOT NULL,
            content text,
            translation_id uuid,
            translation_version integer,
            translation_review_id uuid,
            CONSTRAINT pk_normalized_working_segments
                PRIMARY KEY (tenant_id, session_id, working_transcript_version, ordinal),
            CONSTRAINT uq_normalized_working_segment_source
                UNIQUE (
                    tenant_id, session_id, working_transcript_version, source_segment_id
                ),
            CONSTRAINT fk_working_segment_header
                FOREIGN KEY (tenant_id, session_id, working_transcript_version)
                REFERENCES public.normalized_working_transcripts (
                    tenant_id, session_id, working_transcript_version
                ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CONSTRAINT fk_working_segment_source
                FOREIGN KEY (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version
                ) REFERENCES public.normalized_source_segments (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version
                ) ON DELETE CASCADE,
            CONSTRAINT fk_working_segment_translation_input
                FOREIGN KEY (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version
                ) REFERENCES public.normalized_working_translation_inputs (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version
                ) ON DELETE CASCADE,
            CONSTRAINT fk_working_segment_review_input
                FOREIGN KEY (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version, translation_review_id
                ) REFERENCES public.normalized_working_review_inputs (
                    tenant_id, session_id, working_transcript_version,
                    source_transcript_version, source_segment_id, source_segment_version,
                    translation_id, translation_version, review_id
                ) ON DELETE CASCADE,
            CONSTRAINT ck_working_segment_ordinal CHECK (ordinal BETWEEN 0 AND 9999),
            CONSTRAINT ck_working_segment_source_locale
                CHECK (source_locale IN ('en-US', 'es-US', 'unknown')),
            CONSTRAINT ck_working_segment_speaker_role
                CHECK (speaker_role IN ('clinician', 'patient', 'other', 'unknown')),
            CONSTRAINT ck_working_segment_timing CHECK (start_ms >= 0 AND end_ms > start_ms),
            CONSTRAINT ck_working_segment_resolution CHECK (
                (
                    resolution = 'english_source'
                    AND source_locale = 'en-US'
                    AND content IS NOT NULL
                    AND char_length(content) BETWEEN 1 AND 100000
                    AND btrim(content) <> ''
                    AND translation_id IS NULL
                    AND translation_version IS NULL
                    AND translation_review_id IS NULL
                )
                OR (
                    resolution = 'spanish_translation'
                    AND source_locale = 'es-US'
                    AND content IS NOT NULL
                    AND char_length(content) BETWEEN 1 AND 100000
                    AND btrim(content) <> ''
                    AND translation_id IS NOT NULL
                    AND translation_version IS NOT NULL
                    AND translation_review_id IS NOT NULL
                )
                OR (
                    resolution = 'unresolved'
                    AND source_locale IN ('es-US', 'unknown')
                    AND content IS NULL
                    AND translation_id IS NULL
                    AND translation_version IS NULL
                    AND translation_review_id IS NULL
                )
            )
        )
        """
    )
    op.execute(
        """
        CREATE TABLE public.normalized_working_blockers (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            working_transcript_version integer NOT NULL,
            ordinal smallint NOT NULL,
            source_transcript_version integer NOT NULL,
            source_segment_id uuid NOT NULL,
            source_segment_version integer NOT NULL,
            code varchar(48) NOT NULL,
            CONSTRAINT pk_normalized_working_blockers
                PRIMARY KEY (tenant_id, session_id, working_transcript_version, ordinal),
            CONSTRAINT uq_normalized_working_blocker
                UNIQUE (
                    tenant_id, session_id, working_transcript_version,
                    source_segment_id, code
                ),
            CONSTRAINT fk_working_blocker_header
                FOREIGN KEY (tenant_id, session_id, working_transcript_version)
                REFERENCES public.normalized_working_transcripts (
                    tenant_id, session_id, working_transcript_version
                ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CONSTRAINT fk_working_blocker_source
                FOREIGN KEY (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version
                ) REFERENCES public.normalized_source_segments (
                    tenant_id, session_id, source_transcript_version,
                    source_segment_id, source_segment_version
                ) ON DELETE CASCADE,
            CONSTRAINT ck_working_blocker_ordinal CHECK (ordinal BETWEEN 0 AND 19999),
            CONSTRAINT ck_working_blocker_code CHECK (code IN (
                'source_locale_unknown', 'source_overlap', 'translation_missing',
                'translation_review_required', 'translation_failed',
                'translation_retry_required'
            ))
        )
        """
    )
    op.execute(
        """
        ALTER TABLE public.scribe_sessions
        ADD CONSTRAINT scribe_sessions_current_working_transcript_fkey
        FOREIGN KEY (tenant_id, id, current_working_transcript_version)
        REFERENCES public.normalized_working_transcripts (
            tenant_id, session_id, working_transcript_version
        ) DEFERRABLE INITIALLY DEFERRED NOT VALID
        """
    )
    op.execute(
        "ALTER TABLE public.scribe_sessions "
        "VALIDATE CONSTRAINT scribe_sessions_current_working_transcript_fkey"
    )

    op.execute(
        """
        CREATE FUNCTION public.enforce_working_session_projection()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
            IF OLD.working_transcript_id IS NOT NULL
               AND OLD.working_transcript_id IS DISTINCT FROM NEW.working_transcript_id THEN
                RAISE EXCEPTION 'working transcript identity is immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.working_transcript_id IS NULL
               AND NEW.working_transcript_id IS NOT NULL
               AND (
                   NEW.current_working_transcript_version IS DISTINCT FROM 1
                   OR NEW.current_source_transcript_version IS NULL
                   OR NEW.content_purged_at IS NOT NULL
               ) THEN
                RAISE EXCEPTION 'working transcript identity begins with live version one'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.current_working_transcript_version IS NOT NULL
               AND NEW.current_working_transcript_version IS NULL
               AND NOT (
                   NEW.content_purged_at IS NOT NULL
                   OR (
                       NEW.current_source_transcript_version =
                           OLD.current_source_transcript_version + 1
                       AND NEW.status = 'source_received'
                   )
               ) THEN
                RAISE EXCEPTION 'current working version clears only for correction or purge'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.current_working_transcript_version IS NOT NULL
               AND NEW.current_working_transcript_version IS NOT NULL
               AND OLD.current_working_transcript_version IS DISTINCT FROM
                    NEW.current_working_transcript_version
               AND NEW.current_working_transcript_version <
                    OLD.current_working_transcript_version THEN
                RAISE EXCEPTION 'current working version cannot move backward'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.current_source_transcript_version IS NOT NULL
               AND NEW.current_source_transcript_version IS DISTINCT FROM
                    OLD.current_source_transcript_version
               AND NEW.current_working_transcript_version IS NOT NULL THEN
                RAISE EXCEPTION 'source correction must clear the current working projection'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.status IS DISTINCT FROM 'transcript_ready'
               AND NEW.status = 'transcript_ready'
               AND NEW.working_transcript_id IS NOT NULL
               AND NEW.current_working_transcript_version IS NULL THEN
                RAISE EXCEPTION 'transcript-ready state requires a working projection'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER scribe_sessions_working_projection
        BEFORE UPDATE ON public.scribe_sessions
        FOR EACH ROW WHEN (OLD.transcript_contract_version IS NOT NULL)
        EXECUTE FUNCTION public.enforce_working_session_projection()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_working_child_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_row public.scribe_sessions%ROWTYPE;
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
               OR session_row.current_working_transcript_version
                    IS DISTINCT FROM NEW.working_transcript_version
               OR session_row.transcript_content_expires_at IS NULL
               OR session_row.content_purged_at IS NOT NULL
               OR clock_timestamp() >= session_row.transcript_content_expires_at
               OR session_row.status IN ('handed_off', 'failed')
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
    for table in WORKING_CHILD_TABLES:
        op.execute(
            f"""
            CREATE TRIGGER {table}_session_guard
            BEFORE INSERT ON public.{table}
            FOR EACH ROW EXECUTE FUNCTION public.enforce_working_child_insert()
            """
        )
    op.execute(
        """
        CREATE FUNCTION public.enforce_working_header_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_row public.scribe_sessions%ROWTYPE;
            session_found boolean;
            next_version integer;
        BEGIN
            SELECT * INTO session_row
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            session_found := FOUND;
            SELECT COALESCE(max(working_transcript_version), 0) + 1
            INTO next_version
            FROM public.normalized_working_transcripts
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id;
            IF NOT COALESCE(session_found, false)
               OR session_row.transcript_contract_version IS DISTINCT FROM '1.0'
               OR session_row.ingest_mode IS DISTINCT FROM 'external_async_transcript'
               OR session_row.working_transcript_id IS DISTINCT FROM NEW.working_transcript_id
               OR session_row.current_working_transcript_version
                    IS DISTINCT FROM NEW.working_transcript_version
               OR session_row.current_source_transcript_version
                    IS DISTINCT FROM NEW.source_transcript_version
               OR NEW.working_transcript_version IS DISTINCT FROM next_version
               OR session_row.transcript_content_expires_at IS NULL
               OR session_row.content_purged_at IS NOT NULL
               OR clock_timestamp() >= session_row.transcript_content_expires_at
               OR session_row.status NOT IN (
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
        CREATE TRIGGER normalized_working_transcripts_session_guard
        BEFORE INSERT ON public.normalized_working_transcripts
        FOR EACH ROW EXECUTE FUNCTION public.enforce_working_header_insert()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_working_session_precommit()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            header_source_version integer;
            header_working_id uuid;
            expected_status text;
        BEGIN
            IF NEW.current_working_transcript_version IS NULL THEN
                IF NEW.working_transcript_id IS NOT NULL
                   AND NEW.status = 'transcript_ready' THEN
                    RAISE EXCEPTION 'transcript-ready state requires a working projection'
                        USING ERRCODE = '23514';
                END IF;
                RETURN NULL;
            END IF;
            SELECT source_transcript_version, working_transcript_id
            INTO header_source_version, header_working_id
            FROM public.normalized_working_transcripts
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.id
              AND working_transcript_version = NEW.current_working_transcript_version;
            IF NOT FOUND
               OR header_source_version IS DISTINCT FROM NEW.current_source_transcript_version
               OR header_working_id IS DISTINCT FROM NEW.working_transcript_id THEN
                RAISE EXCEPTION 'current working projection does not match the session'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW.content_purged_at IS NOT NULL
               OR (
                   NEW.transcript_content_expires_at IS NOT NULL
                   AND clock_timestamp() >= NEW.transcript_content_expires_at
               ) THEN
                RAISE EXCEPTION 'current working projection is outside the live session fence'
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
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.id
              AND working_transcript_version = NEW.current_working_transcript_version;
            IF NEW.status IS DISTINCT FROM expected_status THEN
                RAISE EXCEPTION 'working readiness does not match session state'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER scribe_sessions_working_projection_precommit
        AFTER INSERT OR UPDATE ON public.scribe_sessions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.transcript_contract_version IS NOT NULL)
        EXECUTE FUNCTION public.enforce_working_session_precommit()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_working_transcript_complete()
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
                SELECT *
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
                SELECT source.*,
                       max(end_ms) OVER (
                           ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ) AS prior_max_end
                FROM public.normalized_source_segments AS source
                WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
                  AND source_transcript_version = NEW.source_transcript_version
            ), expected_unordered AS (
                SELECT ordinal AS source_ordinal, source_segment_id,
                       source_segment_version, 0 AS code_order, 'source_overlap'::text AS code
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
                (SELECT * FROM expected EXCEPT SELECT * FROM actual)
                UNION ALL
                (SELECT * FROM actual EXCEPT SELECT * FROM expected)
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
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER normalized_working_transcripts_complete
        AFTER INSERT ON public.normalized_working_transcripts
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.enforce_working_transcript_complete()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_current_working_evidence_membership()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            current_source integer;
            current_working integer;
            header_found boolean;
            header_translation_count integer;
            header_review_count integer;
            actual_translation_count integer;
            actual_review_count integer;
        BEGIN
            SELECT current_source_transcript_version, current_working_transcript_version
            INTO current_source, current_working
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            IF current_working IS NULL
               OR current_source IS DISTINCT FROM NEW.source_transcript_version THEN
                RETURN NULL;
            END IF;
            SELECT translation_input_count, review_input_count, true
            INTO header_translation_count, header_review_count, header_found
            FROM public.normalized_working_transcripts
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND working_transcript_version = current_working
              AND source_transcript_version = current_source;
            SELECT count(*) INTO actual_translation_count
            FROM public.normalized_translation_attempts
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND source_transcript_version = current_source;
            SELECT count(*) INTO actual_review_count
            FROM public.normalized_translation_reviews
            WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
              AND source_transcript_version = current_source;
            IF NOT COALESCE(header_found, false)
               OR header_translation_count IS DISTINCT FROM actual_translation_count
               OR header_review_count IS DISTINCT FROM actual_review_count THEN
                RAISE EXCEPTION 'current working projection omits current derived evidence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    for table in (
        "normalized_translation_attempts",
        "normalized_translation_reviews",
    ):
        op.execute(
            f"""
            CREATE CONSTRAINT TRIGGER {table}_current_working_membership
            AFTER INSERT ON public.{table}
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION public.enforce_current_working_evidence_membership()
            """
        )
    op.execute(
        """
        CREATE FUNCTION public.reject_normalized_working_update()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
            RAISE EXCEPTION 'normalized working evidence is immutable' USING ERRCODE = '23514';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_normalized_working_delete_fence()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            purge_marker timestamptz;
            session_found boolean;
        BEGIN
            SELECT content_purged_at, true INTO purge_marker, session_found
            FROM public.scribe_sessions
            WHERE tenant_id = OLD.tenant_id AND id = OLD.session_id
            FOR UPDATE;
            IF COALESCE(session_found, false) AND purge_marker IS NULL THEN
                RAISE EXCEPTION 'normalized working deletion requires the purge marker'
                    USING ERRCODE = '23514';
            END IF;
            RETURN OLD;
        END;
        $$
        """
    )
    for table in WORKING_TABLES:
        op.execute(
            f"""
            CREATE TRIGGER {table}_immutable
            BEFORE UPDATE ON public.{table}
            FOR EACH ROW EXECUTE FUNCTION public.reject_normalized_working_update()
            """
        )
        op.execute(
            f"""
            CREATE TRIGGER {table}_delete_fence
            BEFORE DELETE ON public.{table}
            FOR EACH ROW EXECUTE FUNCTION public.enforce_normalized_working_delete_fence()
            """
        )
        _enable_tenant_isolation(table)
        op.execute(f"REVOKE ALL PRIVILEGES ON TABLE public.{table} FROM PUBLIC")
    for function in (
        "enforce_working_session_projection",
        "enforce_working_child_insert",
        "enforce_working_header_insert",
        "enforce_working_session_precommit",
        "enforce_working_transcript_complete",
        "enforce_current_working_evidence_membership",
        "reject_normalized_working_update",
        "enforce_normalized_working_delete_fence",
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
                    'refusing working transcript downgrade outside a disposable test database'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    op.execute(
        "LOCK TABLE public.scribe_sessions, "
        + ", ".join(f"public.{table}" for table in WORKING_TABLES)
        + " IN ACCESS EXCLUSIVE MODE"
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM public.scribe_sessions
                WHERE working_transcript_id IS NOT NULL
                   OR current_working_transcript_version IS NOT NULL
            )
               OR EXISTS (SELECT 1 FROM public.normalized_working_transcripts)
               OR EXISTS (SELECT 1 FROM public.normalized_working_translation_inputs)
               OR EXISTS (SELECT 1 FROM public.normalized_working_review_inputs)
               OR EXISTS (SELECT 1 FROM public.normalized_working_segments)
               OR EXISTS (SELECT 1 FROM public.normalized_working_blockers) THEN
                RAISE EXCEPTION
                    'refusing to remove working transcript storage after it has been used'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    for table in (
        "normalized_translation_attempts",
        "normalized_translation_reviews",
    ):
        op.execute(
            f"DROP TRIGGER IF EXISTS {table}_current_working_membership ON public.{table}"
        )
    op.execute(
        "DROP TRIGGER IF EXISTS scribe_sessions_working_projection ON public.scribe_sessions"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS scribe_sessions_working_projection_precommit "
        "ON public.scribe_sessions"
    )
    op.execute(
        "ALTER TABLE public.scribe_sessions "
        "DROP CONSTRAINT IF EXISTS scribe_sessions_current_working_transcript_fkey"
    )
    for table in reversed(WORKING_TABLES):
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON public.{table}")
        op.execute(f"ALTER TABLE public.{table} DISABLE ROW LEVEL SECURITY")
        op.execute(f"DROP TABLE IF EXISTS public.{table} CASCADE")
    for function in (
        "enforce_normalized_working_delete_fence",
        "reject_normalized_working_update",
        "enforce_current_working_evidence_membership",
        "enforce_working_transcript_complete",
        "enforce_working_session_precommit",
        "enforce_working_header_insert",
        "enforce_working_child_insert",
        "enforce_working_session_projection",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS public.{function}()")
    op.execute(
        "ALTER TABLE public.normalized_translation_reviews "
        "DROP CONSTRAINT IF EXISTS uq_normalized_translation_review_exact"
    )
    op.execute("DROP INDEX IF EXISTS public.uq_scribe_sessions_working_transcript_id")
    op.execute(
        """
        ALTER TABLE public.scribe_sessions
        DROP CONSTRAINT IF EXISTS scribe_sessions_working_projection_check,
        DROP COLUMN IF EXISTS current_working_transcript_version,
        DROP COLUMN IF EXISTS working_transcript_id
        """
    )
