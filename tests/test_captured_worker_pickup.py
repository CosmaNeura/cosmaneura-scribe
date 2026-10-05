from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from cosmaneura_scribe import captured_worker_job_runner as runner
from cosmaneura_scribe.captured_worker_settings import CapturedWorkerSettings


@pytest.fixture
def pickup(monkeypatch):
    clock = SimpleNamespace(now=0.0, sleeps=[])

    async def sleep(delay):
        clock.sleeps.append(delay)
        clock.now += delay

    monkeypatch.setattr(runner, "time", SimpleNamespace(monotonic=lambda: clock.now))
    monkeypatch.setattr(runner, "asyncio", SimpleNamespace(sleep=sleep))
    reconcile = AsyncMock()

    @asynccontextmanager
    async def transaction(tenant):
        yield SimpleNamespace(reconcile_exhausted_speech=reconcile)

    repositories = SimpleNamespace(transaction=transaction)
    worker = SimpleNamespace(process=AsyncMock())
    return SimpleNamespace(
        clock=clock, repositories=repositories, worker=worker, tenant=uuid4(), reconcile=reconcile
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["speech", "translation"])
async def test_finds_upload_after_initial_empty_scan_without_next_scheduled_run(
    pickup,
    monkeypatch,
    stage,
):
    target = uuid4()
    settings = CapturedWorkerSettings(captured_worker_stage=stage, captured_worker_batch_size=1)
    scans = []

    async def targets(repositories, configuration, tenant, session):
        assert repositories is pickup.repositories and configuration is settings
        assert tenant == pickup.tenant and session is None
        scans.append(pickup.clock.now)
        return (target,) if pickup.clock.now >= 3 else ()

    monkeypatch.setattr(runner, "_targets", targets)
    await runner._dispatch(pickup.repositories, settings, pickup.tenant, None, pickup.worker)
    assert scans == [0, 5]
    pickup.worker.process.assert_awaited_once_with(tenant_id=pickup.tenant, session_id=target)
    assert pickup.reconcile.await_count == (1 if stage == "speech" else 0)
    if stage == "speech":
        pickup.reconcile.assert_awaited_once_with(pickup.tenant, target, max_attempts=3)


@pytest.mark.asyncio
async def test_empty_worker_stops_polling_at_bounded_monotonic_deadline(pickup, monkeypatch):
    targets = AsyncMock(return_value=())
    monkeypatch.setattr(runner, "_targets", targets)
    await runner._dispatch(
        pickup.repositories, CapturedWorkerSettings(), pickup.tenant, None, pickup.worker
    )
    assert pickup.clock.now == 65
    assert pickup.clock.sleeps == [5] * 13
    assert targets.await_count == 13
    pickup.worker.process.assert_not_awaited()


@pytest.mark.asyncio
async def test_repeated_failed_target_is_not_retried_and_total_work_stays_bounded(
    pickup,
    monkeypatch,
):
    first, second, third = uuid4(), uuid4(), uuid4()
    settings = CapturedWorkerSettings(captured_worker_stage="speech", captured_worker_batch_size=2)
    targets = AsyncMock(side_effect=[(first,), (first,), (first, second), (third,)])
    monkeypatch.setattr(runner, "_targets", targets)
    pickup.worker.process.side_effect = [RuntimeError("private source sentinel"), None]
    with pytest.raises(runner.CapturedWorkerError, match="^captured_worker_target_unavailable$"):
        await runner._dispatch(pickup.repositories, settings, pickup.tenant, None, pickup.worker)
    assert [call.kwargs["session_id"] for call in pickup.worker.process.await_args_list] == [
        first,
        second,
    ]
    assert pickup.reconcile.await_count == 2
    assert targets.await_count == 3 and pickup.clock.now == 10


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, True])
async def test_explicit_session_stays_one_attempt_without_pending_wait(
    pickup,
    monkeypatch,
    failure,
):
    target = uuid4()
    # Use the actual explicit-target branch; it never needs database discovery.
    if failure:
        pickup.worker.process.side_effect = RuntimeError("synthetic provider failure")
        with pytest.raises(runner.CapturedWorkerError):
            await runner._dispatch(
                pickup.repositories, CapturedWorkerSettings(), pickup.tenant, target, pickup.worker
            )
    else:
        await runner._dispatch(
            pickup.repositories, CapturedWorkerSettings(), pickup.tenant, target, pickup.worker
        )
    pickup.worker.process.assert_awaited_once_with(tenant_id=pickup.tenant, session_id=target)
    assert not pickup.clock.sleeps


@pytest.mark.asyncio
async def test_pickup_deadline_does_not_cancel_accepted_long_processing(pickup, monkeypatch):
    target = uuid4()
    targets = AsyncMock(return_value=(target,))
    monkeypatch.setattr(runner, "_targets", targets)

    async def long_processing(**kwargs):
        assert kwargs["session_id"] == target
        pickup.clock.now = 90

    pickup.worker.process.side_effect = long_processing
    await runner._dispatch(
        pickup.repositories, CapturedWorkerSettings(), pickup.tenant, None, pickup.worker
    )
    assert pickup.clock.now == 90 and not pickup.clock.sleeps
    assert targets.await_count == 1
    pickup.worker.process.assert_awaited_once()


@pytest.mark.asyncio
async def test_cancellation_during_pickup_closes_production_composition_resources(
    pickup,
    monkeypatch,
):
    database_close, assembly_close, speech_close = AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(
        runner,
        "build_postgres_provider",
        lambda _: SimpleNamespace(engine=object(), close=database_close),
    )
    monkeypatch.setattr(runner, "CapturedSourceRepositoryProvider", lambda _: pickup.repositories)
    monkeypatch.setattr(
        runner, "build_audio_track_assembler", lambda *_: SimpleNamespace(close=assembly_close)
    )
    monkeypatch.setattr(
        runner, "build_speech_to_text_provider", lambda _: SimpleNamespace(close=speech_close)
    )
    monkeypatch.setattr(runner, "CapturedTranscriptionWorker", lambda **_: pickup.worker)
    monkeypatch.setattr(runner, "_targets", AsyncMock(return_value=()))

    async def cancelled_sleep(_):
        raise asyncio.CancelledError

    monkeypatch.setattr(runner.asyncio, "sleep", cancelled_sleep)
    with pytest.raises(asyncio.CancelledError):
        await runner._execute(
            CapturedWorkerSettings(captured_worker_stage="speech"), pickup.tenant, None
        )
    for close in (database_close, assembly_close, speech_close):
        close.assert_awaited_once()
    pickup.worker.process.assert_not_awaited()
