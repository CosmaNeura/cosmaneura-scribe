from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
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

from .capture_protocol_v1 import (
    CAPTURE_LEASE_TTL_SECONDS,
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_RESERVATIONS_PER_BATCH,
    PROTOCOL_VERSION,
    RESERVATION_PLAINTEXT_BUDGET_BYTES,
)
from .external_transcript_v1 import TranscriptLanguageMode
from .normalized_source_persistence import (
    VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID,
    VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT,
    VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID,
    VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID,
    ConfiguredExternalSessionStatus,
    VersionedExternalSessionCreate,
    VersionedExternalSessionRecord,
    consent_authorizes_versioned_session,
)
from .repository import (
    AudioAssemblyManifest,
    CaptureChannelFinalization,
    CaptureChannelFinalizationDraft,
    CaptureContext,
    CaptureFinalizationError,
    CaptureIngestModeError,
    CaptureLeaseCloseReason,
    CaptureLeaseConflictError,
    CaptureLeaseReceipt,
    CaptureLeaseRecord,
    CaptureReservationLimitError,
    CaptureReservationUsage,
    ChunkReceipt,
    ChunkReservationBatch,
    ChunkReservationDraft,
    ChunkReservationRecord,
    ConsentRevocationResult,
    DeliveryClaimPolicy,
    DeliverySessionSyncResult,
    DeliverySuccessCompletion,
    DeliverySuccessConflictError,
    IdempotencyClaimUnavailableError,
    IdempotencyConflictError,
    IdempotencyRecord,
    Repository,
    UploadAuthorizationReceipt,
    UploadGrantRecord,
)
from .schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    ConsentRecord,
    DeliveryAttempt,
    DeliveryConsentSource,
    DeliveryPayloadSource,
    DeliverySessionSource,
    DeliveryStatus,
    DeliveryTranscriptSource,
    SessionAudioKey,
    SessionStatus,
    Transcript,
    TranscriptDelivery,
    TranscriptionJob,
)
from .session_state_v1 import SessionIngestMode
from .settings import Settings

AZURE_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"
MAXIMUM_CAPTURE_AUTHORIZATION_SECONDS = CAPTURE_LEASE_TTL_SECONDS


def _capture_duration_seconds(duration: timedelta) -> float:
    seconds = duration.total_seconds()
    if seconds <= 0 or seconds > MAXIMUM_CAPTURE_AUTHORIZATION_SECONDS:
        raise ValueError("capture authorization duration must be between zero and 15 minutes")
    return seconds


def _capture_lease_record(row: dict[str, Any]) -> CaptureLeaseRecord:
    reason = row.get("close_reason")
    return CaptureLeaseRecord(
        lease_id=row["lease_id"],
        session_id=row["session_id"],
        generation=row["generation"],
        issued_at=row["issued_at"],
        renewed_at=row["renewed_at"],
        expires_at=row["expires_at"],
        closed_at=row.get("closed_at"),
        close_reason=CaptureLeaseCloseReason(reason) if reason is not None else None,
    )


def _capture_lease_receipt(row: dict[str, Any]) -> CaptureLeaseReceipt:
    return CaptureLeaseReceipt(
        id=row["id"],
        lease_id=row["lease_id"],
        session_id=row["session_id"],
        generation=row["generation"],
        issued_at=row["issued_at"],
        expires_at=row["expires_at"],
    )


def _chunk_reservation(row: dict[str, Any]) -> ChunkReservationRecord:
    return ChunkReservationRecord(
        object_id=row["object_id"],
        session_id=row["session_id"],
        sequence_number=row["sequence_number"],
        channel=CaptureChannel(row["channel"]),
        protocol_version=row["protocol_version"],
        additional_data=bytes(row["additional_data"]),
        plaintext_budget_bytes=row["plaintext_budget_bytes"],
        created_at=row["created_at"],
    )


def _versioned_external_session_record(
    row: dict[str, Any],
) -> VersionedExternalSessionRecord:
    return VersionedExternalSessionRecord(
        id=row["id"],
        appointment_id=row["appointment_id"],
        practitioner_id=row["practitioner_id"],
        patient_id=row["patient_id"],
        consent_record_id=row["consent_record_id"],
        modality=CaptureModality(row["modality"]),
        creator_actor_id=row["creator_actor_id"],
        language_mode=TranscriptLanguageMode(row["language_mode"]),
        transcript_contract_version=row["transcript_contract_version"],
        transcription_adapter_id=row["transcription_adapter_id"],
        transcription_model_profile_id=row["transcription_model_profile_id"],
        normalization_profile_id=row["normalization_profile_id"],
        status=ConfiguredExternalSessionStatus(row["status"]),
        created_at=row["created_at"],
    )


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

    async def _require_chunk_upload_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> None:
        # This is the one legacy guard that intentionally sees configured rows:
        # their external ingest mode must fail closed before any audio child write.
        row = await self._one_or_none(
            """
            SELECT ingest_mode
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        if (
            row is not None
            and SessionIngestMode(row["ingest_mode"]) != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )

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

    async def _lock_consent_scope(self, tenant_id: UUID, consent_id: UUID) -> None:
        await self._session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
            {"lock_key": f"scribe-consent:{tenant_id}:{consent_id}"},
        )

    async def lock_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None:
        # A transaction advisory lock gives every least-privilege principal the same
        # serialization point without granting workers permission to mutate consent.
        await self._lock_consent_scope(tenant_id, consent_id)
        return await self.get_consent(tenant_id, consent_id)

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

    async def revoke_consent(
        self,
        tenant_id: UUID,
        consent_id: UUID,
    ) -> ConsentRevocationResult | None:
        current = await self.lock_consent(tenant_id, consent_id)
        if current is None:
            return None
        changed = current.revoked_at is None
        revoked = current
        if changed:
            row = (
                (
                    await self._session.execute(
                        text(
                            """
                            UPDATE consent_records
                            SET revoked_at = statement_timestamp()
                            WHERE tenant_id = :tenant_id AND id = :id AND revoked_at IS NULL
                            RETURNING id, appointment_id, practitioner_id, patient_id, modality,
                                      participant_regions, method, all_parties_consented,
                                      granted_at, evidence_object_id, policy_version, revoked_at
                            """
                        ),
                        {"tenant_id": tenant_id, "id": consent_id},
                    )
                )
                .mappings()
                .one()
            )
            revoked = ConsentRecord.model_validate(row)
        await self._session.execute(
            text(
                """
                UPDATE capture_leases AS lease
                SET closed_at = statement_timestamp(), close_reason = :reason
                FROM scribe_sessions AS scribe_session
                WHERE lease.tenant_id = :tenant_id
                  AND lease.closed_at IS NULL
                  AND lease.expires_at > statement_timestamp()
                  AND scribe_session.tenant_id = lease.tenant_id
                  AND scribe_session.id = lease.session_id
                  AND scribe_session.consent_record_id = :consent_id
                  AND scribe_session.transcript_contract_version IS NULL
                """
            ),
            {
                "tenant_id": tenant_id,
                "consent_id": consent_id,
                "reason": CaptureLeaseCloseReason.CONSENT_REVOKED.value,
            },
        )
        return ConsentRevocationResult(consent=revoked, changed=changed)

    async def get_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, ingest_mode, status, created_at
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :id
              AND transcript_contract_version IS NULL
            """,
            tenant_id=tenant_id,
            id=session_id,
        )
        return CaptureSession.model_validate(row) if row is not None else None

    async def lock_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        reference = await self._one_or_none(
            """
            SELECT consent_record_id
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :id
              AND transcript_contract_version IS NULL
            """,
            tenant_id=tenant_id,
            id=session_id,
        )
        if reference is None:
            return None
        await self._lock_consent_scope(tenant_id, reference["consent_record_id"])
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, ingest_mode, status, created_at
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :id
              AND transcript_contract_version IS NULL
            FOR UPDATE
            """,
            tenant_id=tenant_id,
            id=session_id,
        )
        return CaptureSession.model_validate(row) if row is not None else None

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self.lock_consent(tenant_id, session.consent_record_id)
        await self._session.execute(
            text(
                """
                INSERT INTO scribe_sessions (
                    id, tenant_id, appointment_id, practitioner_id, patient_id,
                    consent_record_id, modality, ingest_mode, status, created_at
                ) VALUES (
                    :id, :tenant_id, :appointment_id, :practitioner_id, :patient_id,
                    :consent_record_id, :modality, :ingest_mode, :status, :created_at
                )
                """
            ),
            {
                **session.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "modality": session.modality.value,
                "ingest_mode": session.ingest_mode.value,
                "status": session.status.value,
            },
        )

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self.lock_consent(tenant_id, session.consent_record_id)
        updated = await self._session.execute(
            text(
                """
                UPDATE scribe_sessions
                SET status = :status
                WHERE tenant_id = :tenant_id AND id = :id
                  AND ingest_mode = :ingest_mode
                  AND transcript_contract_version IS NULL
                RETURNING id
                """
            ),
            {
                "tenant_id": tenant_id,
                "id": session.id,
                "ingest_mode": session.ingest_mode.value,
                "status": session.status.value,
            },
        )
        if updated.scalar_one_or_none() is not None:
            return
        current = await self.get_session(tenant_id, session.id)
        if current is not None and current.ingest_mode != session.ingest_mode:
            raise ValueError("scribe session ingest mode is immutable")

    async def create_versioned_external_session(
        self,
        tenant_id: UUID,
        draft: VersionedExternalSessionCreate,
    ) -> VersionedExternalSessionRecord | None:
        consent = await self.lock_consent(tenant_id, draft.consent_record_id)
        if not consent_authorizes_versioned_session(consent, draft):
            return None
        row = (
            (
                await self._session.execute(
                    text(
                        """
                        INSERT INTO scribe_sessions (
                            id, tenant_id, appointment_id, practitioner_id, patient_id,
                            consent_record_id, modality, ingest_mode, status,
                            transcript_contract_version, creator_actor_id, language_mode,
                            transcription_adapter_id, transcription_model_profile_id,
                            normalization_profile_id
                        ) VALUES (
                            :id, :tenant_id, :appointment_id, :practitioner_id, :patient_id,
                            :consent_record_id, :modality, 'external_async_transcript', 'created',
                            :transcript_contract_version, :creator_actor_id, :language_mode,
                            :transcription_adapter_id, :transcription_model_profile_id,
                            :normalization_profile_id
                        )
                        RETURNING id, appointment_id, practitioner_id, patient_id,
                                  consent_record_id, modality, transcript_contract_version,
                                  creator_actor_id, language_mode, transcription_adapter_id,
                                  transcription_model_profile_id, normalization_profile_id,
                                  status, created_at
                        """
                    ),
                    {
                        "id": draft.id,
                        "tenant_id": tenant_id,
                        "appointment_id": draft.appointment_id,
                        "practitioner_id": draft.practitioner_id,
                        "patient_id": draft.patient_id,
                        "consent_record_id": draft.consent_record_id,
                        "modality": draft.modality.value,
                        "transcript_contract_version": VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT,
                        "creator_actor_id": draft.creator_actor_id,
                        "language_mode": draft.language_mode.value,
                        "transcription_adapter_id": (
                            VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID
                        ),
                        "transcription_model_profile_id": (
                            VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID
                        ),
                        "normalization_profile_id": (
                            VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID
                        ),
                    },
                )
            )
            .mappings()
            .one()
        )
        return _versioned_external_session_record(dict(row))

    async def get_versioned_external_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> VersionedExternalSessionRecord | None:
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, transcript_contract_version, creator_actor_id, language_mode,
                   transcription_adapter_id, transcription_model_profile_id,
                   normalization_profile_id, status, created_at
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
              AND ingest_mode = 'external_async_transcript'
              AND transcript_contract_version = :transcript_contract_version
            """,
            tenant_id=tenant_id,
            session_id=session_id,
            transcript_contract_version=VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT,
        )
        return _versioned_external_session_record(row) if row is not None else None

    async def lock_versioned_external_session(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> VersionedExternalSessionRecord | None:
        reference = await self._one_or_none(
            """
            SELECT consent_record_id
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
              AND transcript_contract_version = :transcript_contract_version
            """,
            tenant_id=tenant_id,
            session_id=session_id,
            transcript_contract_version=VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT,
        )
        if reference is None:
            return None
        await self._lock_consent_scope(tenant_id, reference["consent_record_id"])
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, transcript_contract_version, creator_actor_id, language_mode,
                   transcription_adapter_id, transcription_model_profile_id,
                   normalization_profile_id, status, created_at
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
              AND consent_record_id = :consent_id
              AND ingest_mode = 'external_async_transcript'
              AND transcript_contract_version = :transcript_contract_version
            FOR UPDATE
            """,
            tenant_id=tenant_id,
            session_id=session_id,
            consent_id=reference["consent_record_id"],
            transcript_contract_version=VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT,
        )
        return _versioned_external_session_record(row) if row is not None else None

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
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = :session_id
                    AND session.transcript_contract_version IS NULL
              )
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
        await self._require_chunk_upload_session(tenant_id, audio_key.session_id)
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

    async def lock_capture_context(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureContext | None:
        reference = await self._one_or_none(
            """
            SELECT consent_record_id
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
              AND transcript_contract_version IS NULL
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        if reference is None:
            return None
        await self._lock_consent_scope(tenant_id, reference["consent_record_id"])
        row = await self._one_or_none(
            """
            SELECT
                scribe_session.id AS session_id,
                scribe_session.appointment_id AS session_appointment_id,
                scribe_session.practitioner_id AS session_practitioner_id,
                scribe_session.patient_id AS session_patient_id,
                scribe_session.consent_record_id,
                scribe_session.modality AS session_modality,
                scribe_session.ingest_mode AS session_ingest_mode,
                scribe_session.status AS session_status,
                scribe_session.created_at AS session_created_at,
                consent.id AS consent_id,
                consent.appointment_id AS consent_appointment_id,
                consent.practitioner_id AS consent_practitioner_id,
                consent.patient_id AS consent_patient_id,
                consent.modality AS consent_modality,
                consent.participant_regions,
                consent.method,
                consent.all_parties_consented,
                consent.granted_at,
                consent.evidence_object_id,
                consent.policy_version,
                consent.revoked_at,
                audio_key.session_id AS audio_key_session_id,
                audio_key.key_version,
                audio_key.wrapped_dek,
                audio_key.created_at AS audio_key_created_at,
                lease.lease_id,
                lease.generation AS lease_generation,
                lease.issued_at AS lease_issued_at,
                lease.renewed_at AS lease_renewed_at,
                lease.expires_at AS lease_expires_at,
                lease.closed_at AS lease_closed_at,
                lease.close_reason
            FROM scribe_sessions AS scribe_session
            JOIN consent_records AS consent
              ON consent.tenant_id = scribe_session.tenant_id
             AND consent.id = scribe_session.consent_record_id
            LEFT JOIN session_audio_keys AS audio_key
              ON audio_key.tenant_id = scribe_session.tenant_id
             AND audio_key.session_id = scribe_session.id
            LEFT JOIN capture_leases AS lease
              ON lease.tenant_id = scribe_session.tenant_id
             AND lease.session_id = scribe_session.id
            WHERE scribe_session.tenant_id = :tenant_id
              AND scribe_session.id = :session_id
              AND scribe_session.transcript_contract_version IS NULL
            FOR UPDATE OF scribe_session
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        if row is None:
            return None
        session = CaptureSession.model_validate(
            {
                "id": row["session_id"],
                "appointment_id": row["session_appointment_id"],
                "practitioner_id": row["session_practitioner_id"],
                "patient_id": row["session_patient_id"],
                "consent_record_id": row["consent_record_id"],
                "modality": row["session_modality"],
                "ingest_mode": row["session_ingest_mode"],
                "status": row["session_status"],
                "created_at": row["session_created_at"],
            }
        )
        consent = ConsentRecord.model_validate(
            {
                "id": row["consent_id"],
                "appointment_id": row["consent_appointment_id"],
                "practitioner_id": row["consent_practitioner_id"],
                "patient_id": row["consent_patient_id"],
                "modality": row["consent_modality"],
                "participant_regions": row["participant_regions"],
                "method": row["method"],
                "all_parties_consented": row["all_parties_consented"],
                "granted_at": row["granted_at"],
                "evidence_object_id": row["evidence_object_id"],
                "policy_version": row["policy_version"],
                "revoked_at": row["revoked_at"],
            }
        )
        audio_key = (
            SessionAudioKey.model_validate(
                {
                    "session_id": row["audio_key_session_id"],
                    "key_version": row["key_version"],
                    "wrapped_dek": row["wrapped_dek"],
                    "created_at": row["audio_key_created_at"],
                }
            )
            if row["audio_key_session_id"] is not None
            else None
        )
        lease = (
            _capture_lease_record(
                {
                    "lease_id": row["lease_id"],
                    "session_id": row["session_id"],
                    "generation": row["lease_generation"],
                    "issued_at": row["lease_issued_at"],
                    "renewed_at": row["lease_renewed_at"],
                    "expires_at": row["lease_expires_at"],
                    "closed_at": row["lease_closed_at"],
                    "close_reason": row["close_reason"],
                }
            )
            if row["lease_id"] is not None
            else None
        )
        return CaptureContext(session=session, consent=consent, audio_key=audio_key, lease=lease)

    async def get_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureLeaseRecord | None:
        row = await self._one_or_none(
            """
            SELECT lease_id, session_id, generation, issued_at, renewed_at,
                   expires_at, closed_at, close_reason
            FROM capture_leases
            WHERE tenant_id = :tenant_id AND session_id = :session_id
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = :session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return _capture_lease_record(row) if row is not None else None

    async def get_capture_lease_receipt(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> CaptureLeaseReceipt | None:
        row = await self._one_or_none(
            """
            SELECT id, lease_id, session_id, generation, issued_at, expires_at
            FROM capture_lease_receipts
            WHERE tenant_id = :tenant_id AND id = :receipt_id
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = capture_lease_receipts.session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            receipt_id=receipt_id,
        )
        return _capture_lease_receipt(row) if row is not None else None

    async def issue_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        lease_id: UUID,
        receipt_id: UUID,
        duration: timedelta,
    ) -> CaptureLeaseReceipt | None:
        duration_seconds = _capture_duration_seconds(duration)
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or context.lease is not None
        ):
            return None
        row = (
            (
                await self._session.execute(
                    text(
                        """
                        WITH inserted_lease AS (
                            INSERT INTO capture_leases (
                                tenant_id, session_id, lease_id, generation,
                                issued_at, renewed_at, expires_at
                            )
                            SELECT :tenant_id, scribe_session.id, :lease_id, 1,
                                   statement_timestamp(), statement_timestamp(),
                                   statement_timestamp()
                                       + (:duration_seconds * INTERVAL '1 second')
                            FROM scribe_sessions AS scribe_session
                            JOIN consent_records AS consent
                              ON consent.tenant_id = scribe_session.tenant_id
                             AND consent.id = scribe_session.consent_record_id
                            JOIN session_audio_keys AS audio_key
                              ON audio_key.tenant_id = scribe_session.tenant_id
                             AND audio_key.session_id = scribe_session.id
                            WHERE scribe_session.tenant_id = :tenant_id
                              AND scribe_session.id = :session_id
                              AND scribe_session.transcript_contract_version IS NULL
                              AND scribe_session.status IN ('created', 'capturing')
                              AND consent.all_parties_consented
                              AND consent.revoked_at IS NULL
                            ON CONFLICT (tenant_id, session_id) DO NOTHING
                            RETURNING tenant_id, session_id, lease_id, generation,
                                      issued_at, expires_at
                        ), inserted_receipt AS (
                            INSERT INTO capture_lease_receipts (
                                id, tenant_id, session_id, lease_id, generation,
                                issued_at, expires_at
                            )
                            SELECT :receipt_id, tenant_id, session_id, lease_id,
                                   generation, issued_at, expires_at
                            FROM inserted_lease
                            RETURNING id, lease_id, session_id, generation,
                                      issued_at, expires_at
                        )
                        SELECT id, lease_id, session_id, generation, issued_at, expires_at
                        FROM inserted_receipt
                        """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "session_id": session_id,
                        "lease_id": lease_id,
                        "receipt_id": receipt_id,
                        "duration_seconds": duration_seconds,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        return _capture_lease_receipt(dict(row)) if row is not None else None

    async def renew_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        expected_lease_id: UUID,
        expected_generation: int,
        receipt_id: UUID,
        duration: timedelta,
    ) -> CaptureLeaseReceipt | None:
        duration_seconds = _capture_duration_seconds(duration)
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or context.lease is None
            or context.lease.lease_id != expected_lease_id
            or context.lease.generation != expected_generation
            or context.lease.closed_at is not None
        ):
            return None
        row = (
            (
                await self._session.execute(
                    text(
                        """
                        WITH renewed_lease AS (
                            UPDATE capture_leases AS lease
                            SET generation = lease.generation + 1,
                                renewed_at = statement_timestamp(),
                                expires_at = statement_timestamp()
                                    + (:duration_seconds * INTERVAL '1 second')
                            FROM scribe_sessions AS scribe_session
                            JOIN consent_records AS consent
                              ON consent.tenant_id = scribe_session.tenant_id
                             AND consent.id = scribe_session.consent_record_id
                            JOIN session_audio_keys AS audio_key
                              ON audio_key.tenant_id = scribe_session.tenant_id
                             AND audio_key.session_id = scribe_session.id
                            WHERE lease.tenant_id = :tenant_id
                              AND lease.session_id = :session_id
                              AND lease.lease_id = :expected_lease_id
                              AND lease.generation = :expected_generation
                              AND lease.closed_at IS NULL
                              AND scribe_session.tenant_id = lease.tenant_id
                              AND scribe_session.id = lease.session_id
                              AND scribe_session.transcript_contract_version IS NULL
                              AND scribe_session.status IN ('created', 'capturing')
                              AND consent.all_parties_consented
                              AND consent.revoked_at IS NULL
                            RETURNING lease.tenant_id, lease.session_id, lease.lease_id,
                                      lease.generation, lease.renewed_at, lease.expires_at
                        ), inserted_receipt AS (
                            INSERT INTO capture_lease_receipts (
                                id, tenant_id, session_id, lease_id, generation,
                                issued_at, expires_at
                            )
                            SELECT :receipt_id, tenant_id, session_id, lease_id,
                                   generation, renewed_at, expires_at
                            FROM renewed_lease
                            RETURNING id, lease_id, session_id, generation,
                                      issued_at, expires_at
                        )
                        SELECT id, lease_id, session_id, generation, issued_at, expires_at
                        FROM inserted_receipt
                        """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "session_id": session_id,
                        "expected_lease_id": expected_lease_id,
                        "expected_generation": expected_generation,
                        "receipt_id": receipt_id,
                        "duration_seconds": duration_seconds,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        return _capture_lease_receipt(dict(row)) if row is not None else None

    async def close_capture_lease(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        expected_lease_id: UUID,
        expected_generation: int,
        reason: CaptureLeaseCloseReason,
    ) -> bool:
        closed = await self._session.execute(
            text(
                """
                UPDATE capture_leases
                SET closed_at = statement_timestamp(), close_reason = :reason
                WHERE tenant_id = :tenant_id
                  AND session_id = :session_id
                  AND lease_id = :expected_lease_id
                  AND generation = :expected_generation
                  AND closed_at IS NULL
                  AND EXISTS (
                      SELECT 1 FROM scribe_sessions AS session
                      WHERE session.tenant_id = :tenant_id
                        AND session.id = :session_id
                        AND session.transcript_contract_version IS NULL
                  )
                RETURNING session_id
                """
            ),
            {
                "tenant_id": tenant_id,
                "session_id": session_id,
                "expected_lease_id": expected_lease_id,
                "expected_generation": expected_generation,
                "reason": reason.value,
            },
        )
        return closed.scalar_one_or_none() is not None

    async def get_chunk_reservation_batch(
        self,
        tenant_id: UUID,
        batch_id: UUID,
    ) -> ChunkReservationBatch | None:
        batch = await self._one_or_none(
            """
            SELECT id, session_id, lease_id, lease_generation,
                   requested_protocol_version, created_at, capture_authorized_until
            FROM audio_chunk_reservation_batches
            WHERE tenant_id = :tenant_id AND id = :batch_id
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = audio_chunk_reservation_batches.session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            batch_id=batch_id,
        )
        if batch is None:
            return None
        rows = (
            (
                await self._session.execute(
                    text(
                        """
                        SELECT reservation.object_id, reservation.session_id,
                               reservation.sequence_number, reservation.channel,
                               reservation.protocol_version, reservation.additional_data,
                               reservation.plaintext_budget_bytes, reservation.created_at
                        FROM audio_chunk_reservation_batch_items AS item
                        JOIN audio_chunk_reservations AS reservation
                          ON reservation.tenant_id = item.tenant_id
                         AND reservation.session_id = item.session_id
                         AND reservation.object_id = item.object_id
                        WHERE item.tenant_id = :tenant_id
                          AND item.batch_id = :batch_id
                        ORDER BY item.ordinal
                        """
                    ),
                    {"tenant_id": tenant_id, "batch_id": batch_id},
                )
            )
            .mappings()
            .all()
        )
        reservations = tuple(_chunk_reservation(dict(row)) for row in rows)
        return ChunkReservationBatch(
            id=batch["id"],
            session_id=batch["session_id"],
            lease_id=batch["lease_id"],
            lease_generation=batch["lease_generation"],
            requested_protocol_version=batch["requested_protocol_version"],
            created_at=batch["created_at"],
            capture_authorized_until=batch["capture_authorized_until"],
            reservations=reservations,
        )

    async def create_chunk_reservation_batch(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        batch_id: UUID,
        lease_id: UUID,
        lease_generation: int,
        requested_protocol_version: str,
        drafts: tuple[ChunkReservationDraft, ...],
        maximum_batch_size: int,
        maximum_chunks: int,
        maximum_plaintext_bytes: int,
    ) -> ChunkReservationBatch:
        if (
            not drafts
            or maximum_batch_size < 1
            or maximum_batch_size > MAX_RESERVATIONS_PER_BATCH
            or len(drafts) > maximum_batch_size
            or maximum_chunks < 1
            or maximum_chunks > MAX_CHUNKS
            or maximum_plaintext_bytes < 1
            or maximum_plaintext_bytes > MAX_AGGREGATE_PLAINTEXT_BYTES
            or requested_protocol_version != PROTOCOL_VERSION
        ):
            raise CaptureReservationLimitError
        positions = {(draft.channel, draft.sequence_number) for draft in drafts}
        if len(positions) != len(drafts) or any(
            draft.protocol_version != PROTOCOL_VERSION
            or draft.sequence_number < 0
            or draft.sequence_number >= MAX_CHUNKS
            or not 1 <= len(draft.additional_data) <= 1_024
            or draft.plaintext_budget_bytes != RESERVATION_PLAINTEXT_BUDGET_BYTES
            for draft in drafts
        ):
            raise CaptureReservationLimitError

        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        if (
            context is None
            or context.audio_key is None
            or context.consent.revoked_at is not None
            or not context.consent.all_parties_consented
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or context.lease is None
            or context.lease.lease_id != lease_id
            or context.lease.generation != lease_generation
            or context.lease.closed_at is not None
        ):
            raise CaptureLeaseConflictError
        lease_is_active = await self._session.scalar(
            text(
                """
                SELECT EXISTS (
                    SELECT 1 FROM capture_leases
                    WHERE tenant_id = :tenant_id
                      AND session_id = :session_id
                      AND lease_id = :lease_id
                      AND generation = :lease_generation
                      AND closed_at IS NULL
                      AND expires_at > statement_timestamp()
                )
                """
            ),
            {
                "tenant_id": tenant_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "lease_generation": lease_generation,
            },
        )
        if not lease_is_active:
            raise CaptureLeaseConflictError

        existing_rows = (
            (
                await self._session.execute(
                    text(
                        """
                        SELECT object_id, session_id, sequence_number, channel,
                               protocol_version, additional_data,
                               plaintext_budget_bytes, created_at
                        FROM audio_chunk_reservations
                        WHERE tenant_id = :tenant_id AND session_id = :session_id
                        ORDER BY channel, sequence_number
                        """
                    ),
                    {"tenant_id": tenant_id, "session_id": session_id},
                )
            )
            .mappings()
            .all()
        )
        existing = {
            (CaptureChannel(row["channel"]), int(row["sequence_number"])): _chunk_reservation(
                dict(row)
            )
            for row in existing_rows
        }
        next_by_channel = {
            channel: (
                max(
                    (sequence for current, sequence in existing if current == channel),
                    default=-1,
                )
                + 1
            )
            for channel in CaptureChannel
        }
        for channel in CaptureChannel:
            requested_new = sorted(
                draft.sequence_number
                for draft in drafts
                if draft.channel == channel
                and (draft.channel, draft.sequence_number) not in existing
            )
            if requested_new != list(
                range(next_by_channel[channel], next_by_channel[channel] + len(requested_new))
            ):
                raise CaptureReservationLimitError

        new_drafts = [
            draft
            for draft in drafts
            if (draft.channel, draft.sequence_number) not in existing
        ]
        current_budget = sum(row.plaintext_budget_bytes for row in existing.values())
        if len(existing) + len(new_drafts) > maximum_chunks or (
            current_budget + sum(draft.plaintext_budget_bytes for draft in new_drafts)
            > maximum_plaintext_bytes
        ):
            raise CaptureReservationLimitError

        for draft in new_drafts:
            await self._session.execute(
                text(
                    """
                    INSERT INTO audio_chunk_reservations (
                        object_id, tenant_id, session_id, sequence_number, channel,
                        protocol_version, additional_data, plaintext_budget_bytes
                    ) VALUES (
                        :object_id, :tenant_id, :session_id, :sequence_number, :channel,
                        :protocol_version, :additional_data, :plaintext_budget_bytes
                    )
                    ON CONFLICT (tenant_id, session_id, sequence_number, channel)
                    DO NOTHING
                    """
                ),
                {
                    "object_id": draft.object_id,
                    "tenant_id": tenant_id,
                    "session_id": session_id,
                    "sequence_number": draft.sequence_number,
                    "channel": draft.channel.value,
                    "protocol_version": draft.protocol_version,
                    "additional_data": draft.additional_data,
                    "plaintext_budget_bytes": draft.plaintext_budget_bytes,
                },
            )

        canonical: list[ChunkReservationRecord] = []
        for draft in drafts:
            row = await self._one_or_none(
                """
                SELECT object_id, session_id, sequence_number, channel,
                       protocol_version, additional_data, plaintext_budget_bytes, created_at
                FROM audio_chunk_reservations
                WHERE tenant_id = :tenant_id
                  AND session_id = :session_id
                  AND sequence_number = :sequence_number
                  AND channel = :channel
                """,
                tenant_id=tenant_id,
                session_id=session_id,
                sequence_number=draft.sequence_number,
                channel=draft.channel.value,
            )
            if row is None:
                raise CaptureReservationLimitError
            canonical.append(_chunk_reservation(row))

        inserted_batch = await self._session.execute(
            text(
                """
                INSERT INTO audio_chunk_reservation_batches (
                    id, tenant_id, session_id, lease_id, lease_generation,
                    requested_protocol_version, item_count, capture_authorized_until
                )
                SELECT :batch_id, lease.tenant_id, lease.session_id, lease.lease_id,
                       lease.generation, :requested_protocol_version, :item_count,
                       lease.expires_at
                FROM capture_leases AS lease
                WHERE lease.tenant_id = :tenant_id
                  AND lease.session_id = :session_id
                  AND lease.lease_id = :lease_id
                  AND lease.generation = :lease_generation
                  AND lease.closed_at IS NULL
                  AND lease.expires_at > statement_timestamp()
                RETURNING id
                """
            ),
            {
                "batch_id": batch_id,
                "tenant_id": tenant_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "lease_generation": lease_generation,
                "requested_protocol_version": requested_protocol_version,
                "item_count": len(canonical),
            },
        )
        if inserted_batch.scalar_one_or_none() is None:
            raise CaptureLeaseConflictError
        for ordinal, reservation in enumerate(canonical):
            await self._session.execute(
                text(
                    """
                    INSERT INTO audio_chunk_reservation_batch_items (
                        tenant_id, session_id, batch_id, ordinal, object_id
                    ) VALUES (
                        :tenant_id, :session_id, :batch_id, :ordinal, :object_id
                    )
                    """
                ),
                {
                    "tenant_id": tenant_id,
                    "session_id": session_id,
                    "batch_id": batch_id,
                    "ordinal": ordinal,
                    "object_id": reservation.object_id,
                },
            )
        batch = await self.get_chunk_reservation_batch(tenant_id, batch_id)
        if batch is None:
            raise CaptureReservationLimitError
        return batch

    async def get_chunk_reservation(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
    ) -> ChunkReservationRecord | None:
        row = await self._one_or_none(
            """
            SELECT object_id, session_id, sequence_number, channel,
                   protocol_version, additional_data, plaintext_budget_bytes, created_at
            FROM audio_chunk_reservations
            WHERE tenant_id = :tenant_id
              AND session_id = :session_id
              AND object_id = :object_id
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = :session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            session_id=session_id,
            object_id=object_id,
        )
        return _chunk_reservation(row) if row is not None else None

    async def capture_reservation_usage(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> CaptureReservationUsage:
        rows = (
            (
                await self._session.execute(
                    text(
                        """
                        SELECT channel, max(sequence_number) AS maximum_sequence,
                               count(*) AS reservation_count,
                               sum(plaintext_budget_bytes) AS plaintext_budget_bytes
                        FROM audio_chunk_reservations
                        WHERE tenant_id = :tenant_id AND session_id = :session_id
                          AND EXISTS (
                              SELECT 1 FROM scribe_sessions AS session
                              WHERE session.tenant_id = :tenant_id
                                AND session.id = :session_id
                                AND session.transcript_contract_version IS NULL
                          )
                        GROUP BY channel
                        """
                    ),
                    {"tenant_id": tenant_id, "session_id": session_id},
                )
            )
            .mappings()
            .all()
        )
        by_channel = {CaptureChannel(row["channel"]): row for row in rows}
        return CaptureReservationUsage(
            reservation_count=sum(int(row["reservation_count"]) for row in rows),
            plaintext_budget_bytes=sum(
                int(row["plaintext_budget_bytes"] or 0) for row in rows
            ),
            next_sequence_numbers={
                channel: int(by_channel[channel]["maximum_sequence"]) + 1
                if channel in by_channel
                else 0
                for channel in CaptureChannel
            },
        )

    async def get_upload_authorization_receipt(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> UploadAuthorizationReceipt | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, reservation_object_id, issued_at, expires_at
            FROM audio_upload_authorization_receipts
            WHERE tenant_id = :tenant_id AND id = :receipt_id
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = audio_upload_authorization_receipts.session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            receipt_id=receipt_id,
        )
        return UploadAuthorizationReceipt(**row) if row is not None else None

    async def is_upload_authorization_active(
        self,
        tenant_id: UUID,
        receipt_id: UUID,
    ) -> bool:
        return bool(
            await self._session.scalar(
                text(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM audio_upload_authorization_receipts
                        WHERE tenant_id = :tenant_id
                          AND id = :receipt_id
                          AND expires_at > statement_timestamp()
                          AND EXISTS (
                              SELECT 1 FROM scribe_sessions AS session
                              WHERE session.tenant_id = :tenant_id
                                AND session.id =
                                    audio_upload_authorization_receipts.session_id
                                AND session.transcript_contract_version IS NULL
                          )
                    )
                    """
                ),
                {"tenant_id": tenant_id, "receipt_id": receipt_id},
            )
        )

    async def add_upload_authorization_receipt(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
        *,
        receipt_id: UUID,
        duration: timedelta,
    ) -> UploadAuthorizationReceipt | None:
        duration_seconds = _capture_duration_seconds(duration)
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or context.lease is None
            or context.lease.closed_at is not None
        ):
            return None
        row = (
            (
                await self._session.execute(
                    text(
                        """
                        INSERT INTO audio_upload_authorization_receipts (
                            id, tenant_id, session_id, reservation_object_id,
                            issued_at, expires_at
                        )
                        SELECT :receipt_id, reservation.tenant_id, reservation.session_id,
                               reservation.object_id, statement_timestamp(),
                               statement_timestamp()
                                   + (:duration_seconds * INTERVAL '1 second')
                        FROM audio_chunk_reservations AS reservation
                        JOIN scribe_sessions AS scribe_session
                          ON scribe_session.tenant_id = reservation.tenant_id
                         AND scribe_session.id = reservation.session_id
                        JOIN consent_records AS consent
                          ON consent.tenant_id = scribe_session.tenant_id
                         AND consent.id = scribe_session.consent_record_id
                        JOIN session_audio_keys AS audio_key
                          ON audio_key.tenant_id = scribe_session.tenant_id
                         AND audio_key.session_id = scribe_session.id
                        JOIN capture_leases AS lease
                          ON lease.tenant_id = scribe_session.tenant_id
                         AND lease.session_id = scribe_session.id
                        WHERE reservation.tenant_id = :tenant_id
                          AND reservation.session_id = :session_id
                          AND reservation.object_id = :object_id
                          AND scribe_session.transcript_contract_version IS NULL
                          AND scribe_session.status IN ('created', 'capturing')
                          AND consent.all_parties_consented
                          AND consent.revoked_at IS NULL
                          AND lease.closed_at IS NULL
                          AND NOT EXISTS (
                              SELECT 1
                              FROM audio_upload_authorization_receipts AS active_authorization
                              WHERE active_authorization.tenant_id = reservation.tenant_id
                                AND active_authorization.reservation_object_id =
                                    reservation.object_id
                                AND active_authorization.expires_at > statement_timestamp()
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM audio_chunks AS chunk
                              WHERE chunk.tenant_id = reservation.tenant_id
                                AND chunk.reservation_object_id = reservation.object_id
                          )
                        RETURNING id, session_id, reservation_object_id,
                                  issued_at, expires_at
                        """
                    ),
                    {
                        "receipt_id": receipt_id,
                        "tenant_id": tenant_id,
                        "session_id": session_id,
                        "object_id": object_id,
                        "duration_seconds": duration_seconds,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        return UploadAuthorizationReceipt(**dict(row)) if row is not None else None

    async def get_chunk_receipt(
        self,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
    ) -> ChunkReceipt | None:
        row = await self._one_or_none(
            """
            SELECT reservation.object_id, reservation.session_id,
                   reservation.sequence_number, reservation.channel,
                   reservation.protocol_version, reservation.additional_data,
                   reservation.plaintext_budget_bytes, reservation.created_at,
                   chunk.id AS chunk_id, chunk.sha256,
                   chunk.ciphertext_size_bytes, chunk.registered_at
            FROM audio_chunk_reservations AS reservation
            LEFT JOIN audio_chunks AS chunk
              ON chunk.tenant_id = reservation.tenant_id
             AND chunk.reservation_object_id = reservation.object_id
            WHERE reservation.tenant_id = :tenant_id
              AND reservation.session_id = :session_id
              AND reservation.object_id = :object_id
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = :session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            session_id=session_id,
            object_id=object_id,
        )
        if row is None:
            return None
        reservation = _chunk_reservation(row)
        registration = (
            AudioChunk(
                id=row["chunk_id"],
                session_id=row["session_id"],
                sequence_number=row["sequence_number"],
                channel=CaptureChannel(row["channel"]),
                object_id=row["object_id"],
                sha256=row["sha256"],
                ciphertext_size_bytes=row["ciphertext_size_bytes"],
                registered_at=row["registered_at"],
            )
            if row["chunk_id"] is not None
            else None
        )
        return ChunkReceipt(reservation=reservation, registration=registration)

    async def add_reserved_chunk(
        self,
        tenant_id: UUID,
        chunk: AudioChunk,
        *,
        protocol_version: str,
    ) -> bool:
        context = await self.lock_capture_context(tenant_id, chunk.session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}
            or context.lease is None
            or context.lease.closed_at is not None
        ):
            return False
        inserted = await self._session.execute(
            text(
                """
                INSERT INTO audio_chunks (
                    id, tenant_id, session_id, sequence_number, channel, object_id,
                    sha256, ciphertext_size_bytes, registered_at,
                    reservation_object_id, protocol_version
                )
                SELECT :id, reservation.tenant_id, reservation.session_id,
                       reservation.sequence_number, reservation.channel,
                       reservation.object_id, :sha256, :ciphertext_size_bytes,
                       :registered_at, reservation.object_id, reservation.protocol_version
                FROM audio_chunk_reservations AS reservation
                JOIN scribe_sessions AS scribe_session
                  ON scribe_session.tenant_id = reservation.tenant_id
                 AND scribe_session.id = reservation.session_id
                JOIN consent_records AS consent
                  ON consent.tenant_id = scribe_session.tenant_id
                 AND consent.id = scribe_session.consent_record_id
                JOIN capture_leases AS lease
                  ON lease.tenant_id = scribe_session.tenant_id
                 AND lease.session_id = scribe_session.id
                WHERE reservation.tenant_id = :tenant_id
                  AND reservation.session_id = :session_id
                  AND reservation.object_id = :object_id
                  AND reservation.sequence_number = :sequence_number
                  AND reservation.channel = :channel
                  AND reservation.protocol_version = :protocol_version
                  AND scribe_session.transcript_contract_version IS NULL
                  AND scribe_session.status IN ('created', 'capturing')
                  AND consent.all_parties_consented
                  AND consent.revoked_at IS NULL
                  AND lease.closed_at IS NULL
                  AND EXISTS (
                      SELECT 1
                      FROM audio_upload_authorization_receipts AS upload_receipt
                      WHERE upload_receipt.tenant_id = reservation.tenant_id
                        AND upload_receipt.reservation_object_id = reservation.object_id
                  )
                ON CONFLICT (tenant_id, object_id) DO NOTHING
                RETURNING id
                """
            ),
            {
                "id": chunk.id,
                "tenant_id": tenant_id,
                "session_id": chunk.session_id,
                "object_id": chunk.object_id,
                "sequence_number": chunk.sequence_number,
                "channel": chunk.channel.value,
                "protocol_version": protocol_version,
                "sha256": chunk.sha256,
                "ciphertext_size_bytes": chunk.ciphertext_size_bytes,
                "registered_at": chunk.registered_at,
            },
        )
        return inserted.scalar_one_or_none() is not None

    async def finalize_capture_channels(
        self,
        tenant_id: UUID,
        session_id: UUID,
        declarations: tuple[CaptureChannelFinalizationDraft, ...],
    ) -> tuple[CaptureChannelFinalization, ...]:
        if not declarations or len({item.channel for item in declarations}) != len(declarations):
            raise CaptureFinalizationError
        declared = {item.channel: item.last_sequence_number for item in declarations}
        if any(last < 0 or last >= MAX_CHUNKS for last in declared.values()):
            raise CaptureFinalizationError
        context = await self.lock_capture_context(tenant_id, session_id)
        if (
            context is not None
            and context.session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD
        ):
            raise CaptureIngestModeError(
                "session does not accept audio chunk capture"
            )
        existing = await self.capture_finalizations_for(tenant_id, session_id)
        if existing:
            if {
                item.channel: item.last_sequence_number for item in existing
            } != declared:
                raise CaptureFinalizationError
            return existing

        if (
            context is None
            or context.audio_key is None
            or not context.consent.all_parties_consented
            or context.consent.revoked_at is not None
            or context.session.status != SessionStatus.CAPTURING
            or context.lease is None
            or context.lease.closed_at is not None
        ):
            raise CaptureFinalizationError
        has_unreserved_chunk = await self._session.scalar(
            text(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM audio_chunks
                    WHERE tenant_id = :tenant_id
                      AND session_id = :session_id
                      AND reservation_object_id IS NULL
                )
                """
            ),
            {"tenant_id": tenant_id, "session_id": session_id},
        )
        if has_unreserved_chunk:
            raise CaptureFinalizationError
        chunks = await self.chunks_for(tenant_id, session_id)
        grouped: dict[CaptureChannel, list[int]] = {}
        for chunk in chunks:
            grouped.setdefault(chunk.channel, []).append(chunk.sequence_number)
        if set(grouped) != set(declared):
            raise CaptureFinalizationError
        for channel, last_sequence_number in declared.items():
            if sorted(grouped[channel]) != list(range(last_sequence_number + 1)):
                raise CaptureFinalizationError

        for channel in CaptureChannel:
            if channel not in declared:
                continue
            await self._session.execute(
                text(
                    """
                    INSERT INTO capture_channel_finalizations (
                        tenant_id, session_id, channel, last_sequence_number
                    ) VALUES (
                        :tenant_id, :session_id, :channel, :last_sequence_number
                    )
                    """
                ),
                {
                    "tenant_id": tenant_id,
                    "session_id": session_id,
                    "channel": channel.value,
                    "last_sequence_number": declared[channel],
                },
            )
        return await self.capture_finalizations_for(tenant_id, session_id)

    async def capture_finalizations_for(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> tuple[CaptureChannelFinalization, ...]:
        rows = (
            (
                await self._session.execute(
                    text(
                        """
                        SELECT session_id, channel, last_sequence_number, finalized_at
                        FROM capture_channel_finalizations
                        WHERE tenant_id = :tenant_id AND session_id = :session_id
                          AND EXISTS (
                              SELECT 1 FROM scribe_sessions AS session
                              WHERE session.tenant_id = :tenant_id
                                AND session.id = :session_id
                                AND session.transcript_contract_version IS NULL
                          )
                        ORDER BY CASE channel
                            WHEN 'microphone' THEN 0
                            WHEN 'system_audio' THEN 1
                            ELSE 2
                        END
                        """
                    ),
                    {"tenant_id": tenant_id, "session_id": session_id},
                )
            )
            .mappings()
            .all()
        )
        return tuple(
            CaptureChannelFinalization(
                session_id=row["session_id"],
                channel=CaptureChannel(row["channel"]),
                last_sequence_number=row["last_sequence_number"],
                finalized_at=row["finalized_at"],
            )
            for row in rows
        )

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
              AND session.transcript_contract_version IS NULL
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
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = audio_chunks.session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            id=chunk_id,
        )
        return AudioChunk.model_validate(row) if row is not None else None

    async def add_chunk(self, tenant_id: UUID, chunk: AudioChunk) -> None:
        await self._require_chunk_upload_session(tenant_id, chunk.session_id)
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
                      AND EXISTS (
                          SELECT 1 FROM scribe_sessions AS session
                          WHERE session.tenant_id = :tenant_id
                            AND session.id = :session_id
                            AND session.transcript_contract_version IS NULL
                      )
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
              AND EXISTS (
                  SELECT 1 FROM scribe_sessions AS session
                  WHERE session.tenant_id = :tenant_id
                    AND session.id = audio_upload_grants.session_id
                    AND session.transcript_contract_version IS NULL
              )
            """,
            tenant_id=tenant_id,
            id=object_id,
        )
        return UploadGrantRecord(**row) if row is not None else None

    async def add_upload_grant(self, tenant_id: UUID, grant: UploadGrantRecord) -> None:
        await self._require_chunk_upload_session(tenant_id, grant.session_id)
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
            SELECT transcript.id, transcript.session_id, transcript.language_code,
                   transcript.stt_provider, transcript.segments, transcript.created_at
            FROM transcripts AS transcript
            JOIN scribe_sessions AS session
              ON session.tenant_id = transcript.tenant_id
             AND session.id = transcript.session_id
            WHERE transcript.tenant_id = :tenant_id AND transcript.id = :id
              AND session.transcript_contract_version IS NULL
            """,
            tenant_id=tenant_id,
            id=transcript_id,
        )
        return Transcript.model_validate(row) if row is not None else None

    async def add_transcript(self, tenant_id: UUID, transcript: Transcript) -> None:
        inserted = await self._session.execute(
            text(
                """
                INSERT INTO transcripts (
                    id, tenant_id, session_id, language_code, stt_provider, segments, created_at
                )
                SELECT
                    :id, :tenant_id, :session_id, :language_code, :stt_provider,
                    CAST(:segments AS jsonb), :created_at
                FROM scribe_sessions AS session
                WHERE session.tenant_id = :tenant_id
                  AND session.id = :session_id
                  AND session.transcript_contract_version IS NULL
                RETURNING id
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
        if inserted.scalar_one_or_none() is None:
            raise ValueError("legacy session is unavailable for transcript persistence")

    async def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        row = await self._one_or_none(
            """
            SELECT transcript.id, transcript.session_id, transcript.language_code,
                   transcript.stt_provider, transcript.segments, transcript.created_at
            FROM transcripts AS transcript
            JOIN scribe_sessions AS session
              ON session.tenant_id = transcript.tenant_id
             AND session.id = transcript.session_id
            WHERE transcript.tenant_id = :tenant_id
              AND transcript.session_id = :session_id
              AND session.transcript_contract_version IS NULL
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
            SELECT job.id, job.session_id, job.status, job.attempt_count,
                   job.lease_token, job.lease_until, job.last_error_code,
                   job.created_at, job.updated_at
            FROM transcription_jobs AS job
            JOIN scribe_sessions AS session
              ON session.tenant_id = job.tenant_id
             AND session.id = job.session_id
            WHERE job.tenant_id = :tenant_id
              AND job.session_id = :session_id
              AND session.transcript_contract_version IS NULL
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
        await self._require_chunk_upload_session(tenant_id, session_id)
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
                                  AND scribe_sessions.transcript_contract_version IS NULL
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
                UPDATE transcription_jobs AS job
                SET status = :status,
                    attempt_count = :attempt_count,
                    lease_token = :lease_token,
                    lease_until = :lease_until,
                    last_error_code = :last_error_code,
                    updated_at = :updated_at
                FROM scribe_sessions AS session
                WHERE job.tenant_id = :tenant_id
                  AND job.id = :id
                  AND job.status = 'processing'
                  AND job.lease_token = :expected_lease_token
                  AND session.tenant_id = job.tenant_id
                  AND session.id = job.session_id
                  AND session.transcript_contract_version IS NULL
                RETURNING job.id
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
                UPDATE transcription_jobs AS job
                SET lease_until = :lease_until,
                    updated_at = :now
                FROM scribe_sessions AS session
                WHERE job.tenant_id = :tenant_id
                  AND job.id = :id
                  AND job.status = 'processing'
                  AND job.lease_token = :lease_token
                  AND job.lease_until > :now
                  AND session.tenant_id = job.tenant_id
                  AND session.id = job.session_id
                  AND session.transcript_contract_version IS NULL
                RETURNING job.id
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
            SELECT delivery.id, delivery.session_id, delivery.idempotency_key,
                   delivery.payload_sha256, delivery.status, delivery.attempt_count,
                   delivery.platform_transcript_id, delivery.last_error_code,
                   delivery.created_at, delivery.updated_at
            FROM transcript_deliveries AS delivery
            JOIN scribe_sessions AS session
              ON session.tenant_id = delivery.tenant_id
             AND session.id = delivery.session_id
            WHERE delivery.tenant_id = :tenant_id AND delivery.id = :id
              AND session.transcript_contract_version IS NULL
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
            SELECT delivery.id, delivery.session_id, delivery.idempotency_key,
                   delivery.payload_sha256, delivery.status, delivery.attempt_count,
                   delivery.platform_transcript_id, delivery.last_error_code,
                   delivery.updated_at
            FROM transcript_deliveries AS delivery
            JOIN scribe_sessions AS session
              ON session.tenant_id = delivery.tenant_id
             AND session.id = delivery.session_id
            WHERE delivery.tenant_id = :tenant_id AND delivery.id = :id
              AND session.transcript_contract_version IS NULL
            """,
            tenant_id=tenant_id,
            id=delivery_id,
        )
        return DeliveryAttempt.model_validate(row) if row is not None else None

    async def delivery_for(self, tenant_id: UUID, session_id: UUID) -> TranscriptDelivery | None:
        row = await self._one_or_none(
            """
            SELECT delivery.id, delivery.session_id, delivery.idempotency_key,
                   delivery.payload_sha256, delivery.status, delivery.attempt_count,
                   delivery.platform_transcript_id, delivery.last_error_code,
                   delivery.created_at, delivery.updated_at
            FROM transcript_deliveries AS delivery
            JOIN scribe_sessions AS session
              ON session.tenant_id = delivery.tenant_id
             AND session.id = delivery.session_id
            WHERE delivery.tenant_id = :tenant_id
              AND delivery.session_id = :session_id
              AND session.transcript_contract_version IS NULL
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return TranscriptDelivery.model_validate(row) if row is not None else None

    async def add_delivery(self, tenant_id: UUID, delivery: TranscriptDelivery) -> None:
        inserted = await self._session.execute(
            text(
                """
                INSERT INTO transcript_deliveries (
                    id, tenant_id, session_id, idempotency_key, payload_sha256,
                    status, attempt_count, platform_transcript_id, last_error_code,
                    created_at, updated_at
                )
                SELECT
                    :id, :tenant_id, :session_id, :idempotency_key, :payload_sha256,
                    :status, :attempt_count, :platform_transcript_id, :last_error_code,
                    :created_at, :updated_at
                FROM scribe_sessions AS session
                WHERE session.tenant_id = :tenant_id
                  AND session.id = :session_id
                  AND session.transcript_contract_version IS NULL
                RETURNING id
                """
            ),
            {
                **delivery.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "status": delivery.status.value,
            },
        )
        if inserted.scalar_one_or_none() is None:
            raise ValueError("legacy session is unavailable for delivery persistence")

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
                            JOIN scribe_sessions AS session
                              ON session.tenant_id = delivery.tenant_id
                             AND session.id = delivery.session_id
                            CROSS JOIN claim_clock
                            WHERE delivery.tenant_id = :tenant_id
                              AND session.transcript_contract_version IS NULL
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
              AND transcript_contract_version IS NULL
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
            SELECT consent_record_id
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
              AND transcript_contract_version IS NULL
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        if row is None:
            return DeliverySessionSyncResult.SESSION_UNAVAILABLE
        await self._lock_consent_scope(tenant_id, row["consent_record_id"])
        row = await self._one_or_none(
            """
            SELECT status
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :session_id
              AND transcript_contract_version IS NULL
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
                  AND transcript_contract_version IS NULL
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
                        UPDATE transcript_deliveries AS delivery
                        SET status = :status,
                            last_error_code = :last_error_code,
                            updated_at = statement_timestamp()
                        FROM scribe_sessions AS session
                        WHERE delivery.tenant_id = :tenant_id
                          AND delivery.id = :id
                          AND delivery.status = 'pending'
                          AND delivery.attempt_count = :expected_attempt_count
                          AND session.tenant_id = delivery.tenant_id
                          AND session.id = delivery.session_id
                          AND session.transcript_contract_version IS NULL
                        RETURNING delivery.id, delivery.session_id, delivery.idempotency_key,
                                  delivery.payload_sha256, delivery.status,
                                  delivery.attempt_count, delivery.platform_transcript_id,
                                  delivery.last_error_code, delivery.updated_at
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
                        UPDATE transcript_deliveries AS delivery
                        SET status = 'delivered',
                            platform_transcript_id = :platform_transcript_id,
                            last_error_code = NULL,
                            updated_at = statement_timestamp()
                        FROM scribe_sessions AS session
                        WHERE delivery.tenant_id = :tenant_id
                          AND delivery.id = :id
                          AND delivery.payload_sha256 = :expected_payload_sha256
                          AND delivery.status <> 'delivered'
                          AND session.tenant_id = delivery.tenant_id
                          AND session.id = delivery.session_id
                          AND session.transcript_contract_version IS NULL
                        RETURNING delivery.id, delivery.session_id, delivery.idempotency_key,
                                  delivery.payload_sha256, delivery.status,
                                  delivery.attempt_count, delivery.platform_transcript_id,
                                  delivery.last_error_code, delivery.updated_at
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
