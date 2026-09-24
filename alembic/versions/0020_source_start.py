"""Durable native start ownership; expand only, dormant until paired release.

Revision ID: 0020_source_start
Revises: 0019_captured_bilingual
"""

from alembic import op

revision = "0020_source_start"
down_revision = "0019_captured_bilingual"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
CREATE TABLE source_start_attempts (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            id uuid NOT NULL,
            attempt_id uuid NOT NULL,
            creator_actor_id varchar(128) NOT NULL,
            consent_record_id uuid NOT NULL,
            source varchar(32) NOT NULL,
            owner_proof_sha256 varchar(64) NOT NULL,
            lease_id uuid NOT NULL,
            lease_receipt_id uuid NOT NULL,
            lease_generation integer NOT NULL,
            capture_authorized_until timestamptz NOT NULL,
            prepared_at timestamptz NOT NULL,
            preparation_expires_at timestamptz NOT NULL,
            capability_id uuid NOT NULL,
            state varchar(16) NOT NULL DEFAULT 'prepared',
            issued_at timestamptz,
            expires_at timestamptz,
            PRIMARY KEY (tenant_id, id),
            UNIQUE (tenant_id, attempt_id),
            UNIQUE (tenant_id, capability_id),
            FOREIGN KEY (tenant_id, session_id, lease_id)
                REFERENCES capture_leases (tenant_id, session_id, lease_id),
            FOREIGN KEY (tenant_id, lease_receipt_id)
                REFERENCES capture_lease_receipts (tenant_id, id),
            FOREIGN KEY (tenant_id, consent_record_id)
                REFERENCES consent_records (tenant_id, id),
            CHECK (creator_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
            CHECK (source IN ('desktop_companion', 'ios_microphone')),
            CHECK (owner_proof_sha256 ~ '^[0-9a-f]{64}$'),
            CHECK (lease_generation >= 1),
            CHECK (preparation_expires_at > prepared_at
                AND preparation_expires_at <= prepared_at + INTERVAL '2 minutes'
                AND preparation_expires_at <= capture_authorized_until),
            CHECK ((state IN ('prepared', 'cancelled', 'expired')
                    AND issued_at IS NULL AND expires_at IS NULL)
                OR (state = 'issued' AND issued_at IS NOT NULL AND expires_at IS NOT NULL
                    AND issued_at >= prepared_at AND issued_at < preparation_expires_at
                    AND expires_at > issued_at
                    AND expires_at <= issued_at + INTERVAL '15 seconds'
                    AND expires_at <= capture_authorized_until))
        );
    """)
    op.execute("""
CREATE UNIQUE INDEX source_start_one_owner
            ON source_start_attempts (tenant_id, session_id)
            WHERE state IN ('prepared', 'issued');
    """)
    op.execute("""
ALTER TABLE source_start_attempts ENABLE ROW LEVEL SECURITY;
    """)
    op.execute("""
ALTER TABLE source_start_attempts FORCE ROW LEVEL SECURITY;
    """)
    op.execute("""
CREATE POLICY source_start_tenant ON source_start_attempts
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    """)
    op.execute("""
CREATE FUNCTION enforce_source_start_history() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                RAISE EXCEPTION 'source start history is retained' USING ERRCODE = '23514';
            END IF;
            IF TG_OP = 'INSERT' THEN
                IF NEW.state <> 'prepared' THEN
                    RAISE EXCEPTION 'source start must be prepared' USING ERRCODE = '23514';
                END IF;
            ELSE
                IF OLD.state <> 'prepared'
                   OR NEW.state NOT IN ('issued', 'cancelled', 'expired')
                   OR (to_jsonb(OLD) - ARRAY['state', 'issued_at', 'expires_at'])
                      IS DISTINCT FROM
                      (to_jsonb(NEW) - ARRAY['state', 'issued_at', 'expires_at']) THEN
                    RAISE EXCEPTION 'source start history is immutable' USING ERRCODE = '23514';
                END IF;
                IF NEW.state = 'expired' AND OLD.preparation_expires_at > clock_timestamp() THEN
                    RAISE EXCEPTION 'source start has not expired' USING ERRCODE = '23514';
                END IF;
            END IF;
            IF NEW.state IN ('prepared', 'issued') THEN
                PERFORM pg_advisory_xact_lock(hashtextextended(
                    'scribe-consent:' || NEW.tenant_id::text || ':'
                    || NEW.consent_record_id::text, 0));
                PERFORM 1 FROM public.scribe_sessions
                    WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id FOR UPDATE;
                IF NOT EXISTS (
                    SELECT 1 FROM public.scribe_sessions AS s
                    JOIN public.consent_records AS c
                        ON c.tenant_id = s.tenant_id AND c.id = s.consent_record_id
                    JOIN public.capture_leases AS l
                        ON l.tenant_id = s.tenant_id AND l.session_id = s.id
                    JOIN public.capture_lease_receipts AS r
                        ON r.tenant_id = s.tenant_id AND r.id = NEW.lease_receipt_id
                    JOIN public.session_audio_keys AS k
                        ON k.tenant_id = s.tenant_id AND k.session_id = s.id
                    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.session_id
                        AND s.transcript_contract_version = '1.0'
                        AND s.ingest_mode = 'chunk_upload' AND s.status = 'created'
                        AND s.creator_actor_id = NEW.creator_actor_id
                        AND s.consent_record_id = NEW.consent_record_id
                        AND s.content_purged_at IS NULL AND c.all_parties_consented
                        AND c.revoked_at IS NULL
                        AND l.lease_id = NEW.lease_id AND l.generation = NEW.lease_generation
                        AND l.closed_at IS NULL AND l.expires_at > clock_timestamp()
                        AND r.session_id = s.id AND r.lease_id = l.lease_id
                        AND r.generation = l.generation AND r.expires_at = l.expires_at
                        AND NEW.capture_authorized_until = r.expires_at
                ) THEN
                    RAISE EXCEPTION 'source start context unavailable' USING ERRCODE = '23514';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$;
    """)
    op.execute("""
CREATE TRIGGER source_start_history
            BEFORE INSERT OR UPDATE OR DELETE ON source_start_attempts
            FOR EACH ROW EXECUTE FUNCTION enforce_source_start_history();
    """)


def downgrade() -> None:
    raise RuntimeError("expand recovery retains dormant source start history")
