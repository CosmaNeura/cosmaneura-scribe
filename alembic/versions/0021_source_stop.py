"""Retain native-confirmed source stops without refreshing start authority.

Revision ID: 0021_source_stop
Revises: 0020_source_start
"""

from alembic import op

revision = "0021_source_stop"
down_revision = "0020_source_start"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE source_start_attempts ADD COLUMN stopped_at timestamptz")
    op.execute("""
DO $$
DECLARE state_constraint name; matches integer;
BEGIN
    SELECT count(*), min(c.conname) INTO matches, state_constraint
    FROM pg_constraint AS c JOIN pg_attribute AS a
      ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'source_start_attempts'::regclass
      AND c.contype = 'c' AND a.attname = 'state';
    IF matches <> 1 THEN RAISE EXCEPTION 'unexpected source start state constraints'; END IF;
    EXECUTE format('ALTER TABLE source_start_attempts DROP CONSTRAINT %I', state_constraint);
END $$;
    """)
    op.execute("""
ALTER TABLE source_start_attempts ADD CONSTRAINT source_start_state_history CHECK (
    (state IN ('prepared', 'cancelled', 'expired') AND issued_at IS NULL
        AND expires_at IS NULL AND stopped_at IS NULL)
    OR (state IN ('issued', 'stopped') AND issued_at IS NOT NULL AND expires_at IS NOT NULL
        AND issued_at >= prepared_at AND issued_at < preparation_expires_at
        AND expires_at > issued_at AND expires_at <= issued_at + INTERVAL '15 seconds'
        AND expires_at <= capture_authorized_until
        AND ((state = 'issued' AND stopped_at IS NULL)
          OR (state = 'stopped' AND stopped_at IS NOT NULL AND stopped_at >= issued_at)))
);
    """)
    op.execute("""
CREATE OR REPLACE FUNCTION enforce_source_start_history() RETURNS trigger
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
                IF OLD.state = 'issued' AND NEW.state = 'stopped' THEN
                    IF (to_jsonb(OLD) - ARRAY['state', 'stopped_at']) IS DISTINCT FROM
                       (to_jsonb(NEW) - ARRAY['state', 'stopped_at'])
                       OR NEW.stopped_at IS NULL OR NEW.stopped_at < OLD.issued_at
                       OR NEW.stopped_at > clock_timestamp() THEN
                        RAISE EXCEPTION 'source stop history is immutable' USING ERRCODE = '23514';
                    END IF;
                ELSIF OLD.state <> 'prepared'
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


def downgrade() -> None:
    raise RuntimeError("expand recovery retains native source stop history")
