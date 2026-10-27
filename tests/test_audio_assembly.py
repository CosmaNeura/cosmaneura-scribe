from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import struct
import tracemalloc
import wave
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from azure.core.credentials import AccessToken
from conftest import RepositoryBackend
from cosmaneura_scribe.audio_assembly import (
    AudioAssemblyError,
    EncryptedAudioTrackReader,
    EncryptedBlobAudioTrackAssembler,
    KeyVaultSessionKeyUnwrapper,
    _wave_layout,
    chunk_additional_data,
)
from cosmaneura_scribe.capture_protocol_v1 import (
    EncryptedChunkHeader,
    encode_envelope,
)
from cosmaneura_scribe.encrypted_wave_stream import EncryptedWaveChunk, wave_header
from cosmaneura_scribe.repository import AudioAssemblyManifest
from cosmaneura_scribe.schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    SessionAudioKey,
    SessionStatus,
)
from cosmaneura_scribe.transcription_worker import AudioAssemblyRequest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


WRAPPED_DEK = _base64url(b"w" * 384)


class StaticManifestProvider:
    def __init__(self, manifest: AudioAssemblyManifest | None) -> None:
        self.manifest = manifest
        self.calls = 0

    async def resolve(self, request: AudioAssemblyRequest) -> AudioAssemblyManifest | None:
        del request
        self.calls += 1
        return self.manifest


class MemoryBlobReader:
    def __init__(self, objects: dict[UUID, bytes]) -> None:
        self.objects = objects
        self.calls: list[UUID] = []
        self.closed = False

    async def read(self, request: AudioAssemblyRequest, chunk: AudioChunk) -> bytes:
        assert request.session_id == chunk.session_id
        self.calls.append(chunk.object_id)
        return self.objects[chunk.object_id]

    async def close(self) -> None:
        self.closed = True


class StaticKeyUnwrapper:
    def __init__(self, key: bytes) -> None:
        self.key = key
        self.calls: list[SessionAudioKey] = []
        self.closed = False

    async def unwrap(self, audio_key: SessionAudioKey) -> bytearray:
        self.calls.append(audio_key)
        return bytearray(self.key)

    async def close(self) -> None:
        self.closed = True


class StaticCredential:
    def __init__(self) -> None:
        self.scopes: list[str] = []
        self.closed = False

    async def get_token(self, *scopes: str, **kwargs: object) -> AccessToken:
        del kwargs
        self.scopes.extend(scopes)
        return AccessToken("key-vault-token", 4_000_000_000)

    async def close(self) -> None:
        self.closed = True


def _wave_bytes(
    frames: bytes,
    *,
    channels: int = 1,
    sample_width: int = 2,
    frame_rate: int = 16_000,
) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(sample_width)
        audio.setframerate(frame_rate)
        audio.writeframes(frames)
    return output.getvalue()


def _compressed_wave_bytes() -> bytes:
    frames = b"\x00" * 16
    return b"".join(
        (
            b"RIFF",
            struct.pack("<I", 36 + len(frames)),
            b"WAVEfmt ",
            struct.pack("<IHHIIHH", 16, 6, 1, 16_000, 16_000, 1, 8),
            b"data",
            struct.pack("<I", len(frames)),
            frames,
        )
    )


def _chunk(
    session_id: UUID,
    sequence_number: int,
    channel: CaptureChannel,
    object_id: UUID,
) -> AudioChunk:
    return AudioChunk(
        id=uuid4(),
        session_id=session_id,
        sequence_number=sequence_number,
        channel=channel,
        object_id=object_id,
        sha256="0" * 64,
        ciphertext_size_bytes=1,
        registered_at=datetime.now(UTC),
    )


def _request(session_id: UUID, chunks: tuple[AudioChunk, ...]) -> AudioAssemblyRequest:
    return AudioAssemblyRequest(
        tenant_id=uuid4(),
        session_id=session_id,
        chunks=chunks,
        job_id=uuid4(),
        lease_token=uuid4(),
    )


def _audio_key(session_id: UUID) -> SessionAudioKey:
    return SessionAudioKey(
        session_id=session_id,
        key_version="version-1",
        wrapped_dek=WRAPPED_DEK,
        created_at=datetime.now(UTC),
    )


def _encrypt(
    request: AudioAssemblyRequest,
    chunk: AudioChunk,
    plaintext: bytes,
    key: bytes,
    nonce: bytes,
) -> bytes:
    header = EncryptedChunkHeader(nonce=_base64url(nonce))
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, chunk_additional_data(request, chunk))
    return encode_envelope(header, ciphertext)


def _streaming_fixture(
    tmp_path: Path,
    count: int = 3,
    frames: int | tuple[int, ...] = 40,
    channel: CaptureChannel = CaptureChannel.MICROPHONE,
):
    """Invented authorized manifest and synthetic PCM, using the existing envelope."""
    key = b"k" * 32
    session_id = uuid4()
    initial = tuple(_chunk(session_id, i, channel, uuid4()) for i in range(count))
    request = _request(session_id, initial)
    objects, complete = {}, []
    for i, chunk in enumerate(initial):
        pcm = struct.pack("<h", i + 1) * (frames if isinstance(frames, int) else frames[i])
        envelope = _encrypt(request, chunk, _wave_bytes(pcm), key, i.to_bytes(12, "big"))
        objects[chunk.object_id] = envelope
        complete.append(
            chunk.model_copy(
                update={
                    "sha256": hashlib.sha256(envelope).hexdigest(),
                    "ciphertext_size_bytes": len(envelope),
                }
            )
        )
    request = AudioAssemblyRequest(
        request.tenant_id, session_id, tuple(complete), request.job_id, request.lease_token
    )
    unwrapper = StaticKeyUnwrapper(key)
    blobs = MemoryBlobReader(objects)
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=StaticManifestProvider(
            AudioAssemblyManifest(_audio_key(session_id), tuple(complete)),
        ),
        reader=blobs,
        key_unwrapper=unwrapper,
        temporary_directory=tmp_path,
    )
    return assembler, request, blobs


@pytest.mark.asyncio
async def test_mixed_track_pause_flush_uses_cumulative_pcm_passage_offsets(tmp_path: Path) -> None:
    # Same invented vector as Desktop passage-continuity.test.ts: the third
    # chunk is a short pause flush; the resumed source begins at sequence 3.
    # This is the real server assembler/reader consumed by the speech provider.
    frames = (16_000, 16_000, 4_000, 16_000)
    assembler, request, _ = _streaming_fixture(tmp_path, 4, frames, CaptureChannel.MIXED)
    expected_pcm = b"".join(
        struct.pack("<h", index + 1) * count for index, count in enumerate(frames)
    )
    async with assembler.assemble(request) as (track,):
        with track.open() as stream:
            assert stream.read() == _wave_bytes(expected_pcm)
            for start_ms, end_ms in ((500, 1500), (2000, 2500), (2500, 3000)):
                stream.seek(44 + start_ms * 32)
                assert stream.read((end_ms - start_ms) * 32) == expected_pcm[
                    start_ms * 32 : end_ms * 32
                ]


@pytest.mark.asyncio
async def test_streaming_wave_seeks_and_reopens_with_original_ciphertext(tmp_path: Path) -> None:
    assembler, request, blobs = _streaming_fixture(tmp_path)
    expected_pcm = b"".join(struct.pack("<h", i) * 40 for i in (1, 2, 3))
    expected = _wave_bytes(expected_pcm)
    async with assembler.assemble(request) as (track,):
        assert track.local_path.stat().st_mode & 0o777 == 0o600
        assert track.local_path.parent.stat().st_mode & 0o777 == 0o700
        assert track.local_path.read_bytes() == b"".join(
            blobs.objects[c.object_id] for c in request.chunks
        )
        with track.open() as stream:
            assert stream.read(47) == expected[:47]
            stream.seek(44 + 79)
            assert stream.read(90) == expected[123:213]
            assert stream.seek(-11, os.SEEK_END) == len(expected) - 11
            assert stream.read() == expected[-11:]
            stream.seek(0)
            assert stream.read() == expected
        with track.open() as stream:
            assert stream.read(44) == expected[:44]
        reader = track.reader
        assert isinstance(reader, EncryptedAudioTrackReader)
        with reader.open() as stream:
            assert stream.read(60) == expected[:60]
            reader.close()
            assert stream.closed
    assert isinstance(reader, EncryptedAudioTrackReader)
    assert reader.key == bytearray(32)
    with pytest.raises(OSError, match="encrypted audio track unavailable"):
        with reader.open():
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize("damage", ["tamper", "truncate", "replace", "wrong_key", "wrong_aad"])
async def test_streaming_wave_rejects_changed_encrypted_data(tmp_path: Path, damage: str) -> None:
    assembler, request, _ = _streaming_fixture(tmp_path)
    async with assembler.assemble(request) as (track,):
        reader = track.reader
        assert isinstance(reader, EncryptedAudioTrackReader)
        if damage in {"tamper", "truncate", "replace"}:
            data = bytearray(track.local_path.read_bytes())
            if damage == "tamper":
                data[reader.chunks[0].envelope_size - 1] ^= 1
            elif damage == "truncate":
                del data[-1:]
            else:
                # Same-length envelope from another position is not accepted.
                first, second = reader.chunks[:2]
                data[: first.envelope_size] = data[
                    second.envelope_offset : second.envelope_offset + second.envelope_size
                ]
            track.local_path.write_bytes(data)
        elif damage == "wrong_key":
            reader.key[0] ^= 1
        else:
            from dataclasses import replace

            reader.chunks = (
                replace(reader.chunks[0], additional_data=b"other-scope"),
                *reader.chunks[1:],
            )
        with pytest.raises(OSError, match="encrypted audio track unavailable"):
            with track.open() as stream:
                stream.seek(44)
                stream.read(1)
    assert await asyncio.to_thread(lambda: list(tmp_path.iterdir())) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [AudioAssemblyError("audio_blob_unavailable"), asyncio.CancelledError()]
)
async def test_streaming_assembly_clears_partial_files(
    tmp_path: Path,
    failure: BaseException,
) -> None:
    assembler, request, blobs = _streaming_fixture(tmp_path)
    read = blobs.read

    async def fail_second(req, chunk):
        if chunk.sequence_number == 1:
            raise failure
        return await read(req, chunk)

    blobs.read = fail_second
    with pytest.raises(type(failure)):
        async with assembler.assemble(request):
            pytest.fail("A partially validated recording must not reach Speech")
    assert await asyncio.to_thread(lambda: list(tmp_path.iterdir())) == []


@pytest.mark.parametrize("remove", [1, 2, 10])
def test_wave_layout_rejects_truncated_pcm(remove: int) -> None:
    with pytest.raises(AudioAssemblyError, match="audio_wave_invalid"):
        _wave_layout(bytearray(_wave_bytes(b"\x01\x00" * 20)[:-remove]))


def test_three_hour_stream_capacity_has_bounded_read_memory(
    tmp_path: Path,
) -> None:
    # Bounded stream component at the advertised three-hour capacity.
    # Generate encrypted bytes in seconds; no microphone, real-time wait or Speech call.
    key = b"s" * 32
    path = tmp_path / "synthetic-capacity.enc"
    count, frames_per_chunk = 1080, 160_000
    request = _request(uuid4(), ())
    index = []
    with path.open("wb") as destination:
        for i in range(count):
            chunk = _chunk(request.session_id, i, CaptureChannel.MICROPHONE, uuid4())
            nonce = i.to_bytes(12, "big")
            pcm = struct.pack("<h", i) * frames_per_chunk
            envelope = _encrypt(request, chunk, _wave_bytes(pcm), key, nonce)
            index.append(
                EncryptedWaveChunk(
                    destination.tell(),
                    len(envelope),
                    hashlib.sha256(envelope).hexdigest(),
                    nonce,
                    chunk_additional_data(request, chunk),
                    44,
                    len(pcm),
                )
            )
            destination.write(envelope)
    reader = EncryptedAudioTrackReader(path, bytearray(key), tuple(index))
    tracemalloc.start()
    try:
        total, digest = 0, hashlib.sha256()
        with reader.open() as stream:
            assert stream.seek(0, os.SEEK_END) == 44 + count * frames_per_chunk * 2
            stream.seek(0)
            while block := stream.read(65536):
                total += len(block)
                digest.update(block)
            stream.seek(-2, os.SEEK_END)
            assert stream.read(2) == struct.pack("<h", count - 1)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
        reader.close()
    expected = hashlib.sha256(wave_header(count * frames_per_chunk * 2))
    for i in range(count):
        expected.update(struct.pack("<h", i) * frames_per_chunk)
    assert total == 345_600_044
    assert digest.digest() == expected.digest()
    assert peak < 8 * 1024 * 1024, f"Bounded stream grew to {peak} bytes"
    print(f"three_hour_stream_bytes={total} peak_traced_read_bytes={peak}")


@pytest.mark.asyncio
async def test_installed_speech_sdk_streams_encrypted_wave_as_multipart(tmp_path: Path) -> None:
    from azure.ai.transcription.aio import TranscriptionClient
    from azure.ai.transcription.models import TranscriptionContent, TranscriptionOptions
    from azure.core.pipeline.transport import AioHttpTransport, AsyncHttpTransport

    class UploadInspected(Exception):
        pass

    class Sink:
        def __init__(self):
            self.body = bytearray()
            self.largest = 0

        async def write(self, data):
            self.largest = max(self.largest, len(data))
            self.body.extend(data)

    sink = Sink()

    class OfflineTransport(AsyncHttpTransport):
        async def open(self):
            pass

        async def close(self):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            await self.close()

        async def send(self, request, **kwargs):
            from urllib.parse import urlsplit

            url = urlsplit(request.url)
            assert url.hostname == "synthetic.invalid"
            assert url.path.endswith("/transcriptions:transcribe")
            # Use the installed Azure/aiohttp multipart implementation, not a fake encoder.
            encoder = AioHttpTransport()
            try:
                form = encoder._get_request_data(request)
                await form().write(sink)
            finally:
                await encoder.close()
            raise UploadInspected

    assembler, request, _ = _streaming_fixture(tmp_path, frames=160_000)
    async with assembler.assemble(request) as (track,):
        with track.open() as source:
            async with TranscriptionClient(
                "https://synthetic.invalid",
                StaticCredential(),
                transport=OfflineTransport(),
            ) as client:
                with pytest.raises(UploadInspected):
                    await client.transcribe(
                        TranscriptionContent(
                            definition=TranscriptionOptions(locales=["en-US"]),
                            audio=source,
                        ),
                        logging_enable=False,
                    )
    expected = _wave_bytes(b"".join(struct.pack("<h", i) * 160_000 for i in (1, 2, 3)))
    assert expected in sink.body
    assert sink.body.count(b'; name="audio"') == 1
    assert 0 < sink.largest <= 256 * 1024


@pytest.mark.asyncio
async def test_assembly_memory_does_not_grow_with_track_plaintext(tmp_path: Path) -> None:
    assembler, request, _ = _streaming_fixture(tmp_path, count=96, frames=160_000)
    tracemalloc.start()
    try:
        async with assembler.assemble(request) as (track,):
            with track.open() as stream:
                assert stream.seek(0, os.SEEK_END) == 44 + 96 * 320_000
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 * 1024 * 1024, f"Assembly grew to {peak} bytes"
    print(f"assembly_plaintext_bytes={96 * 320_044} peak_traced_assembly_bytes={peak}")


@pytest.mark.asyncio
async def test_assembler_revalidates_manifest_orders_tracks_and_leaves_no_plaintext_files(
    tmp_path: Path,
) -> None:
    session_id = uuid4()
    key = b"k" * 32
    initial = (
        _chunk(session_id, 0, CaptureChannel.SYSTEM_AUDIO, uuid4()),
        _chunk(session_id, 1, CaptureChannel.MICROPHONE, uuid4()),
        _chunk(session_id, 0, CaptureChannel.MICROPHONE, uuid4()),
    )
    request = _request(session_id, initial)
    frames = {
        (CaptureChannel.MICROPHONE, 0): b"\x01\x00" * 4,
        (CaptureChannel.MICROPHONE, 1): b"\x02\x00" * 3,
        (CaptureChannel.SYSTEM_AUDIO, 0): b"\x03\x00" * 2,
    }
    objects: dict[UUID, bytes] = {}
    complete: list[AudioChunk] = []
    for index, chunk in enumerate(initial, start=1):
        envelope = _encrypt(
            request,
            chunk,
            _wave_bytes(frames[(chunk.channel, chunk.sequence_number)]),
            key,
            index.to_bytes(12, "big"),
        )
        objects[chunk.object_id] = envelope
        complete.append(
            chunk.model_copy(
                update={
                    "sha256": hashlib.sha256(envelope).hexdigest(),
                    "ciphertext_size_bytes": len(envelope),
                }
            )
        )
    request = AudioAssemblyRequest(
        tenant_id=request.tenant_id,
        session_id=session_id,
        chunks=tuple(complete),
        job_id=request.job_id,
        lease_token=request.lease_token,
    )
    manifest = AudioAssemblyManifest(_audio_key(session_id), tuple(complete))
    reader = MemoryBlobReader(objects)
    unwrapper = StaticKeyUnwrapper(key)
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=StaticManifestProvider(manifest),
        reader=reader,
        key_unwrapper=unwrapper,
        temporary_directory=tmp_path,
    )

    async with assembler.assemble(request) as tracks:
        assert [track.channel for track in tracks] == [
            CaptureChannel.MICROPHONE,
            CaptureChannel.SYSTEM_AUDIO,
        ]
        for track in tracks:
            assert track.local_path.is_file()
            encrypted = track.local_path.read_bytes()
            assert not encrypted.startswith(b"RIFF")
            assert b"\x01\x00" * 4 not in encrypted
            with track.open() as source, wave.open(source, "rb") as assembled:
                output_frames = assembled.readframes(assembled.getnframes())
            if track.channel == CaptureChannel.MICROPHONE:
                assert output_frames == frames[(track.channel, 0)] + frames[(track.channel, 1)]
            else:
                assert output_frames == frames[(track.channel, 0)]
        paths = [track.local_path for track in tracks]

    assert all(not path.exists() for path in paths)
    assert await asyncio.to_thread(lambda: list(tmp_path.iterdir())) == []
    assert len(unwrapper.calls) == 1
    await assembler.close()
    assert reader.closed
    assert unwrapper.closed


@pytest.mark.asyncio
async def test_assembler_rejects_digest_before_aes_decryption(tmp_path: Path) -> None:
    session_id = uuid4()
    chunk = _chunk(session_id, 0, CaptureChannel.MIXED, uuid4()).model_copy(
        update={"ciphertext_size_bytes": 4}
    )
    request = _request(session_id, (chunk,))
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=StaticManifestProvider(AudioAssemblyManifest(_audio_key(session_id), (chunk,))),
        reader=MemoryBlobReader({chunk.object_id: b"data"}),
        key_unwrapper=StaticKeyUnwrapper(b"not-the-right-key".ljust(32, b"x")),
        temporary_directory=tmp_path,
    )

    with pytest.raises(AudioAssemblyError) as caught:
        async with assembler.assemble(request):
            pass

    assert str(caught.value) == "audio_ciphertext_digest_mismatch"
    assert await asyncio.to_thread(lambda: list(tmp_path.iterdir())) == []


@pytest.mark.asyncio
async def test_assembler_rejects_request_not_identical_to_leased_manifest(
    tmp_path: Path,
) -> None:
    session_id = uuid4()
    registered = _chunk(session_id, 0, CaptureChannel.MIXED, uuid4())
    unregistered = registered.model_copy(update={"object_id": uuid4()})
    request = _request(session_id, (unregistered,))
    reader = MemoryBlobReader({})
    unwrapper = StaticKeyUnwrapper(b"k" * 32)
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=StaticManifestProvider(
            AudioAssemblyManifest(_audio_key(session_id), (registered,))
        ),
        reader=reader,
        key_unwrapper=unwrapper,
        temporary_directory=tmp_path,
    )

    with pytest.raises(AudioAssemblyError, match="audio_assembly_not_authorized"):
        async with assembler.assemble(request):
            pass

    assert reader.calls == []
    assert unwrapper.calls == []


@pytest.mark.asyncio
async def test_key_vault_unwrapper_reconstructs_configured_key_and_uses_unwrapkey() -> None:
    credential = StaticCredential()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"value": _base64url(b"k" * 32)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        unwrapper = KeyVaultSessionKeyUnwrapper(
            configured_key_id="https://scribe-test.vault.azure.net/keys/scribe-audio",
            credential=credential,
            client=client,
        )
        content_key = await unwrapper.unwrap(_audio_key(uuid4()))
        await unwrapper.close()

    assert bytes(content_key) == b"k" * 32
    assert credential.scopes == ["https://vault.azure.net/.default"]
    assert credential.closed
    assert len(seen) == 1
    assert seen[0].headers["authorization"] == "Bearer key-vault-token"
    assert seen[0].url.path == "/keys/scribe-audio/version-1/unwrapkey"
    assert json.loads(seen[0].content) == {
        "alg": "RSA-OAEP-256",
        "value": WRAPPED_DEK,
    }


@pytest.mark.asyncio
async def test_key_vault_unwrapper_sanitizes_protocol_errors() -> None:
    sensitive = "protocol-detail-must-not-escape"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError(sensitive, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        unwrapper = KeyVaultSessionKeyUnwrapper(
            configured_key_id="https://scribe-test.vault.azure.net/keys/scribe-audio",
            credential=StaticCredential(),
            client=client,
        )
        with pytest.raises(AudioAssemblyError) as caught:
            await unwrapper.unwrap(_audio_key(uuid4()))

    assert str(caught.value) == "audio_key_unwrap_unavailable"
    assert sensitive not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__


def test_encrypted_track_reader_repr_omits_path(tmp_path: Path) -> None:
    sensitive_path = tmp_path / "object-path-must-not-escape.enc"
    reader = EncryptedAudioTrackReader(
        path=sensitive_path,
        key=bytearray(b"k" * 32),
        chunks=(),
    )

    assert str(sensitive_path) not in repr(reader)


@pytest.mark.parametrize(
    ("channels", "sample_width", "frame_rate"),
    ((2, 2, 16_000), (1, 1, 16_000), (1, 2, 48_000)),
)
def test_wave_assembly_rejects_media_outside_the_capture_profile(
    channels: int,
    sample_width: int,
    frame_rate: int,
) -> None:
    chunk = bytearray(
        _wave_bytes(
            b"\x00" * 12,
            channels=channels,
            sample_width=sample_width,
            frame_rate=frame_rate,
        )
    )

    with pytest.raises(AudioAssemblyError) as caught:
        _wave_layout(chunk)

    assert str(caught.value) == "audio_wave_media_profile_unsupported"


def test_wave_assembly_rejects_compressed_wav() -> None:
    with pytest.raises(AudioAssemblyError) as caught:
        _wave_layout(bytearray(_compressed_wave_bytes()))

    assert str(caught.value) == "audio_wave_invalid"


@pytest.mark.asyncio
async def test_assembler_rejects_oversized_manifest_before_blob_or_key_access(
    tmp_path: Path,
) -> None:
    session_id = uuid4()
    chunk = _chunk(session_id, 0, CaptureChannel.MIXED, uuid4()).model_copy(
        update={"ciphertext_size_bytes": 70 * 1_024 * 1_024}
    )
    request = _request(session_id, (chunk,))
    reader = MemoryBlobReader({})
    unwrapper = StaticKeyUnwrapper(b"k" * 32)
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=StaticManifestProvider(AudioAssemblyManifest(_audio_key(session_id), (chunk,))),
        reader=reader,
        key_unwrapper=unwrapper,
        temporary_directory=tmp_path,
    )

    with pytest.raises(AudioAssemblyError, match="audio_ciphertext_limit_exceeded"):
        async with assembler.assemble(request):
            pass

    assert reader.calls == []
    assert unwrapper.calls == []


def test_repository_manifest_requires_matching_live_lease(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    consent_id = uuid4()
    job_id = uuid4()
    lease_token = uuid4()
    now = datetime.now(UTC)
    consent = ConsentRecord(
        id=consent_id,
        appointment_id="appointment-assembly-manifest",
        practitioner_id="practitioner-assembly-manifest",
        patient_id="patient-assembly-manifest",
        modality=CaptureModality.VIRTUAL,
        participant_regions={"FL"},
        method=ConsentMethod.PRE_VISIT_FORM,
        all_parties_consented=True,
        granted_at=now,
        policy_version="all-party-v1",
    )
    session = CaptureSession(
        id=session_id,
        appointment_id=consent.appointment_id,
        practitioner_id=consent.practitioner_id,
        patient_id=consent.patient_id,
        consent_record_id=consent_id,
        modality=consent.modality,
        status=SessionStatus.PROCESSING,
        created_at=now,
    )
    audio_key = _audio_key(session_id)
    chunk = _chunk(session_id, 0, CaptureChannel.MIXED, uuid4())

    async def scenario() -> None:
        async with repository_backend.provider.transaction(tenant_id) as repository:
            await repository.add_consent(tenant_id, consent)
            await repository.add_session(tenant_id, session)
            assert await repository.add_session_audio_key(tenant_id, audio_key)
            await repository.add_chunk(tenant_id, chunk)
            claimed = await repository.claim_transcription_job(
                tenant_id,
                session_id,
                job_id=job_id,
                lease_token=lease_token,
                now=now,
                lease_until=now + timedelta(minutes=5),
                max_attempts=3,
            )
            assert claimed is not None
            manifest = await repository.get_audio_assembly_manifest(
                tenant_id,
                session_id,
                job_id=job_id,
                lease_token=lease_token,
                now=now,
            )
            assert manifest == AudioAssemblyManifest(audio_key, (chunk,))
            assert (
                await repository.get_audio_assembly_manifest(
                    tenant_id,
                    session_id,
                    job_id=job_id,
                    lease_token=uuid4(),
                    now=now,
                )
                is None
            )
            assert (
                await repository.get_audio_assembly_manifest(
                    tenant_id,
                    session_id,
                    job_id=job_id,
                    lease_token=lease_token,
                    now=now + timedelta(minutes=6),
                )
                is None
            )
        async with repository_backend.provider.transaction(uuid4()) as repository:
            assert (
                await repository.get_audio_assembly_manifest(
                    uuid4(),
                    session_id,
                    job_id=job_id,
                    lease_token=lease_token,
                    now=now,
                )
                is None
            )

    repository_backend.run(scenario)
