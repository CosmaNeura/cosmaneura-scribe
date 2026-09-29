"""Bounded job entry point for one separately identified capture-processing stage."""

from __future__ import annotations

import asyncio
import os
import sys
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from urllib.parse import urlsplit
from uuid import UUID

from azure.identity.aio import DefaultAzureCredential
from sqlalchemy import text

from .audio_assembly import KeyVaultSessionKeyUnwrapper, build_audio_track_assembler
from .audio_keys import build_audio_encryption_key_provider
from .azure_translation import AzureGPT41TranslationAdapter, AzureTranslationProfile
from .captured_source_runtime import CapturedSourceRepositoryProvider
from .captured_transcription_worker import CapturedTranscriptionWorker
from .captured_translation_worker import CapturedTranslationWorker
from .captured_worker_settings import CapturedWorkerSettings
from .postgres_repository import build_postgres_provider
from .safe_logging import configure_standalone_logging, log_event
from .speech_private_network import PrivateSpeechEndpointGuard
from .transcription import build_speech_to_text_provider
from .transcription_job_runner import (
    AsyncCloser,
    close_job_resources,
    run_job_with_signal_cancellation,
)
from .translation_job_encryption import TranslationJobCipher

_ENABLED = "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED"
# Scheduled jobs start once per minute. Reuse their initialized clients across
# a bounded pickup window instead of leaving uploads waiting for the next start.
PENDING_PICKUP_SECONDS = 65.0
PENDING_POLL_SECONDS = 5.0
WorkerExecution = Callable[[CapturedWorkerSettings, UUID, UUID | None], Awaitable[None]]


class CapturedWorkerError(RuntimeError):
    """A fixed operational code, without configuration, content, or provider errors."""


async def run_captured_worker(
    *, arguments: Sequence[str] | None = None, environ: Mapping[str, str] | None = None,
    settings_factory: Callable[[], CapturedWorkerSettings] | None = None,
    execute: WorkerExecution | None = None,
) -> bool:
    source = os.environ if environ is None else environ
    if source.get(_ENABLED, "").strip().casefold() != "true":
        raise CapturedWorkerError("captured_worker_disabled")
    tenant_id: UUID | None = None
    try:
        args = list(sys.argv[1:] if arguments is None else arguments)
        if len(args) != 2:
            raise CapturedWorkerError("captured_worker_target_invalid")
        tenant_id = UUID(args[0])
        session_id = None if args[1] == "--pending" else UUID(args[1])
        settings = (settings_factory or CapturedWorkerSettings)()
        if (
            not settings.captured_worker_enabled
            or tenant_id not in settings.configured_capture_tenant_ids
            or (session_id is not None and session_id.int == 0)
            or source.get("AZURE_TOKEN_CREDENTIALS") != "ManagedIdentityCredential"
        ):
            raise CapturedWorkerError("captured_worker_bindings_invalid")
        await (execute or _execute)(settings, tenant_id, session_id)
        log_event(action="captured_worker.completed", tenant_id=tenant_id)
        return True
    except asyncio.CancelledError:
        log_event(action="captured_worker.cancelled", tenant_id=tenant_id)
        raise
    except Exception:
        pass
    log_event(action="captured_worker.failed", tenant_id=tenant_id,
              error_class="CapturedWorkerError")
    raise CapturedWorkerError("captured_worker_execution_failed") from None


async def _targets(
    repositories: CapturedSourceRepositoryProvider, settings: CapturedWorkerSettings,
    tenant_id: UUID, session_id: UUID | None,
) -> tuple[UUID, ...]:
    if session_id is not None:
        return (session_id,)
    if settings.captured_worker_stage == "translation":
        # Existing discovery already excludes unconfirmed provider calls. Its
        # speech branch is invisible under the translation role's session RLS.
        async with repositories.transaction(tenant_id) as store:
            return await store.discover_pending_captures(
                tenant_id, limit=settings.captured_worker_batch_size
            )
    # Speech discovery never reads translation jobs or encrypted text. Durable
    # claims and a maximum of three attempts still gate each selected session.
    async with repositories.engine.begin() as connection:
        await connection.execute(text("SET LOCAL statement_timeout = '60s'"))
        await connection.execute(text("SELECT set_config('app.tenant_id', :tenant, true)"),
                                 {"tenant": str(tenant_id)})
        rows = await connection.execute(text("""
            SELECT s.id FROM scribe_sessions s
            JOIN consent_records c ON c.tenant_id=s.tenant_id AND c.id=s.consent_record_id
            LEFT JOIN transcription_jobs j ON j.tenant_id=s.tenant_id AND j.session_id=s.id
            WHERE s.tenant_id=:tenant AND s.ingest_mode='chunk_upload'
              AND s.transcript_contract_version='1.0' AND s.status IN ('uploaded','processing')
              AND s.content_purged_at IS NULL AND c.all_parties_consented
              AND c.revoked_at IS NULL
              AND (s.transcript_content_expires_at IS NULL
                   OR s.transcript_content_expires_at>clock_timestamp())
              AND (j.id IS NULL OR j.status='retryable'
                   OR (j.status='processing' AND j.lease_until<=clock_timestamp()))
            ORDER BY s.id LIMIT :maximum
        """), {"tenant": tenant_id, "maximum": settings.captured_worker_batch_size})
        return tuple(rows.scalars())


async def _execute(settings: CapturedWorkerSettings, tenant: UUID, session: UUID | None) -> None:
    base = build_postgres_provider(settings)
    repositories = CapturedSourceRepositoryProvider(base.engine)
    closers: list[AsyncCloser] = [base.close]
    try:
        worker: CapturedTranscriptionWorker | CapturedTranslationWorker
        if settings.captured_worker_stage == "speech":
            assembler = build_audio_track_assembler(settings, repositories)
            closers.insert(0, assembler.close)
            transcriber = build_speech_to_text_provider(settings)
            closers.insert(0, transcriber.close)
            worker = CapturedTranscriptionWorker(
                repositories=repositories, assembler=assembler,
                transcriber=transcriber, enabled=True,
            )
        else:
            if (
                settings.azure_translation_endpoint is None
                or settings.azure_translation_deployment is None
            ):
                raise CapturedWorkerError("captured_worker_bindings_invalid")
            credential = DefaultAzureCredential(
                managed_identity_client_id=str(settings.managed_identity_client_id),
                require_envvar=True,
            )
            closers.insert(0, credential.close)
            keys = build_audio_encryption_key_provider(settings)
            closers.insert(0, keys.close)
            key_credential = DefaultAzureCredential(
                managed_identity_client_id=str(settings.managed_identity_client_id),
                require_envvar=True,
            )
            unwrapper = KeyVaultSessionKeyUnwrapper(
                configured_key_id=str(settings.audio_encryption_key_id), credential=key_credential
            )
            closers.insert(0, unwrapper.close)
            translator = AzureGPT41TranslationAdapter(
                AzureTranslationProfile(settings.azure_translation_endpoint,
                                        settings.azure_translation_deployment),
                credential=credential, endpoint_guard=PrivateSpeechEndpointGuard(
                    urlsplit(settings.azure_translation_endpoint).hostname or "",
                    settings.azure_translation_private_endpoint_cidrs,
                ),
            )
            worker = CapturedTranslationWorker(
                repositories=repositories, translator=translator,
                job_cipher=TranslationJobCipher(keys, unwrapper), enabled=True,
                limit=settings.captured_worker_batch_size,
            )
        await _dispatch(repositories, settings, tenant, session, worker)
    finally:
        await close_job_resources(closers)


async def _dispatch(
    repositories: CapturedSourceRepositoryProvider, settings: CapturedWorkerSettings,
    tenant: UUID, session: UUID | None,
    worker: CapturedTranscriptionWorker | CapturedTranslationWorker,
) -> None:
    deadline = time.monotonic() + PENDING_PICKUP_SECONDS
    seen: set[UUID] = set()
    failed = False
    while True:
        for target in await _targets(repositories, settings, tenant, session):
            if target in seen:
                continue  # A failed target is never retried within this execution.
            seen.add(target)
            try:
                if settings.captured_worker_stage == "speech":
                    async with repositories.transaction(tenant) as store:
                        await store.reconcile_exhausted_speech(tenant, target, max_attempts=3)
                # Existing durable claims arbitrate overlapping scheduled runs.
                await worker.process(tenant_id=tenant, session_id=target)
            except Exception:
                failed = True
            if len(seen) >= settings.captured_worker_batch_size:
                break
        if session is not None or len(seen) >= settings.captured_worker_batch_size:
            break  # Preserve explicit one-target runs and the existing work budget.
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        await asyncio.sleep(min(PENDING_POLL_SECONDS, remaining))
        if time.monotonic() >= deadline:
            break  # Pickup expires; accepted work was allowed to finish normally.
    if failed:
        raise CapturedWorkerError("captured_worker_target_unavailable")


def main() -> None:
    configure_standalone_logging()
    try:
        asyncio.run(run_job_with_signal_cancellation(run_captured_worker))
    except (asyncio.CancelledError, KeyboardInterrupt):
        raise SystemExit(130) from None
    except CapturedWorkerError:
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
