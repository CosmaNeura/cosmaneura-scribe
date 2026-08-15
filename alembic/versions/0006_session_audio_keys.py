"""Add immutable per-session wrapped audio keys.

Revision ID: 0006
Revises: 0005
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE session_audio_keys (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            key_version varchar(128) NOT NULL,
            wrapped_dek varchar(512) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, session_id),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            CHECK (key_version ~ '^[A-Za-z0-9_-]{1,128}$'),
            CHECK (
                char_length(wrapped_dek) = 512
                AND wrapped_dek ~ '^[A-Za-z0-9_-]+$'
            )
        )
        """
    )
    op.execute(
        """
        CREATE FUNCTION reject_session_audio_key_update()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            RAISE EXCEPTION 'session audio keys are immutable' USING ERRCODE = '23514';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER session_audio_keys_immutable
        BEFORE UPDATE ON session_audio_keys
        FOR EACH ROW EXECUTE FUNCTION reject_session_audio_key_update()
        """
    )
    op.execute("ALTER TABLE session_audio_keys ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE session_audio_keys FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY session_audio_keys_tenant_isolation ON session_audio_keys
        USING (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        WITH CHECK (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS session_audio_keys_tenant_isolation ON session_audio_keys")
    op.execute("ALTER TABLE session_audio_keys DISABLE ROW LEVEL SECURITY")
    op.execute("DROP TRIGGER IF EXISTS session_audio_keys_immutable ON session_audio_keys")
    op.execute("DROP FUNCTION IF EXISTS reject_session_audio_key_update")
    op.execute("DROP TABLE IF EXISTS session_audio_keys")
