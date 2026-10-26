"""Opt-in count-only Azure boundary observations for scoped diagnostics.

Callers must already hold consent and the intended synthetic session scope;
this module neither authorizes nor logs. The capture worker can explicitly
install a default-off, expiring metadata observer for one exact scope.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from importlib.metadata import version
from typing import BinaryIO


@dataclass(frozen=True)
class WaveHeaderObservation:
    channels: int
    sample_rate_hz: int
    sample_width_bits: int
    format_code: int


@dataclass(frozen=True)
class SpeechBoundaryObservation:
    track_index: int
    sdk_version: str
    max_speakers: int
    phrase_count: int
    missing_speaker_count: int
    distinct_non_null_speaker_count: int
    accepted_phrase_count: int
    accepted_distinct_speaker_count: int
    wave_header: WaveHeaderObservation | None
    diarization_enabled: bool | None = None
    call_id: str | None = None
    accepted_missing_speaker_count: int | None = None
    accepted_distinct_non_null_speaker_count: int | None = None


def inspect_wave_header(stream: BinaryIO) -> WaveHeaderObservation | None:
    """Inspect only the first canonical 44 bytes and restore the exact position."""
    if not stream.seekable():
        return None
    position = stream.tell()
    try:
        stream.seek(0)
        header = stream.read(44)
    finally:
        stream.seek(position)
    if len(header) != 44 or header[:4] != b"RIFF" or header[8:16] != b"WAVEfmt ":
        return None
    size, code, channels, rate, _, _, bits = struct.unpack("<IHHIIHH", header[16:36])
    if size != 16 or header[36:40] != b"data":
        return None
    return WaveHeaderObservation(channels, rate, bits, code)


def azure_sdk_version() -> str:
    return version("azure-ai-transcription")
