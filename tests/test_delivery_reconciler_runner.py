from __future__ import annotations

import asyncio
import logging
import sys
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe import delivery_reconciler_runner
from cosmaneura_scribe.delivery_reconciler_runner import (
    DELIVERY_RECONCILER_JOB_ENABLED_ENV,
    DeliveryReconcilerRunnerError,
    run_delivery_reconciler_job,
)
from cosmaneura_scribe.settings import Settings


def _enabled_settings() -> Settings:
    return Settings(
        managed_identity_client_id=uuid4(),
        repository_backend="postgres",
        database_url="postgresql+asyncpg://test:test@localhost/scribe",
        database_ssl=False,
        master_platform_handoff_enabled=True,
        master_platform_base_url="https://platform.example.test",
        master_platform_scope="api://00000000-0000-0000-0000-000000000001/.default",
        delivery_reconciler_job_enabled=True,
    )


@pytest.mark.asyncio
async def test_disabled_job_hard_gate_precedes_arguments_settings_and_execution() -> None:
    def settings_factory() -> Settings:
        raise AssertionError("disabled execution must not parse settings")

    async def execute(_: Settings, __: UUID) -> None:
        raise AssertionError("disabled execution must not build clients")

    with pytest.raises(
        DeliveryReconcilerRunnerError,
        match="^delivery_reconciler_job_disabled$",
    ):
        await run_delivery_reconciler_job(
            arguments=("sensitive-invalid-target", "extra"),
            environ={DELIVERY_RECONCILER_JOB_ENABLED_ENV: "false"},
            settings_factory=settings_factory,
            execute=execute,
        )


@pytest.mark.asyncio
async def test_job_runs_exactly_one_explicit_tenant() -> None:
    tenant_id = uuid4()
    calls: list[UUID] = []
    settings = _enabled_settings()

    async def execute(_: Settings, target_tenant: UUID) -> None:
        calls.append(target_tenant)

    assert await run_delivery_reconciler_job(
        arguments=(str(tenant_id),),
        environ={DELIVERY_RECONCILER_JOB_ENABLED_ENV: "true"},
        settings_factory=lambda: settings,
        execute=execute,
    )
    assert calls == [tenant_id]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [(), ("sensitive-invalid-target",), (str(uuid4()), "sensitive-extra-target")],
)
async def test_enabled_job_rejects_invalid_targets_before_settings_without_echo(
    arguments: tuple[str, ...],
    caplog: pytest.LogCaptureFixture,
) -> None:
    def settings_factory() -> Settings:
        raise AssertionError("invalid targets must fail before Settings")

    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(
            DeliveryReconcilerRunnerError,
            match="^delivery_reconciler_job_target_invalid$",
        ):
            await run_delivery_reconciler_job(
                arguments=arguments,
                environ={DELIVERY_RECONCILER_JOB_ENABLED_ENV: "true"},
                settings_factory=settings_factory,
            )

    assert "sensitive" not in caplog.text


@pytest.mark.asyncio
async def test_raw_enable_cannot_override_disabled_validated_settings() -> None:
    with pytest.raises(
        DeliveryReconcilerRunnerError,
        match="^delivery_reconciler_job_disabled$",
    ):
        await run_delivery_reconciler_job(
            arguments=(str(uuid4()),),
            environ={DELIVERY_RECONCILER_JOB_ENABLED_ENV: "true"},
            settings_factory=Settings,
        )


@pytest.mark.asyncio
async def test_execution_failure_is_sanitized(caplog: pytest.LogCaptureFixture) -> None:
    settings = _enabled_settings()

    async def execute(_: Settings, __: UUID) -> None:
        raise ValueError("unsafe transcript content")

    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(
            DeliveryReconcilerRunnerError,
            match="^delivery_reconciler_job_execution_failed$",
        ):
            await run_delivery_reconciler_job(
                arguments=(str(uuid4()),),
                environ={DELIVERY_RECONCILER_JOB_ENABLED_ENV: "true"},
                settings_factory=lambda: settings,
                execute=execute,
            )

    assert "unsafe transcript content" not in caplog.text


@pytest.mark.asyncio
async def test_production_composition_closes_clients_on_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _enabled_settings()
    closed: list[str] = []
    reconciler_arguments: dict[str, object] = {}

    class FakeRepositories:
        async def close(self) -> None:
            closed.append("repositories")

    class FakeHandoff:
        async def close(self) -> None:
            closed.append("handoff")

    class FakeReconciler:
        def __init__(self, **kwargs: object) -> None:
            reconciler_arguments.update(kwargs)

        async def reconcile(self, *, tenant_id: UUID) -> None:
            reconciler_arguments["tenant_id"] = tenant_id
            raise asyncio.CancelledError

    repositories = FakeRepositories()
    handoff = FakeHandoff()
    monkeypatch.setattr(
        delivery_reconciler_runner,
        "build_postgres_provider",
        lambda _: repositories,
    )
    monkeypatch.setattr(
        delivery_reconciler_runner,
        "build_master_platform_handoff",
        lambda _: handoff,
    )
    monkeypatch.setattr(delivery_reconciler_runner, "DeliveryReconciler", FakeReconciler)

    tenant_id = uuid4()
    with pytest.raises(asyncio.CancelledError):
        await delivery_reconciler_runner._execute_delivery_reconciler_job(
            settings,
            tenant_id,
        )

    assert reconciler_arguments["maximum_deliveries"] == 25
    assert reconciler_arguments["tenant_id"] == tenant_id
    assert closed == ["handoff", "repositories"]


@pytest.mark.asyncio
async def test_partial_builder_failure_closes_repository(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _enabled_settings()
    closed: list[str] = []

    class FakeRepositories:
        async def close(self) -> None:
            closed.append("repositories")

    repositories = FakeRepositories()
    monkeypatch.setattr(
        delivery_reconciler_runner,
        "build_postgres_provider",
        lambda _: repositories,
    )

    def fail_handoff(_: Settings) -> None:
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(
        delivery_reconciler_runner,
        "build_master_platform_handoff",
        fail_handoff,
    )

    with pytest.raises(RuntimeError, match="provider unavailable"):
        await delivery_reconciler_runner._execute_delivery_reconciler_job(
            settings,
            uuid4(),
        )

    assert closed == ["repositories"]


@pytest.mark.asyncio
async def test_signal_boundary_cancels_and_awaits_active_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cleaned = asyncio.Event()

    async def run() -> bool:
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    def install(
        loop: asyncio.AbstractEventLoop,
        task: asyncio.Task[bool],
    ) -> tuple[object, ...]:
        loop.call_soon(task.cancel)
        return ()

    monkeypatch.setattr(delivery_reconciler_runner, "_install_signal_handlers", install)

    with pytest.raises(asyncio.CancelledError):
        await delivery_reconciler_runner._run_with_signal_cancellation(run)

    assert cleaned.is_set()


def test_main_exits_nonzero_while_disabled_before_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def settings_factory() -> Settings:
        raise AssertionError("disabled main must not parse settings")

    monkeypatch.setenv(DELIVERY_RECONCILER_JOB_ENABLED_ENV, "false")
    monkeypatch.setattr(sys, "argv", ["delivery-reconciler", "sensitive-target"])
    monkeypatch.setattr(delivery_reconciler_runner, "get_settings", settings_factory)
    monkeypatch.setattr(delivery_reconciler_runner, "configure_standalone_logging", lambda: None)

    with pytest.raises(SystemExit) as caught:
        delivery_reconciler_runner.main()

    assert caught.value.code == 1
