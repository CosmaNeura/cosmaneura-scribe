from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from time import perf_counter
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field

from .schemas import CaptureChannel
from .transcription import (
    AudioTrack,
    SpeechToTextProvider,
    TranscriptionRequest,
)


class BenchmarkCase(BaseModel):
    model_config = ConfigDict(frozen=True)

    case_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,63}$")
    consent_record_id: UUID
    consent_verified: Literal[True]
    source_kind: Literal["synthetic", "consented_deidentified"]
    audio_path: Path = Field(repr=False)
    reference_path: Path = Field(repr=False)
    language_code: str = Field(default="en-US", min_length=2, max_length=16)
    channel: CaptureChannel = CaptureChannel.MIXED


class BenchmarkManifest(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal["1.0"] = "1.0"
    deidentified: Literal[True]
    cases: list[BenchmarkCase] = Field(min_length=1, max_length=100)


@dataclass(frozen=True)
class BenchmarkResult:
    case_id: str
    provider: str
    word_error_rate: float
    audio_duration_seconds: float
    elapsed_seconds: float
    real_time_factor: float | None
    segment_count: int
    speaker_count: int

    def sanitized_dict(self) -> dict[str, object]:
        return asdict(self)


def _tokens(value: str) -> list[str]:
    return re.findall(r"\w+", value.casefold(), flags=re.UNICODE)


def word_error_rate(reference: str, hypothesis: str) -> float:
    expected = _tokens(reference)
    actual = _tokens(hypothesis)
    if not expected:
        return 0.0 if not actual else float(len(actual))

    previous = list(range(len(actual) + 1))
    for row_index, expected_token in enumerate(expected, start=1):
        current = [row_index]
        for column_index, actual_token in enumerate(actual, start=1):
            substitution_cost = 0 if expected_token == actual_token else 1
            current.append(
                min(
                    current[column_index - 1] + 1,
                    previous[column_index] + 1,
                    previous[column_index - 1] + substitution_cost,
                )
            )
        previous = current
    return previous[-1] / len(expected)


def load_manifest(manifest_path: Path) -> BenchmarkManifest:
    manifest = BenchmarkManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    root = manifest_path.resolve().parent
    resolved_cases: list[BenchmarkCase] = []
    for case in manifest.cases:
        audio_path = (root / case.audio_path).resolve()
        reference_path = (root / case.reference_path).resolve()
        if not audio_path.is_file() or not reference_path.is_file():
            raise ValueError("benchmark case files are unavailable")
        resolved_cases.append(
            case.model_copy(update={"audio_path": audio_path, "reference_path": reference_path})
        )
    return manifest.model_copy(update={"cases": resolved_cases})


async def run_benchmark(
    manifest: BenchmarkManifest,
    provider: SpeechToTextProvider,
) -> list[BenchmarkResult]:
    results: list[BenchmarkResult] = []
    for case in manifest.cases:
        started = perf_counter()
        transcription = await provider.transcribe(
            TranscriptionRequest(
                session_id=uuid5(NAMESPACE_URL, f"cosmaneura-stt-benchmark:{case.case_id}"),
                consent_record_id=case.consent_record_id,
                language_code=case.language_code,
                tracks=(
                    AudioTrack(
                        object_id=uuid5(
                            NAMESPACE_URL,
                            f"cosmaneura-stt-benchmark-object:{case.case_id}",
                        ),
                        channel=case.channel,
                        local_path=case.audio_path,
                    ),
                ),
            )
        )
        elapsed_seconds = perf_counter() - started
        reference = case.reference_path.read_text(encoding="utf-8")
        hypothesis = " ".join(segment.content for segment in transcription.segments)
        duration_seconds = transcription.duration_ms / 1000
        results.append(
            BenchmarkResult(
                case_id=case.case_id,
                provider=transcription.provider,
                word_error_rate=round(word_error_rate(reference, hypothesis), 6),
                audio_duration_seconds=round(duration_seconds, 3),
                elapsed_seconds=round(elapsed_seconds, 3),
                real_time_factor=(
                    round(elapsed_seconds / duration_seconds, 6) if duration_seconds > 0 else None
                ),
                segment_count=len(transcription.segments),
                speaker_count=len(
                    {segment.provider_speaker_id for segment in transcription.segments}
                ),
            )
        )
    return results


def encode_results(results: list[BenchmarkResult]) -> str:
    payload = {
        "schema_version": "1.0",
        "results": [result.sanitized_dict() for result in results],
    }
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"
