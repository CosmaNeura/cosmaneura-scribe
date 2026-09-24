"""Add dormant normalized bilingual source storage.

Revision ID: 0009
Revises: 0008
"""

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'"
STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '60s'"

LEGACY_STATUS_VALUES = (
    "'created', 'capturing', 'uploaded', 'processing', 'transcript_ready', 'handed_off', 'failed'"
)
EXPANDED_STATUS_VALUES = (
    "'created', 'capturing', 'uploaded', 'processing', 'source_received', "
    "'translation_pending', 'review_required', 'quality_blocked', "
    "'transcript_ready', 'handed_off', 'failed'"
)

# This is the exact 0008 behavior for unconfigured legacy rows. Keep this
# migration independent of future runtime enums and renderers.
LEGACY_TRANSITION_PREDICATE = """
OLD.status = NEW.status
OR (OLD.status = 'created' AND NEW.status IN ('capturing', 'failed'))
OR (OLD.status = 'capturing' AND NEW.status IN ('uploaded', 'failed'))
OR (OLD.status = 'uploaded' AND NEW.status IN ('processing', 'transcript_ready', 'failed'))
OR (OLD.status = 'processing' AND NEW.status IN ('transcript_ready', 'failed'))
OR (OLD.status = 'transcript_ready' AND NEW.status IN ('handed_off', 'failed'))
OR (OLD.status = 'handed_off' AND NEW.status IN ('failed'))
OR (OLD.status = 'failed' AND NEW.status IN ('uploaded'))
""".strip()


def _replace_status_constraint(values: str) -> None:
    op.execute("ALTER TABLE scribe_sessions DROP CONSTRAINT IF EXISTS scribe_sessions_status_check")
    op.execute(
        "ALTER TABLE scribe_sessions "
        f"ADD CONSTRAINT scribe_sessions_status_check CHECK (status IN ({values})) NOT VALID"
    )
    op.execute("ALTER TABLE scribe_sessions VALIDATE CONSTRAINT scribe_sessions_status_check")


def _legacy_transition_function() -> str:
    return f"""
        CREATE OR REPLACE FUNCTION enforce_scribe_session_status_transition()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF {LEGACY_TRANSITION_PREDICATE}
               OR (
                   OLD.ingest_mode = 'external_async_transcript'
                   AND OLD.status = 'created'
                   AND NEW.status = 'transcript_ready'
               ) THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'invalid scribe session status transition: % -> %',
                OLD.status, NEW.status USING ERRCODE = '23514';
        END;
        $$
    """


def _versioned_transition_function() -> str:
    return f"""
        CREATE OR REPLACE FUNCTION enforce_scribe_session_status_transition()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            configured boolean := OLD.transcript_contract_version IS NOT NULL;
        BEGIN
            IF NOT configured THEN
                IF {LEGACY_TRANSITION_PREDICATE}
                   OR (
                       OLD.ingest_mode = 'external_async_transcript'
                       AND OLD.status = 'created'
                       AND NEW.status = 'transcript_ready'
                   ) THEN
                    RETURN NEW;
                END IF;
            ELSE
                IF OLD.status = NEW.status
                   OR (OLD.status = 'created' AND NEW.status = 'source_received')
                   OR (
                       OLD.status = 'source_received'
                       AND NEW.status IN (
                           'translation_pending', 'quality_blocked', 'transcript_ready'
                       )
                   )
                   OR (
                       OLD.status = 'translation_pending'
                       AND NEW.status IN ('source_received', 'review_required')
                   )
                   OR (
                       OLD.status = 'review_required'
                       AND NEW.status IN (
                           'source_received', 'translation_pending', 'transcript_ready'
                       )
                   )
                   OR (OLD.status = 'quality_blocked' AND NEW.status = 'source_received')
                   OR (
                       OLD.status = 'transcript_ready'
                       AND NEW.status IN ('source_received', 'handed_off')
                   ) THEN
                    RETURN NEW;
                END IF;

                IF NEW.status = 'failed'
                   AND OLD.status IN (
                       'created', 'source_received', 'translation_pending',
                       'review_required', 'quality_blocked', 'transcript_ready'
                   )
                   AND EXISTS (
                       SELECT 1
                       FROM external_session_terminal_events AS event
                       WHERE event.tenant_id = OLD.tenant_id
                         AND event.session_id = OLD.id
                         AND event.prior_status = OLD.status
                   ) THEN
                    RETURN NEW;
                END IF;
            END IF;

            RAISE EXCEPTION 'invalid scribe session status transition: % -> %',
                OLD.status, NEW.status USING ERRCODE = '23514';
        END;
        $$
    """


def _enable_tenant_isolation(table: str) -> None:
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


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)

    op.execute(
        """
        ALTER TABLE scribe_sessions
        ADD COLUMN transcript_contract_version varchar(16),
        ADD COLUMN creator_actor_id varchar(128),
        ADD COLUMN language_mode varchar(16),
        ADD COLUMN transcription_adapter_id varchar(128),
        ADD COLUMN transcription_model_profile_id varchar(128),
        ADD COLUMN normalization_profile_id varchar(128),
        ADD COLUMN source_received_at timestamptz,
        ADD COLUMN transcript_content_expires_at timestamptz,
        ADD COLUMN content_purged_at timestamptz,
        ADD COLUMN current_source_transcript_version integer
        """
    )
    op.execute(
        """
        ALTER TABLE scribe_sessions
        ADD CONSTRAINT scribe_sessions_external_configuration_check CHECK (
            num_nonnulls(
                transcript_contract_version,
                creator_actor_id,
                language_mode,
                transcription_adapter_id,
                transcription_model_profile_id,
                normalization_profile_id
            ) = 0
            OR (
                num_nonnulls(
                    transcript_contract_version,
                    creator_actor_id,
                    language_mode,
                    transcription_adapter_id,
                    transcription_model_profile_id,
                    normalization_profile_id
                ) = 6
                AND
                ingest_mode = 'external_async_transcript'
                AND transcript_contract_version = '1.0'
                AND language_mode IN ('en-US', 'en-US+es-US')
                AND creator_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                AND transcription_adapter_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                AND transcription_model_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                AND normalization_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
            )
        ) NOT VALID,
        ADD CONSTRAINT scribe_sessions_external_lifecycle_check CHECK (
            (
                source_received_at IS NULL
                AND transcript_content_expires_at IS NULL
                AND current_source_transcript_version IS NULL
                AND content_purged_at IS NULL
                AND (transcript_contract_version IS NULL OR status IN ('created', 'failed'))
            )
            OR COALESCE((
                transcript_contract_version = '1.0'
                AND source_received_at IS NOT NULL
                AND transcript_content_expires_at > source_received_at
                AND transcript_content_expires_at <= source_received_at + INTERVAL '14 days'
                AND (
                    (
                        content_purged_at IS NULL
                        AND current_source_transcript_version >= 1
                    )
                    OR (
                        content_purged_at >= source_received_at
                        AND current_source_transcript_version IS NULL
                    )
                )
            ), false)
        ) NOT VALID,
        ADD CONSTRAINT scribe_sessions_external_status_scope_check CHECK (
            (
                transcript_contract_version IS NULL
                AND status NOT IN (
                    'source_received', 'translation_pending',
                    'review_required', 'quality_blocked'
                )
            )
            OR (
                transcript_contract_version = '1.0'
                AND status IN (
                    'created', 'source_received', 'translation_pending',
                    'review_required', 'quality_blocked', 'transcript_ready',
                    'handed_off', 'failed'
                )
                AND (content_purged_at IS NULL OR status IN ('handed_off', 'failed'))
            )
        ) NOT VALID
        """
    )
    for constraint in (
        "scribe_sessions_external_configuration_check",
        "scribe_sessions_external_lifecycle_check",
        "scribe_sessions_external_status_scope_check",
    ):
        op.execute(f"ALTER TABLE scribe_sessions VALIDATE CONSTRAINT {constraint}")
    _replace_status_constraint(EXPANDED_STATUS_VALUES)
    op.execute(
        """
        CREATE FUNCTION enforce_versioned_external_session_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.transcript_contract_version IS NOT NULL THEN
                IF NEW.status <> 'created'
                   OR NEW.source_received_at IS NOT NULL
                   OR NEW.transcript_content_expires_at IS NOT NULL
                   OR NEW.content_purged_at IS NOT NULL
                   OR NEW.current_source_transcript_version IS NOT NULL THEN
                    RAISE EXCEPTION 'versioned external sessions must start unreceived'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER scribe_sessions_versioned_external_insert BEFORE INSERT
        ON scribe_sessions FOR EACH ROW
        EXECUTE FUNCTION enforce_versioned_external_session_insert()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_versioned_external_session_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.source_received_at IS NULL
               AND NEW.source_received_at IS NOT NULL THEN
                NEW.source_received_at := clock_timestamp();
            END IF;
            IF OLD.content_purged_at IS NULL
               AND NEW.content_purged_at IS NOT NULL THEN
                NEW.content_purged_at := clock_timestamp();
                IF (OLD.status = 'handed_off' AND NEW.status <> 'handed_off')
                   OR (OLD.status <> 'handed_off' AND NEW.status <> 'failed') THEN
                    RAISE EXCEPTION 'purge must preserve handoff or terminalize the session'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
            IF OLD.transcript_contract_version IS DISTINCT FROM NEW.transcript_contract_version
               OR OLD.creator_actor_id IS DISTINCT FROM NEW.creator_actor_id
               OR OLD.language_mode IS DISTINCT FROM NEW.language_mode
               OR OLD.transcription_adapter_id IS DISTINCT FROM NEW.transcription_adapter_id
               OR OLD.transcription_model_profile_id
                    IS DISTINCT FROM NEW.transcription_model_profile_id
               OR OLD.normalization_profile_id IS DISTINCT FROM NEW.normalization_profile_id THEN
                RAISE EXCEPTION 'versioned external session configuration is immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.transcript_contract_version IS NOT NULL
               AND (
                   OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
                   OR OLD.id IS DISTINCT FROM NEW.id
                   OR OLD.appointment_id IS DISTINCT FROM NEW.appointment_id
                   OR OLD.practitioner_id IS DISTINCT FROM NEW.practitioner_id
                   OR OLD.patient_id IS DISTINCT FROM NEW.patient_id
                   OR OLD.consent_record_id IS DISTINCT FROM NEW.consent_record_id
                   OR OLD.modality IS DISTINCT FROM NEW.modality
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at
               ) THEN
                RAISE EXCEPTION 'versioned external session identity is immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.source_received_at IS NULL THEN
                IF (NEW.source_received_at IS NULL)
                   <> (NEW.transcript_content_expires_at IS NULL) THEN
                    RAISE EXCEPTION 'source receipt and expiry anchors must be set together'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.source_received_at IS NOT NULL
                   AND (
                       NEW.current_source_transcript_version <> 1
                       OR NEW.status <> 'source_received'
                   ) THEN
                    RAISE EXCEPTION 'first source anchors require source version one'
                        USING ERRCODE = '23514';
                END IF;
            ELSIF OLD.source_received_at IS DISTINCT FROM NEW.source_received_at
               OR OLD.transcript_content_expires_at
                    IS DISTINCT FROM NEW.transcript_content_expires_at THEN
                RAISE EXCEPTION 'source receipt and expiry anchors are immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.status IN (
                   'translation_pending', 'review_required',
                   'quality_blocked', 'transcript_ready'
               )
               AND NEW.status = 'source_received'
               AND NEW.current_source_transcript_version IS DISTINCT FROM
                   OLD.current_source_transcript_version + 1 THEN
                RAISE EXCEPTION 'corrected source requires the next source version'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.current_source_transcript_version IS DISTINCT FROM
                    NEW.current_source_transcript_version THEN
                IF NEW.current_source_transcript_version IS NULL THEN
                    IF OLD.current_source_transcript_version IS NULL
                       OR NEW.content_purged_at IS NULL
                       OR NEW.status NOT IN ('handed_off', 'failed') THEN
                        RAISE EXCEPTION 'current source version clears only during purge'
                            USING ERRCODE = '23514';
                    END IF;
                ELSIF NEW.content_purged_at IS NOT NULL
                   OR NEW.transcript_content_expires_at IS NULL
                   OR clock_timestamp() >= NEW.transcript_content_expires_at
                   OR (
                       OLD.current_source_transcript_version IS NULL
                       AND NEW.current_source_transcript_version <> 1
                   )
                   OR (
                       OLD.current_source_transcript_version IS NOT NULL
                       AND NEW.current_source_transcript_version
                            <> OLD.current_source_transcript_version + 1
                   )
                   OR NEW.status <> 'source_received' THEN
                    RAISE EXCEPTION 'current source version is not a live monotonic successor'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
            IF OLD.content_purged_at IS NOT NULL
               AND OLD.content_purged_at IS DISTINCT FROM NEW.content_purged_at THEN
                RAISE EXCEPTION 'content purge marker is immutable' USING ERRCODE = '23514';
            END IF;
            IF OLD.content_purged_at IS NULL
               AND NEW.content_purged_at IS NOT NULL
               AND NEW.content_purged_at < NEW.source_received_at THEN
                RAISE EXCEPTION 'content purge cannot predate first source receipt'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.content_purged_at IS NOT NULL
               AND OLD.status IS DISTINCT FROM NEW.status THEN
                RAISE EXCEPTION 'purged versioned external session state is terminal'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.transcript_contract_version IS NOT NULL
               AND OLD.status IS DISTINCT FROM NEW.status
               AND OLD.transcript_content_expires_at IS NOT NULL
               AND clock_timestamp() >= OLD.transcript_content_expires_at
               AND NOT (
                   OLD.content_purged_at IS NULL
                   AND NEW.content_purged_at IS NOT NULL
                   AND NEW.status IN ('handed_off', 'failed')
               ) THEN
                RAISE EXCEPTION 'expired versioned external session state is fenced'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER scribe_sessions_versioned_external_update BEFORE UPDATE
        ON scribe_sessions FOR EACH ROW
        EXECUTE FUNCTION enforce_versioned_external_session_update()
        """
    )
    op.execute(
        """
        CREATE TABLE external_session_terminal_events (
            tenant_id uuid NOT NULL, session_id uuid NOT NULL,
            event_id uuid NOT NULL, prior_status text NOT NULL,
            failure_code varchar(64) NOT NULL,
            occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            principal_type varchar(16) NOT NULL, principal_id varchar(128) NOT NULL,
            PRIMARY KEY (tenant_id, session_id),
            UNIQUE (tenant_id, event_id),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id),
            CHECK (prior_status IN (
                'created', 'source_received', 'translation_pending',
                'review_required', 'quality_blocked', 'transcript_ready'
            )),
            CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
            CHECK (principal_type IN ('system', 'operator')),
            CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
        )
        """
    )
    op.execute(
        """
        CREATE TABLE normalized_source_transcripts (
            tenant_id uuid NOT NULL, session_id uuid NOT NULL,
            source_transcript_version integer NOT NULL, source_receipt_id uuid NOT NULL,
            schema_version varchar(16) NOT NULL, language_mode varchar(16) NOT NULL,
            transcription_adapter_id varchar(128) NOT NULL,
            transcription_model_profile_id varchar(128) NOT NULL,
            normalization_profile_id varchar(128) NOT NULL,
            duration_ms integer NOT NULL, segment_count smallint NOT NULL,
            total_content_chars integer NOT NULL,
            request_fingerprint char(64) NOT NULL,
            received_at timestamptz NOT NULL, transcript_content_expires_at timestamptz NOT NULL,
            PRIMARY KEY (tenant_id, session_id, source_transcript_version),
            UNIQUE (tenant_id, source_receipt_id),
            UNIQUE (
                tenant_id, session_id, source_transcript_version, request_fingerprint
            ),
            FOREIGN KEY (tenant_id, session_id)
                REFERENCES scribe_sessions (tenant_id, id) ON DELETE CASCADE,
            CHECK (source_transcript_version >= 1),
            CHECK (schema_version = '1.0'),
            CHECK (language_mode IN ('en-US', 'en-US+es-US')),
            CHECK (transcription_adapter_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
            CHECK (
                transcription_model_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
            ),
            CHECK (normalization_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
            CHECK (duration_ms BETWEEN 1 AND 86400000),
            CHECK (segment_count BETWEEN 1 AND 10000),
            CHECK (total_content_chars BETWEEN 1 AND 100000),
            CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
            CHECK (
                transcript_content_expires_at > received_at
                AND transcript_content_expires_at <= received_at + INTERVAL '14 days'
            )
        )
        """
    )
    op.execute(
        """
        CREATE TABLE normalized_source_segments (
            tenant_id uuid NOT NULL, session_id uuid NOT NULL,
            source_transcript_version integer NOT NULL, ordinal smallint NOT NULL,
            source_segment_id uuid NOT NULL, source_segment_version integer NOT NULL,
            source_locale varchar(16) NOT NULL, speaker_id uuid NOT NULL,
            speaker_role varchar(16) NOT NULL,
            content text NOT NULL,
            start_ms integer NOT NULL, end_ms integer NOT NULL,
            locale_confidence double precision,
            PRIMARY KEY (tenant_id, session_id, source_transcript_version, ordinal),
            UNIQUE (tenant_id, source_segment_id, source_segment_version),
            UNIQUE (tenant_id, session_id, source_transcript_version, source_segment_id),
            FOREIGN KEY (tenant_id, session_id, source_transcript_version)
                REFERENCES normalized_source_transcripts (
                    tenant_id, session_id, source_transcript_version
                ) ON DELETE CASCADE,
            CHECK (ordinal BETWEEN 0 AND 9999),
            CHECK (source_segment_version >= 1),
            CHECK (source_locale IN ('en-US', 'es-US', 'unknown')),
            CHECK (speaker_role IN ('clinician', 'patient', 'other', 'unknown')),
            CHECK (char_length(content) BETWEEN 1 AND 100000 AND btrim(content) <> ''),
            CHECK (start_ms >= 0 AND end_ms > start_ms),
            CHECK (
                locale_confidence IS NULL
                OR (
                    locale_confidence <> 'NaN'::double precision
                    AND locale_confidence BETWEEN 0.0 AND 1.0
                )
            )
        )
        """
    )
    op.execute(
        """
        CREATE TABLE normalized_source_receipt_keys (
            tenant_id uuid NOT NULL, session_id uuid NOT NULL,
            idempotency_key varchar(255) NOT NULL,
            source_transcript_version integer NOT NULL, request_fingerprint char(64) NOT NULL,
            bound_at timestamptz NOT NULL DEFAULT statement_timestamp(),
            PRIMARY KEY (tenant_id, session_id, idempotency_key),
            FOREIGN KEY (
                tenant_id, session_id, source_transcript_version, request_fingerprint
            ) REFERENCES normalized_source_transcripts (
                tenant_id, session_id, source_transcript_version, request_fingerprint
            ) ON DELETE CASCADE,
            CHECK (char_length(idempotency_key) BETWEEN 8 AND 255),
            CHECK (request_fingerprint ~ '^[a-f0-9]{64}$')
        )
        """
    )
    op.execute(
        """
        ALTER TABLE scribe_sessions ADD CONSTRAINT
            scribe_sessions_current_source_transcript_fkey
        FOREIGN KEY (tenant_id, id, current_source_transcript_version)
        REFERENCES normalized_source_transcripts (
            tenant_id, session_id, source_transcript_version
        ) DEFERRABLE INITIALLY DEFERRED NOT VALID
        """
    )
    op.execute(
        "ALTER TABLE scribe_sessions VALIDATE CONSTRAINT "
        "scribe_sessions_current_source_transcript_fkey"
    )
    op.execute(
        """
        CREATE FUNCTION enforce_versioned_external_session_precommit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            session_row scribe_sessions%ROWTYPE;
        BEGIN
            SELECT * INTO session_row
            FROM scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.id
            FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'versioned external session fence is unavailable'
                    USING ERRCODE = '23514';
            END IF;
            IF session_row.content_purged_at IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM normalized_source_transcripts
                    WHERE tenant_id = NEW.tenant_id AND session_id = NEW.id
                ) THEN
                    RAISE EXCEPTION 'completed purge cannot retain normalized source content'
                        USING ERRCODE = '23514';
                END IF;
            ELSIF session_row.transcript_content_expires_at IS NOT NULL
                  AND clock_timestamp() >= session_row.transcript_content_expires_at THEN
                RAISE EXCEPTION 'expired versioned external session cannot commit'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER scribe_sessions_external_precommit
        AFTER INSERT OR UPDATE ON scribe_sessions DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.transcript_contract_version IS NOT NULL)
        EXECUTE FUNCTION enforce_versioned_external_session_precommit()
        """
    )
    op.execute(
        """
        CREATE FUNCTION reject_normalized_source_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'normalized source evidence is immutable' USING ERRCODE = '23514';
        END;
        $$
        """
    )
    for table in (
        "normalized_source_transcripts",
        "normalized_source_segments",
        "normalized_source_receipt_keys",
    ):
        op.execute(
            f"""
            CREATE TRIGGER {table}_immutable BEFORE UPDATE ON {table} FOR EACH ROW
            EXECUTE FUNCTION reject_normalized_source_update()
            """
        )
    op.execute(
        """
        CREATE TRIGGER external_session_terminal_events_immutable
        BEFORE UPDATE OR DELETE ON external_session_terminal_events FOR EACH ROW
        EXECUTE FUNCTION reject_normalized_source_update()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_terminal_event_session()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            session_status text;
            session_contract varchar(16);
        BEGIN
            SELECT status, transcript_contract_version
            INTO session_status, session_contract
            FROM scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            NEW.occurred_at := clock_timestamp();
            IF session_contract IS DISTINCT FROM '1.0'
               OR session_status IS DISTINCT FROM NEW.prior_status THEN
                RAISE EXCEPTION 'terminal event does not match a configured external session'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER external_session_terminal_events_session_guard
        BEFORE INSERT ON external_session_terminal_events FOR EACH ROW
        EXECUTE FUNCTION enforce_terminal_event_session()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_terminal_event_committed_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM scribe_sessions
                WHERE tenant_id = NEW.tenant_id
                  AND id = NEW.session_id
                  AND transcript_contract_version = '1.0'
                  AND status = 'failed'
            ) THEN
                RAISE EXCEPTION 'terminal event requires a failed configured external session'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER external_session_terminal_events_committed_failure
        AFTER INSERT ON external_session_terminal_events DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION enforce_terminal_event_committed_failure()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_normalized_source_header()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            session_row scribe_sessions%ROWTYPE;
        BEGIN
            SELECT * INTO session_row
            FROM scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            IF NEW.source_transcript_version = 1 THEN
                NEW.received_at := session_row.source_received_at;
            ELSE
                NEW.received_at := clock_timestamp();
            END IF;
            IF session_row.transcript_contract_version IS DISTINCT FROM '1.0'
               OR session_row.ingest_mode IS DISTINCT FROM 'external_async_transcript'
               OR NEW.language_mode IS DISTINCT FROM session_row.language_mode
               OR NEW.transcription_adapter_id
                    IS DISTINCT FROM session_row.transcription_adapter_id
               OR NEW.transcription_model_profile_id
                    IS DISTINCT FROM session_row.transcription_model_profile_id
               OR NEW.normalization_profile_id
                    IS DISTINCT FROM session_row.normalization_profile_id
               OR session_row.status IS DISTINCT FROM 'source_received'
               OR NEW.source_transcript_version
                    IS DISTINCT FROM session_row.current_source_transcript_version
               OR NEW.transcript_content_expires_at
                    IS DISTINCT FROM session_row.transcript_content_expires_at
               OR session_row.content_purged_at IS NOT NULL
               OR clock_timestamp() >= session_row.transcript_content_expires_at
               OR (
                   NEW.source_transcript_version = 1
                   AND NEW.received_at IS DISTINCT FROM session_row.source_received_at
               )
               OR (
                   NEW.source_transcript_version > 1
                   AND NOT EXISTS (
                       SELECT 1
                       FROM normalized_source_transcripts AS prior_source
                       WHERE prior_source.tenant_id = NEW.tenant_id
                         AND prior_source.session_id = NEW.session_id
                         AND prior_source.source_transcript_version =
                             NEW.source_transcript_version - 1
                   )
               )
               OR NEW.received_at < session_row.source_received_at THEN
                RAISE EXCEPTION 'normalized source header does not match a live session fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER normalized_source_transcripts_session_guard
        BEFORE INSERT ON normalized_source_transcripts FOR EACH ROW
        EXECUTE FUNCTION enforce_normalized_source_header()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_normalized_source_child_fence()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            session_expiry timestamptz; session_purged_at timestamptz;
            session_source_version integer; session_status text;
        BEGIN
            SELECT
                transcript_content_expires_at,
                content_purged_at,
                current_source_transcript_version,
                status
            INTO session_expiry, session_purged_at, session_source_version, session_status
            FROM scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            IF session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR NEW.source_transcript_version IS DISTINCT FROM session_source_version
               OR session_status = 'failed'
               OR (
                   TG_TABLE_NAME = 'normalized_source_segments'
                   AND session_status <> 'source_received'
               ) THEN
                RAISE EXCEPTION 'normalized source child write is outside the live session fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    for table in (
        "normalized_source_segments",
        "normalized_source_receipt_keys",
    ):
        op.execute(
            f"""
            CREATE TRIGGER {table}_session_fence BEFORE INSERT ON {table} FOR EACH ROW
            EXECUTE FUNCTION enforce_normalized_source_child_fence()
            """
        )
    op.execute(
        """
        CREATE FUNCTION enforce_normalized_source_segment()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            source_duration integer; source_segment_count integer;
            source_language varchar(16);
        BEGIN
            SELECT duration_ms, language_mode, segment_count
            INTO source_duration, source_language, source_segment_count
            FROM normalized_source_transcripts
            WHERE tenant_id = NEW.tenant_id
              AND session_id = NEW.session_id
              AND source_transcript_version = NEW.source_transcript_version;
            IF source_duration IS NULL
               OR NEW.end_ms > source_duration
               OR NEW.ordinal >= source_segment_count
               OR (source_language = 'en-US' AND NEW.source_locale = 'es-US') THEN
                RAISE EXCEPTION 'normalized source segment does not match its header'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER normalized_source_segments_header_guard
        BEFORE INSERT ON normalized_source_segments FOR EACH ROW
        EXECUTE FUNCTION enforce_normalized_source_segment()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_normalized_source_aggregate()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            segment_count integer; total_characters bigint;
            invalid_order boolean; receipt_key_count integer;
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM normalized_source_transcripts
                WHERE tenant_id = NEW.tenant_id
                  AND session_id = NEW.session_id
                  AND source_transcript_version = NEW.source_transcript_version
            ) THEN
                RETURN NULL;
            END IF;
            SELECT count(*), COALESCE(sum(char_length(content)), 0)
            INTO segment_count, total_characters
            FROM normalized_source_segments
            WHERE tenant_id = NEW.tenant_id
              AND session_id = NEW.session_id
              AND source_transcript_version = NEW.source_transcript_version;
            SELECT EXISTS (
                SELECT 1
                FROM (
                    SELECT
                        ordinal,
                        row_number() OVER (ORDER BY ordinal) - 1 AS expected_ordinal,
                        start_ms,
                        end_ms,
                        lag(start_ms) OVER (ORDER BY ordinal) AS prior_start_ms,
                        lag(end_ms) OVER (ORDER BY ordinal) AS prior_end_ms
                    FROM normalized_source_segments
                    WHERE tenant_id = NEW.tenant_id
                      AND session_id = NEW.session_id
                      AND source_transcript_version = NEW.source_transcript_version
                ) AS ordered
                WHERE ordinal <> expected_ordinal
                   OR (
                       prior_start_ms IS NOT NULL
                       AND (
                           start_ms < prior_start_ms
                           OR (start_ms = prior_start_ms AND end_ms < prior_end_ms)
                       )
                   )
            ) INTO invalid_order;
            SELECT count(*) INTO receipt_key_count
            FROM normalized_source_receipt_keys
            WHERE tenant_id = NEW.tenant_id
              AND session_id = NEW.session_id
              AND source_transcript_version = NEW.source_transcript_version;
            IF segment_count IS DISTINCT FROM NEW.segment_count
               OR total_characters IS DISTINCT FROM NEW.total_content_chars
               OR invalid_order
               OR receipt_key_count < 1 THEN
                RAISE EXCEPTION 'normalized source aggregate is incomplete or out of bounds'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER normalized_source_transcripts_complete
        AFTER INSERT ON normalized_source_transcripts DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION enforce_normalized_source_aggregate()
        """
    )
    op.execute(
        """
        CREATE FUNCTION enforce_normalized_source_precommit_fence()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            session_expiry timestamptz; session_purged_at timestamptz;
            session_source_version integer; session_status text;
        BEGIN
            SELECT
                transcript_content_expires_at,
                content_purged_at,
                current_source_transcript_version,
                status
            INTO session_expiry, session_purged_at, session_source_version, session_status
            FROM scribe_sessions
            WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id
            FOR UPDATE;
            IF session_expiry IS NULL
               OR session_purged_at IS NOT NULL
               OR clock_timestamp() >= session_expiry
               OR NEW.source_transcript_version IS DISTINCT FROM session_source_version
               OR session_status = 'failed'
               OR (
                   TG_TABLE_NAME = 'normalized_source_transcripts'
                   AND session_status <> 'source_received'
               ) THEN
                RAISE EXCEPTION 'normalized source commit is outside the live session fence'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    for table in (
        "normalized_source_transcripts",
        "normalized_source_receipt_keys",
    ):
        op.execute(
            f"""
            CREATE CONSTRAINT TRIGGER {table}_precommit_fence
            AFTER INSERT ON {table} DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION enforce_normalized_source_precommit_fence()
            """
        )
    op.execute(
        """
        CREATE FUNCTION enforce_normalized_source_delete_fence()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            purge_marker timestamptz; session_found boolean;
        BEGIN
            SELECT content_purged_at, true
            INTO purge_marker, session_found
            FROM scribe_sessions
            WHERE tenant_id = OLD.tenant_id AND id = OLD.session_id
            FOR UPDATE;
            IF COALESCE(session_found, false) AND purge_marker IS NULL THEN
                RAISE EXCEPTION 'normalized source deletion requires the purge marker'
                    USING ERRCODE = '23514';
            END IF;
            RETURN OLD;
        END;
        $$
        """
    )
    for table in (
        "normalized_source_transcripts",
        "normalized_source_segments",
        "normalized_source_receipt_keys",
    ):
        op.execute(
            f"""
            CREATE TRIGGER {table}_delete_fence BEFORE DELETE ON {table} FOR EACH ROW
            EXECUTE FUNCTION enforce_normalized_source_delete_fence()
            """
        )
    for table in (
        "external_session_terminal_events",
        "normalized_source_transcripts",
        "normalized_source_segments",
        "normalized_source_receipt_keys",
    ):
        _enable_tenant_isolation(table)
    for function in (
        "enforce_versioned_external_session_insert",
        "enforce_versioned_external_session_update",
        "enforce_versioned_external_session_precommit",
        "reject_normalized_source_update",
        "enforce_terminal_event_session",
        "enforce_terminal_event_committed_failure",
        "enforce_normalized_source_header",
        "enforce_normalized_source_child_fence",
        "enforce_normalized_source_segment",
        "enforce_normalized_source_aggregate",
        "enforce_normalized_source_precommit_fence",
        "enforce_normalized_source_delete_fence",
    ):
        op.execute(f"REVOKE ALL PRIVILEGES ON FUNCTION {function}() FROM PUBLIC")
    op.execute(
        """
        CREATE INDEX scribe_sessions_external_content_expiry_idx
        ON scribe_sessions (transcript_content_expires_at, tenant_id, id)
        WHERE transcript_contract_version IS NOT NULL AND content_purged_at IS NULL
        """
    )
    op.execute(_versioned_transition_function())


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT_SQL)
    op.execute(STATEMENT_TIMEOUT_SQL)
    op.execute(
        """
        DO $$
        BEGIN
            IF current_database() !~ '_test$' THEN
                RAISE EXCEPTION
                    'refusing destructive bilingual source downgrade '
                    'outside a disposable test database'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )
    op.execute("SET LOCAL row_security = off")
    op.execute(
        """
        LOCK TABLE
            scribe_sessions,
            external_session_terminal_events,
            normalized_source_transcripts,
            normalized_source_segments,
            normalized_source_receipt_keys
        IN ACCESS EXCLUSIVE MODE
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM scribe_sessions
                WHERE transcript_contract_version IS NOT NULL
                   OR creator_actor_id IS NOT NULL
                   OR language_mode IS NOT NULL
                   OR transcription_adapter_id IS NOT NULL
                   OR transcription_model_profile_id IS NOT NULL
                   OR normalization_profile_id IS NOT NULL
                   OR source_received_at IS NOT NULL
                   OR transcript_content_expires_at IS NOT NULL
                   OR content_purged_at IS NOT NULL
                   OR current_source_transcript_version IS NOT NULL
                   OR status IN (
                       'source_received', 'translation_pending',
                       'review_required', 'quality_blocked'
                   )
            ) OR EXISTS (SELECT 1 FROM external_session_terminal_events)
              OR EXISTS (SELECT 1 FROM normalized_source_transcripts)
              OR EXISTS (SELECT 1 FROM normalized_source_segments)
              OR EXISTS (SELECT 1 FROM normalized_source_receipt_keys) THEN
                RAISE EXCEPTION
                    'refusing to remove bilingual source storage after it has been used'
                    USING ERRCODE = '55000';
            END IF;
        END;
        $$
        """
    )

    op.execute(_legacy_transition_function())
    op.execute("DROP INDEX IF EXISTS scribe_sessions_external_content_expiry_idx")
    op.execute("DROP TRIGGER IF EXISTS scribe_sessions_external_precommit ON scribe_sessions")
    for table in (
        "normalized_source_receipt_keys",
        "normalized_source_segments",
        "normalized_source_transcripts",
        "external_session_terminal_events",
    ):
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.execute(
        "DROP TRIGGER IF EXISTS normalized_source_transcripts_complete "
        "ON normalized_source_transcripts"
    )
    for table in (
        "normalized_source_receipt_keys",
        "normalized_source_transcripts",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_precommit_fence ON {table}")
    op.execute(
        "DROP TRIGGER IF EXISTS normalized_source_segments_header_guard "
        "ON normalized_source_segments"
    )
    for table in (
        "normalized_source_receipt_keys",
        "normalized_source_segments",
        "normalized_source_transcripts",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_delete_fence ON {table}")
    for table in (
        "normalized_source_receipt_keys",
        "normalized_source_segments",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_session_fence ON {table}")
    op.execute(
        "DROP TRIGGER IF EXISTS normalized_source_transcripts_session_guard "
        "ON normalized_source_transcripts"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS external_session_terminal_events_committed_failure "
        "ON external_session_terminal_events"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS external_session_terminal_events_session_guard "
        "ON external_session_terminal_events"
    )
    for table in (
        "external_session_terminal_events",
        "normalized_source_transcripts",
        "normalized_source_segments",
        "normalized_source_receipt_keys",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_immutable ON {table}")

    op.execute("DROP FUNCTION IF EXISTS enforce_normalized_source_aggregate()")
    op.execute("DROP FUNCTION IF EXISTS enforce_normalized_source_precommit_fence()")
    op.execute("DROP FUNCTION IF EXISTS enforce_normalized_source_segment()")
    op.execute("DROP FUNCTION IF EXISTS enforce_normalized_source_delete_fence()")
    op.execute("DROP FUNCTION IF EXISTS enforce_normalized_source_child_fence()")
    op.execute("DROP FUNCTION IF EXISTS enforce_normalized_source_header()")
    op.execute("DROP FUNCTION IF EXISTS enforce_terminal_event_committed_failure()")
    op.execute("DROP FUNCTION IF EXISTS enforce_terminal_event_session()")
    op.execute("DROP FUNCTION IF EXISTS reject_normalized_source_update()")
    op.execute("DROP FUNCTION IF EXISTS enforce_versioned_external_session_precommit()")
    op.execute(
        "ALTER TABLE scribe_sessions DROP CONSTRAINT "
        "IF EXISTS scribe_sessions_current_source_transcript_fkey"
    )
    op.execute("DROP TABLE IF EXISTS normalized_source_receipt_keys")
    op.execute("DROP TABLE IF EXISTS normalized_source_segments")
    op.execute("DROP TABLE IF EXISTS normalized_source_transcripts")
    op.execute("DROP TABLE IF EXISTS external_session_terminal_events")

    op.execute(
        "DROP TRIGGER IF EXISTS scribe_sessions_versioned_external_update ON scribe_sessions"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS scribe_sessions_versioned_external_insert ON scribe_sessions"
    )
    op.execute("DROP FUNCTION IF EXISTS enforce_versioned_external_session_update()")
    op.execute("DROP FUNCTION IF EXISTS enforce_versioned_external_session_insert()")
    op.execute(
        """
        ALTER TABLE scribe_sessions
        DROP CONSTRAINT IF EXISTS scribe_sessions_external_status_scope_check,
        DROP CONSTRAINT IF EXISTS scribe_sessions_external_lifecycle_check,
        DROP CONSTRAINT IF EXISTS scribe_sessions_external_configuration_check,
        DROP COLUMN IF EXISTS current_source_transcript_version,
        DROP COLUMN IF EXISTS content_purged_at,
        DROP COLUMN IF EXISTS transcript_content_expires_at,
        DROP COLUMN IF EXISTS source_received_at,
        DROP COLUMN IF EXISTS normalization_profile_id,
        DROP COLUMN IF EXISTS transcription_model_profile_id,
        DROP COLUMN IF EXISTS transcription_adapter_id,
        DROP COLUMN IF EXISTS language_mode,
        DROP COLUMN IF EXISTS creator_actor_id,
        DROP COLUMN IF EXISTS transcript_contract_version
        """
    )
    _replace_status_constraint(LEGACY_STATUS_VALUES)
