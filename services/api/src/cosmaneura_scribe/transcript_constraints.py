from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

MAX_TRANSCRIPT_SEGMENTS = 10_000
MAX_TRANSCRIPT_CONTENT_CHARS = 100_000
MAX_TRANSCRIPT_DURATION_MS = 86_400_000


class TimedTranscriptSegment(Protocol):
    content: str
    start_ms: int
    end_ms: int


def validate_transcript_segments(
    segments: Sequence[TimedTranscriptSegment],
    *,
    duration_ms: int | None = None,
) -> None:
    if not segments or len(segments) > MAX_TRANSCRIPT_SEGMENTS:
        raise ValueError("transcript segment count is outside the supported range")
    starts = [segment.start_ms for segment in segments]
    if starts != sorted(starts):
        raise ValueError("transcript segments must be in nondecreasing time order")
    if max(segment.end_ms for segment in segments) > MAX_TRANSCRIPT_DURATION_MS:
        raise ValueError("transcript duration exceeds the supported limit")
    if duration_ms is not None:
        if duration_ms <= 0 or duration_ms > MAX_TRANSCRIPT_DURATION_MS:
            raise ValueError("provider duration is outside the supported range")
        if any(segment.end_ms > duration_ms for segment in segments):
            raise ValueError("transcript segment exceeds the provider duration")
