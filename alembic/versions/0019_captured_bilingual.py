"""Admit dormant, newly configured captured bilingual sources.

Revision ID: 0019_captured_bilingual
Revises: 0018_translation_jobs

Expand only. Existing rows are neither converted nor backfilled. Recovery leaves
this schema dormant; empty-use reversal is restricted to disposable test databases.
Reconcile the separate integration graph before any promotion.
"""

from alembic import op

revision = "0019_captured_bilingual"
down_revision = "0018_translation_jobs"
branch_labels = None
depends_on = None

# Frozen prior SQL, not imports from mutable application code or introspected
# deployed function bodies. Rendering changes only the explicitly reviewed mode
# predicates. The disposable reversal restores these exact prior definitions.
PRIOR_CONFIGURATION = """
ALTER TABLE scribe_sessions
        ADD CONSTRAINT scribe_sessions_external_configuration_check CHECK (
            num_nonnulls(
                transcript_contract_version,
                creator_actor_id,
                language_mode,
                transcription_adapter_id,
                transcription_model_profile_id,
                normalization_profile_id
            ) = 0
            OR (
                num_nonnulls(
                    transcript_contract_version,
                    creator_actor_id,
                    language_mode,
                    transcription_adapter_id,
                    transcription_model_profile_id,
                    normalization_profile_id
                ) = 6
                AND
                ingest_mode = 'external_async_transcript'
                AND transcript_contract_version = '1.0'
                AND language_mode IN ('en-US', 'en-US+es-US')
                AND creator_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                AND transcription_adapter_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                AND transcription_model_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                AND normalization_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
            )
        ) NOT VALID,
        ADD CONSTRAINT scribe_sessions_external_lifecycle_check CHECK (
            (
                source_received_at IS NULL
                AND transcript_content_expires_at IS NULL
                AND current_source_transcript_version IS NULL
                AND content_purged_at IS NULL
                AND (transcript_contract_version IS NULL OR status IN ('created', 'failed'))
            )
            OR COALESCE((
                transcript_contract_version = '1.0'
                AND source_received_at IS NOT NULL
                AND transcript_content_expires_at > source_received_at
                AND transcript_content_expires_at <= source_received_at + INTERVAL '14 days'
                AND (
                    (
                        content_purged_at IS NULL
                        AND current_source_transcript_version >= 1
                    )
                    OR (
                        content_purged_at >= source_received_at
                        AND current_source_transcript_version IS NULL
                    )
                )
            ), false)
        ) NOT VALID,
        ADD CONSTRAINT scribe_sessions_external_status_scope_check CHECK (
            (
                transcript_contract_version IS NULL
                AND status NOT IN (
                    'source_received', 'translation_pending',
                    'review_required', 'quality_blocked'
                )
            )
            OR (
                transcript_contract_version = '1.0'
                AND status IN (
                    'created', 'source_received', 'translation_pending',
                    'review_required', 'quality_blocked', 'transcript_ready',
                    'handed_off', 'failed'
                )
                AND (content_purged_at IS NULL OR status IN ('handed_off', 'failed'))
            )
        ) NOT VALID
"""

PRIOR_TRANSITION = """
CREATE OR REPLACE FUNCTION public.enforce_scribe_session_status_transition()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            configured boolean := OLD.transcript_contract_version IS NOT NULL;
        BEGIN
            IF NOT configured THEN
                IF OLD.status = NEW.status
OR (OLD.status = 'created' AND NEW.status IN ('capturing', 'failed'))
OR (OLD.status = 'capturing' AND NEW.status IN ('uploaded', 'failed'))
OR (OLD.status = 'uploaded' AND NEW.status IN ('processing', 'transcript_ready', 'failed'))
OR (OLD.status = 'processing' AND NEW.status IN ('transcript_ready', 'failed'))
OR (OLD.status = 'transcript_ready' AND NEW.status IN ('handed_off', 'failed'))
OR (OLD.status = 'handed_off' AND NEW.status IN ('failed'))
OR (OLD.status = 'failed' AND NEW.status IN ('uploaded'))
                   OR (
                       OLD.ingest_mode = 'external_async_transcript'
                       AND OLD.status = 'created'
                       AND NEW.status = 'transcript_ready'
                   ) THEN
                    RETURN NEW;
                END IF;
            ELSE
                IF OLD.status = NEW.status
                   OR (OLD.status = 'created' AND NEW.status = 'source_received')
                   OR (
                       OLD.status = 'source_received'
                       AND NEW.status IN (
                           'translation_pending', 'quality_blocked', 'transcript_ready'
                       )
                   )
                   OR (
                       OLD.status = 'translation_pending'
                       AND NEW.status IN ('source_received', 'review_required')
                   )
                   OR (
                       OLD.status = 'review_required'
                       AND NEW.status IN (
                           'source_received', 'translation_pending', 'transcript_ready'
                       )
                   )
                   OR (OLD.status = 'quality_blocked' AND NEW.status = 'source_received')
                   OR (
                       OLD.status = 'transcript_ready'
                       AND NEW.status IN ('source_received', 'handed_off')
                   ) THEN
                    RETURN NEW;
                END IF;

                IF NEW.status = 'failed'
                   AND OLD.status IN (
                       'created', 'source_received', 'translation_pending',
                       'review_required', 'quality_blocked', 'transcript_ready'
                   )
                   AND EXISTS (
                       SELECT 1
                       FROM external_session_terminal_events AS event
                       WHERE event.tenant_id = OLD.tenant_id
                         AND event.session_id = OLD.id
                         AND event.prior_status = OLD.status
                   ) THEN
                    RETURN NEW;
                END IF;
            END IF;

            RAISE EXCEPTION 'invalid scribe session status transition: % -> %',
                OLD.status, NEW.status USING ERRCODE = '23514';
        END;
        $$
"""

PRIOR_CHILD_GUARD = """
CREATE OR REPLACE FUNCTION public.enforce_legacy_child_session_discriminator()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_contract varchar(16);
        BEGIN
            SELECT transcript_contract_version
            INTO session_contract
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id;
            IF NOT FOUND OR session_contract IS NOT NULL THEN
                RAISE EXCEPTION 'legacy child root requires an unconfigured session'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
"""

PRIOR_SOURCE_GUARDS = (
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
    """,
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
    """,
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
    """,
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
    """,
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
    """,
    """
CREATE OR REPLACE FUNCTION public.fence_encrypted_translation_job()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        DECLARE session_row RECORD;
                consent_row RECORD;
                consent_id uuid;
        BEGIN
            -- Same consent -> session order as the application writers/revoker.
            SELECT consent_record_id INTO consent_id FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id;
            IF consent_id IS NULL THEN
                RAISE EXCEPTION 'translation job authority unavailable' USING ERRCODE = '23514';
            END IF;
            PERFORM pg_advisory_xact_lock(hashtextextended(
                'scribe-consent:' || NEW.tenant_id::text || ':' || consent_id::text, 0));
            SELECT transcript_contract_version, ingest_mode, current_source_transcript_version,
                   transcript_content_expires_at, content_purged_at, status, appointment_id,
                   practitioner_id, patient_id, modality, consent_record_id
            INTO session_row FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id FOR UPDATE;
            SELECT all_parties_consented, revoked_at, appointment_id,
                   practitioner_id, patient_id, modality
            INTO consent_row FROM public.consent_records
            WHERE tenant_id = NEW.tenant_id AND id = consent_id;
            IF session_row.transcript_contract_version IS DISTINCT FROM '1.0'
               OR session_row.consent_record_id IS DISTINCT FROM consent_id
               OR session_row.ingest_mode IS DISTINCT FROM 'external_async_transcript'
               OR session_row.current_source_transcript_version
                    IS DISTINCT FROM NEW.source_transcript_version
               OR session_row.transcript_content_expires_at IS DISTINCT FROM NEW.expires_at
               OR session_row.content_purged_at IS NOT NULL
               OR session_row.status = 'failed' OR clock_timestamp() >= NEW.expires_at
               OR consent_row.all_parties_consented IS DISTINCT FROM true
               OR consent_row.revoked_at IS NOT NULL
               OR ROW(consent_row.appointment_id, consent_row.practitioner_id,
                      consent_row.patient_id, consent_row.modality)
                    IS DISTINCT FROM ROW(session_row.appointment_id, session_row.practitioner_id,
                                         session_row.patient_id, session_row.modality)
               OR NOT EXISTS (
                   SELECT 1 FROM public.normalized_source_segments
                   WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
                     AND source_transcript_version = NEW.source_transcript_version
                     AND source_segment_id = NEW.source_segment_id
                     AND source_segment_version = NEW.source_segment_version
                     AND source_locale = 'es-US'
               ) THEN
                RAISE EXCEPTION 'translation job outside current consent/source/retention fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
    """,
)

CONFIGURATION_CONSTRAINTS = (
    "scribe_sessions_external_configuration_check",
    "scribe_sessions_external_lifecycle_check",
    "scribe_sessions_external_status_scope_check",
)

CAPTURE_CONSTRAINTS = (
    "scribe_sessions_captured_configuration_check",
    "scribe_sessions_captured_status_scope_check",
)

GUARDED_TABLES = (
    "scribe_sessions",
    "external_session_terminal_events",
    "audio_chunks",
    "audio_upload_grants",
    "session_audio_keys",
    "transcripts",
    "transcript_deliveries",
    "transcription_jobs",
    "capture_leases",
    "audio_chunk_reservation_batches",
    "audio_chunk_reservations",
    "capture_channel_finalizations",
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
    "encrypted_translation_jobs",
)


def _replace_once(sql: str, before: str, after: str) -> str:
    if sql.count(before) != 1:
        raise RuntimeError("captured bilingual migration template mismatch")
    return sql.replace(before, after, 1)


def _lock_tables() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '60s'")
    op.execute("SET LOCAL row_security = off")
    op.execute(
        "LOCK TABLE "
        + ", ".join(f"public.{table}" for table in GUARDED_TABLES)
        + " IN ACCESS EXCLUSIVE MODE"
    )


def _replace_configuration(*, capture: bool) -> None:
    sql = PRIOR_CONFIGURATION
    if capture:
        sql = _replace_once(
            sql,
            "ingest_mode = 'external_async_transcript'",
            "ingest_mode IN ('external_async_transcript', 'chunk_upload')",
        )
        sql = _replace_once(
            sql,
            "(transcript_contract_version IS NULL OR status IN ('created', 'failed'))",
            """(transcript_contract_version IS NULL OR status IN ('created', 'failed')
                OR (ingest_mode = 'chunk_upload'
                    AND status IN ('capturing', 'uploaded', 'processing')))""",
        )
        sql = _replace_once(
            sql,
            "'created', 'source_received', 'translation_pending',",
            "'created', 'capturing', 'uploaded', 'processing', "
            "'source_received', 'translation_pending',",
        )
    for name in CONFIGURATION_CONSTRAINTS:
        op.execute(f"ALTER TABLE public.scribe_sessions DROP CONSTRAINT {name}")
    op.execute(sql)
    for name in CONFIGURATION_CONSTRAINTS:
        op.execute(f"ALTER TABLE public.scribe_sessions VALIDATE CONSTRAINT {name}")
    if capture:
        op.execute("""
            ALTER TABLE public.scribe_sessions
            ADD CONSTRAINT scribe_sessions_captured_configuration_check CHECK (
                transcript_contract_version IS NULL
                OR ingest_mode <> 'chunk_upload'
                OR (
                    transcription_adapter_id = 'azure_ai_speech'
                    AND transcription_model_profile_id = 'azure_fast_transcription_en_es_v1'
                    AND normalization_profile_id = 'azure_phrase_en_es_evidence_v1'
                )
            ) NOT VALID,
            ADD CONSTRAINT scribe_sessions_captured_status_scope_check CHECK (
                transcript_contract_version IS NULL
                OR status NOT IN ('capturing', 'uploaded', 'processing')
                OR ingest_mode = 'chunk_upload'
            ) NOT VALID
        """)
        for name in CAPTURE_CONSTRAINTS:
            op.execute(f"ALTER TABLE public.scribe_sessions VALIDATE CONSTRAINT {name}")
    else:
        for name in CAPTURE_CONSTRAINTS:
            op.execute(f"ALTER TABLE public.scribe_sessions DROP CONSTRAINT {name}")
    op.execute("""
        ALTER TABLE public.external_session_terminal_events
        DROP CONSTRAINT external_session_terminal_events_prior_status_check
    """)
    capture_states = "'capturing', 'uploaded', 'processing'," if capture else ""
    op.execute(f"""
        ALTER TABLE public.external_session_terminal_events
        ADD CONSTRAINT external_session_terminal_events_prior_status_check CHECK (
            prior_status IN ({capture_states}
                'created', 'source_received', 'translation_pending',
                'review_required', 'quality_blocked', 'transcript_ready')
        ) NOT VALID
    """)
    op.execute("""
        ALTER TABLE public.external_session_terminal_events
        VALIDATE CONSTRAINT external_session_terminal_events_prior_status_check
    """)


def _replace_functions(*, capture: bool) -> None:
    transition = PRIOR_TRANSITION
    child = PRIOR_CHILD_GUARD
    if capture:
        transition = _replace_once(
            transition,
            "OR (OLD.status = 'created' AND NEW.status = 'source_received')",
            """OR (OLD.ingest_mode = 'external_async_transcript'
                       AND OLD.status = 'created' AND NEW.status = 'source_received')
                   OR (OLD.ingest_mode = 'chunk_upload' AND (
                       (OLD.status = 'created' AND NEW.status = 'capturing')
                       OR (OLD.status = 'capturing' AND NEW.status = 'uploaded')
                       OR (OLD.status = 'uploaded' AND NEW.status = 'processing')
                       OR (OLD.status = 'processing' AND NEW.status = 'source_received')
                   ))""",
        )
        transition = _replace_once(
            transition,
            "'created', 'source_received', 'translation_pending',",
            "'created', 'capturing', 'uploaded', 'processing', "
            "'source_received', 'translation_pending',",
        )
        child = _replace_once(
            child,
            "session_contract varchar(16);",
            "session_contract varchar(16); session_ingest text;",
        )
        child = _replace_once(
            child,
            "SELECT transcript_contract_version\n            INTO session_contract",
            "SELECT transcript_contract_version, ingest_mode\n"
            "            INTO session_contract, session_ingest",
        )
        child = _replace_once(
            child,
            "IF NOT FOUND OR session_contract IS NOT NULL THEN",
            """IF NOT FOUND OR (session_contract IS NOT NULL AND NOT (
                session_contract = '1.0' AND session_ingest = 'chunk_upload'
                AND TG_TABLE_NAME IN (
                    'audio_chunks', 'audio_upload_grants', 'session_audio_keys',
                    'transcription_jobs', 'capture_leases',
                    'audio_chunk_reservation_batches', 'audio_chunk_reservations',
                    'capture_channel_finalizations'
                )
            )) THEN""",
        )
    op.execute(transition)
    op.execute(child)
    op.execute(
        "REVOKE ALL ON FUNCTION public.enforce_legacy_child_session_discriminator() FROM PUBLIC"
    )
    for sql in PRIOR_SOURCE_GUARDS:
        if capture:
            variable = (
                "session_row.ingest_mode"
                if "fence_encrypted_translation_job()" in sql
                else "session_ingest"
            )
            sql = _replace_once(
                sql,
                f"{variable} IS DISTINCT FROM 'external_async_transcript'",
                f"({variable} IS DISTINCT FROM 'external_async_transcript' "
                f"AND {variable} IS DISTINCT FROM 'chunk_upload')",
            )
        op.execute(sql)
    # CREATE OR REPLACE retains existing ownership and ACLs. No grants are added.


def upgrade() -> None:
    _lock_tables()
    _replace_configuration(capture=True)
    _replace_functions(capture=True)


def downgrade() -> None:
    _lock_tables()
    op.execute("""
        DO $$ BEGIN
            IF right(current_database(), 5) <> '_test' THEN
                RAISE EXCEPTION
                    'refusing captured bilingual downgrade outside disposable test database'
                    USING ERRCODE = '55000';
            END IF;
            IF EXISTS (
                SELECT 1 FROM public.scribe_sessions
                WHERE transcript_contract_version IS NOT NULL AND ingest_mode = 'chunk_upload'
            ) THEN
                RAISE EXCEPTION 'refusing captured bilingual downgrade after use'
                    USING ERRCODE = '55000';
            END IF;
        END $$
    """)
    _replace_functions(capture=False)
    _replace_configuration(capture=False)
