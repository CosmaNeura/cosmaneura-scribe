"""Add durable master-platform transcript deliveries.

Revision ID: 0003
Revises: 0002
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE transcript_deliveries (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            idempotency_key varchar(255) NOT NULL,
            payload_sha256 char(64) NOT NULL,
            status text NOT NULL,
            attempt_count integer NOT NULL DEFAULT 0,
            platform_transcript_id varchar(128),
            last_error_code varchar(64),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            UNIQUE (tenant_id, id),
            UNIQUE (tenant_id, session_id),
            UNIQUE (tenant_id, idempotency_key),
            CHECK (length(idempotency_key) BETWEEN 8 AND 255),
            CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
            CHECK (status IN ('pending', 'retryable', 'delivered', 'terminal')),
            CHECK (attempt_count >= 0),
            CHECK (
                (status = 'delivered' AND platform_transcript_id IS NOT NULL)
                OR (status <> 'delivered')
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX transcript_deliveries_tenant_status_idx
        ON transcript_deliveries (tenant_id, status, updated_at)
        """
    )
    op.execute("ALTER TABLE transcript_deliveries ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE transcript_deliveries FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY transcript_deliveries_tenant_isolation ON transcript_deliveries
        USING (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        WITH CHECK (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP POLICY IF EXISTS transcript_deliveries_tenant_isolation ON transcript_deliveries"
    )
    op.execute("ALTER TABLE transcript_deliveries DISABLE ROW LEVEL SECURITY")
    op.execute("DROP INDEX IF EXISTS transcript_deliveries_tenant_status_idx")
    op.execute("DROP TABLE IF EXISTS transcript_deliveries")
