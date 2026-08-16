from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from azure.core.credentials import AccessToken
from azure.identity.aio import DefaultAzureCredential
from sqlalchemy import text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .repository import (
    AudioAssemblyManifest,
    DeliveryClaimPolicy,
    DeliverySessionSyncResult,
    DeliverySuccessCompletion,
    DeliverySuccessConflictError,
    IdempotencyClaimUnavailableError,
    IdempotencyConflictError,
    IdempotencyRecord,
    Repository,
    UploadGrantRecord,
)
from .schemas import (
    AudioChunk,
    CaptureSession,
    ConsentRecord,
    DeliveryAttempt,
    DeliveryConsentSource,
    DeliveryPayloadSource,
    DeliverySessionSource,
    DeliveryStatus,
    DeliveryTranscriptSource,
    SessionAudioKey,
    Transcript,
    TranscriptDelivery,
    TranscriptionJob,
)
from .settings import Settings

AZURE_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"


class PostgresRepositoryProvider:
    def __init__(
        self,
        engine: AsyncEngine,
        credential: DefaultAzureCredential | None = None,
    ) -> None:
        self._engine = engine
        self._sessions = async_sessionmaker(engine, expire_on_commit=False)
        self._credential = credential

    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        async with self._sessions() as session, session.begin():
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            yield PostgresRepository(session)

    async def health(self) -> None:
        async with self._engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def close(self) -> None:
        await self._engine.dispose()
        if self._credential is not None:
            await self._credential.close()


class PostgresRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
    ) -> IdempotencyRecord | None:
        row = await self._one_or_none(
            """
            SELECT request_fingerprint, entity_id
            FROM idempotency_records
            WHERE tenant_id = :tenant_id
              AND operation = :operation
              AND idempotency_key = :idempotency_key
            """,
            tenant_id=tenant_id,
            operation=operation,
            idempotency_key=key,
        )
        return IdempotencyRecord(**row) if row is not None else None

    async def claim_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
        request_fingerprint: str,
        entity_id: UUID,
    ) -> UUID | None:
        await self._session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
            {"lock_key": f"{tenant_id}:{operation}:{key}"},
        )
        inserted = await self._session.execute(
            text(
                """
                INSERT INTO idempotency_records (
                    tenant_id, operation, idempotency_key, request_fingerprint, entity_id
                ) VALUES (
                    :tenant_id, :operation, :idempotency_key, :request_fingerprint, :entity_id
                )
                ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING
                RETURNING entity_id
                """
            ),
            {
                "tenant_id": tenant_id,
                "operation": operation,
                "idempotency_key": key,
                "request_fingerprint": request_fingerprint,
                "entity_id": entity_id,
            },
        )
        if inserted.scalar_one_or_none() is not None:
            return None

        previous = (
            (
                await self._session.execute(
                    text(
                        """
                    SELECT request_fingerprint, entity_id
                    FROM idempotency_records
                    WHERE tenant_id = :tenant_id
                      AND operation = :operation
                      AND idempotency_key = :idempotency_key
                    """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "operation": operation,
                        "idempotency_key": key,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        if previous is None:
            raise IdempotencyClaimUnavailableError
        if previous["request_fingerprint"] != request_fingerprint:
            raise IdempotencyConflictError
        return previous["entity_id"]

    async def get_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None:
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, modality,
                   participant_regions, method, all_parties_consented, granted_at,
                   evidence_object_id, policy_version, revoked_at
            FROM consent_records
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=consent_id,
        )
        return ConsentRecord.model_validate(row) if row is not None else None

    async def add_consent(self, tenant_id: UUID, consent: ConsentRecord) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO consent_records (
                    id, tenant_id, appointment_id, practitioner_id, patient_id, modality,
                    participant_regions, method, all_parties_consented, granted_at,
                    evidence_object_id, policy_version, revoked_at
                ) VALUES (
                    :id, :tenant_id, :appointment_id, :practitioner_id, :patient_id, :modality,
                    :participant_regions, :method, :all_parties_consented, :granted_at,
                    :evidence_object_id, :policy_version, :revoked_at
                )
                """
            ),
            {
                **consent.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "modality": consent.modality.value,
                "method": consent.method.value,
                "participant_regions": sorted(consent.participant_regions),
            },
        )

    async def get_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, status, created_at
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=session_id,
        )
        return CaptureSession.model_validate(row) if row is not None else None

    async def lock_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, status, created_at
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :id
            FOR UPDATE
            """,
            tenant_id=tenant_id,
            id=session_id,
        )
        return CaptureSession.model_validate(row) if row is not None else None

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO scribe_sessions (
                    id, tenant_id, appointment_id, practitioner_id, patient_id,
                    consent_record_id, modality, status, created_at
                ) VALUES (
                    :id, :tenant_id, :appointment_id, :practitioner_id, :patient_id,
                    :consent_record_id, :modality, :status, :created_at
                )
                """
            ),
            {
                **session.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "modality": session.modality.value,
                "status": session.status.value,
            },
        )

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self._session.execute(
            text(
                """
                UPDATE scribe_sessions
                SET status = :status
                WHERE tenant_id = :tenant_id AND id = :id
                """
            ),
            {"tenant_id": tenant_id, "id": session.id, "status": session.status.value},
        )

    async def get_session_audio_key(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> SessionAudioKey | None:
        row = await self._one_or_none(
            """
            SELECT session_id, key_version, wrapped_dek, created_at
            FROM session_audio_keys
            WHERE tenant_id = :tenant_id AND session_id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return SessionAudioKey.model_validate(row) if row is not None else None

    async def add_session_audio_key(
        self,
        tenant_id: UUID,
        audio_key: SessionAudioKey,
    ) -> bool:
        inserted = await self._session.execute(
            text(
                """
                INSERT INTO session_audio_keys (
                    tenant_id, session_id, key_version, wrapped_dek, created_at
                ) VALUES (
                    :tenant_id, :session_id, :key_version, :wrapped_dek, :created_at
                )
                ON CONFLICT (tenant_id, session_id) DO NOTHING
                RETURNING session_id
                """
            ),
            {"tenant_id": tenant_id, **audio_key.model_dump(mode="python")},
        )
        return inserted.scalar_one_or_none() is not None

    async def get_audio_assembly_manifest(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        job_id: UUID,
        lease_token: UUID,
        now: datetime,
    ) -> AudioAssemblyManifest | None:
        row = await self._one_or_none(
            """
            SELECT audio_key.session_id, audio_key.key_version,
                   audio_key.wrapped_dek, audio_key.created_at
            FROM session_audio_keys AS audio_key
            JOIN scribe_sessions AS session
              ON session.tenant_id = audio_key.tenant_id
             AND session.id = audio_key.session_id
            JOIN transcription_jobs AS job
              ON job.tenant_id = session.tenant_id
             AND job.session_id = session.id
            WHERE audio_key.tenant_id = :tenant_id
              AND audio_key.session_id = :session_id
              AND session.status = 'processing'
              AND job.id = :job_id
              AND job.status = 'processing'
              AND job.lease_token = :lease_token
              AND job.lease_until > :now
            """,
            tenant_id=tenant_id,
            session_id=session_id,
            job_id=job_id,
            lease_token=lease_token,
            now=now,
        )
        if row is None:
            return None
        return AudioAssemblyManifest(
            audio_key=SessionAudioKey.model_validate(row),
            chunks=tuple(await self.chunks_for(tenant_id, session_id)),
        )

    async def get_chunk(self, tenant_id: UUID, chunk_id: UUID) -> AudioChunk | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, sequence_number, channel, object_id, sha256,
                   ciphertext_size_bytes, registered_at
            FROM audio_chunks
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=chunk_id,
        )
        return AudioChunk.model_validate(row) if row is not None else None

    async def add_chunk(self, tenant_id: UUID, chunk: AudioChunk) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO audio_chunks (
                    id, tenant_id, session_id, sequence_number, channel, object_id,
                    sha256, ciphertext_size_bytes, registered_at
                ) VALUES (
                    :id, :tenant_id, :session_id, :sequence_number, :channel, :object_id,
                    :sha256, :ciphertext_size_bytes, :registered_at
                )
                """
            ),
            {
                **chunk.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "channel": chunk.channel.value,
            },
        )

    async def chunks_for(self, tenant_id: UUID, session_id: UUID) -> list[AudioChunk]:
        rows = (
            (
                await self._session.execute(
                    text(
                        """
                    SELECT id, session_id, sequence_number, channel, object_id, sha256,
                           ciphertext_size_bytes, registered_at
                    FROM audio_chunks
                    WHERE tenant_id = :tenant_id AND session_id = :session_id
                    ORDER BY sequence_number, channel
                    """
                    ),
                    {"tenant_id": tenant_id, "session_id": session_id},
                )
            )
            .mappings()
            .all()
        )
        return [AudioChunk.model_validate(dict(row)) for row in rows]

    async def get_upload_grant(self, tenant_id: UUID, object_id: UUID) -> UploadGrantRecord | None:
        row = await self._one_or_none(
            """
            SELECT object_id, session_id, sequence_number, channel, expires_at
            FROM audio_upload_grants
            WHERE tenant_id = :tenant_id AND object_id = :id
            """,
            tenant_id=tenant_id,
            id=object_id,
        )
        return UploadGrantRecord(**row) if row is not None else None

    async def add_upload_grant(self, tenant_id: UUID, grant: UploadGrantRecord) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO audio_upload_grants (
                    object_id, tenant_id, session_id, sequence_number, channel, expires_at
                ) VALUES (
                    :object_id, :tenant_id, :session_id, :sequence_number, :channel, :expires_at
                )
                """
            ),
            {
                **grant.__dict__,
                "tenant_id": tenant_id,
                "channel": grant.channel.value,
            },
        )

    async def get_transcript(self, tenant_id: UUID, transcript_id: UUID) -> Transcript | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, language_code, stt_provider, segments, created_at
            FROM transcripts
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=transcript_id,
        )
        return Transcript.model_validate(row) if row is not None else None

    async def add_transcript(self, tenant_id: UUID, transcript: Transcript) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO transcripts (
                    id, tenant_id, session_id, language_code, stt_provider, segments, created_at
                ) VALUES (
                    :id, :tenant_id, :session_id, :language_code, :stt_provider,
                    CAST(:segments AS jsonb), :created_at
                )
                """
            ),
            {
                "tenant_id": tenant_id,
                "id": transcript.id,
                "session_id": transcript.session_id,
                "language_code": transcript.language_code,
                "stt_provider": transcript.stt_provider,
                "created_at": transcript.created_at,
                "segments": json.dumps(
                    [segment.model_dump(mode="json") for segment in transcript.segments]
                ),
            },
        )

    async def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, language_code, stt_provider, segments, created_at
            FROM transcripts
            WHERE tenant_id = :tenant_id AND session_id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return Transcript.model_validate(row) if row is not None else None

    async def transcription_job_for(
        self, tenant_id: UUID, session_id: UUID
    ) -> TranscriptionJob | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, status, attempt_count, lease_token, lease_until,
                   last_error_code, created_at, updated_at
            FROM transcription_jobs
            WHERE tenant_id = :tenant_id AND session_id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return TranscriptionJob.model_validate(row) if row is not None else None

    async def claim_transcription_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        job_id: UUID,
        lease_token: UUID,
        now: datetime,
        lease_until: datetime,
        max_attempts: int,
    ) -> TranscriptionJob | None:
        row = (
            (
                await self._session.execute(
                    text(
                        """
                        INSERT INTO transcription_jobs (
                            id, tenant_id, session_id, status, attempt_count,
                            lease_token, lease_until, created_at, updated_at
                        ) VALUES (
                            :id, :tenant_id, :session_id, 'processing', 1,
                            :lease_token, :lease_until, :now, :now
                        )
                        ON CONFLICT (tenant_id, session_id) DO UPDATE
                        SET status = 'processing',
                            attempt_count = CASE
                                WHEN transcription_jobs.status = 'terminal' THEN 1
                                ELSE transcription_jobs.attempt_count + 1
                            END,
                            lease_token = EXCLUDED.lease_token,
                            lease_until = EXCLUDED.lease_until,
                            last_error_code = NULL,
                            updated_at = EXCLUDED.updated_at
                        WHERE (
                            transcription_jobs.attempt_count < :max_attempts
                            AND (
                                transcription_jobs.status = 'retryable'
                                OR (
                                    transcription_jobs.status = 'processing'
                                    AND transcription_jobs.lease_until <= :now
                                )
                            )
                          )
                          OR (
                            transcription_jobs.status = 'terminal'
                            AND EXISTS (
                                SELECT 1
                                FROM scribe_sessions
                                WHERE scribe_sessions.tenant_id = :tenant_id
                                  AND scribe_sessions.id = :session_id
                                  AND scribe_sessions.status = 'uploaded'
                            )
                          )
                        RETURNING id, session_id, status, attempt_count, lease_token,
                                  lease_until, last_error_code, created_at, updated_at
                        """
                    ),
                    {
                        "id": job_id,
                        "tenant_id": tenant_id,
                        "session_id": session_id,
                        "lease_token": lease_token,
                        "lease_until": lease_until,
                        "now": now,
                        "max_attempts": max_attempts,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        return TranscriptionJob.model_validate(dict(row)) if row is not None else None

    async def update_transcription_job(
        self,
        tenant_id: UUID,
        job: TranscriptionJob,
        *,
        expected_lease_token: UUID,
    ) -> bool:
        updated = await self._session.execute(
            text(
                """
                UPDATE transcription_jobs
                SET status = :status,
                    attempt_count = :attempt_count,
                    lease_token = :lease_token,
                    lease_until = :lease_until,
                    last_error_code = :last_error_code,
                    updated_at = :updated_at
                WHERE tenant_id = :tenant_id
                  AND id = :id
                  AND status = 'processing'
                  AND lease_token = :expected_lease_token
                RETURNING id
                """
            ),
            {
                **job.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "status": job.status.value,
                "expected_lease_token": expected_lease_token,
            },
        )
        return updated.scalar_one_or_none() is not None

    async def renew_transcription_job(
        self,
        tenant_id: UUID,
        job_id: UUID,
        *,
        lease_token: UUID,
        now: datetime,
        lease_until: datetime,
    ) -> bool:
        renewed = await self._session.execute(
            text(
                """
                UPDATE transcription_jobs
                SET lease_until = :lease_until,
                    updated_at = :now
                WHERE tenant_id = :tenant_id
                  AND id = :id
                  AND status = 'processing'
                  AND lease_token = :lease_token
                  AND lease_until > :now
                RETURNING id
                """
            ),
            {
                "tenant_id": tenant_id,
                "id": job_id,
                "lease_token": lease_token,
                "now": now,
                "lease_until": lease_until,
            },
        )
        return renewed.scalar_one_or_none() is not None

    async def get_delivery(self, tenant_id: UUID, delivery_id: UUID) -> TranscriptDelivery | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, idempotency_key, payload_sha256, status,
                   attempt_count, platform_transcript_id, last_error_code,
                   created_at, updated_at
            FROM transcript_deliveries
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=delivery_id,
        )
        return TranscriptDelivery.model_validate(row) if row is not None else None

    async def get_delivery_attempt(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
    ) -> DeliveryAttempt | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, idempotency_key, payload_sha256, status,
                   attempt_count, platform_transcript_id, last_error_code, updated_at
            FROM transcript_deliveries
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=delivery_id,
        )
        return DeliveryAttempt.model_validate(row) if row is not None else None

    async def delivery_for(self, tenant_id: UUID, session_id: UUID) -> TranscriptDelivery | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, idempotency_key, payload_sha256, status,
                   attempt_count, platform_transcript_id, last_error_code,
                   created_at, updated_at
            FROM transcript_deliveries
            WHERE tenant_id = :tenant_id AND session_id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return TranscriptDelivery.model_validate(row) if row is not None else None

    async def add_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO transcript_deliveries (
                    id, tenant_id, session_id, idempotency_key, payload_sha256,
                    status, attempt_count, platform_transcript_id, last_error_code,
                    created_at, updated_at
                ) VALUES (
                    :id, :tenant_id, :session_id, :idempotency_key, :payload_sha256,
                    :status, :attempt_count, :platform_transcript_id, :last_error_code,
                    :created_at, :updated_at
                )
                """
            ),
            {
                **delivery.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "status": delivery.status.value,
            },
        )

    async def claim_delivery_attempt(
        self,
        tenant_id: UUID,
        *,
        policy: DeliveryClaimPolicy,
        delivery_id: UUID | None = None,
        excluded_delivery_ids: frozenset[UUID] = frozenset(),
    ) -> DeliveryAttempt | None:
        delivery_filter = "AND delivery.id = :delivery_id" if delivery_id is not None else ""
        exclusion_filter = (
            "AND NOT (delivery.id = ANY(CAST(:excluded_delivery_ids AS uuid[])))"
            if excluded_delivery_ids
            else ""
        )
        row = (
            (
                await self._session.execute(
                    text(
                        f"""
                        WITH claim_clock AS (
                            SELECT statement_timestamp() AS claimed_at
                        ), candidate AS (
                            SELECT delivery.id
                            FROM transcript_deliveries AS delivery
                            CROSS JOIN claim_clock
                            WHERE delivery.tenant_id = :tenant_id
                              {delivery_filter}
                              {exclusion_filter}
                              AND (
                                  (
                                      delivery.status = 'pending'
                                      AND delivery.attempt_count = 0
                                  )
                                  OR (
                                      delivery.status = 'pending'
                                      AND delivery.attempt_count > 0
                                      AND delivery.updated_at <= claim_clock.claimed_at -
                                          make_interval(
                                              secs => CAST(
                                                  :pending_timeout_seconds AS double precision
                                              )
                                          )
                                  )
                                  OR (
                                      delivery.status = 'retryable'
                                      AND delivery.updated_at <= claim_clock.claimed_at -
                                          make_interval(
                                              secs => CAST(
                                                  :retry_delay_seconds AS double precision
                                              )
                                          )
                                  )
                              )
                            ORDER BY delivery.updated_at, delivery.id
                            FOR UPDATE OF delivery SKIP LOCKED
                            LIMIT 1
                        )
                        UPDATE transcript_deliveries AS delivery
                        SET status = 'pending',
                            attempt_count = delivery.attempt_count + 1,
                            last_error_code = NULL,
                            updated_at = claim_clock.claimed_at
                        FROM candidate, claim_clock
                        WHERE delivery.tenant_id = :tenant_id
                          AND delivery.id = candidate.id
                        RETURNING delivery.id, delivery.session_id, delivery.idempotency_key,
                                  delivery.payload_sha256, delivery.status,
                                  delivery.attempt_count, delivery.platform_transcript_id,
                                  delivery.last_error_code, delivery.updated_at
                        """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "delivery_id": delivery_id,
                        "excluded_delivery_ids": list(excluded_delivery_ids),
                        "pending_timeout_seconds": policy.pending_timeout.total_seconds(),
                        "retry_delay_seconds": policy.retry_delay.total_seconds(),
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            return None
        claimed = DeliveryAttempt.model_validate(row)
        await self.audit(
            tenant_id=tenant_id,
            action="transcript.delivery_attempted",
            entity_type="transcript_delivery",
            entity_id=claimed.id,
        )
        return claimed

    async def delivery_payload_source(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> DeliveryPayloadSource:
        session_row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, status
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        if session_row is None:
            return DeliveryPayloadSource()
        session = DeliverySessionSource.model_validate(session_row)
        consent_row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, modality,
                   all_parties_consented, revoked_at
            FROM consent_records
            WHERE tenant_id = :tenant_id AND id = :consent_id
            """,
            tenant_id=tenant_id,
            consent_id=session.consent_record_id,
        )
        transcript_row = await self._one_or_none(
            """
            SELECT id, session_id, segments
            FROM transcripts
            WHERE tenant_id = :tenant_id AND session_id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return DeliveryPayloadSource(
            session=session,
            consent=(
                DeliveryConsentSource.model_validate(consent_row)
                if consent_row is not None
                else None
            ),
            transcript=(
                DeliveryTranscriptSource.model_validate(transcript_row)
                if transcript_row is not None
                else None
            ),
        )

    async def synchronize_delivery_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> DeliverySessionSyncResult:
        row = await self._one_or_none(
            """
            SELECT status
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
            FOR UPDATE
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        if row is None:
            return DeliverySessionSyncResult.SESSION_UNAVAILABLE
        if row["status"] == "handed_off":
            return DeliverySessionSyncResult.ALREADY_SYNCHRONIZED
        if row["status"] != "transcript_ready":
            return DeliverySessionSyncResult.SESSION_STATE_CONFLICT
        await self._session.execute(
            text(
                """
                UPDATE scribe_sessions
                SET status = 'handed_off'
                WHERE tenant_id = :tenant_id
                  AND id = :session_id
                  AND status = 'transcript_ready'
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id},
        )
        await self.audit(
            tenant_id=tenant_id,
            action="transcript.delivery_session_synchronized",
            entity_type="scribe_session",
            entity_id=session_id,
        )
        return DeliverySessionSyncResult.SYNCHRONIZED

    async def complete_delivery_failure(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
        *,
        expected_attempt_count: int,
        failure_status: DeliveryStatus,
        error_code: str,
    ) -> DeliveryAttempt | None:
        if failure_status not in {DeliveryStatus.RETRYABLE, DeliveryStatus.TERMINAL}:
            raise ValueError("delivery failure status must be retryable or terminal")
        row = (
            (
                await self._session.execute(
                    text(
                        """
                        UPDATE transcript_deliveries
                        SET status = :status,
                            last_error_code = :last_error_code,
                            updated_at = statement_timestamp()
                        WHERE tenant_id = :tenant_id
                          AND id = :id
                          AND status = 'pending'
                          AND attempt_count = :expected_attempt_count
                        RETURNING id, session_id, idempotency_key, payload_sha256, status,
                                  attempt_count, platform_transcript_id, last_error_code, updated_at
                        """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "id": delivery_id,
                        "status": failure_status.value,
                        "last_error_code": error_code,
                        "expected_attempt_count": expected_attempt_count,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        return DeliveryAttempt.model_validate(row) if row is not None else None

    async def complete_delivery_success(
        self,
        tenant_id: UUID,
        delivery_id: UUID,
        *,
        expected_payload_sha256: str,
        platform_transcript_id: str,
    ) -> DeliverySuccessCompletion | None:
        row = (
            (
                await self._session.execute(
                    text(
                        """
                        UPDATE transcript_deliveries
                        SET status = 'delivered',
                            platform_transcript_id = :platform_transcript_id,
                            last_error_code = NULL,
                            updated_at = statement_timestamp()
                        WHERE tenant_id = :tenant_id
                          AND id = :id
                          AND payload_sha256 = :expected_payload_sha256
                          AND status <> 'delivered'
                        RETURNING id, session_id, idempotency_key, payload_sha256, status,
                                  attempt_count, platform_transcript_id, last_error_code, updated_at
                        """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "id": delivery_id,
                        "expected_payload_sha256": expected_payload_sha256,
                        "platform_transcript_id": platform_transcript_id,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is not None:
            return DeliverySuccessCompletion(
                delivery=DeliveryAttempt.model_validate(row),
                changed=True,
            )
        current = await self.get_delivery_attempt(tenant_id, delivery_id)
        if current is None:
            return None
        if (
            current.payload_sha256 != expected_payload_sha256
            or current.status != DeliveryStatus.DELIVERED
            or current.platform_transcript_id != platform_transcript_id
        ):
            raise DeliverySuccessConflictError("delivery_success_conflict")
        return DeliverySuccessCompletion(delivery=current, changed=False)

    async def audit(
        self, *, tenant_id: UUID, action: str, entity_type: str, entity_id: UUID
    ) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO audit_events (id, tenant_id, action, entity_type, entity_id)
                VALUES (:id, :tenant_id, :action, :entity_type, :entity_id)
                """
            ),
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "action": action,
                "entity_type": entity_type,
                "entity_id": entity_id,
            },
        )

    async def _one_or_none(self, statement: str, **params: object) -> dict[str, Any] | None:
        row = (await self._session.execute(text(statement), params)).mappings().one_or_none()
        return dict(row) if row is not None else None


def build_postgres_provider(settings: Settings) -> PostgresRepositoryProvider:
    credential: DefaultAzureCredential | None = None
    connect_args: dict[str, object] = {}

    if settings.database_url is not None:
        url: str | URL = settings.database_url.get_secret_value()
    else:
        if settings.database_host is None or settings.database_user is None:
            raise ValueError("PostgreSQL requires database_host and database_user")
        credential = DefaultAzureCredential(
            managed_identity_client_id=(
                str(settings.managed_identity_client_id)
                if settings.managed_identity_client_id is not None
                else None
            ),
            require_envvar=False,
        )

        async def azure_password() -> str:
            token: AccessToken = await credential.get_token(AZURE_POSTGRES_SCOPE)
            return token.token

        url = URL.create(
            drivername="postgresql+asyncpg",
            username=settings.database_user,
            host=settings.database_host,
            port=settings.database_port,
            database=settings.database_name,
        )
        connect_args["password"] = azure_password

    connect_args["ssl"] = settings.database_ssl
    engine = create_async_engine(
        url,
        connect_args=connect_args,
        pool_pre_ping=True,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
    )
    return PostgresRepositoryProvider(engine, credential)
