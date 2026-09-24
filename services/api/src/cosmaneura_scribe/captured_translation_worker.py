"""Translation phase only: no audio reader, Speech client, or capture authority."""

from __future__ import annotations

from uuid import UUID, uuid4

from .captured_processing import CapturedProcessingReceipt, captured_processing_state
from .captured_source_runtime import CapturedSourceRepositoryProvider, CapturedSourceUnavailable
from .normalized_source_persistence import ConfiguredExternalSessionStatus
from .postgres_translation_jobs import PostgresTranslationJobStore
from .session_state_v1 import SessionIngestMode
from .translation_adapter import SpanishToEnglishTranslationAdapter, translation_adapter_profile
from .translation_execution_v1 import (
    RepositoryCompletedTranslationJobCommitter,
    execute_reserved_translation_job,
)
from .translation_job_encryption import TranslationJobCipher


class CapturedTranslationWorker:
    def __init__(
        self, *, repositories: CapturedSourceRepositoryProvider,
        translator: SpanishToEnglishTranslationAdapter, job_cipher: TranslationJobCipher,
        enabled: bool = False, limit: int = 8,
    ) -> None:
        if type(limit) is not int or not 1 <= limit <= 32:
            raise ValueError("captured_translation_limit_invalid")
        self._enabled = enabled is True
        self._repositories = repositories
        self._translator = translator
        self._profile = translation_adapter_profile(translator)
        self._limit = limit
        self._jobs = PostgresTranslationJobStore(
            repositories.engine, job_cipher, normalized_ingest_mode=SessionIngestMode.CHUNK_UPLOAD
        )
        self._committer = RepositoryCompletedTranslationJobCommitter(repositories)

    async def process(self, *, tenant_id: UUID, session_id: UUID) -> CapturedProcessingReceipt:
        if not self._enabled:
            raise CapturedSourceUnavailable()
        async with self._repositories.transaction(tenant_id) as store:
            session = await store.lock_live_capture(tenant_id, session_id)
            if session.status not in {
                ConfiguredExternalSessionStatus.TRANSLATION_PENDING,
                ConfiguredExternalSessionStatus.REVIEW_REQUIRED,
                ConfiguredExternalSessionStatus.TRANSCRIPT_READY,
            }:
                raise CapturedSourceUnavailable()
            speech = await store.transcription_job_for(tenant_id, session_id)
            if speech is None or not await store.recover_completed_speech(
                tenant_id, session_id, speech
            ):
                raise CapturedSourceUnavailable()
        batch = await self._jobs.prepare_dispatch(tenant_id, session_id, limit=self._limit)
        for job_id in batch.executable_job_ids:
            if translation_adapter_profile(self._translator) != self._profile:
                raise CapturedSourceUnavailable()
            await execute_reserved_translation_job(
                store=self._jobs, adapter=self._translator, committer=self._committer,
                tenant_id=tenant_id, session_id=session_id, translation_id=job_id,
                provider_call_token=uuid4(),
            )
        current = await self._jobs.prepare_dispatch(
            tenant_id, session_id, limit=self._limit, reserve_initial=False
        )
        return CapturedProcessingReceipt(session_id, captured_processing_state(current))
