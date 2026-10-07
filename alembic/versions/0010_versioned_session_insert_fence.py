"""Keep configured-session inserts compatible with least-privilege runtime grants.

Revision ID: 0010
Revises: 0009
"""

from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def _replace_precommit_function(*, insert_fast_path: bool) -> None:
    insert_guard = (
        """
            IF TG_OP = 'INSERT' THEN
                RETURN NULL;
            END IF;
    """
        if insert_fast_path
        else ""
    )
    declaration = (
        "session_purged_at timestamptz; session_expiry timestamptz;"
        if insert_fast_path
        else "session_row public.scribe_sessions%ROWTYPE;"
    )
    selection = (
        "SELECT content_purged_at, transcript_content_expires_at "
        "INTO session_purged_at, session_expiry"
        if insert_fast_path
        else "SELECT * INTO session_row"
    )
    purged_at = "session_purged_at" if insert_fast_path else "session_row.content_purged_at"
    expiry = "session_expiry" if insert_fast_path else "session_row.transcript_content_expires_at"
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION public.enforce_versioned_external_session_precommit()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            {declaration}
        BEGIN
{insert_guard}
            {selection}
            FROM public.scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.id
            FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'versioned external session fence is unavailable'
                    USING ERRCODE = '23514';
            END IF;
            IF {purged_at} IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM public.normalized_source_transcripts
                    WHERE tenant_id = NEW.tenant_id AND session_id = NEW.id
                ) THEN
                    RAISE EXCEPTION 'completed purge cannot retain normalized source content'
                        USING ERRCODE = '23514';
                END IF;
            ELSIF {expiry} IS NOT NULL
                  AND clock_timestamp() >= {expiry} THEN
                RAISE EXCEPTION 'expired versioned external session cannot commit'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION public.enforce_versioned_external_session_precommit() FROM PUBLIC"
    )


def upgrade() -> None:
    _replace_precommit_function(insert_fast_path=True)


def downgrade() -> None:
    _replace_precommit_function(insert_fast_path=False)
