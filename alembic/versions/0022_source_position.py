"""Expand immutable native starts with their initial chunk position.

Revision ID: 0022_source_position
Revises: 0021_source_stop
"""

from alembic import op

revision = "0022_source_position"
down_revision = "0021_source_stop"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
ALTER TABLE source_start_attempts
    ADD COLUMN first_sequence_number integer NOT NULL DEFAULT 0
        CHECK (first_sequence_number >= 0 AND first_sequence_number < 1000);
    """)
    op.execute("""
CREATE FUNCTION enforce_source_start_position() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE previous_position integer; issued_count integer;
BEGIN
    -- Same lock order as consent, capture leases and source-start history.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'scribe-consent:' || NEW.tenant_id::text || ':' || NEW.consent_record_id::text, 0));
    PERFORM 1 FROM public.scribe_sessions
        WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id FOR UPDATE;
    SELECT max(first_sequence_number), count(*) INTO previous_position, issued_count
        FROM public.source_start_attempts
        WHERE tenant_id = NEW.tenant_id AND session_id = NEW.session_id
            AND issued_at IS NOT NULL;
    IF issued_count >= 1000
       OR (previous_position IS NULL AND NEW.first_sequence_number <> 0)
       OR (previous_position IS NOT NULL AND NEW.first_sequence_number < previous_position) THEN
        RAISE EXCEPTION 'source start position is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
    """)
    op.execute("""
CREATE TRIGGER source_start_position BEFORE INSERT ON source_start_attempts
    FOR EACH ROW EXECUTE FUNCTION enforce_source_start_position();
    """)


def downgrade() -> None:
    raise RuntimeError("expand recovery retains native source positions")
