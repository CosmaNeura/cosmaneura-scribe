"""Add dormant external transcript ingest mode to Scribe sessions.

Revision ID: 0008
Revises: 0007
"""

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'"
STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '60s'"

# Keep historical migration behavior pinned. Tests verify these predicates stay
# aligned with the domain renderer without making a past migration depend on
# future application-code changes.
CHUNK_UPLOAD_TRANSITION_PREDICATE = """
OLD.status = NEW.status
OR (OLD.status = 'created' AND NEW.status IN ('capturing', 'failed'))
OR (OLD.status = 'capturing' AND NEW.status IN ('uploaded', 'failed'))
OR (OLD.status = 'uploaded' AND NEW.status IN ('processing', 'transcript_ready', 'failed'))
OR (OLD.status = 'processing' AND NEW.status IN ('transcript_ready', 'failed'))
OR (OLD.status = 'transcript_ready' AND NEW.status IN ('handed_off', 'failed'))
OR (OLD.status = 'handed_off' AND NEW.status IN ('failed'))
OR (OLD.status = 'failed' AND NEW.status IN ('uploaded'))
""".strip()

INGEST_MODE_TRANSITION_PREDICATE = f"""
{CHUNK_UPLOAD_TRANSITION_PREDICATE}
OR (OLD.ingest_mode = 'external_async_transcript'
    AND OLD.status = 'created'
    AND NEW.status = 'transcript_ready')
""".strip()


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
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)
    op.execute(
        """
        ALTER TABLE scribe_sessions
        ADD COLUMN ingest_mode text NOT NULL DEFAULT 'chunk_upload',
        ADD CONSTRAINT scribe_sessions_ingest_mode_check
            CHECK (ingest_mode IN ('chunk_upload', 'external_async_transcript'))
        """
    )
    op.execute(_transition_function(INGEST_MODE_TRANSITION_PREDICATE))
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


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)
    op.execute(
        """
        DO $$
        BEGIN
            IF current_database() !~ '_test$' THEN
                RAISE EXCEPTION
                    'refusing destructive ingest_mode downgrade outside a disposable test database'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    op.execute("SET LOCAL row_security = off")
    op.execute("LOCK TABLE scribe_sessions IN ACCESS EXCLUSIVE MODE")
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM scribe_sessions
                WHERE ingest_mode = 'external_async_transcript'
            ) THEN
                RAISE EXCEPTION
                    'refusing to remove ingest_mode while external-mode rows exist'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    op.execute(_transition_function(CHUNK_UPLOAD_TRANSITION_PREDICATE))
    op.execute("DROP TRIGGER IF EXISTS scribe_sessions_ingest_mode_immutable ON scribe_sessions")
    op.execute("DROP FUNCTION IF EXISTS reject_scribe_session_ingest_mode_mutation()")
    op.execute(
        "ALTER TABLE scribe_sessions DROP CONSTRAINT IF EXISTS scribe_sessions_ingest_mode_check"
    )
    op.execute("ALTER TABLE scribe_sessions DROP COLUMN IF EXISTS ingest_mode")
