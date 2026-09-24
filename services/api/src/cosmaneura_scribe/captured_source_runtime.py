"""Default-off PostgreSQL admission and atomic leased Speech-result publication.

Inputs are trusted Core/worker context, never request-body identity or a public
transcript upload. No route, recorder, provider call or worker is activated here.
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from .azure_speech_source import normalize_azure_source
from .normalized_source_persistence import (
    CAPTURED_NORMALIZATION_PROFILE_ID,
    CAPTURED_TRANSCRIPTION_ADAPTER_ID,
    CAPTURED_TRANSCRIPTION_MODEL_PROFILE_ID,
    CapturedPreSourceStatus,
    CapturedSessionCreate,
    ConfiguredSourceSessionRecord,
    NormalizedSourceAcceptance,
    consent_authorizes_versioned_session,
)
from .postgres_repository import PostgresRepository
from .session_state_v1 import SessionIngestMode
from .transcription import SttResult
from .working_transcript_persistence import WorkingTranscriptPublication


class CapturedSourceUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("captured_source_unavailable")


@dataclass(frozen=True, repr=False)
class CapturedSpeechCompletion:
    job_id: UUID
    lease_token: UUID
    attempt_count: int
    result: SttResult

    def __post_init__(self) -> None:
        if type(self.attempt_count) is not int or self.attempt_count < 1:
            raise ValueError("captured Speech attempt is invalid")

    @property
    def receipt_key(self) -> str:
        # The full lease token is not copied into a receipt key or audit record.
        token_digest = hashlib.sha256(self.lease_token.bytes).hexdigest()
        return f"captured-speech:{self.job_id}:{self.attempt_count}:{token_digest}"

    def __repr__(self) -> str:
        return "CapturedSpeechCompletion(<protected>)"


@dataclass(frozen=True, repr=False)
class CapturedSourcePublication:
    source: NormalizedSourceAcceptance
    working: WorkingTranscriptPublication

    def __repr__(self) -> str:
        return "CapturedSourcePublication(<protected>)"


class CapturedSourceRepository(PostgresRepository):
    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, normalized_ingest_mode=SessionIngestMode.CHUNK_UPLOAD)

    async def admit_capture(
        self, tenant_id: UUID, draft: CapturedSessionCreate
    ) -> ConfiguredSourceSessionRecord:
        consent = await self.lock_consent(tenant_id, draft.consent_record_id)
        if not consent_authorizes_versioned_session(consent, draft):
            raise CapturedSourceUnavailable()
        values = {
            "tenant": tenant_id,
            "id": draft.id,
            "appointment": draft.appointment_id,
            "practitioner": draft.practitioner_id,
            "patient": draft.patient_id,
            "consent": draft.consent_record_id,
            "modality": draft.modality.value,
            "creator": draft.creator_actor_id,
            "language": draft.language_mode.value,
            "adapter": CAPTURED_TRANSCRIPTION_ADAPTER_ID,
            "model": CAPTURED_TRANSCRIPTION_MODEL_PROFILE_ID,
            "normalizer": CAPTURED_NORMALIZATION_PROFILE_ID,
        }
        inserted = await self._session.scalar(
            text("""
            INSERT INTO scribe_sessions (
                id, tenant_id, appointment_id, practitioner_id, patient_id, consent_record_id,
                modality, ingest_mode, status, transcript_contract_version, creator_actor_id,
                language_mode, transcription_adapter_id, transcription_model_profile_id,
                normalization_profile_id
            ) VALUES (:id, :tenant, :appointment, :practitioner, :patient, :consent, :modality,
                      'chunk_upload', 'created', '1.0', :creator, :language, :adapter,
                      :model, :normalizer)
            ON CONFLICT (id) DO NOTHING RETURNING id
        """),
            values,
        )
        current = await self._get_configured_source_session(tenant_id, draft.id)
        if current is None or any(
            getattr(current, field) != getattr(draft, field)
            for field in (
                "id",
                "appointment_id",
                "practitioner_id",
                "patient_id",
                "consent_record_id",
                "modality",
                "creator_actor_id",
                "language_mode",
            )
        ):
            raise CapturedSourceUnavailable()
        if inserted is not None:
            await self.audit(
                tenant_id=tenant_id,
                action="captured_session.admitted",
                entity_type="scribe_session",
                entity_id=draft.id,
            )
        # Same consent scope remains locked until the caller's transaction commits.
        if not consent_authorizes_versioned_session(
            await self.get_consent(tenant_id, draft.consent_record_id), current
        ):
            raise CapturedSourceUnavailable()
        return current

    async def complete_speech(
        self,
        tenant_id: UUID,
        session_id: UUID,
        completion: CapturedSpeechCompletion,
    ) -> CapturedSourcePublication:
        locked = await self._lock_normalized_source_session(tenant_id, session_id)
        if locked is None:
            raise CapturedSourceUnavailable()
        session, now = locked
        self._require_live_normalized_source_session(session, now)
        if completion.result.language_code != session.language_mode.value:
            raise CapturedSourceUnavailable()
        job = await self._one_or_none(
            """
            SELECT id, status, attempt_count, lease_token, lease_until
            FROM transcription_jobs WHERE tenant_id = :tenant AND session_id = :session
            FOR UPDATE
        """,
            tenant=tenant_id,
            session=session_id,
        )
        if (
            job is None
            or job["id"] != completion.job_id
            or job["attempt_count"] != completion.attempt_count
        ):
            raise CapturedSourceUnavailable()
        replay = job["status"] == "completed"
        if replay:
            # A completed job cannot submit a correction or mint another receipt.
            bound = await self._one_or_none(
                """
                SELECT source_transcript_version FROM normalized_source_receipt_keys
                WHERE tenant_id = :tenant AND session_id = :session AND idempotency_key = :key
            """,
                tenant=tenant_id,
                session=session_id,
                key=completion.receipt_key,
            )
            if (
                bound is None
                or bound["source_transcript_version"] != 1
                or session.current_source_transcript_version != 1
            ):
                raise CapturedSourceUnavailable()
        elif (
            job["status"] != "processing"
            or job["lease_token"] != completion.lease_token
            or not isinstance(job["lease_until"], datetime)
            or job["lease_until"] <= now
            or session.status != CapturedPreSourceStatus.PROCESSING
            or session.current_source_transcript_version is not None
        ):
            raise CapturedSourceUnavailable()
        request = normalize_azure_source(completion.result)
        source = await self.accept_normalized_source_transcript(
            tenant_id, session_id, idempotency_key=completion.receipt_key, request=request
        )
        working = await self.publish_current_working_transcript(tenant_id, session_id)
        if source is None or working is None or source.receipt.source_transcript_version != 1:
            raise CapturedSourceUnavailable()
        if not replay:
            completed = await self._session.scalar(
                text("""
                UPDATE transcription_jobs
                SET status = 'completed', lease_token = NULL, lease_until = NULL,
                    last_error_code = NULL, updated_at = clock_timestamp()
                WHERE tenant_id = :tenant AND session_id = :session AND id = :job
                  AND attempt_count = :attempt AND status = 'processing'
                  AND lease_token = :token AND lease_until > clock_timestamp()
                RETURNING id
            """),
                {
                    "tenant": tenant_id,
                    "session": session_id,
                    "job": completion.job_id,
                    "attempt": completion.attempt_count,
                    "token": completion.lease_token,
                },
            )
            if completed is None:
                raise CapturedSourceUnavailable()
            await self.audit(
                tenant_id=tenant_id,
                action="captured_speech.completed",
                entity_type="transcription_job",
                entity_id=completion.job_id,
            )
        await self._final_normalized_source_gate(tenant_id, session_id)
        return CapturedSourcePublication(source=source, working=working)


class CapturedSourceRepositoryProvider:
    """Explicit captured-mode provider. Owns its engine; no environment bootstrap."""

    def __init__(self, engine: AsyncEngine) -> None:
        self.engine = engine
        self._sessions = async_sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[CapturedSourceRepository]:
        async with self._sessions() as session, session.begin():
            await session.execute(text("SET LOCAL lock_timeout = '5s'"))
            await session.execute(text("SET LOCAL statement_timeout = '60s'"))
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tenant, true)"),
                {"tenant": str(tenant_id)},
            )
            yield CapturedSourceRepository(session)

    async def health(self) -> None:
        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def close(self) -> None:
        await self.engine.dispose()


class CapturedSourceRuntime:
    def __init__(self, repositories: CapturedSourceRepositoryProvider, *, enabled: bool = False):
        self._repositories = repositories
        self._enabled = enabled is True

    def _require_enabled(self) -> None:
        if not self._enabled:
            raise CapturedSourceUnavailable()

    async def admit(
        self, *, tenant_id: UUID, draft: CapturedSessionCreate
    ) -> ConfiguredSourceSessionRecord:
        self._require_enabled()
        try:
            async with self._repositories.transaction(tenant_id) as repository:
                record = await repository.admit_capture(tenant_id, draft)
            return record
        except Exception:
            pass
        raise CapturedSourceUnavailable()

    async def publish_speech_result(
        self, *, tenant_id: UUID, session_id: UUID, completion: CapturedSpeechCompletion
    ) -> CapturedSourcePublication:
        self._require_enabled()
        try:
            async with self._repositories.transaction(tenant_id) as repository:
                publication = await repository.complete_speech(tenant_id, session_id, completion)
            return publication
        except Exception:
            pass
        # Raise after __aexit__ and outside the handler: no raw driver/result context.
        # Cancellation propagates. Only an exact caller retry may resolve a lost commit reply.
        raise CapturedSourceUnavailable()
