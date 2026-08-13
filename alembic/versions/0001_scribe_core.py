"""Create consent, custody, transcript, and audit core.

Revision ID: 0001
Revises: None
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE consent_records (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            appointment_id uuid NOT NULL,
            practitioner_id uuid NOT NULL,
            patient_id uuid NOT NULL,
            modality text NOT NULL,
            participant_regions text[] NOT NULL,
            method text NOT NULL,
            all_parties_consented boolean NOT NULL,
            granted_at timestamptz NOT NULL,
            evidence_object_id uuid,
            policy_version text NOT NULL,
            revoked_at timestamptz,
            UNIQUE (tenant_id, id),
            CHECK (all_parties_consented)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE scribe_sessions (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            appointment_id uuid NOT NULL,
            practitioner_id uuid NOT NULL,
            patient_id uuid NOT NULL,
            consent_record_id uuid NOT NULL,
            modality text NOT NULL,
            status text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (tenant_id, consent_record_id)
                REFERENCES consent_records (tenant_id, id),
            UNIQUE (tenant_id, id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE audio_chunks (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            sequence_number integer NOT NULL,
            channel text NOT NULL,
            object_id uuid NOT NULL,
            sha256 char(64) NOT NULL,
            ciphertext_size_bytes bigint NOT NULL,
            registered_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            UNIQUE (tenant_id, session_id, sequence_number, channel)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE transcripts (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            language_code text NOT NULL,
            stt_provider text NOT NULL,
            segments jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            UNIQUE (tenant_id, session_id),
            UNIQUE (tenant_id, id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE audit_events (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            action text NOT NULL,
            entity_type text NOT NULL,
            entity_id uuid NOT NULL,
            occurred_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS audit_events")
    op.execute("DROP TABLE IF EXISTS transcripts")
    op.execute("DROP TABLE IF EXISTS audio_chunks")
    op.execute("DROP TABLE IF EXISTS scribe_sessions")
    op.execute("DROP TABLE IF EXISTS consent_records")
