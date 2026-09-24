"""Fence legacy child roots and prepare least-privilege source receipt.

Revision ID: 0011
Revises: 0010
"""

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'"
STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '60s'"

LEGACY_CHILD_ROOTS = (
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
)


def _lock_guarded_tables() -> None:
    op.execute(
        "LOCK TABLE scribe_sessions, " + ", ".join(LEGACY_CHILD_ROOTS) + " IN ACCESS EXCLUSIVE MODE"
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)
    op.execute("SET LOCAL row_security = off")
    _lock_guarded_tables()
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM public.scribe_sessions AS session
                JOIN (
                    SELECT tenant_id, session_id FROM public.audio_chunks
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.audio_upload_grants
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.session_audio_keys
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.transcripts
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.transcript_deliveries
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.transcription_jobs
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.capture_leases
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.audio_chunk_reservation_batches
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.audio_chunk_reservations
                    UNION ALL
                    SELECT tenant_id, session_id FROM public.capture_channel_finalizations
                ) AS child
                  ON child.tenant_id = session.tenant_id
                 AND child.session_id = session.id
                WHERE session.transcript_contract_version IS NOT NULL
            ) THEN
                RAISE EXCEPTION
                    'refusing legacy child guard while configured session owns legacy rows'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_legacy_child_session_discriminator()
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
    )
    op.execute(
        "REVOKE ALL PRIVILEGES ON FUNCTION "
        "public.enforce_legacy_child_session_discriminator() FROM PUBLIC"
    )
    for table in LEGACY_CHILD_ROOTS:
        op.execute(
            f"""
            CREATE TRIGGER {table}_legacy_session_only
            BEFORE INSERT OR UPDATE OF tenant_id, session_id ON public.{table}
            FOR EACH ROW
            EXECUTE FUNCTION public.enforce_legacy_child_session_discriminator()
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
                    'refusing legacy child guard downgrade outside a disposable test database'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    _lock_guarded_tables()
    for table in reversed(LEGACY_CHILD_ROOTS):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_legacy_session_only ON public.{table}")
    op.execute("DROP FUNCTION IF EXISTS public.enforce_legacy_child_session_discriminator()")
