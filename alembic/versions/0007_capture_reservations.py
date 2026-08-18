"""Add staged capture leases, reservations, receipts, and finalization.

Revision ID: 0007
Revises: 0006
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

TENANT_TABLES = (
    "capture_leases",
    "capture_lease_receipts",
    "audio_chunk_reservation_batches",
    "audio_chunk_reservations",
    "audio_chunk_reservation_batch_items",
    "audio_upload_authorization_receipts",
    "capture_channel_finalizations",
)


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE capture_leases (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            lease_id uuid NOT NULL,
            generation integer NOT NULL,
            issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            renewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            expires_at timestamptz NOT NULL,
            closed_at timestamptz,
            close_reason varchar(32),
            PRIMARY KEY (tenant_id, session_id),
            UNIQUE (tenant_id, lease_id),
            UNIQUE (tenant_id, session_id, lease_id),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            CHECK (generation >= 1),
            CHECK (renewed_at >= issued_at),
            CHECK (
                expires_at > renewed_at
                AND expires_at <= renewed_at + INTERVAL '15 minutes'
            ),
            CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
            CHECK (closed_at IS NULL OR closed_at >= issued_at),
            CHECK (
                close_reason IS NULL OR close_reason IN (
                    'session_completed', 'consent_revoked',
                    'capture_stopped', 'session_failed'
                )
            )
        )
        """
    )
    op.execute(
        """
        CREATE TABLE capture_lease_receipts (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            lease_id uuid NOT NULL,
            generation integer NOT NULL,
            issued_at timestamptz NOT NULL,
            expires_at timestamptz NOT NULL,
            UNIQUE (tenant_id, id),
            UNIQUE (tenant_id, session_id, generation),
            FOREIGN KEY (tenant_id, session_id, lease_id)
                REFERENCES capture_leases (tenant_id, session_id, lease_id),
            CHECK (generation >= 1),
            CHECK (
                expires_at > issued_at
                AND expires_at <= issued_at + INTERVAL '15 minutes'
            )
        )
        """
    )
    op.execute(
        """
        CREATE TABLE audio_chunk_reservation_batches (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            lease_id uuid NOT NULL,
            lease_generation integer NOT NULL,
            requested_protocol_version varchar(16) NOT NULL,
            item_count smallint NOT NULL,
            created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            capture_authorized_until timestamptz NOT NULL,
            UNIQUE (tenant_id, id),
            UNIQUE (tenant_id, session_id, id),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            FOREIGN KEY (tenant_id, session_id, lease_id)
                REFERENCES capture_leases (tenant_id, session_id, lease_id),
            CHECK (lease_generation >= 1),
            CHECK (requested_protocol_version = '1.0'),
            CHECK (item_count BETWEEN 1 AND 90),
            CHECK (capture_authorized_until > created_at)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE audio_chunk_reservations (
            object_id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            sequence_number integer NOT NULL,
            channel text NOT NULL,
            protocol_version varchar(16) NOT NULL,
            additional_data bytea NOT NULL,
            plaintext_budget_bytes bigint NOT NULL,
            created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            UNIQUE (tenant_id, object_id),
            UNIQUE (tenant_id, session_id, object_id),
            UNIQUE (tenant_id, session_id, sequence_number, channel),
            UNIQUE (
                tenant_id, session_id, sequence_number, channel,
                object_id, protocol_version
            ),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            CHECK (sequence_number >= 0 AND sequence_number < 1000),
            CHECK (channel IN ('microphone', 'system_audio', 'mixed')),
            CHECK (protocol_version = '1.0'),
            CHECK (octet_length(additional_data) BETWEEN 1 AND 1024),
            CHECK (plaintext_budget_bytes = 327680)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE audio_chunk_reservation_batch_items (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            batch_id uuid NOT NULL,
            ordinal smallint NOT NULL,
            object_id uuid NOT NULL,
            PRIMARY KEY (tenant_id, batch_id, ordinal),
            UNIQUE (tenant_id, batch_id, object_id),
            FOREIGN KEY (tenant_id, session_id, batch_id)
                REFERENCES audio_chunk_reservation_batches (tenant_id, session_id, id),
            FOREIGN KEY (tenant_id, session_id, object_id)
                REFERENCES audio_chunk_reservations (tenant_id, session_id, object_id),
            CHECK (ordinal >= 0 AND ordinal < 90)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE audio_upload_authorization_receipts (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            reservation_object_id uuid NOT NULL,
            issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            expires_at timestamptz NOT NULL,
            UNIQUE (tenant_id, id),
            FOREIGN KEY (tenant_id, session_id, reservation_object_id)
                REFERENCES audio_chunk_reservations (tenant_id, session_id, object_id),
            CHECK (
                expires_at > issued_at
                AND expires_at <= issued_at + INTERVAL '15 minutes'
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX audio_upload_authorization_reservation_idx
        ON audio_upload_authorization_receipts (
            tenant_id, reservation_object_id, issued_at DESC
        )
        """
    )
    op.execute(
        """
        CREATE TABLE capture_channel_finalizations (
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            channel text NOT NULL,
            last_sequence_number integer NOT NULL,
            finalized_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            PRIMARY KEY (tenant_id, session_id, channel),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            CHECK (channel IN ('microphone', 'system_audio', 'mixed')),
            CHECK (last_sequence_number >= 0 AND last_sequence_number < 1000)
        )
        """
    )

    op.execute(
        """
        ALTER TABLE audio_chunks
        ADD COLUMN reservation_object_id uuid,
        ADD COLUMN protocol_version varchar(16) NOT NULL DEFAULT '1.0',
        ADD CONSTRAINT audio_chunks_tenant_object_unique
            UNIQUE (tenant_id, object_id),
        ADD CONSTRAINT audio_chunks_reservation_object_check
            CHECK (
                reservation_object_id IS NULL
                OR reservation_object_id = object_id
            ),
        ADD CONSTRAINT audio_chunks_protocol_version_check
            CHECK (protocol_version = '1.0'),
        ADD CONSTRAINT audio_chunks_reservation_binding_fk
            FOREIGN KEY (
                tenant_id, session_id, sequence_number, channel,
                reservation_object_id, protocol_version
            ) REFERENCES audio_chunk_reservations (
                tenant_id, session_id, sequence_number, channel,
                object_id, protocol_version
            )
        """
    )

    op.execute(
        """
        CREATE FUNCTION enforce_capture_lease_update()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF OLD.tenant_id <> NEW.tenant_id
               OR OLD.session_id <> NEW.session_id
               OR OLD.lease_id <> NEW.lease_id
               OR OLD.issued_at <> NEW.issued_at THEN
                RAISE EXCEPTION 'capture lease identity is immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.closed_at IS NOT NULL THEN
                RAISE EXCEPTION 'closed capture leases are immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW.closed_at IS NOT NULL THEN
                IF NEW.generation <> OLD.generation
                   OR NEW.renewed_at <> OLD.renewed_at
                   OR NEW.expires_at <> OLD.expires_at THEN
                    RAISE EXCEPTION 'capture lease close cannot renew'
                        USING ERRCODE = '23514';
                END IF;
                RETURN NEW;
            END IF;
            IF NEW.generation <> OLD.generation + 1
               OR NEW.renewed_at <= OLD.renewed_at
               OR NEW.expires_at <= NEW.renewed_at THEN
                RAISE EXCEPTION 'capture lease renewal is not fenced'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER capture_leases_fenced_update
        BEFORE UPDATE ON capture_leases
        FOR EACH ROW EXECUTE FUNCTION enforce_capture_lease_update()
        """
    )
    op.execute(
        """
        CREATE FUNCTION reject_capture_metadata_update()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            RAISE EXCEPTION 'capture metadata is immutable' USING ERRCODE = '23514';
        END;
        $$
        """
    )
    for table in (
        "capture_lease_receipts",
        "audio_chunk_reservation_batches",
        "audio_chunk_reservations",
        "audio_chunk_reservation_batch_items",
        "audio_upload_authorization_receipts",
        "capture_channel_finalizations",
    ):
        op.execute(
            f"""
            CREATE TRIGGER {table}_immutable
            BEFORE UPDATE ON {table}
            FOR EACH ROW EXECUTE FUNCTION reject_capture_metadata_update()
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

    for table in (
        "capture_channel_finalizations",
        "audio_upload_authorization_receipts",
        "audio_chunk_reservation_batch_items",
        "audio_chunk_reservations",
        "audio_chunk_reservation_batches",
        "capture_lease_receipts",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_immutable ON {table}")
    op.execute("DROP TRIGGER IF EXISTS capture_leases_fenced_update ON capture_leases")
    op.execute("DROP FUNCTION IF EXISTS reject_capture_metadata_update")
    op.execute("DROP FUNCTION IF EXISTS enforce_capture_lease_update")

    op.execute(
        """
        ALTER TABLE audio_chunks
        DROP CONSTRAINT IF EXISTS audio_chunks_reservation_binding_fk,
        DROP CONSTRAINT IF EXISTS audio_chunks_protocol_version_check,
        DROP CONSTRAINT IF EXISTS audio_chunks_reservation_object_check,
        DROP CONSTRAINT IF EXISTS audio_chunks_tenant_object_unique,
        DROP COLUMN IF EXISTS protocol_version,
        DROP COLUMN IF EXISTS reservation_object_id
        """
    )

    op.execute("DROP TABLE IF EXISTS capture_channel_finalizations")
    op.execute("DROP INDEX IF EXISTS audio_upload_authorization_reservation_idx")
    op.execute("DROP TABLE IF EXISTS audio_upload_authorization_receipts")
    op.execute("DROP TABLE IF EXISTS audio_chunk_reservation_batch_items")
    op.execute("DROP TABLE IF EXISTS audio_chunk_reservations")
    op.execute("DROP TABLE IF EXISTS audio_chunk_reservation_batches")
    op.execute("DROP TABLE IF EXISTS capture_lease_receipts")
    op.execute("DROP TABLE IF EXISTS capture_leases")
