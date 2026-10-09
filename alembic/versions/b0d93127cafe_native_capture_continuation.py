"""retain continuous native capture extensions

Revision ID: b0d93127cafe
Revises: 611c583b362a
Create Date: 2026-09-27
"""

from alembic import op

revision = "b0d93127cafe"
down_revision = "611c583b362a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '60s'")
    definitions = """
CREATE TABLE source_start_extensions (
    tenant_id uuid NOT NULL,
    session_id uuid NOT NULL,
    id uuid NOT NULL,
    source_start_id uuid NOT NULL,
    previous_extension_id uuid,
    lease_id uuid NOT NULL,
    lease_receipt_id uuid NOT NULL,
    lease_generation integer NOT NULL CHECK (lease_generation >= 2),
    previous_capture_authorized_until timestamptz NOT NULL,
    capture_authorized_until timestamptz NOT NULL,
    reservation_batch_id uuid NOT NULL,
    first_sequence_number integer NOT NULL CHECK (first_sequence_number BETWEEN 1 AND 2047),
    maximum_sequence_number integer NOT NULL CHECK (maximum_sequence_number BETWEEN 1 AND 2047),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    capability_id uuid NOT NULL,
    request_sha256 varchar(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, capability_id),
    UNIQUE (tenant_id, source_start_id, lease_generation),
    FOREIGN KEY (tenant_id, source_start_id) REFERENCES source_start_attempts(tenant_id, id),
    FOREIGN KEY (tenant_id, previous_extension_id)
        REFERENCES source_start_extensions(tenant_id, id),
    FOREIGN KEY (tenant_id, session_id, lease_id)
        REFERENCES capture_leases(tenant_id, session_id, lease_id),
    FOREIGN KEY (tenant_id, lease_receipt_id) REFERENCES capture_lease_receipts(tenant_id, id),
    FOREIGN KEY (tenant_id, session_id, reservation_batch_id)
        REFERENCES audio_chunk_reservation_batches(tenant_id, session_id, id),
    CHECK (maximum_sequence_number >= first_sequence_number
        AND maximum_sequence_number < first_sequence_number + 90),
    CHECK (issued_at < expires_at AND expires_at <= issued_at + INTERVAL '15 seconds'
        AND expires_at <= previous_capture_authorized_until
        AND capture_authorized_until > previous_capture_authorized_until)
);
CREATE UNIQUE INDEX source_extension_first ON source_start_extensions(tenant_id, source_start_id)
    WHERE previous_extension_id IS NULL;
CREATE UNIQUE INDEX source_extension_next
    ON source_start_extensions(tenant_id, previous_extension_id)
    WHERE previous_extension_id IS NOT NULL;
ALTER TABLE source_start_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_start_extensions FORCE ROW LEVEL SECURITY;
CREATE POLICY source_extension_tenant ON source_start_extensions
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    """
    for statement in definitions.split(";"):
        if statement.strip():
            op.execute(statement)
    op.execute("""
CREATE FUNCTION enforce_source_extension_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
    owner_row public.source_start_attempts%ROWTYPE;
    prior public.source_start_extensions%ROWTYPE;
    consent_id uuid;
    previous_generation integer;
    previous_deadline timestamptz;
    previous_position integer;
    previous_maximum integer;
    expected_channel text;
    actual_first integer;
    actual_last integer;
    actual_count integer;
    channels_match boolean;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'source extension history is retained' USING ERRCODE = '23514';
    END IF;
    SELECT consent_record_id INTO consent_id FROM public.scribe_sessions
        WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('scribe-consent:' || NEW.tenant_id::text
        || ':' || consent_id::text, 0));
    PERFORM 1 FROM public.scribe_sessions
        WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id FOR UPDATE;
    SELECT * INTO owner_row FROM public.source_start_attempts
        WHERE tenant_id = NEW.tenant_id AND id = NEW.source_start_id FOR UPDATE;
    IF NOT FOUND OR owner_row.session_id IS DISTINCT FROM NEW.session_id
        OR owner_row.state IS DISTINCT FROM 'issued'
        OR owner_row.lease_id IS DISTINCT FROM NEW.lease_id
        OR owner_row.consent_record_id IS DISTINCT FROM consent_id THEN
        RAISE EXCEPTION 'source extension owner unavailable' USING ERRCODE = '23514';
    END IF;
    expected_channel := CASE owner_row.source
        WHEN 'desktop_companion' THEN 'mixed' ELSE 'microphone' END;
    SELECT * INTO prior FROM public.source_start_extensions
        WHERE tenant_id = NEW.tenant_id AND source_start_id = NEW.source_start_id
        ORDER BY lease_generation DESC LIMIT 1;
    IF FOUND THEN
        IF NEW.previous_extension_id IS DISTINCT FROM prior.id THEN
            RAISE EXCEPTION 'source extension chain conflict' USING ERRCODE = '23514';
        END IF;
        previous_generation := prior.lease_generation;
        previous_deadline := prior.capture_authorized_until;
        previous_position := prior.first_sequence_number;
        previous_maximum := prior.maximum_sequence_number;
    ELSE
        IF NEW.previous_extension_id IS NOT NULL THEN
            RAISE EXCEPTION 'source extension predecessor missing' USING ERRCODE = '23514';
        END IF;
        previous_generation := owner_row.lease_generation;
        previous_deadline := owner_row.capture_authorized_until;
        previous_position := owner_row.first_sequence_number;
        SELECT max(r.sequence_number) INTO previous_maximum
            FROM public.audio_chunk_reservation_batches AS b
            JOIN public.audio_chunk_reservation_batch_items AS i
                ON i.tenant_id = b.tenant_id AND i.batch_id = b.id AND i.session_id = b.session_id
            JOIN public.audio_chunk_reservations AS r
                ON r.tenant_id = i.tenant_id AND r.session_id = i.session_id
                AND r.object_id = i.object_id
            WHERE b.tenant_id = NEW.tenant_id AND b.session_id = NEW.session_id
                AND b.lease_id = NEW.lease_id AND b.lease_generation = previous_generation
                AND r.channel = expected_channel;
    END IF;
    IF NEW.lease_generation <> previous_generation + 1
        OR NEW.previous_capture_authorized_until IS DISTINCT FROM previous_deadline
        OR previous_deadline <= clock_timestamp()
        OR NEW.issued_at > clock_timestamp()
        OR NEW.issued_at < clock_timestamp() - INTERVAL '5 seconds'
        OR NEW.expires_at <= clock_timestamp()
        OR NEW.first_sequence_number <= previous_position
        OR previous_maximum IS NULL OR NEW.maximum_sequence_number <= previous_maximum THEN
        RAISE EXCEPTION 'source extension window invalid' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.scribe_sessions AS s
        JOIN public.consent_records AS c ON c.tenant_id = s.tenant_id AND c.id = s.consent_record_id
        JOIN public.capture_leases AS l ON l.tenant_id = s.tenant_id AND l.session_id = s.id
        JOIN public.capture_lease_receipts AS r
            ON r.tenant_id = s.tenant_id AND r.id = NEW.lease_receipt_id
        JOIN public.session_audio_keys AS k ON k.tenant_id = s.tenant_id AND k.session_id = s.id
            WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.session_id
            AND s.transcript_contract_version = '1.0' AND s.ingest_mode = 'chunk_upload'
            AND s.status IN ('created', 'capturing') AND s.content_purged_at IS NULL
            AND (s.transcript_content_expires_at IS NULL
                OR s.transcript_content_expires_at > clock_timestamp())
            AND s.creator_actor_id = owner_row.creator_actor_id AND s.consent_record_id = consent_id
            AND c.all_parties_consented AND c.revoked_at IS NULL
            AND l.lease_id = NEW.lease_id AND l.generation = NEW.lease_generation
            AND l.closed_at IS NULL AND l.expires_at = NEW.capture_authorized_until
            AND r.session_id = s.id AND r.lease_id = l.lease_id
            AND r.generation = l.generation AND r.expires_at = l.expires_at
    ) THEN
        RAISE EXCEPTION 'source extension context unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT min(r.sequence_number), max(r.sequence_number), count(*),
        bool_and(r.channel = expected_channel)
        INTO actual_first, actual_last, actual_count, channels_match
        FROM public.audio_chunk_reservation_batches AS b
        JOIN public.audio_chunk_reservation_batch_items AS i
            ON i.tenant_id = b.tenant_id AND i.batch_id = b.id AND i.session_id = b.session_id
        JOIN public.audio_chunk_reservations AS r
            ON r.tenant_id = i.tenant_id AND r.session_id = i.session_id
            AND r.object_id = i.object_id
        WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.reservation_batch_id
            AND b.session_id = NEW.session_id AND b.lease_id = NEW.lease_id
            AND b.lease_generation = NEW.lease_generation
            AND b.capture_authorized_until = NEW.capture_authorized_until
            AND b.item_count = NEW.maximum_sequence_number - NEW.first_sequence_number + 1;
    IF actual_first IS DISTINCT FROM NEW.first_sequence_number
        OR actual_last IS DISTINCT FROM NEW.maximum_sequence_number
        OR actual_count <> NEW.maximum_sequence_number - NEW.first_sequence_number + 1
        OR channels_match IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'source extension reservation unavailable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
    """)
    op.execute("""
CREATE TRIGGER source_extension_history BEFORE INSERT OR UPDATE OR DELETE
    ON source_start_extensions FOR EACH ROW EXECUTE FUNCTION enforce_source_extension_history();
    """)


def downgrade() -> None:
    raise RuntimeError("expand recovery retains dormant native extension history")
