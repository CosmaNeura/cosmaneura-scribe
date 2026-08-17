from __future__ import annotations

import asyncio
import os
import signal
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import timedelta
from uuid import UUID

from .delivery_reconciler import DeliveryReconciler
from .handoff import build_master_platform_handoff
from .postgres_repository import build_postgres_provider
from .repository import DeliveryClaimPolicy
from .safe_logging import configure_standalone_logging, log_event
from .settings import Settings, get_settings

DELIVERY_RECONCILER_JOB_ENABLED_ENV = (
    "COSMANEURA_SCRIBE_DELIVERY_RECONCILER_JOB_ENABLED"
)

SettingsFactory = Callable[[], Settings]
JobExecution = Callable[[Settings, UUID], Awaitable[None]]
AsyncCloser = Callable[[], Awaitable[None]]
JobRun = Callable[[], Awaitable[bool]]


class DeliveryReconcilerRunnerError(RuntimeError):
    """Fixed-code execution failure safe for an operational exit boundary."""


def _is_raw_execution_enabled(environ: Mapping[str, str]) -> bool:
    value = environ.get(DELIVERY_RECONCILER_JOB_ENABLED_ENV)
    return value is not None and value.strip().casefold() == "true"


async def run_delivery_reconciler_job(
    *,
    arguments: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    settings_factory: SettingsFactory | None = None,
    execute: JobExecution | None = None,
) -> bool:
    """Reconcile one explicit tenant, or fail before clients behind the raw gate."""

    source = os.environ if environ is None else environ
    if not _is_raw_execution_enabled(source):
        log_event(
            action="delivery_reconciler_job.disabled",
            error_class="DeliveryReconcilerJobDisabled",
        )
        raise DeliveryReconcilerRunnerError("delivery_reconciler_job_disabled")

    tenant_id: UUID | None = None
    try:
        tenant_id = _parse_target_arguments(sys.argv[1:] if arguments is None else arguments)
        settings = (settings_factory or get_settings)()
        if not settings.delivery_reconciler_job_enabled:
            raise DeliveryReconcilerRunnerError("delivery_reconciler_job_disabled")

        log_event(action="delivery_reconciler_job.started", tenant_id=tenant_id)
        await (execute or _execute_delivery_reconciler_job)(settings, tenant_id)
        log_event(action="delivery_reconciler_job.completed", tenant_id=tenant_id)
        return True
    except asyncio.CancelledError:
        log_event(
            action="delivery_reconciler_job.cancelled",
            tenant_id=tenant_id,
            error_class="CancelledError",
        )
        raise
    except DeliveryReconcilerRunnerError:
        log_event(
            action="delivery_reconciler_job.failed",
            tenant_id=tenant_id,
            error_class="DeliveryReconcilerRunnerError",
        )
        raise
    except Exception:
        log_event(
            action="delivery_reconciler_job.failed",
            tenant_id=tenant_id,
            error_class="DeliveryReconcilerExecutionError",
        )
        raise DeliveryReconcilerRunnerError(
            "delivery_reconciler_job_execution_failed"
        ) from None


def _parse_target_arguments(arguments: Sequence[str]) -> UUID:
    if len(arguments) != 1:
        raise DeliveryReconcilerRunnerError("delivery_reconciler_job_target_invalid")
    try:
        return UUID(arguments[0])
    except (AttributeError, ValueError):
        raise DeliveryReconcilerRunnerError(
            "delivery_reconciler_job_target_invalid"
        ) from None


async def _execute_delivery_reconciler_job(settings: Settings, tenant_id: UUID) -> None:
    repositories = build_postgres_provider(settings)
    closers: list[AsyncCloser] = [repositories.close]
    try:
        handoff = build_master_platform_handoff(settings)
        closers.insert(0, handoff.close)
        reconciler = DeliveryReconciler(
            repositories=repositories,
            handoff=handoff,
            claim_policy=DeliveryClaimPolicy(
                pending_timeout=timedelta(
                    seconds=settings.delivery_pending_timeout_seconds
                ),
                retry_delay=timedelta(seconds=settings.delivery_retry_delay_seconds),
            ),
            maximum_deliveries=settings.delivery_reconciler_max_deliveries,
        )
        await reconciler.reconcile(tenant_id=tenant_id)
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
        raise DeliveryReconcilerRunnerError("delivery_reconciler_job_cleanup_failed")


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
        return await (run or run_delivery_reconciler_job)()

    task = asyncio.create_task(invoke())
    loop = asyncio.get_running_loop()
    installed = _install_signal_handlers(loop, task)
    try:
        return await task
    finally:
        for received_signal in installed:
            loop.remove_signal_handler(received_signal)


def main() -> None:
    configure_standalone_logging()
    try:
        asyncio.run(_run_with_signal_cancellation())
    except asyncio.CancelledError:
        raise SystemExit(130) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except DeliveryReconcilerRunnerError:
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
