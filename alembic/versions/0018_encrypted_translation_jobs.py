"""Dormant encrypted translation jobs; local expand rung only.

Revision ID: 0018_translation_jobs
Revises: 0014

Reconcile the parent with the separate integration graph before promotion.
"""

from alembic import op

revision = "0018_translation_jobs"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '60s'")
    op.execute("""
        CREATE TABLE public.encrypted_translation_jobs (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            translation_id uuid NOT NULL,
            source_transcript_version integer NOT NULL,
            source_segment_id uuid NOT NULL,
            source_segment_version integer NOT NULL,
            previous_translation_version integer NOT NULL CHECK (previous_translation_version >= 0),
            status varchar(32) NOT NULL,
            reserved_at timestamptz NOT NULL,
            provider_call_started_at timestamptz,
            provider_result_stored_at timestamptz,
            attempt_committed_at timestamptz,
            expires_at timestamptz NOT NULL,
            key_version varchar(128) NOT NULL CHECK (key_version ~ '^[A-Za-z0-9_-]{1,128}$'),
            wrapped_dek varchar(512) NOT NULL CHECK (
                char_length(wrapped_dek) = 512 AND wrapped_dek ~ '^[A-Za-z0-9_-]+$'),
            nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
            ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 1048592),
            PRIMARY KEY (tenant_id, translation_id),
            UNIQUE (tenant_id, session_id, source_transcript_version, source_segment_id,
                    source_segment_version, previous_translation_version),
            FOREIGN KEY (tenant_id, session_id, source_transcript_version, source_segment_id,
                         source_segment_version)
                REFERENCES public.normalized_source_segments
                    (tenant_id, session_id, source_transcript_version, source_segment_id,
                     source_segment_version) ON DELETE CASCADE,
            CHECK (expires_at > reserved_at),
            CHECK (provider_call_started_at >= reserved_at),
            CHECK (provider_result_stored_at >= provider_call_started_at),
            CHECK (attempt_committed_at >= provider_result_stored_at),
            CHECK (
                (status = 'reserved' AND provider_call_started_at IS NULL
                 AND provider_result_stored_at IS NULL AND attempt_committed_at IS NULL)
                OR (status = 'provider_call_started' AND provider_call_started_at IS NOT NULL
                    AND provider_result_stored_at IS NULL AND attempt_committed_at IS NULL)
                OR (status = 'provider_result_stored' AND provider_call_started_at IS NOT NULL
                    AND provider_result_stored_at IS NOT NULL AND attempt_committed_at IS NULL)
                OR (status = 'attempt_committed' AND provider_call_started_at IS NOT NULL
                    AND provider_result_stored_at IS NOT NULL AND attempt_committed_at IS NOT NULL)
            )
        )
    """)
    op.execute("ALTER TABLE public.encrypted_translation_jobs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.encrypted_translation_jobs FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY encrypted_translation_jobs_tenant_isolation
        ON public.encrypted_translation_jobs
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    """)
    op.execute("REVOKE ALL ON public.encrypted_translation_jobs FROM PUBLIC")
    op.execute("""
        CREATE FUNCTION public.guard_encrypted_translation_job_transition()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF EXISTS (
                    SELECT 1 FROM public.normalized_source_segments
                    WHERE tenant_id = OLD.tenant_id AND session_id = OLD.session_id
                      AND source_transcript_version = OLD.source_transcript_version
                      AND source_segment_id = OLD.source_segment_id
                      AND source_segment_version = OLD.source_segment_version
                ) THEN
                    RAISE EXCEPTION 'translation job removal requires source retention cleanup'
                        USING ERRCODE = '23514';
                END IF;
                RETURN OLD;
            END IF;
            IF TG_OP = 'INSERT' THEN
                IF NEW.status <> 'reserved' THEN
                    RAISE EXCEPTION 'translation job must begin reserved' USING ERRCODE = '23514';
                END IF;
            ELSE
                IF ROW(NEW.tenant_id, NEW.session_id, NEW.translation_id,
                       NEW.source_transcript_version, NEW.source_segment_id,
                       NEW.source_segment_version, NEW.previous_translation_version,
                       NEW.reserved_at, NEW.expires_at)
                   IS DISTINCT FROM
                   ROW(OLD.tenant_id, OLD.session_id, OLD.translation_id,
                       OLD.source_transcript_version, OLD.source_segment_id,
                       OLD.source_segment_version, OLD.previous_translation_version,
                       OLD.reserved_at, OLD.expires_at)
                   OR (OLD.provider_call_started_at IS NOT NULL AND
                       NEW.provider_call_started_at IS DISTINCT FROM OLD.provider_call_started_at)
                   OR (OLD.provider_result_stored_at IS NOT NULL AND
                       NEW.provider_result_stored_at IS DISTINCT FROM OLD.provider_result_stored_at)
                   OR NOT (
                       (OLD.status = 'reserved' AND NEW.status = 'provider_call_started')
                       OR (OLD.status = 'provider_call_started'
                           AND NEW.status = 'provider_result_stored')
                       OR (OLD.status = 'provider_result_stored'
                           AND NEW.status = 'attempt_committed')
                   ) THEN
                    RAISE EXCEPTION 'translation job transition is not monotonic'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER encrypted_translation_jobs_transition
        BEFORE INSERT OR UPDATE OR DELETE ON public.encrypted_translation_jobs
        FOR EACH ROW EXECUTE FUNCTION public.guard_encrypted_translation_job_transition()
    """)
    op.execute("""
        CREATE FUNCTION public.fence_encrypted_translation_job()
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
    """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER encrypted_translation_jobs_precommit
        AFTER INSERT OR UPDATE ON public.encrypted_translation_jobs
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION public.fence_encrypted_translation_job()
    """)
    for function in (
        "guard_encrypted_translation_job_transition",
        "fence_encrypted_translation_job",
    ):
        op.execute(f"REVOKE ALL ON FUNCTION public.{function}() FROM PUBLIC")


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '60s'")
    op.execute("SET LOCAL row_security = off")
    op.execute("LOCK TABLE public.encrypted_translation_jobs IN ACCESS EXCLUSIVE MODE")
    op.execute("""
        DO $$ BEGIN
            IF right(current_database(), 5) <> '_test' THEN
                RAISE EXCEPTION
                    'refusing translation job downgrade outside disposable test database';
            END IF;
            IF EXISTS (SELECT 1 FROM public.encrypted_translation_jobs) THEN
                RAISE EXCEPTION 'refusing translation job downgrade after it has been used';
            END IF;
        END $$
    """)
    op.execute("DROP TABLE public.encrypted_translation_jobs")
    op.execute("DROP FUNCTION public.guard_encrypted_translation_job_transition()")
    op.execute("DROP FUNCTION public.fence_encrypted_translation_job()")
