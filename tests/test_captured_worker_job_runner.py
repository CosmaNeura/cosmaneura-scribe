from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe import captured_worker_job_runner
from cosmaneura_scribe.captured_worker_job_runner import (
    CapturedWorkerError,
    run_captured_worker,
)
from cosmaneura_scribe.captured_worker_settings import CapturedWorkerSettings


def _settings(tmp_path: Path, *, stage: str = "speech") -> CapturedWorkerSettings:
    tenant_id = uuid4()
    common: dict[str, object] = {
        "captured_worker_enabled": True,
        "captured_worker_stage": stage,
        "configured_capture_tenant_ids": frozenset({tenant_id}),
        "repository_backend": "postgres",
        "database_host": "scribe-test.postgres.database.azure.com",
        "database_user": f"scribe-{stage}",
        "database_ssl": True,
        "managed_identity_client_id": uuid4(),
        "database_transcription_principal_name": "scribe-speech",
        "database_transcription_principal_object_id": uuid4(),
        "database_translation_principal_name": "scribe-translation",
        "database_translation_principal_object_id": uuid4(),
        "audio_encryption_key_id": "https://scribe-test.vault.azure.net/keys/scribe-audio",
    }
    if stage == "speech":
        common.update(
            database_user="scribe-speech",
            transcription_backend="azure",
            storage_backend="azure",
            storage_account_url="https://scribetest.blob.core.windows.net",
            audio_assembly_encrypted_temp_directory=tmp_path,
            azure_speech_endpoint="https://scribe-test.cognitiveservices.azure.com",
            azure_speech_private_endpoint_cidrs=("10.42.0.0/16",),
        )
    else:
        common.update(
            database_user="scribe-translation",
            transcription_backend="none",
            storage_backend="memory",
            azure_translation_endpoint="https://synthetic-model.openai.azure.com/openai/v1",
            azure_translation_deployment="gpt-4.1",
            azure_translation_private_endpoint_cidrs=("10.43.0.7/32",),
        )
    return CapturedWorkerSettings(**common)


@pytest.mark.asyncio
async def test_disabled_worker_fails_before_parsing_targets() -> None:
    def settings_factory() -> CapturedWorkerSettings:
        raise AssertionError("disabled worker must not parse settings")

    with pytest.raises(CapturedWorkerError, match="^captured_worker_disabled$"):
        await run_captured_worker(
            arguments=("not-a-uuid", "--pending"),
            environ={},
            settings_factory=settings_factory,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["--pending", str(uuid4())])
async def test_worker_runs_one_explicit_tenant_target(tmp_path: Path, target: str) -> None:
    settings = _settings(tmp_path)
    tenant_id = next(iter(settings.configured_capture_tenant_ids))
    calls: list[tuple[UUID, UUID | None]] = []

    async def execute(
        _: CapturedWorkerSettings, target_tenant: UUID, target_session: UUID | None
    ) -> None:
        calls.append((target_tenant, target_session))

    assert await run_captured_worker(
        arguments=(str(tenant_id), target),
        environ={
            "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED": "true",
            "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
        },
        settings_factory=lambda: settings,
        execute=execute,
    )
    assert calls == [(tenant_id, None if target == "--pending" else UUID(target))]


@pytest.mark.asyncio
async def test_worker_rejects_unconfigured_tenant_with_metadata_only_log(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    settings = _settings(tmp_path)
    unknown_tenant = uuid4()

    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(CapturedWorkerError, match="captured_worker_execution_failed"):
            await run_captured_worker(
                arguments=(str(unknown_tenant), "--pending"),
                environ={
                    "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED": "true",
                    "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
                },
                settings_factory=lambda: settings,
            )

    assert "captured_worker.failed" in caplog.text
    assert "captured_worker_bindings_invalid" not in caplog.text


@pytest.mark.asyncio
async def test_worker_sanitizes_execution_failure(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    settings = _settings(tmp_path)
    tenant_id = next(iter(settings.configured_capture_tenant_ids))

    async def execute(*_: object) -> None:
        raise RuntimeError("unsafe transcript content")

    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(CapturedWorkerError, match="captured_worker_execution_failed"):
            await run_captured_worker(
                arguments=(str(tenant_id), "--pending"),
                environ={
                    "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED": "true",
                    "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
                },
                settings_factory=lambda: settings,
                execute=execute,
            )

    assert "unsafe transcript content" not in caplog.text


@pytest.mark.asyncio
async def test_worker_propagates_cancellation(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    tenant_id = next(iter(settings.configured_capture_tenant_ids))

    async def execute(*_: object) -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_captured_worker(
            arguments=(str(tenant_id), "--pending"),
            environ={
                "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED": "true",
                "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
            },
            settings_factory=lambda: settings,
            execute=execute,
        )


@pytest.mark.asyncio
async def test_translation_discovery_uses_tenant_transaction(tmp_path: Path) -> None:
    settings = _settings(tmp_path, stage="translation")
    tenant_id = next(iter(settings.configured_capture_tenant_ids))
    expected = (uuid4(), uuid4())
    observed: list[tuple[UUID, int]] = []

    class Store:
        async def discover_pending_captures(self, tenant: UUID, *, limit: int):
            observed.append((tenant, limit))
            return expected

    class Transaction:
        async def __aenter__(self):
            return Store()

        async def __aexit__(self, *_: object) -> None:
            return None

    repositories = SimpleNamespace(transaction=lambda tenant: Transaction())

    assert await captured_worker_job_runner._targets(
        repositories, settings, tenant_id, None
    ) == expected
    assert observed == [(tenant_id, settings.captured_worker_batch_size)]


@pytest.mark.asyncio
async def test_speech_discovery_scopes_query_and_returns_targets(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    tenant_id = next(iter(settings.configured_capture_tenant_ids))
    expected = (uuid4(), uuid4())
    statements: list[tuple[str, object | None]] = []

    class Scalars:
        def __iter__(self):
            return iter(expected)

    class Result:
        def scalars(self):
            return Scalars()

    class Connection:
        async def execute(self, statement, parameters=None):
            statements.append((str(statement), parameters))
            return Result()

    class Transaction:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_: object) -> None:
            return None

    repositories = SimpleNamespace(engine=SimpleNamespace(begin=lambda: Transaction()))

    assert await captured_worker_job_runner._targets(
        repositories, settings, tenant_id, None
    ) == expected
    assert "statement_timeout" in statements[0][0]
    assert statements[1][1] == {"tenant": str(tenant_id)}
    assert statements[2][1] == {
        "tenant": tenant_id,
        "maximum": settings.captured_worker_batch_size,
    }


@pytest.mark.asyncio
async def test_speech_composition_reconciles_targets_and_closes_resources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    settings = _settings(tmp_path)
    tenant_id = next(iter(settings.configured_capture_tenant_ids))
    targets = (uuid4(), uuid4())
    closed: list[str] = []
    reconciled: list[UUID] = []
    processed: list[UUID] = []

    class Store:
        async def reconcile_exhausted_speech(
            self, tenant: UUID, session: UUID, *, max_attempts: int
        ) -> None:
            assert tenant == tenant_id
            assert max_attempts == 3
            reconciled.append(session)

    class Transaction:
        async def __aenter__(self):
            return Store()

        async def __aexit__(self, *_: object) -> None:
            return None

    class Repositories:
        def __init__(self, engine: object) -> None:
            self.engine = engine

        def transaction(self, tenant: UUID):
            assert tenant == tenant_id
            return Transaction()

    class Worker:
        def __init__(self, **kwargs: object) -> None:
            assert kwargs["enabled"] is True

        async def process(self, *, tenant_id: UUID, session_id: UUID) -> None:
            assert tenant_id == next(iter(settings.configured_capture_tenant_ids))
            processed.append(session_id)
            if session_id == targets[1]:
                raise RuntimeError("synthetic provider failure")

    base = SimpleNamespace(engine=object(), close=lambda: _close(closed, "database"))
    assembler = SimpleNamespace(close=lambda: _close(closed, "assembler"))
    transcriber = SimpleNamespace(close=lambda: _close(closed, "transcriber"))
    monkeypatch.setattr(captured_worker_job_runner, "build_postgres_provider", lambda _: base)
    monkeypatch.setattr(
        captured_worker_job_runner, "CapturedSourceRepositoryProvider", Repositories
    )
    monkeypatch.setattr(
        captured_worker_job_runner, "build_audio_track_assembler", lambda *_: assembler
    )
    monkeypatch.setattr(
        captured_worker_job_runner, "build_speech_to_text_provider", lambda _: transcriber
    )
    monkeypatch.setattr(captured_worker_job_runner, "CapturedTranscriptionWorker", Worker)

    async def selected(*_: object):
        return targets

    monkeypatch.setattr(captured_worker_job_runner, "_targets", selected)

    with pytest.raises(CapturedWorkerError, match="captured_worker_target_unavailable"):
        await captured_worker_job_runner._execute(settings, tenant_id, None)

    assert reconciled == list(targets)
    assert processed == list(targets)
    assert closed == ["transcriber", "assembler", "database"]


async def _close(closed: list[str], name: str) -> None:
    closed.append(name)


@pytest.mark.asyncio
async def test_translation_composition_builds_private_clients_and_closes_them(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    settings = _settings(tmp_path, stage="translation")
    tenant_id = next(iter(settings.configured_capture_tenant_ids))
    target = uuid4()
    closed: list[str] = []
    constructed: list[str] = []

    class Repositories:
        def __init__(self, engine: object) -> None:
            self.engine = engine

    class Credential:
        def __init__(self, **kwargs: object) -> None:
            assert kwargs["require_envvar"] is True
            constructed.append("credential")

        async def close(self) -> None:
            closed.append("credential")

    class Keys:
        async def close(self) -> None:
            closed.append("keys")

    class Unwrapper:
        def __init__(self, **_: object) -> None:
            constructed.append("unwrapper")

        async def close(self) -> None:
            closed.append("unwrapper")
            closed.append("credential")

    class Worker:
        def __init__(self, **kwargs: object) -> None:
            assert kwargs["enabled"] is True
            assert kwargs["limit"] == settings.captured_worker_batch_size
            constructed.append("worker")

        async def process(self, *, tenant_id: UUID, session_id: UUID) -> None:
            assert (tenant_id, session_id) == (
                next(iter(settings.configured_capture_tenant_ids)),
                target,
            )

    base = SimpleNamespace(engine=object(), close=lambda: _close(closed, "database"))
    monkeypatch.setattr(captured_worker_job_runner, "build_postgres_provider", lambda _: base)
    monkeypatch.setattr(
        captured_worker_job_runner, "CapturedSourceRepositoryProvider", Repositories
    )
    monkeypatch.setattr(captured_worker_job_runner, "DefaultAzureCredential", Credential)
    monkeypatch.setattr(
        captured_worker_job_runner, "build_audio_encryption_key_provider", lambda _: Keys()
    )
    monkeypatch.setattr(captured_worker_job_runner, "KeyVaultSessionKeyUnwrapper", Unwrapper)
    monkeypatch.setattr(
        captured_worker_job_runner,
        "AzureGPT41TranslationAdapter",
        lambda *_args, **_kwargs: SimpleNamespace(),
    )
    monkeypatch.setattr(
        captured_worker_job_runner, "PrivateSpeechEndpointGuard", lambda *_: SimpleNamespace()
    )
    monkeypatch.setattr(captured_worker_job_runner, "TranslationJobCipher", lambda *_: object())
    monkeypatch.setattr(captured_worker_job_runner, "CapturedTranslationWorker", Worker)

    async def selected(*_: object):
        return (target,)

    monkeypatch.setattr(captured_worker_job_runner, "_targets", selected)

    await captured_worker_job_runner._execute(settings, tenant_id, None)

    assert constructed == ["credential", "credential", "unwrapper", "worker"]
    assert closed == ["unwrapper", "credential", "keys", "credential", "database"]


@pytest.mark.parametrize(
    ("error", "status"),
    [(CapturedWorkerError("failure"), 1), (asyncio.CancelledError(), 130)],
)
def test_main_maps_worker_failures_to_process_status(
    monkeypatch: pytest.MonkeyPatch, error: BaseException, status: int
) -> None:
    async def fail(*_: object) -> bool:
        raise error

    monkeypatch.setattr(captured_worker_job_runner, "configure_standalone_logging", lambda: None)
    monkeypatch.setattr(captured_worker_job_runner, "run_job_with_signal_cancellation", fail)

    with pytest.raises(SystemExit) as raised:
        captured_worker_job_runner.main()

    assert raised.value.code == status


@pytest.mark.parametrize("stage", ["speech", "translation"])
def test_worker_settings_are_false_default_and_stage_closed(
    tmp_path: Path, stage: str
) -> None:
    defaults = CapturedWorkerSettings()
    assert defaults.captured_worker_enabled is False
    assert defaults.captured_worker_stage is None

    settings = _settings(tmp_path, stage=stage)
    assert settings.captured_worker_stage == stage

    invalid = settings.model_dump()
    invalid["database_user"] = "wrong-principal"
    with pytest.raises(ValueError, match="captured_worker_bindings_invalid"):
        CapturedWorkerSettings(**invalid)
