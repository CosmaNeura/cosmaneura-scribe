"""Default-off PostgreSQL admission and atomic leased Speech-result publication.

Inputs are trusted Core/worker context, never request-body identity or a public
transcript upload. No route, recorder, provider call or worker is activated here.
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from .azure_speech_source import normalize_azure_source
from .capture_continuity import CaptureContinuity, NativeIntervalStart
from .creator_review_contract_v1 import CreatorTranslationProgressV1
from .normalized_source_persistence import (
    CAPTURED_NORMALIZATION_PROFILE_ID,
    CAPTURED_TRANSCRIPTION_ADAPTER_ID,
    CAPTURED_TRANSCRIPTION_MODEL_PROFILE_ID,
    CapturedPreSourceStatus,
    CapturedSessionCreate,
    ConfiguredExternalSessionStatus,
    ConfiguredSourceSessionRecord,
    NormalizedSourceAcceptance,
    consent_authorizes_versioned_session,
)
from .postgres_repository import PostgresRepository
from .repository import (
    CaptureChannelFinalization,
    CaptureChannelFinalizationDraft,
    CaptureFinalizationError,
    CaptureIngestModeError,
)
from .schemas import Transcript, TranscriptionJob, TranscriptionJobStatus
from .session_state_v1 import SessionIngestMode
from .transcript_constraints import MAX_TRANSCRIPT_SEGMENTS
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
        super().__init__(
            session,
            normalized_ingest_mode=SessionIngestMode.CHUNK_UPLOAD,
            configured_capture=True,
        )

    async def finalize_capture_channels(
        self,
        tenant_id: UUID,
        session_id: UUID,
        declarations: tuple[CaptureChannelFinalizationDraft, ...],
    ) -> tuple[CaptureChannelFinalization, ...]:
        await self.lock_live_capture(tenant_id, session_id)
        active = await self._session.scalar(
            text("""
            SELECT EXISTS (SELECT 1 FROM source_start_attempts
                WHERE tenant_id = :tenant AND session_id = :session
                    AND state IN ('prepared', 'issued'))
        """),
            {"tenant": tenant_id, "session": session_id},
        )
        if active:
            raise CaptureFinalizationError
        starts = await self._native_interval_starts(tenant_id, session_id)
        declared = {item.channel.value: item.last_sequence_number for item in declarations}
        if any(
            row["first_sequence_number"]
            > declared.get("mixed" if row["source"] == "desktop_companion" else "microphone", -2)
            + 1
            for row in starts
        ):
            raise CaptureFinalizationError
        return await super().finalize_capture_channels(tenant_id, session_id, declarations)

    async def _native_interval_starts(
        self,
        tenant_id: UUID,
        session_id: UUID,
    ) -> Sequence[RowMapping]:
        rows = (
            (
                await self._session.execute(
                    text("""
            SELECT id, source, first_sequence_number, state FROM source_start_attempts
            WHERE tenant_id = :tenant AND session_id = :session AND issued_at IS NOT NULL
            ORDER BY first_sequence_number, prepared_at, id LIMIT 1001
        """),
                    {"tenant": tenant_id, "session": session_id},
                )
            )
            .mappings()
            .all()
        )
        if len(rows) > 1000 or any(row["state"] != "stopped" for row in rows):
            raise CapturedSourceUnavailable()
        return rows

    async def capture_continuity(
        self, tenant_id: UUID, session_id: UUID
    ) -> CaptureContinuity | None:
        # Caller holds the live creator/source session lock. These starts cannot
        # change after finalization; they do not claim actual audio or gap duration.
        rows = await self._native_interval_starts(tenant_id, session_id)
        if len(rows) < 2:
            return None
        return CaptureContinuity(
            starts=tuple(
                NativeIntervalStart(
                    source_start_id=row["id"],
                    first_sequence_number=row["first_sequence_number"],
                )
                for row in rows
            )
        )

    async def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        # The legacy worker probes here before assembling audio. Fail before any
        # provider call when it is accidentally paired with configured capture.
        raise CaptureIngestModeError("configured capture requires its source reader")

    async def get_transcript(self, tenant_id: UUID, transcript_id: UUID) -> Transcript | None:
        raise CaptureIngestModeError("configured capture requires its source reader")

    async def lock_live_capture(
        self, tenant_id: UUID, session_id: UUID
    ) -> ConfiguredSourceSessionRecord:
        locked = await self._lock_normalized_source_session(tenant_id, session_id)
        if locked is None:
            raise CapturedSourceUnavailable()
        session, now = locked
        self._require_live_normalized_source_session(session, now)
        return session

    async def creator_translation_progress(
        self,
        tenant_id: UUID,
        session_id: UUID,
        *,
        creator_actor_id: str,
        source_version: int,
    ) -> tuple[CreatorTranslationProgressV1, ...]:
        """Read outstanding metadata under the same live creator/source lock.

        No ciphertext, key service, reservation, worker or model is accessed.
        A published attempt wins over a lagging job commit marker.
        """
        session = await self.lock_live_capture(tenant_id, session_id)
        if (
            type(source_version) is not int
            or session.creator_actor_id != creator_actor_id
            or session.current_source_transcript_version != source_version
            or session.status == ConfiguredExternalSessionStatus.HANDED_OFF
        ):
            raise CapturedSourceUnavailable()
        rows = (
            (
                await self._session.execute(
                    text("""
                SELECT job.source_segment_id, job.source_segment_version,
                       CASE job.status
                         WHEN 'reserved' THEN 'queued'
                         WHEN 'provider_call_started' THEN 'unconfirmed'
                         WHEN 'provider_result_stored' THEN 'result_saved'
                       END AS state
                FROM encrypted_translation_jobs AS job
                WHERE job.tenant_id = :tenant AND job.session_id = :session
                  AND job.source_transcript_version = :version
                  AND job.status IN ('reserved', 'provider_call_started', 'provider_result_stored')
                  AND NOT EXISTS (
                    SELECT 1 FROM normalized_translation_attempts AS attempt
                    WHERE attempt.tenant_id = job.tenant_id
                      AND attempt.session_id = job.session_id
                      AND attempt.translation_id = job.translation_id
                  )
                ORDER BY job.source_segment_id
                LIMIT :limit
            """),
                    {
                        "tenant": tenant_id,
                        "session": session_id,
                        "version": source_version,
                        "limit": MAX_TRANSCRIPT_SEGMENTS + 1,
                    },
                )
            )
            .mappings()
            .all()
        )
        if len(rows) > MAX_TRANSCRIPT_SEGMENTS or len(
            {row["source_segment_id"] for row in rows}
        ) != len(rows):
            raise CapturedSourceUnavailable()
        return tuple(CreatorTranslationProgressV1.model_validate(dict(row)) for row in rows)

    async def reconcile_exhausted_speech(
        self, tenant_id: UUID, session_id: UUID, *, max_attempts: int
    ) -> None:
        if type(max_attempts) is not int or max_attempts < 1:
            raise CapturedSourceUnavailable()
        session = await self.lock_live_capture(tenant_id, session_id)
        if session.status != CapturedPreSourceStatus.PROCESSING:
            return
        job_id = await self._session.scalar(
            text("""
            UPDATE transcription_jobs SET status = 'terminal', lease_token = NULL,
                lease_until = NULL, last_error_code = 'captured_speech_attempts_exhausted',
                updated_at = clock_timestamp()
            WHERE tenant_id = :tenant AND session_id = :session AND attempt_count >= :maximum
              AND (status = 'retryable' OR (
                  status = 'processing' AND lease_until <= clock_timestamp()
              ))
            RETURNING id
        """),
            {"tenant": tenant_id, "session": session_id, "maximum": max_attempts},
        )
        if job_id is not None:
            await self.audit(
                tenant_id=tenant_id,
                action="captured_speech.exhausted",
                entity_type="transcription_job",
                entity_id=job_id,
            )

    async def discover_pending_captures(
        self, tenant_id: UUID, *, limit: int = 8, after: UUID | None = None
    ) -> tuple[UUID, ...]:
        """Metadata discovery only; each target is authorized again before any work."""
        if type(limit) is not int or not 1 <= limit <= 32:
            raise CapturedSourceUnavailable()
        rows = await self._session.execute(
            text("""
            SELECT session.id FROM scribe_sessions AS session
            JOIN consent_records AS consent ON consent.tenant_id = session.tenant_id
              AND consent.id = session.consent_record_id
            LEFT JOIN transcription_jobs AS speech ON speech.tenant_id = session.tenant_id
              AND speech.session_id = session.id
            WHERE session.tenant_id = :tenant
              AND session.transcript_contract_version = '1.0'
              AND session.ingest_mode = 'chunk_upload'
              AND (CAST(:after AS uuid) IS NULL OR session.id > :after)
              AND consent.all_parties_consented AND consent.revoked_at IS NULL
              AND session.content_purged_at IS NULL
              AND (session.transcript_content_expires_at IS NULL
                   OR session.transcript_content_expires_at > clock_timestamp())
              AND (
                (session.status IN ('uploaded', 'processing') AND (
                    speech.id IS NULL OR speech.status = 'retryable'
                    OR (speech.status = 'processing' AND speech.lease_until <= clock_timestamp())
                ))
                OR (session.status IN ('translation_pending', 'review_required', 'transcript_ready')
                    AND speech.status = 'completed' AND (
                    EXISTS (
                        SELECT 1 FROM encrypted_translation_jobs AS job
                        WHERE job.tenant_id = session.tenant_id AND job.session_id = session.id
                          AND job.source_transcript_version =
                              session.current_source_transcript_version
                          AND job.status IN ('reserved', 'provider_result_stored')
                    ) OR (session.status = 'translation_pending' AND EXISTS (
                        SELECT 1 FROM normalized_source_segments AS segment
                        WHERE segment.tenant_id = session.tenant_id
                          AND segment.session_id = session.id
                          AND segment.source_transcript_version =
                              session.current_source_transcript_version
                          AND segment.source_locale = 'es-US'
                          AND NOT EXISTS (
                              SELECT 1 FROM normalized_translation_attempts AS attempt
                              WHERE attempt.tenant_id = segment.tenant_id
                                AND attempt.session_id = segment.session_id
                                AND attempt.source_transcript_version =
                                    segment.source_transcript_version
                                AND attempt.source_segment_id = segment.source_segment_id
                                AND attempt.source_segment_version = segment.source_segment_version
                          ) AND NOT EXISTS (
                              SELECT 1 FROM encrypted_translation_jobs AS job
                              WHERE job.tenant_id = segment.tenant_id
                                AND job.session_id = segment.session_id
                                AND job.source_transcript_version =
                                    segment.source_transcript_version
                                AND job.source_segment_id = segment.source_segment_id
                                AND job.source_segment_version = segment.source_segment_version
                                AND job.previous_translation_version = 0
                          )
                    ))
                ))
              )
            ORDER BY session.id LIMIT :limit
        """),
            {"tenant": tenant_id, "after": after, "limit": limit},
        )
        return tuple(rows.scalars())

    async def recover_completed_speech(
        self, tenant_id: UUID, session_id: UUID, job: TranscriptionJob
    ) -> bool:
        session = await self.lock_live_capture(tenant_id, session_id)
        if (
            job.session_id != session_id
            or job.status != TranscriptionJobStatus.COMPLETED
            or session.current_source_transcript_version is None
        ):
            return False
        # Metadata-only acknowledgment of the original completed Speech attempt.
        # Current corrections/reviews are not republished or replaced by this read.
        receipt = await self._one_or_none(
            """
            SELECT receipt.source_transcript_version
            FROM normalized_source_receipt_keys AS receipt
            JOIN normalized_source_transcripts AS source
              ON source.tenant_id = receipt.tenant_id AND source.session_id = receipt.session_id
             AND source.source_transcript_version = receipt.source_transcript_version
            JOIN transcription_jobs AS job
              ON job.tenant_id = receipt.tenant_id AND job.session_id = receipt.session_id
            WHERE receipt.tenant_id = :tenant AND receipt.session_id = :session
              AND receipt.source_transcript_version = 1
              AND receipt.idempotency_key LIKE :prefix
              AND job.id = :job AND job.attempt_count = :attempt AND job.status = 'completed'
            """,
            tenant=tenant_id,
            session=session_id,
            job=job.id,
            attempt=job.attempt_count,
            prefix=f"captured-speech:{job.id}:{job.attempt_count}:%",
        )
        return receipt is not None

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
