from __future__ import annotations

import asyncio
import os
import signal
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from uuid import UUID

from .audio_assembly import build_audio_track_assembler
from .postgres_repository import build_postgres_provider
from .safe_logging import log_event
from .settings import Settings, get_settings
from .transcription import build_speech_to_text_provider
from .transcription_worker import TranscriptionWorker

TRANSCRIPTION_JOB_ENABLED_ENV = "COSMANEURA_SCRIBE_TRANSCRIPTION_JOB_ENABLED"
DURABLE_MAX_ATTEMPTS = 3

SettingsFactory = Callable[[], Settings]
JobExecution = Callable[[Settings, UUID, UUID], Awaitable[None]]
AsyncCloser = Callable[[], Awaitable[None]]
JobRun = Callable[[], Awaitable[bool]]


class TranscriptionJobRunnerError(RuntimeError):
    """Fixed-code execution failure safe for an operational exit boundary."""


def _is_raw_execution_enabled(environ: Mapping[str, str]) -> bool:
    value = environ.get(TRANSCRIPTION_JOB_ENABLED_ENV)
    return value is not None and value.strip().casefold() == "true"


async def run_transcription_job(
    *,
    arguments: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    settings_factory: SettingsFactory | None = None,
    execute: JobExecution | None = None,
) -> bool:
    """Run one explicit target, or fail before parsing and clients behind the raw gate."""

    source = os.environ if environ is None else environ
    if not _is_raw_execution_enabled(source):
        log_event(
            action="transcription_job.disabled",
            error_class="TranscriptionJobDisabled",
        )
        raise TranscriptionJobRunnerError("transcription_job_disabled")

    tenant_id: UUID | None = None
    session_id: UUID | None = None
    try:
        tenant_id, session_id = _parse_target_arguments(
            sys.argv[1:] if arguments is None else arguments
        )
        settings = (settings_factory or get_settings)()
        if not settings.transcription_job_enabled:
            raise TranscriptionJobRunnerError("transcription_job_disabled")

        log_event(
            action="transcription_job.started",
            tenant_id=tenant_id,
            entity_id=session_id,
        )
        await (execute or _execute_transcription_job)(settings, tenant_id, session_id)
        log_event(
            action="transcription_job.completed",
            tenant_id=tenant_id,
            entity_id=session_id,
        )
        return True
    except asyncio.CancelledError:
        log_event(
            action="transcription_job.cancelled",
            tenant_id=tenant_id,
            entity_id=session_id,
            error_class="CancelledError",
        )
        raise
    except TranscriptionJobRunnerError:
        log_event(
            action="transcription_job.failed",
            tenant_id=tenant_id,
            entity_id=session_id,
            error_class="TranscriptionJobRunnerError",
        )
        raise
    except Exception:
        log_event(
            action="transcription_job.failed",
            tenant_id=tenant_id,
            entity_id=session_id,
            error_class="TranscriptionJobExecutionError",
        )
        raise TranscriptionJobRunnerError("transcription_job_execution_failed") from None


def _parse_target_arguments(arguments: Sequence[str]) -> tuple[UUID, UUID]:
    if len(arguments) != 2:
        raise TranscriptionJobRunnerError("transcription_job_target_invalid")
    try:
        return UUID(arguments[0]), UUID(arguments[1])
    except (AttributeError, ValueError):
        raise TranscriptionJobRunnerError("transcription_job_target_invalid") from None


async def _execute_transcription_job(
    settings: Settings,
    tenant_id: UUID,
    session_id: UUID,
) -> None:
    repositories = build_postgres_provider(settings)
    closers: list[AsyncCloser] = [repositories.close]
    try:
        assembler = build_audio_track_assembler(settings, repositories)
        closers.insert(0, assembler.close)
        transcriber = build_speech_to_text_provider(settings)
        closers.insert(0, transcriber.close)
        worker = TranscriptionWorker(
            repositories=repositories,
            assembler=assembler,
            transcriber=transcriber,
            max_attempts=DURABLE_MAX_ATTEMPTS,
        )
        await worker.process(
            tenant_id=tenant_id,
            session_id=session_id,
            language_code=settings.transcription_job_language_code,
        )
    finally:
        await _close_without_cancellation(closers)


async def _close_without_cancellation(closers: list[AsyncCloser]) -> None:
    task = asyncio.create_task(_close_all(closers))
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


async def _close_all(closers: list[AsyncCloser]) -> None:
    failed = False
    for close in closers:
        try:
            await close()
        except Exception:
            failed = True
    if failed:
        raise TranscriptionJobRunnerError("transcription_job_cleanup_failed")


def _install_signal_handlers(
    loop: asyncio.AbstractEventLoop,
    task: asyncio.Task[bool],
) -> tuple[signal.Signals, ...]:
    installed: list[signal.Signals] = []
    for received_signal in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(received_signal, task.cancel)
        except (NotImplementedError, RuntimeError):
            continue
        installed.append(received_signal)
    return tuple(installed)


async def _run_with_signal_cancellation(run: JobRun | None = None) -> bool:
    async def invoke() -> bool:
        return await (run or run_transcription_job)()

    task = asyncio.create_task(invoke())
    loop = asyncio.get_running_loop()
    installed = _install_signal_handlers(loop, task)
    try:
        return await task
    finally:
        for received_signal in installed:
            loop.remove_signal_handler(received_signal)


def main() -> None:
    try:
        asyncio.run(_run_with_signal_cancellation())
    except asyncio.CancelledError:
        raise SystemExit(130) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except TranscriptionJobRunnerError:
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
