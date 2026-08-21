"""Add consent revocation and provider-neutral external transcript ingestion.

Revision ID: 0008
Revises: 0007
"""

from cosmaneura_scribe.session_state_v1 import render_transition_predicate

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def _transition_function(predicate: str) -> str:
    return f"""
        CREATE OR REPLACE FUNCTION enforce_scribe_session_status_transition()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF {predicate} THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'invalid scribe session status transition: % -> %',
                OLD.status, NEW.status
                USING ERRCODE = '23514';
        END;
        $$
    """


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE scribe_sessions
        ADD COLUMN ingest_mode text NOT NULL DEFAULT 'chunk_upload',
        ADD CONSTRAINT scribe_sessions_ingest_mode_check
            CHECK (ingest_mode IN ('chunk_upload', 'external_async_transcript'))
        """
    )
    op.execute(
        _transition_function(
            render_transition_predicate(ingest_mode_expression="OLD.ingest_mode")
        )
    )
    op.execute(
        """
        CREATE FUNCTION reject_scribe_session_ingest_mode_mutation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            RAISE EXCEPTION 'scribe session ingest mode is immutable'
                USING ERRCODE = '23514';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER scribe_sessions_ingest_mode_immutable
        BEFORE UPDATE OF ingest_mode ON scribe_sessions
        FOR EACH ROW
        WHEN (OLD.ingest_mode IS DISTINCT FROM NEW.ingest_mode)
        EXECUTE FUNCTION reject_scribe_session_ingest_mode_mutation()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_consent_revocation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'consent revocation is immutable'
                USING ERRCODE = '23514';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER consent_records_revocation_immutable
        BEFORE UPDATE OF revoked_at ON consent_records
        FOR EACH ROW
        WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
        EXECUTE FUNCTION enforce_consent_revocation()
        """
    )


def downgrade() -> None:
    op.execute(_transition_function(render_transition_predicate()))
    op.execute(
        "DROP TRIGGER IF EXISTS scribe_sessions_ingest_mode_immutable ON scribe_sessions"
    )
    op.execute("DROP FUNCTION IF EXISTS reject_scribe_session_ingest_mode_mutation")
    op.execute("DROP TRIGGER IF EXISTS consent_records_revocation_immutable ON consent_records")
    op.execute("DROP FUNCTION IF EXISTS enforce_consent_revocation")
    op.execute(
        "ALTER TABLE scribe_sessions "
        "DROP CONSTRAINT IF EXISTS scribe_sessions_ingest_mode_check"
    )
    op.execute("ALTER TABLE scribe_sessions DROP COLUMN IF EXISTS ingest_mode")
