"""Bounded, default-off capture-to-review processing for trusted worker context."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID, uuid4

from .captured_source_runtime import CapturedSourceRepositoryProvider
from .captured_transcription_worker import CapturedTranscriptionWorker
from .normalized_source_persistence import CapturedPreSourceStatus, ConfiguredExternalSessionStatus
from .postgres_translation_jobs import PostgresTranslationJobStore, TranslationDispatchBatch
from .schemas import TranscriptionJobStatus
from .session_state_v1 import SessionIngestMode
from .transcription import SpeechToTextProvider
from .transcription_worker import AudioTrackAssembler, TranscriptionWorkerError
from .translation_adapter import SpanishToEnglishTranslationAdapter, translation_adapter_profile
from .translation_execution_v1 import (
    RepositoryCompletedTranslationJobCommitter,
    execute_reserved_translation_job,
)
from .translation_job_encryption import TranslationJobCipher


class CapturedProcessingState(StrEnum):
    CAPTURE_PENDING = "capture_pending"
    SPEECH_PROCESSING = "speech_processing"
    SPEECH_RETRYABLE = "speech_retryable"
    SPEECH_FAILED = "speech_failed"
    TRANSLATION_PENDING = "translation_pending"
    TRANSLATION_UNCONFIRMED = "translation_unconfirmed"
    TRANSLATION_RETRY_REQUIRED = "translation_retry_required"
    REVIEW_REQUIRED = "review_required"
    TRANSCRIPT_READY = "transcript_ready"
    QUALITY_BLOCKED = "quality_blocked"
    HANDED_OFF = "handed_off"
    UNAVAILABLE = "unavailable"


class CapturedProcessingUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("captured_processing_unavailable")


@dataclass(frozen=True)
class CapturedProcessingReceipt:
    session_id: UUID
    state: CapturedProcessingState


@dataclass(frozen=True)
class CapturedDispatchPage:
    receipts: tuple[CapturedProcessingReceipt, ...]
    next_after: UUID | None


class CapturedProcessingRuntime:
    """Caller owns resources; no settings, credentials, network or routes are bootstrapped."""

    def __init__(
        self,
        *,
        repositories: CapturedSourceRepositoryProvider,
        assembler: AudioTrackAssembler,
        transcriber: SpeechToTextProvider,
        translator: SpanishToEnglishTranslationAdapter,
        job_cipher: TranslationJobCipher,
        enabled: bool = False,
        max_translations: int = 8,
    ) -> None:
        if type(max_translations) is not int or not 1 <= max_translations <= 32:
            raise ValueError("captured_processing_limit_invalid")
        self._enabled = enabled is True
        self._repositories = repositories
        self._translator = translator
        self._profile: tuple[str, str] | None = None
        self._limit = max_translations
        self._speech = CapturedTranscriptionWorker(
            repositories=repositories,
            assembler=assembler,
            transcriber=transcriber,
            enabled=enabled,
        )
        self._jobs = PostgresTranslationJobStore(
            repositories.engine, job_cipher, normalized_ingest_mode=SessionIngestMode.CHUNK_UPLOAD
        )
        self._committer = RepositoryCompletedTranslationJobCommitter(repositories)

    def _require_enabled(self) -> None:
        if not self._enabled:
            raise CapturedProcessingUnavailable()

    async def process(self, *, tenant_id: UUID, session_id: UUID) -> CapturedProcessingReceipt:
        self._require_enabled()
        try:
            profile = translation_adapter_profile(self._translator)
            if self._profile is not None and profile != self._profile:
                raise CapturedProcessingUnavailable()
            self._profile = profile
            return await self._process(tenant_id, session_id)
        except Exception:
            pass
        raise CapturedProcessingUnavailable()

    async def _process(self, tenant_id: UUID, session_id: UUID) -> CapturedProcessingReceipt:
        async with self._repositories.transaction(tenant_id) as store:
            session = await store.lock_live_capture(tenant_id, session_id)
            if session.status in {
                ConfiguredExternalSessionStatus.CREATED,
                CapturedPreSourceStatus.CAPTURING,
            }:
                return CapturedProcessingReceipt(
                    session_id, CapturedProcessingState.CAPTURE_PENDING
                )
            if session.status == ConfiguredExternalSessionStatus.HANDED_OFF:
                return CapturedProcessingReceipt(session_id, CapturedProcessingState.HANDED_OFF)
            needs_speech = isinstance(session.status, CapturedPreSourceStatus)
            if needs_speech:
                await store.reconcile_exhausted_speech(tenant_id, session_id, max_attempts=3)
        if needs_speech:
            try:
                await self._speech.process(tenant_id=tenant_id, session_id=session_id)
            except TranscriptionWorkerError:
                async with self._repositories.transaction(tenant_id) as store:
                    await store.lock_live_capture(tenant_id, session_id)
                    job = await store.transcription_job_for(tenant_id, session_id)
                if job is None:
                    raise CapturedProcessingUnavailable() from None
                state = {
                    TranscriptionJobStatus.TERMINAL: CapturedProcessingState.SPEECH_FAILED,
                    TranscriptionJobStatus.RETRYABLE: CapturedProcessingState.SPEECH_RETRYABLE,
                    TranscriptionJobStatus.PROCESSING: CapturedProcessingState.SPEECH_PROCESSING,
                }.get(job.status)
                if state is not None:
                    return CapturedProcessingReceipt(session_id, state)
                # A lost publication reply may have committed; proceed from storage.
        async with self._repositories.transaction(tenant_id) as store:
            job = await store.transcription_job_for(tenant_id, session_id)
            if job is None or not await store.recover_completed_speech(tenant_id, session_id, job):
                raise CapturedProcessingUnavailable()
        batch = await self._jobs.prepare_dispatch(tenant_id, session_id, limit=self._limit)
        for job_id in batch.executable_job_ids:
            if translation_adapter_profile(self._translator) != self._profile:
                raise CapturedProcessingUnavailable()
            await execute_reserved_translation_job(
                store=self._jobs,
                adapter=self._translator,
                committer=self._committer,
                tenant_id=tenant_id,
                session_id=session_id,
                translation_id=job_id,
                provider_call_token=uuid4(),
            )
        current = await self._jobs.prepare_dispatch(
            tenant_id, session_id, limit=self._limit, reserve_initial=False
        )
        return CapturedProcessingReceipt(session_id, self._state(current))

    @staticmethod
    def _state(batch: TranslationDispatchBatch) -> CapturedProcessingState:
        return captured_processing_state(batch)

    async def run_pending(
        self, *, tenant_id: UUID, limit: int = 8, after: UUID | None = None
    ) -> CapturedDispatchPage:
        self._require_enabled()
        try:
            async with self._repositories.transaction(tenant_id) as store:
                targets = await store.discover_pending_captures(tenant_id, limit=limit, after=after)
        except Exception:
            targets = None
        if targets is None:
            raise CapturedProcessingUnavailable()
        receipts: list[CapturedProcessingReceipt] = []
        for session_id in targets:
            try:
                receipt = await self.process(tenant_id=tenant_id, session_id=session_id)
            except CapturedProcessingUnavailable:
                receipt = CapturedProcessingReceipt(session_id, CapturedProcessingState.UNAVAILABLE)
            receipts.append(receipt)
        return CapturedDispatchPage(
            tuple(receipts), targets[-1] if targets and len(targets) == limit else None
        )


def captured_processing_state(batch: TranslationDispatchBatch) -> CapturedProcessingState:
    if batch.status == ConfiguredExternalSessionStatus.QUALITY_BLOCKED:
        return CapturedProcessingState.QUALITY_BLOCKED
    if batch.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY:
        return CapturedProcessingState.TRANSCRIPT_READY
    if batch.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED:
        return CapturedProcessingState.REVIEW_REQUIRED
    if batch.unconfirmed_count:
        # In flight or uncertain: neither a failed call nor permission to repeat it.
        return CapturedProcessingState.TRANSLATION_UNCONFIRMED
    if batch.retry_required_count:
        return CapturedProcessingState.TRANSLATION_RETRY_REQUIRED
    return CapturedProcessingState.TRANSLATION_PENDING
