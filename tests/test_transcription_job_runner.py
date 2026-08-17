from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe import transcription_job_runner
from cosmaneura_scribe.settings import Settings
from cosmaneura_scribe.transcription_job_runner import (
    DURABLE_MAX_ATTEMPTS,
    TRANSCRIPTION_JOB_ENABLED_ENV,
    TranscriptionJobRunnerError,
    run_transcription_job,
)


def _enabled_settings(tmp_path: Path) -> Settings:
    return Settings(
        managed_identity_client_id=uuid4(),
        storage_backend="azure",
        storage_account_url="https://scribetest.blob.core.windows.net",
        audio_encryption_key_id="https://scribe-test.vault.azure.net/keys/scribe-audio",
        audio_assembly_encrypted_temp_directory=tmp_path,
        repository_backend="postgres",
        database_url="postgresql+asyncpg://test:test@localhost/scribe",
        database_ssl=False,
        transcription_backend="azure",
        azure_speech_endpoint="https://scribe-test.cognitiveservices.azure.com",
        azure_speech_private_endpoint_cidrs=("10.42.1.0/24",),
        transcription_job_enabled=True,
    )


@pytest.mark.asyncio
async def test_disabled_job_hard_gate_precedes_settings_and_execution() -> None:
    def settings_factory() -> Settings:
        raise AssertionError("disabled execution must not parse settings")

    async def execute(_: Settings, __: UUID, ___: UUID) -> None:
        raise AssertionError("disabled execution must not build clients")

    with pytest.raises(TranscriptionJobRunnerError, match="^transcription_job_disabled$"):
        await run_transcription_job(
            arguments=("not-a-uuid", "also-not-a-uuid"),
            environ={
                TRANSCRIPTION_JOB_ENABLED_ENV: "false",
            },
            settings_factory=settings_factory,
            execute=execute,
        )


@pytest.mark.asyncio
async def test_job_runs_exactly_one_explicit_target(tmp_path: Path) -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    calls: list[tuple[UUID, UUID]] = []
    settings = _enabled_settings(tmp_path)

    async def execute(_: Settings, target_tenant: UUID, target_session: UUID) -> None:
        calls.append((target_tenant, target_session))

    assert await run_transcription_job(
        arguments=(str(tenant_id), str(session_id)),
        environ={TRANSCRIPTION_JOB_ENABLED_ENV: "true"},
        settings_factory=lambda: settings,
        execute=execute,
    )
    assert calls == [(tenant_id, session_id)]


@pytest.mark.asyncio
async def test_enabled_job_rejects_targets_without_echoing_arguments(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def settings_factory() -> Settings:
        raise AssertionError("invalid targets must fail before Settings")

    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(
            TranscriptionJobRunnerError,
            match="^transcription_job_target_invalid$",
        ):
            await run_transcription_job(
                arguments=("sensitive-invalid-target",),
                environ={TRANSCRIPTION_JOB_ENABLED_ENV: "true"},
                settings_factory=settings_factory,
            )

    assert "sensitive-invalid-target" not in caplog.text


@pytest.mark.asyncio
async def test_raw_enable_cannot_override_disabled_validated_settings() -> None:
    with pytest.raises(TranscriptionJobRunnerError, match="transcription_job_disabled"):
        await run_transcription_job(
            arguments=(str(uuid4()), str(uuid4())),
            environ={TRANSCRIPTION_JOB_ENABLED_ENV: "true"},
            settings_factory=Settings,
        )


@pytest.mark.asyncio
async def test_execution_failure_is_sanitized(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    settings = _enabled_settings(tmp_path)

    async def execute(_: Settings, __: UUID, ___: UUID) -> None:
        raise ValueError("unsafe transcript content")

    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(
            TranscriptionJobRunnerError,
            match="^transcription_job_execution_failed$",
        ):
            await run_transcription_job(
                arguments=(str(tenant_id), str(session_id)),
                environ={TRANSCRIPTION_JOB_ENABLED_ENV: "true"},
                settings_factory=lambda: settings,
                execute=execute,
            )

    assert "unsafe transcript content" not in caplog.text


@pytest.mark.asyncio
async def test_production_composition_closes_every_client_on_cancellation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    settings = _enabled_settings(tmp_path)
    closed: list[str] = []
    worker_arguments: dict[str, object] = {}

    class FakeRepositories:
        async def close(self) -> None:
            closed.append("repositories")

    class FakeAssembler:
        async def close(self) -> None:
            closed.append("assembler")

    class FakeTranscriber:
        async def close(self) -> None:
            closed.append("transcriber")

    class FakeWorker:
        def __init__(self, **kwargs: object) -> None:
            worker_arguments.update(kwargs)

        async def process(self, **_: object) -> None:
            raise asyncio.CancelledError

    repositories = FakeRepositories()
    assembler = FakeAssembler()
    transcriber = FakeTranscriber()
    monkeypatch.setattr(transcription_job_runner, "build_postgres_provider", lambda _: repositories)
    monkeypatch.setattr(
        transcription_job_runner,
        "build_audio_track_assembler",
        lambda *_: assembler,
    )
    monkeypatch.setattr(
        transcription_job_runner,
        "build_speech_to_text_provider",
        lambda _: transcriber,
    )
    monkeypatch.setattr(transcription_job_runner, "TranscriptionWorker", FakeWorker)

    with pytest.raises(asyncio.CancelledError):
        await transcription_job_runner._execute_transcription_job(
            settings,
            tenant_id,
            session_id,
        )

    assert worker_arguments["max_attempts"] == DURABLE_MAX_ATTEMPTS
    assert closed == ["transcriber", "assembler", "repositories"]


@pytest.mark.asyncio
async def test_partial_builder_failure_closes_completed_components_in_reverse_order(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    settings = _enabled_settings(tmp_path)
    closed: list[str] = []

    class FakeRepositories:
        async def close(self) -> None:
            closed.append("repositories")

    class FakeAssembler:
        async def close(self) -> None:
            closed.append("assembler")

    repositories = FakeRepositories()
    assembler = FakeAssembler()
    monkeypatch.setattr(transcription_job_runner, "build_postgres_provider", lambda _: repositories)
    monkeypatch.setattr(
        transcription_job_runner,
        "build_audio_track_assembler",
        lambda *_: assembler,
    )

    def fail_transcriber(_: Settings) -> None:
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(
        transcription_job_runner,
        "build_speech_to_text_provider",
        fail_transcriber,
    )

    with pytest.raises(RuntimeError, match="provider unavailable"):
        await transcription_job_runner._execute_transcription_job(
            settings,
            uuid4(),
            uuid4(),
        )

    assert closed == ["assembler", "repositories"]


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

    monkeypatch.setattr(transcription_job_runner, "_install_signal_handlers", install)

    with pytest.raises(asyncio.CancelledError):
        await transcription_job_runner._run_with_signal_cancellation(run)

    assert cleaned.is_set()


def test_main_exits_nonzero_while_disabled_before_parsing_or_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def settings_factory() -> Settings:
        raise AssertionError("disabled main must not parse settings")

    monkeypatch.setenv(TRANSCRIPTION_JOB_ENABLED_ENV, "false")
    monkeypatch.setattr(sys, "argv", ["transcription-job", "invalid-sensitive-target"])
    monkeypatch.setattr(transcription_job_runner, "get_settings", settings_factory)

    with pytest.raises(SystemExit) as caught:
        transcription_job_runner.main()

    assert caught.value.code == 1
