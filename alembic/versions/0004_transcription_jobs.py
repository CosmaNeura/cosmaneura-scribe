"""Add leased transcription jobs.

Revision ID: 0004
Revises: 0003
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE transcription_jobs (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            status text NOT NULL,
            attempt_count integer NOT NULL,
            lease_token uuid,
            lease_until timestamptz,
            last_error_code varchar(64),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            UNIQUE (tenant_id, id),
            UNIQUE (tenant_id, session_id),
            CHECK (status IN ('processing', 'retryable', 'completed', 'terminal')),
            CHECK (attempt_count >= 1),
            CHECK (
                (status = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
                OR (status <> 'processing' AND lease_token IS NULL AND lease_until IS NULL)
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX transcription_jobs_claim_idx
        ON transcription_jobs (tenant_id, status, lease_until, updated_at)
        """
    )
    op.execute("ALTER TABLE transcription_jobs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE transcription_jobs FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY transcription_jobs_tenant_isolation ON transcription_jobs
        USING (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        WITH CHECK (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS transcription_jobs_tenant_isolation ON transcription_jobs")
    op.execute("DROP TABLE IF EXISTS transcription_jobs")
