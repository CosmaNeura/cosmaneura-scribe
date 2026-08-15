from __future__ import annotations

import asyncio
import hashlib
import os
import signal
import wave
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from time import perf_counter

from .safe_logging import configure_standalone_logging, log_event
from .settings import Settings, get_settings
from .speech_private_network import PrivateSpeechEndpointUnavailable
from .transcription import SpeechToTextProvider, build_speech_to_text_provider
from .transcription_benchmark import (
    BenchmarkManifest,
    BenchmarkResult,
    load_manifest,
    run_benchmark,
)

SPEECH_SMOKE_ENABLED_ENV = "COSMANEURA_SCRIBE_SPEECH_SMOKE_ENABLED"
FIXTURE_ROOT = Path(__file__).with_name("speech_smoke_fixtures")
MAX_CASE_WORD_ERROR_RATE = 0.25
EXPECTED_CASE_IDS = frozenset({"sample-001", "sample-002"})
EXPECTED_FIXTURE_HASHES = {
    "manifest.json": "a79b2aa7451da5076bb1b24f35c0f507b221005943fccd6d1ab6b0ee699d485f",
    "audio/sample-001.wav": "8a168578a339d94bf7e87f73e56783df34b7886a2032101e0fab3162d512086e",
    "audio/sample-002.wav": "bc679381a7424ffc6a413043abfba67dad3229bf5fde3c15dc5b18c7948c3073",
    "references/sample-001.txt": (
        "9ac348ddbf3d21359887ce3553a36b884fa1082198d4a344c51e6be6c60b6e78"
    ),
    "references/sample-002.txt": (
        "ea85fd711541aa144c0caa7f457bc04315467ba74e1eb233998358ad34deaff6"
    ),
}
SMOKE_ERROR_CLASSES = {
    "speech_smoke_disabled": "SpeechSmokeDisabled",
    "speech_smoke_fixture_invalid": "SpeechSmokeFixtureInvalid",
    "speech_smoke_acceptance_failed": "SpeechSmokeAcceptanceFailed",
    "speech_smoke_cleanup_failed": "SpeechSmokeCleanupFailed",
    "speech_private_endpoint_unavailable": "SpeechPrivateEndpointUnavailable",
}

SettingsFactory = Callable[[], Settings]
ProviderFactory = Callable[[Settings], SpeechToTextProvider]
BenchmarkRun = Callable[
    [BenchmarkManifest, SpeechToTextProvider],
    Awaitable[list[BenchmarkResult]],
]
SmokeRun = Callable[[], Awaitable[bool]]


class SpeechSmokeRunnerError(RuntimeError):
    """Fixed-code smoke failure safe for the Container Apps Job boundary."""


def _is_raw_execution_enabled(environ: Mapping[str, str]) -> bool:
    value = environ.get(SPEECH_SMOKE_ENABLED_ENV)
    return value is not None and value.strip().casefold() == "true"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_wave(path: Path) -> None:
    try:
        with wave.open(str(path), "rb") as audio:
            valid = (
                audio.getnchannels() == 1
                and audio.getsampwidth() == 2
                and audio.getframerate() == 16_000
                and audio.getcomptype() == "NONE"
                and audio.getnframes() > 0
            )
    except (EOFError, OSError, wave.Error):
        valid = False
    if not valid:
        raise SpeechSmokeRunnerError("speech_smoke_fixture_invalid")


def _load_validated_manifest(root: Path) -> BenchmarkManifest:
    try:
        resolved_root = root.resolve(strict=True)
        present_files = {
            str(path.relative_to(resolved_root))
            for path in resolved_root.rglob("*")
            if path.is_file()
        }
        if present_files != set(EXPECTED_FIXTURE_HASHES):
            raise SpeechSmokeRunnerError("speech_smoke_fixture_invalid")
        for relative_path, expected_hash in EXPECTED_FIXTURE_HASHES.items():
            candidate = (resolved_root / relative_path).resolve(strict=True)
            if not candidate.is_relative_to(resolved_root) or _sha256(candidate) != expected_hash:
                raise SpeechSmokeRunnerError("speech_smoke_fixture_invalid")
        _validate_wave(resolved_root / "audio/sample-001.wav")
        _validate_wave(resolved_root / "audio/sample-002.wav")
        manifest = load_manifest(resolved_root / "manifest.json")
    except SpeechSmokeRunnerError:
        raise
    except (OSError, ValueError):
        raise SpeechSmokeRunnerError("speech_smoke_fixture_invalid") from None

    if (
        len(manifest.cases) != 2
        or frozenset(case.case_id for case in manifest.cases) != EXPECTED_CASE_IDS
        or any(case.source_kind != "synthetic" for case in manifest.cases)
    ):
        raise SpeechSmokeRunnerError("speech_smoke_fixture_invalid")
    return manifest


def _assert_acceptance(results: list[BenchmarkResult]) -> None:
    if (
        len(results) != 2
        or frozenset(result.case_id for result in results) != EXPECTED_CASE_IDS
        or any(result.provider != "azure_ai_speech" for result in results)
        or any(result.word_error_rate > MAX_CASE_WORD_ERROR_RATE for result in results)
        or any(result.audio_duration_seconds <= 0 for result in results)
        or any(result.segment_count <= 0 for result in results)
    ):
        raise SpeechSmokeRunnerError("speech_smoke_acceptance_failed")


async def _close_without_cancellation(provider: SpeechToTextProvider) -> None:
    async def close() -> None:
        try:
            await provider.close()
        except Exception:
            raise SpeechSmokeRunnerError("speech_smoke_cleanup_failed") from None

    task = asyncio.create_task(close())
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


async def run_speech_smoke(
    *,
    environ: Mapping[str, str] | None = None,
    settings_factory: SettingsFactory | None = None,
    provider_factory: ProviderFactory | None = None,
    benchmark: BenchmarkRun | None = None,
    fixture_root: Path = FIXTURE_ROOT,
) -> bool:
    """Run the two pinned synthetic cases only after both activation gates pass."""

    source = os.environ if environ is None else environ
    if not _is_raw_execution_enabled(source):
        log_event(action="speech_smoke.disabled", error_class="SpeechSmokeDisabled")
        raise SpeechSmokeRunnerError("speech_smoke_disabled")

    started = perf_counter()
    try:
        settings = (settings_factory or get_settings)()
        if not settings.speech_smoke_enabled:
            raise SpeechSmokeRunnerError("speech_smoke_disabled")
        manifest = _load_validated_manifest(fixture_root)
        provider = (provider_factory or build_speech_to_text_provider)(settings)
        try:
            results = await (benchmark or run_benchmark)(manifest, provider)
        finally:
            await _close_without_cancellation(provider)
        _assert_acceptance(results)
        log_event(
            action="speech_smoke.completed",
            duration_ms=(perf_counter() - started) * 1000,
        )
        return True
    except asyncio.CancelledError:
        log_event(
            action="speech_smoke.cancelled",
            error_class="CancelledError",
            duration_ms=(perf_counter() - started) * 1000,
        )
        raise
    except PrivateSpeechEndpointUnavailable:
        log_event(
            action="speech_smoke.failed",
            error_class="SpeechPrivateEndpointUnavailable",
            duration_ms=(perf_counter() - started) * 1000,
        )
        raise SpeechSmokeRunnerError("speech_private_endpoint_unavailable") from None
    except SpeechSmokeRunnerError as exc:
        log_event(
            action="speech_smoke.failed",
            error_class=SMOKE_ERROR_CLASSES.get(str(exc), "SpeechSmokeRunnerError"),
            duration_ms=(perf_counter() - started) * 1000,
        )
        raise
    except Exception:
        log_event(
            action="speech_smoke.failed",
            error_class="SpeechSmokeExecutionError",
            duration_ms=(perf_counter() - started) * 1000,
        )
        raise SpeechSmokeRunnerError("speech_smoke_execution_failed") from None


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


async def _run_with_signal_cancellation(run: SmokeRun | None = None) -> bool:
    async def invoke() -> bool:
        return await (run or run_speech_smoke)()

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
    except (KeyboardInterrupt, asyncio.CancelledError):
        raise SystemExit(130) from None
    except SpeechSmokeRunnerError:
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
