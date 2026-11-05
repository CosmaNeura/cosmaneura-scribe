"""Bounded configured practices: settings, exact targets, and aggregate pickup."""

from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe import captured_worker_job_runner as runner
from cosmaneura_scribe.captured_worker_settings import CapturedWorkerSettings
from cosmaneura_scribe.settings import Settings
from pydantic import ValidationError
from test_captured_worker_job_runner import _ENVIRON, _settings


def _cohort_settings(tmp_path: Path, *, count: int = 2, stage: str = "translation"):
    return CapturedWorkerSettings(
        **(
            _settings(tmp_path, stage=stage).model_dump()
            | {
                "configured_capture_multi_tenant_enabled": True,
                "configured_capture_tenant_ids": frozenset(UUID(int=i + 1) for i in range(count)),
            }
        )
    )


def test_singleton_defaults_and_explicit_bounded_opt_in() -> None:
    assert Settings(_env_file=None).configured_capture_multi_tenant_enabled is False
    for count in (1, 2, 32):
        tenants = frozenset(UUID(int=i + 1) for i in range(count))
        assert (
            Settings(
                _env_file=None,
                configured_capture_multi_tenant_enabled=True,
                configured_capture_tenant_ids=tenants,
            ).configured_capture_tenant_ids
            == tenants
        )
    with pytest.raises(ValidationError, match="one explicit nonzero tenant"):
        Settings(_env_file=None, configured_capture_tenant_ids={UUID(int=1), UUID(int=2)})


@pytest.mark.parametrize(
    "tenants",
    [
        [UUID(int=0)],
        [UUID(int=i + 1) for i in range(33)],
        ["not-a-uuid"],
        ["*"],
    ],
)
def test_invalid_cohorts_remain_closed(tenants: list[object]) -> None:
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            configured_capture_multi_tenant_enabled=True,
            configured_capture_tenant_ids=tenants,
        )


def test_configured_api_requires_protocol_authentication_and_nonempty_list() -> None:
    configuration = {
        "configured_capture_multi_tenant_enabled": True,
        "configured_capture_tenant_ids": {UUID(int=1), UUID(int=2)},
        "configured_capture_enabled": True,
        "capture_protocol_enabled": True,
        "workflow_authentication_enabled": True,
        "repository_backend": "postgres",
        "database_host": "synthetic.postgres.database.azure.com",
        "database_user": "synthetic-runtime",
        "managed_identity_client_id": uuid4(),
        "entra_tenant_id": uuid4(),
        "workflow_api_audience": str(uuid4()),
        "trusted_platform_client_id": uuid4(),
    }
    assert Settings(_env_file=None, **configuration).configured_capture_enabled
    for change in (
        {"configured_capture_tenant_ids": set()},
        {"capture_protocol_enabled": False},
        {"workflow_authentication_enabled": False},
    ):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, **(configuration | change))


def test_enabled_worker_requires_nonempty_cohort_and_preserves_role_gates(tmp_path: Path) -> None:
    settings = _cohort_settings(tmp_path, count=32)
    assert settings.captured_worker_batch_size == 8
    for overrides in (
        {"configured_capture_tenant_ids": frozenset()},
        {"database_user": "foreign-role"},
        {"configured_capture_enabled": True},
        {"captured_worker_batch_size": 33},
        {"configured_capture_multi_tenant_enabled": False},
    ):
        with pytest.raises(ValidationError):
            CapturedWorkerSettings(**(settings.model_dump() | overrides))


@pytest.mark.asyncio
async def test_cohort_cli_selects_only_validated_members(tmp_path: Path, monkeypatch) -> None:
    settings = _cohort_settings(tmp_path, count=32)
    monkeypatch.setattr(runner.time, "time", lambda: 60.0)
    calls = []

    async def execute(config, tenants):
        assert config is settings
        calls.append(tenants)

    assert await runner.run_captured_worker(
        arguments=("--cohort-pending",),
        environ=_ENVIRON,
        settings_factory=lambda: settings,
        execute_cohort=execute,
    )
    ordered = tuple(sorted(settings.configured_capture_tenant_ids))
    assert calls == [ordered[8:] + ordered[:8]]
    assert set(calls[0]) == settings.configured_capture_tenant_ids


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["off", "disabled", "observation", "credential", "empty"])
async def test_cohort_cli_rejects_before_runtime_resources(tmp_path: Path, change: str) -> None:
    settings = _cohort_settings(tmp_path)
    updates = {
        "off": {"configured_capture_multi_tenant_enabled": False},
        "disabled": {"captured_worker_enabled": False},
        "observation": {"captured_speech_observation_scope": "malformed-diagnostics"},
        "empty": {"configured_capture_tenant_ids": frozenset()},
    }.get(change, {})
    # Exercise runner gates even if a caller bypassed pydantic validation.
    settings = settings.model_copy(update=updates)
    environment = _ENVIRON | (
        {"AZURE_TOKEN_CREDENTIALS": "OtherCredential"} if change == "credential" else {}
    )
    calls = []

    async def execute(*args):
        calls.append(args)

    with pytest.raises(runner.CapturedWorkerError, match="^captured_worker_execution_failed$"):
        await runner.run_captured_worker(
            arguments=("--cohort-pending",),
            environ=environment,
            settings_factory=lambda: settings,
            execute=execute,
            execute_cohort=execute,
        )
    assert not calls


@pytest.mark.asyncio
async def test_existing_target_mode_is_exact_even_with_multi_mode(tmp_path: Path) -> None:
    settings = _cohort_settings(tmp_path)
    tenant, session = UUID(int=1), uuid4()
    calls = []

    async def execute(_, target_tenant, target_session):
        calls.append((target_tenant, target_session))

    await runner.run_captured_worker(
        arguments=(str(tenant), str(session)),
        environ=_ENVIRON,
        settings_factory=lambda: settings,
        execute=execute,
    )
    assert calls == [(tenant, session)]
    for target in (UUID(int=0), uuid4()):
        with pytest.raises(runner.CapturedWorkerError):
            await runner.run_captured_worker(
                arguments=(str(target), "--pending"),
                environ=_ENVIRON,
                settings_factory=lambda: settings,
                execute=execute,
            )
    assert calls == [(tenant, session)]


def test_rotation_covers_busy_cohort_without_authorizing_anyone(
    tmp_path: Path, monkeypatch
) -> None:
    settings = _cohort_settings(tmp_path, count=32)
    visited = set()
    for minute in range(4):
        monkeypatch.setattr(runner.time, "time", lambda minute=minute: minute * 60.0)
        order = runner._cohort_order(settings)
        visited.update(order[: settings.captured_worker_batch_size])
        assert set(order) == settings.configured_capture_tenant_ids
    assert visited == settings.configured_capture_tenant_ids


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["speech", "translation"])
async def test_shared_batch_fairness_and_exact_tenant_transactions(
    tmp_path: Path, monkeypatch, stage: str
) -> None:
    settings = _cohort_settings(tmp_path, count=32, stage=stage)
    tenants = tuple(sorted(settings.configured_capture_tenant_ids))
    # Deliberately identical session UUIDs in different namespaces must remain distinct.
    targets = (uuid4(), uuid4())
    discoveries, processed, reconciled = [], [], []

    async def selected(_, config, tenant, session):
        assert config is settings and session is None
        discoveries.append(tenant)
        return targets

    @asynccontextmanager
    async def transaction(tenant):
        async def reconcile(actual_tenant, session, *, max_attempts):
            assert actual_tenant == tenant and max_attempts == 3
            reconciled.append((tenant, session))

        yield SimpleNamespace(reconcile_exhausted_speech=reconcile)

    async def process(*, tenant_id, session_id):
        processed.append((tenant_id, session_id))

    monkeypatch.setattr(runner, "_targets", selected)
    await runner._dispatch_cohort(
        SimpleNamespace(transaction=transaction),
        settings,
        tenants,
        SimpleNamespace(process=process),
    )
    assert processed == [(tenant, targets[0]) for tenant in tenants[:8]]
    assert discoveries == list(tenants[:8])
    assert reconciled == (processed if stage == "speech" else [])


@pytest.mark.asyncio
async def test_one_shared_deadline_with_no_work(tmp_path: Path, monkeypatch) -> None:
    settings = _cohort_settings(tmp_path, count=32)
    clock = [0.0]
    sleeps, discoveries = [], []

    async def selected(_, __, tenant, session):
        discoveries.append(tenant)
        return ()

    async def sleep(seconds):
        sleeps.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(runner, "_targets", selected)
    monkeypatch.setattr(runner.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(runner.asyncio, "sleep", sleep)
    await runner._dispatch_cohort(
        None, settings, tuple(sorted(settings.configured_capture_tenant_ids)), SimpleNamespace()
    )
    assert sum(sleeps) == runner.PENDING_PICKUP_SECONDS == 65.0
    assert len(sleeps) == 13
    assert set(discoveries) == settings.configured_capture_tenant_ids


@pytest.mark.asyncio
async def test_failed_pair_is_not_retried_and_other_tenant_is_processed(
    tmp_path: Path, monkeypatch
) -> None:
    settings = _cohort_settings(tmp_path).model_copy(update={"captured_worker_batch_size": 2})
    tenants = tuple(sorted(settings.configured_capture_tenant_ids))
    session = uuid4()
    processed = []

    async def selected(*args):
        return (session,)

    async def process(*, tenant_id, session_id):
        processed.append((tenant_id, session_id))
        if tenant_id == tenants[0]:
            raise RuntimeError("synthetic failure")

    monkeypatch.setattr(runner, "_targets", selected)
    with pytest.raises(runner.CapturedWorkerError, match="captured_worker_target_unavailable"):
        await runner._dispatch_cohort(None, settings, tenants, SimpleNamespace(process=process))
    assert processed == [(tenant, session) for tenant in tenants]


@pytest.mark.asyncio
async def test_discovery_wait_cannot_multiply_the_deadline(tmp_path: Path, monkeypatch) -> None:
    settings = _cohort_settings(tmp_path)
    queried = []

    async def selected(_, __, tenant, session):
        queried.append(tenant)
        await runner.asyncio.sleep(1)
        raise AssertionError("query must be cancelled by aggregate pickup timeout")

    monkeypatch.setattr(runner, "PENDING_PICKUP_SECONDS", 0.01)
    monkeypatch.setattr(runner, "_targets", selected)
    with pytest.raises(runner.CapturedWorkerError, match="captured_worker_target_unavailable"):
        await runner._dispatch_cohort(
            None, settings, tuple(settings.configured_capture_tenant_ids), SimpleNamespace()
        )
    assert len(queried) == 1


@pytest.mark.asyncio
async def test_speech_cohort_reuses_resources_without_tenant_bound_observer(
    tmp_path: Path, monkeypatch
) -> None:
    settings = _cohort_settings(tmp_path, stage="speech").model_copy(
        update={"captured_worker_batch_size": 2}
    )
    tenants = tuple(sorted(settings.configured_capture_tenant_ids))
    resources, closed, processed = [], [], []
    session = uuid4()

    async def close(name):
        closed.append(name)

    def resource(name):
        resources.append(name)
        return SimpleNamespace(engine=object(), close=lambda: close(name))

    @asynccontextmanager
    async def transaction(tenant):
        async def reconcile(actual_tenant, target, *, max_attempts):
            assert tenant == actual_tenant and target == session and max_attempts == 3

        yield SimpleNamespace(reconcile_exhausted_speech=reconcile)

    class Worker:
        def __init__(self, **options):
            assert "publication_observer" not in options

        async def process(self, *, tenant_id, session_id):
            processed.append((tenant_id, session_id))

    async def selected(*_):
        return (session,)

    monkeypatch.setattr(runner, "build_postgres_provider", lambda _: resource("database"))
    monkeypatch.setattr(
        runner,
        "CapturedSourceRepositoryProvider",
        lambda engine: SimpleNamespace(transaction=transaction),
    )
    monkeypatch.setattr(runner, "build_audio_track_assembler", lambda *_: resource("assembler"))
    monkeypatch.setattr(runner, "build_speech_to_text_provider", lambda _: resource("transcriber"))
    monkeypatch.setattr(
        runner,
        "capture_speech_observer",
        lambda *_, **__: pytest.fail("cohort must not create a bound observer"),
    )
    monkeypatch.setattr(runner, "CapturedTranscriptionWorker", Worker)
    monkeypatch.setattr(runner, "_targets", selected)
    await runner._execute_cohort(settings, tenants)
    assert resources == ["database", "assembler", "transcriber"]
    assert closed == ["transcriber", "assembler", "database"]
    assert processed == [(tenant, session) for tenant in tenants]
