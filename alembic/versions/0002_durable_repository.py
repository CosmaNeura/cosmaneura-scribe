"""Add durable repository controls and tenant isolation.

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TENANT_TABLES = (
    "consent_records",
    "scribe_sessions",
    "audio_chunks",
    "audio_upload_grants",
    "transcripts",
    "idempotency_records",
    "audit_events",
)


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE audio_upload_grants (
            object_id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            sequence_number integer NOT NULL CHECK (sequence_number >= 0),
            channel text NOT NULL CHECK (channel IN ('microphone', 'system_audio', 'mixed')),
            expires_at timestamptz NOT NULL,
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            UNIQUE (tenant_id, object_id),
            UNIQUE (tenant_id, session_id, sequence_number, channel)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE idempotency_records (
            tenant_id uuid NOT NULL,
            operation varchar(255) NOT NULL,
            idempotency_key varchar(255) NOT NULL,
            request_fingerprint char(64) NOT NULL,
            entity_id uuid NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, operation, idempotency_key),
            CHECK (length(idempotency_key) BETWEEN 8 AND 255),
            CHECK (request_fingerprint ~ '^[a-f0-9]{64}$')
        )
        """
    )

    op.execute(
        """
        ALTER TABLE consent_records
        ADD CONSTRAINT consent_records_modality_check
            CHECK (modality IN ('in_person', 'virtual', 'phone')),
        ADD CONSTRAINT consent_records_method_check
            CHECK (method IN ('pre_visit_form', 'verbal_attestation', 'phone_ivr'))
        """
    )
    op.execute(
        """
        ALTER TABLE scribe_sessions
        ADD CONSTRAINT scribe_sessions_modality_check
            CHECK (modality IN ('in_person', 'virtual', 'phone')),
        ADD CONSTRAINT scribe_sessions_status_check
            CHECK (status IN (
                'created', 'capturing', 'uploaded', 'processing',
                'transcript_ready', 'handed_off', 'failed'
            ))
        """
    )
    op.execute(
        """
        ALTER TABLE audio_chunks
        ADD CONSTRAINT audio_chunks_sequence_check CHECK (sequence_number >= 0),
        ADD CONSTRAINT audio_chunks_channel_check
            CHECK (channel IN ('microphone', 'system_audio', 'mixed')),
        ADD CONSTRAINT audio_chunks_sha256_check CHECK (sha256 ~ '^[a-fA-F0-9]{64}$'),
        ADD CONSTRAINT audio_chunks_size_check
            CHECK (ciphertext_size_bytes > 0 AND ciphertext_size_bytes <= 100000000)
        """
    )
    op.execute(
        """
        CREATE INDEX scribe_sessions_tenant_appointment_idx
        ON scribe_sessions (tenant_id, appointment_id)
        """
    )
    op.execute(
        """
        CREATE INDEX audit_events_tenant_occurred_idx
        ON audit_events (tenant_id, occurred_at DESC)
        """
    )

    op.execute(
        """
        CREATE FUNCTION enforce_scribe_session_status_transition()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF OLD.status = NEW.status THEN
                RETURN NEW;
            END IF;
            IF (OLD.status = 'created' AND NEW.status IN ('capturing', 'failed'))
               OR (OLD.status = 'capturing' AND NEW.status IN ('uploaded', 'failed'))
               OR (
                   OLD.status = 'uploaded'
                   AND NEW.status IN ('processing', 'transcript_ready', 'failed')
               )
               OR (OLD.status = 'processing' AND NEW.status IN ('transcript_ready', 'failed'))
               OR (OLD.status = 'transcript_ready' AND NEW.status IN ('handed_off', 'failed'))
               OR (OLD.status = 'handed_off' AND NEW.status = 'failed') THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'invalid scribe session status transition: % -> %',
                OLD.status, NEW.status
                USING ERRCODE = '23514';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER scribe_sessions_status_transition
        BEFORE UPDATE OF status ON scribe_sessions
        FOR EACH ROW EXECUTE FUNCTION enforce_scribe_session_status_transition()
        """
    )
    op.execute(
        """
        CREATE FUNCTION reject_audit_event_mutation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '23514';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_events_append_only
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation()
        """
    )

    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"""
            CREATE POLICY {table}_tenant_isolation ON {table}
            USING (
                tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            )
            WITH CHECK (
                tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            )
            """
        )


def downgrade() -> None:
    for table in reversed(TENANT_TABLES):
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.execute("DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events")
    op.execute("DROP FUNCTION IF EXISTS reject_audit_event_mutation")
    op.execute("DROP TRIGGER IF EXISTS scribe_sessions_status_transition ON scribe_sessions")
    op.execute("DROP FUNCTION IF EXISTS enforce_scribe_session_status_transition")
    op.execute("DROP INDEX IF EXISTS audit_events_tenant_occurred_idx")
    op.execute("DROP INDEX IF EXISTS scribe_sessions_tenant_appointment_idx")
    op.execute("ALTER TABLE audio_chunks DROP CONSTRAINT IF EXISTS audio_chunks_size_check")
    op.execute("ALTER TABLE audio_chunks DROP CONSTRAINT IF EXISTS audio_chunks_sha256_check")
    op.execute("ALTER TABLE audio_chunks DROP CONSTRAINT IF EXISTS audio_chunks_channel_check")
    op.execute("ALTER TABLE audio_chunks DROP CONSTRAINT IF EXISTS audio_chunks_sequence_check")
    op.execute("ALTER TABLE scribe_sessions DROP CONSTRAINT IF EXISTS scribe_sessions_status_check")
    op.execute(
        "ALTER TABLE scribe_sessions DROP CONSTRAINT IF EXISTS scribe_sessions_modality_check"
    )
    op.execute("ALTER TABLE consent_records DROP CONSTRAINT IF EXISTS consent_records_method_check")
    op.execute(
        "ALTER TABLE consent_records DROP CONSTRAINT IF EXISTS consent_records_modality_check"
    )
    op.execute("DROP TABLE IF EXISTS idempotency_records")
    op.execute("DROP TABLE IF EXISTS audio_upload_grants")
