"""Seekable WAV view over the existing authenticated capture envelopes.

Only encrypted envelopes are on disk. The index contains no speech, and one
chunk is authenticated before its PCM becomes visible to a bounded reader.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import os
import stat
import struct
from bisect import bisect_right
from collections.abc import Buffer, Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, cast

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .capture_protocol_v1 import (
    AUDIO_CHANNELS,
    MAX_ENVELOPE_BYTES,
    MEDIA_SAMPLE_WIDTH_BYTES,
    SAMPLE_RATE_HZ,
    decode_envelope,
)


@dataclass(frozen=True, repr=False)
class EncryptedWaveChunk:
    envelope_offset: int
    envelope_size: int
    sha256: str
    nonce: bytes
    additional_data: bytes
    pcm_offset: int
    pcm_size: int


def wave_header(pcm_size: int) -> bytes:
    alignment = AUDIO_CHANNELS * MEDIA_SAMPLE_WIDTH_BYTES
    if not 0 < pcm_size <= 0xFFFFFFFF - 36 or pcm_size % alignment:
        raise ValueError("audio_wave_size_invalid")
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI", b"RIFF", pcm_size + 36, b"WAVE", b"fmt ",
        16, 1, AUDIO_CHANNELS, SAMPLE_RATE_HZ, SAMPLE_RATE_HZ * alignment,
        alignment, MEDIA_SAMPLE_WIDTH_BYTES * 8, b"data", pcm_size,
    )


class _EncryptedWaveStream(io.RawIOBase):
    def __init__(self, path: Path, key: bytearray, chunks: tuple[EncryptedWaveChunk, ...]):
        super().__init__()
        self._loaded = -1
        self._plaintext = bytearray()
        self._key = key
        self._chunks = chunks
        self._starts: list[int] = []
        pcm_size = 0
        for chunk in chunks:
            self._starts.append(pcm_size)
            pcm_size += chunk.pcm_size
        self._header = wave_header(pcm_size)
        self._length = len(self._header) + pcm_size
        self._position = 0
        # No fileno is exposed: this encrypted file's size is not the WAV size.
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            self._file = os.fdopen(descriptor, "rb")
            info = os.fstat(self._file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != (
                chunks[-1].envelope_offset + chunks[-1].envelope_size
            ):
                self._file.close()
                raise OSError
        except OSError:
            raise OSError("encrypted audio track unavailable") from None

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        self._ensure_open()
        return self._position

    def _ensure_open(self) -> None:
        if self.closed:
            raise ValueError("I/O operation on closed stream")

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        self._ensure_open()
        if whence not in (os.SEEK_SET, os.SEEK_CUR, os.SEEK_END):
            raise ValueError("invalid whence")
        position = offset + (0 if whence == os.SEEK_SET else
                             self._position if whence == os.SEEK_CUR else self._length)
        if position < 0:
            raise ValueError("negative seek position")
        self._position = position
        # A new read after a seek reauthenticates its original envelope.
        self._clear_chunk()
        return position

    def _clear_chunk(self) -> None:
        self._plaintext[:] = b"\x00" * len(self._plaintext)
        self._plaintext = bytearray()
        self._loaded = -1

    def _load_chunk(self, index: int) -> None:
        if self._loaded == index:
            return
        self._clear_chunk()
        chunk = self._chunks[index]
        try:
            if not 0 < chunk.envelope_size <= MAX_ENVELOPE_BYTES:
                raise ValueError
            self._file.seek(chunk.envelope_offset)
            envelope = self._file.read(chunk.envelope_size)
            if len(envelope) != chunk.envelope_size or not hmac.compare_digest(
                hashlib.sha256(envelope).hexdigest(), chunk.sha256.casefold()
            ):
                raise ValueError
            _, ciphertext = decode_envelope(envelope)
            self._plaintext = bytearray(AESGCM(bytes(self._key)).decrypt(
                chunk.nonce, ciphertext, chunk.additional_data,
            ))
            if chunk.pcm_offset < 0 or chunk.pcm_offset + chunk.pcm_size > len(self._plaintext):
                raise ValueError
        except (OSError, InvalidTag, ValueError):
            self._clear_chunk()
            raise OSError("encrypted audio track unavailable") from None
        self._loaded = index

    def readinto(self, buffer: Buffer) -> int:
        self._ensure_open()
        with memoryview(buffer).cast("B") as target:
            length = min(len(target), max(0, self._length - self._position))
            written = 0
            while written < length:
                if self._position < len(self._header):
                    count = min(length - written, len(self._header) - self._position)
                    target[written:written + count] = self._header[
                        self._position:self._position + count
                    ]
                else:
                    position = self._position - len(self._header)
                    index = bisect_right(self._starts, position) - 1
                    self._load_chunk(index)
                    chunk = self._chunks[index]
                    within = position - self._starts[index]
                    count = min(length - written, chunk.pcm_size - within)
                    start = chunk.pcm_offset + within
                    target[written:written + count] = self._plaintext[start:start + count]
                self._position += count
                written += count
            return written

    def close(self) -> None:
        try:
            self._clear_chunk()
            if hasattr(self, "_file"):
                self._file.close()
        finally:
            super().close()


@dataclass
class EncryptedAudioTrackReader:
    path: Path = field(repr=False)
    key: bytearray = field(repr=False)
    chunks: tuple[EncryptedWaveChunk, ...] = field(repr=False)
    _closed: bool = field(default=False, init=False, repr=False)
    _streams: set[io.BufferedIOBase] = field(
        default_factory=lambda: set[io.BufferedIOBase](), init=False, repr=False,
    )

    @contextmanager
    def open(self) -> Generator[BinaryIO]:
        if self._closed:
            raise OSError("encrypted audio track unavailable")
        stream = io.BufferedReader(_EncryptedWaveStream(self.path, self.key, self.chunks), 65536)
        self._streams.add(stream)
        try:
            yield cast(BinaryIO, stream)
        finally:
            stream.close()
            self._streams.discard(stream)

    def close(self) -> None:
        self._closed = True
        for stream in self._streams:
            stream.close()
        self._streams.clear()
        self.key[:] = b"\x00" * len(self.key)
