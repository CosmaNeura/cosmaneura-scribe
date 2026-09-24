"""INERT PROPOSAL: record absence closure without inventing a source start.

Revision ID: 0023_unstarted_retirement
Revises: 0022_source_position
"""
from alembic import op

revision = "0023_unstarted_retirement"
down_revision = "0022_source_position"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
CREATE TABLE source_start_retirements (
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
    first_sequence_number integer NOT NULL,
    retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, attempt_id),
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
    CHECK (first_sequence_number >= 0 AND first_sequence_number < 1000)
);
    """)
    op.execute("ALTER TABLE source_start_retirements ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE source_start_retirements FORCE ROW LEVEL SECURITY")
    op.execute("""
CREATE POLICY source_retirement_tenant ON source_start_retirements
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    """)
    op.execute("""
CREATE FUNCTION enforce_unstarted_retirement() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'source retirement history is immutable' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'scribe-consent:' || NEW.tenant_id::text || ':' || NEW.consent_record_id::text, 0));
    PERFORM 1 FROM public.scribe_sessions
        WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'scribe-native-attempt:' || NEW.tenant_id::text || ':' || NEW.attempt_id::text, 0));
    IF EXISTS (SELECT 1 FROM public.source_start_attempts
        WHERE tenant_id = NEW.tenant_id AND attempt_id = NEW.attempt_id) THEN
        RAISE EXCEPTION 'source attempt requires exact owner stop' USING ERRCODE = '23514';
    END IF;
    -- Historical authority is sufficient for cessation, including an expired,
    -- renewed, revoked or completed capture. It never grants another start.
    IF NEW.retired_at > clock_timestamp() OR NOT EXISTS (
        SELECT 1 FROM public.scribe_sessions AS s
        JOIN public.capture_lease_receipts AS receipt
          ON receipt.tenant_id = s.tenant_id AND receipt.session_id = s.id
        JOIN public.audio_chunk_reservation_batches AS batch
          ON batch.tenant_id = s.tenant_id AND batch.session_id = s.id
        JOIN public.audio_chunk_reservation_batch_items AS item
          ON item.tenant_id = batch.tenant_id AND item.session_id = batch.session_id
            AND item.batch_id = batch.id
        JOIN public.audio_chunk_reservations AS chunk
          ON chunk.tenant_id = item.tenant_id AND chunk.session_id = item.session_id
            AND chunk.object_id = item.object_id
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.session_id
          AND s.transcript_contract_version = '1.0' AND s.ingest_mode = 'chunk_upload'
          AND s.creator_actor_id = NEW.creator_actor_id AND s.consent_record_id = NEW.consent_record_id
          AND receipt.id = NEW.lease_receipt_id AND receipt.lease_id = NEW.lease_id
          AND receipt.generation = NEW.lease_generation AND receipt.expires_at = NEW.capture_authorized_until
          AND batch.lease_id = receipt.lease_id AND batch.lease_generation = receipt.generation
          AND batch.capture_authorized_until = receipt.expires_at
          AND chunk.channel = CASE WHEN NEW.source = 'desktop_companion' THEN 'mixed' ELSE 'microphone' END
          AND chunk.sequence_number = NEW.first_sequence_number
    ) THEN
        RAISE EXCEPTION 'source retirement history unavailable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
    """)
    op.execute("""
CREATE TRIGGER source_retirement_history
    BEFORE INSERT OR UPDATE OR DELETE ON source_start_retirements
    FOR EACH ROW EXECUTE FUNCTION enforce_unstarted_retirement();
    """)
    op.execute("""
CREATE FUNCTION enforce_source_retirement_fence() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.state IN ('prepared', 'issued') THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
            'scribe-consent:' || NEW.tenant_id::text || ':' || NEW.consent_record_id::text, 0));
        PERFORM 1 FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id FOR UPDATE;
        PERFORM pg_advisory_xact_lock(hashtextextended(
            'scribe-native-attempt:' || NEW.tenant_id::text || ':' || NEW.attempt_id::text, 0));
        IF EXISTS (SELECT 1 FROM public.source_start_retirements
            WHERE tenant_id = NEW.tenant_id AND attempt_id = NEW.attempt_id) THEN
            RAISE EXCEPTION 'source attempt has been retired' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
    """)
    op.execute("""
CREATE TRIGGER source_start_retirement_fence
    BEFORE INSERT OR UPDATE ON source_start_attempts
    FOR EACH ROW EXECUTE FUNCTION enforce_source_retirement_fence();
    """)


def downgrade() -> None:
    raise RuntimeError("expand recovery retains immutable source retirement history")
