from __future__ import annotations

import asyncio
import json
import logging
import shutil
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from uuid import uuid4

import pytest
from cosmaneura_scribe import speech_smoke_runner
from cosmaneura_scribe.safe_logging import LOGGER_NAME, log_event
from cosmaneura_scribe.settings import Settings
from cosmaneura_scribe.speech_private_network import PrivateSpeechEndpointUnavailable
from cosmaneura_scribe.speech_smoke_runner import (
    EXPECTED_CASE_IDS,
    EXPECTED_FIXTURE_HASHES,
    FIXTURE_ROOT,
    SPEECH_SMOKE_ENABLED_ENV,
    SpeechSmokeRunnerError,
    _load_validated_manifest,
    run_speech_smoke,
)
from cosmaneura_scribe.transcription import SpeechToTextProvider
from cosmaneura_scribe.transcription_benchmark import BenchmarkResult


def _enabled_settings() -> Settings:
    return Settings(
        managed_identity_client_id=uuid4(),
        transcription_backend="azure",
        azure_speech_endpoint=("https://cosmaneura-scribe-dev-speech.cognitiveservices.azure.com"),
        azure_speech_private_endpoint_cidrs=("10.42.1.7/32",),
        speech_smoke_enabled=True,
    )


class FakeProvider:
    name = "azure_ai_speech"

    def __init__(self) -> None:
        self.closed = False

    async def transcribe(self, _: object) -> object:
        raise AssertionError("the injected benchmark owns provider execution")

    async def close(self) -> None:
        self.closed = True


def _passing_results() -> list[BenchmarkResult]:
    return [
        BenchmarkResult(
            case_id=case_id,
            provider="azure_ai_speech",
            word_error_rate=0.0,
            audio_duration_seconds=2.0,
            elapsed_seconds=0.5,
            real_time_factor=0.25,
            segment_count=1,
            speaker_count=1,
        )
        for case_id in sorted(EXPECTED_CASE_IDS)
    ]


def test_committed_speech_smoke_bundle_matches_approved_hashes_and_provenance() -> None:
    manifest = _load_validated_manifest(FIXTURE_ROOT)

    assert len(EXPECTED_FIXTURE_HASHES) == 5
    assert {case.case_id for case in manifest.cases} == EXPECTED_CASE_IDS
    assert all(case.source_kind == "synthetic" for case in manifest.cases)
    assert all(case.consent_verified is True for case in manifest.cases)


@pytest.mark.asyncio
async def test_disabled_speech_smoke_gate_precedes_settings_fixtures_and_clients(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, object]] = []

    def capture_event(**event: object) -> None:
        events.append(event)

    monkeypatch.setattr(speech_smoke_runner, "log_event", capture_event)

    def settings_factory() -> Settings:
        raise AssertionError("disabled smoke must not parse settings")

    def provider_factory(_: Settings) -> SpeechToTextProvider:
        raise AssertionError("disabled smoke must not create a provider")

    with pytest.raises(SpeechSmokeRunnerError, match="^speech_smoke_disabled$"):
        await run_speech_smoke(
            environ={SPEECH_SMOKE_ENABLED_ENV: "false"},
            settings_factory=settings_factory,
            provider_factory=provider_factory,
            fixture_root=tmp_path / "missing-sensitive-fixture",
        )

    assert events == [
        {
            "action": "speech_smoke.disabled",
            "error_class": "SpeechSmokeDisabled",
        }
    ]


@pytest.mark.asyncio
async def test_speech_smoke_runs_exactly_two_pinned_cases_and_closes_provider() -> None:
    provider = FakeProvider()
    observed_case_ids: set[str] = set()

    async def benchmark(manifest: object, _: SpeechToTextProvider) -> list[BenchmarkResult]:
        observed_case_ids.update(case.case_id for case in manifest.cases)  # type: ignore[attr-defined]
        return _passing_results()

    assert await run_speech_smoke(
        environ={SPEECH_SMOKE_ENABLED_ENV: "true"},
        settings_factory=_enabled_settings,
        provider_factory=lambda _: provider,
        benchmark=benchmark,
    )
    assert observed_case_ids == EXPECTED_CASE_IDS
    assert provider.closed is True


@pytest.mark.asyncio
async def test_speech_smoke_rejects_tampered_bundle_without_exposing_path(tmp_path: Path) -> None:
    copied = tmp_path / "unsafe-patient-label"
    shutil.copytree(FIXTURE_ROOT, copied)
    (copied / "references/sample-001.txt").write_text(
        "tampered unsafe reference",
        encoding="utf-8",
    )

    with pytest.raises(SpeechSmokeRunnerError) as caught:
        await run_speech_smoke(
            environ={SPEECH_SMOKE_ENABLED_ENV: "true"},
            settings_factory=_enabled_settings,
            fixture_root=copied,
        )

    assert str(caught.value) == "speech_smoke_fixture_invalid"
    assert "unsafe-patient-label" not in repr(caught.value)
    assert "tampered" not in repr(caught.value)


@pytest.mark.asyncio
async def test_speech_smoke_fails_when_any_case_exceeds_threshold() -> None:
    provider = FakeProvider()
    results = _passing_results()
    results[0] = BenchmarkResult(**(results[0].sanitized_dict() | {"word_error_rate": 0.251}))

    async def benchmark(_: object, __: SpeechToTextProvider) -> list[BenchmarkResult]:
        return results

    with pytest.raises(
        SpeechSmokeRunnerError,
        match="^speech_smoke_acceptance_failed$",
    ):
        await run_speech_smoke(
            environ={SPEECH_SMOKE_ENABLED_ENV: "true"},
            settings_factory=_enabled_settings,
            provider_factory=lambda _: provider,
            benchmark=benchmark,
        )

    assert provider.closed is True


@pytest.mark.asyncio
async def test_speech_smoke_cancellation_still_closes_provider() -> None:
    provider = FakeProvider()

    async def benchmark(_: object, __: SpeechToTextProvider) -> list[BenchmarkResult]:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_speech_smoke(
            environ={SPEECH_SMOKE_ENABLED_ENV: "true"},
            settings_factory=_enabled_settings,
            provider_factory=lambda _: provider,
            benchmark=benchmark,
        )

    assert provider.closed is True


@pytest.mark.asyncio
async def test_speech_smoke_sanitizes_provider_cleanup_failure() -> None:
    class FailingCloseProvider(FakeProvider):
        async def close(self) -> None:
            raise RuntimeError("unsafe endpoint cleanup detail")

    provider = FailingCloseProvider()

    async def benchmark(_: object, __: SpeechToTextProvider) -> list[BenchmarkResult]:
        return _passing_results()

    with pytest.raises(SpeechSmokeRunnerError) as caught:
        await run_speech_smoke(
            environ={SPEECH_SMOKE_ENABLED_ENV: "true"},
            settings_factory=_enabled_settings,
            provider_factory=lambda _: provider,
            benchmark=benchmark,
        )

    assert str(caught.value) == "speech_smoke_cleanup_failed"
    assert "unsafe endpoint" not in repr(caught.value)


@pytest.mark.asyncio
async def test_speech_smoke_preserves_private_endpoint_failure_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FakeProvider()
    events: list[dict[str, object]] = []

    async def benchmark(_: object, __: SpeechToTextProvider) -> list[BenchmarkResult]:
        raise PrivateSpeechEndpointUnavailable("speech_private_endpoint_unavailable")

    def capture_event(**event: object) -> None:
        events.append(event)

    monkeypatch.setattr(speech_smoke_runner, "log_event", capture_event)

    with pytest.raises(
        SpeechSmokeRunnerError,
        match="^speech_private_endpoint_unavailable$",
    ):
        await run_speech_smoke(
            environ={SPEECH_SMOKE_ENABLED_ENV: "true"},
            settings_factory=_enabled_settings,
            provider_factory=lambda _: provider,
            benchmark=benchmark,
        )

    assert provider.closed is True
    assert len(events) == 1
    assert events[0]["action"] == "speech_smoke.failed"
    assert events[0]["error_class"] == "SpeechPrivateEndpointUnavailable"


def test_speech_smoke_main_emits_success_info_event_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger = logging.getLogger(LOGGER_NAME)
    previous_handlers = logger.handlers[:]
    previous_level = logger.level
    previous_propagate = logger.propagate
    logger.handlers.clear()

    async def run() -> bool:
        log_event(action="speech_smoke.completed", duration_ms=1)
        return True

    monkeypatch.setattr(speech_smoke_runner, "_run_with_signal_cancellation", run)
    output = StringIO()
    try:
        with redirect_stderr(output):
            speech_smoke_runner.main()
    finally:
        logger.handlers.clear()
        logger.handlers.extend(previous_handlers)
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate

    events = [json.loads(line) for line in output.getvalue().splitlines()]
    assert len(events) == 1
    assert events[0]["action"] == "speech_smoke.completed"


@pytest.mark.asyncio
async def test_speech_smoke_signal_boundary_cancels_and_awaits_execution(
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

    monkeypatch.setattr(speech_smoke_runner, "_install_signal_handlers", install)

    with pytest.raises(asyncio.CancelledError):
        await speech_smoke_runner._run_with_signal_cancellation(run)

    assert cleaned.is_set()
