from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
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
    EncryptedChunkHeader,
    KeyVaultSessionKeyUnwrapper,
    chunk_additional_data,
    encode_envelope,
)
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


def _wave_bytes(frames: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(frames)
    return output.getvalue()


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
        nonce=b"n" * 12,
        additional_data=b"metadata",
    )

    assert str(sensitive_path) not in repr(reader)


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
