from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import os
import shutil
import tempfile
import wave
from collections import defaultdict
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import UUID

import httpx
from azure.core.credentials_async import AsyncTokenCredential
from azure.core.exceptions import AzureError
from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob.aio import BlobServiceClient
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .audio_keys import (
    KEY_VAULT_SCOPE,
    KeyVaultTokenCredential,
    versioned_key_id,
    versionless_key_id,
)
from .capture_protocol_v1 import (
    AUDIO_CHANNELS,
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_ENVELOPE_BYTES,
    MAX_HEADER_BYTES,
    MEDIA_COMPRESSION_TYPE,
    MEDIA_SAMPLE_WIDTH_BYTES,
    SAMPLE_RATE_HZ,
    capture_channel_additional_data,
    decode_envelope,
)
from .capture_protocol_v1 import EncryptedChunkHeader as EncryptedChunkHeader
from .capture_protocol_v1 import encode_envelope as encode_envelope
from .encrypted_wave_stream import EncryptedAudioTrackReader as EncryptedAudioTrackReader
from .encrypted_wave_stream import EncryptedWaveChunk
from .repository import AudioAssemblyManifest, RepositoryProvider
from .schemas import AudioChunk, AudioUploadGrantRequest, CaptureChannel, SessionAudioKey
from .settings import Settings
from .storage import blob_name
from .transcription import AudioTrack
from .transcription_worker import AudioAssemblyRequest

DEFAULT_MAXIMUM_PLAINTEXT_BYTES = MAX_AGGREGATE_PLAINTEXT_BYTES


class AudioAssemblyError(RuntimeError):
    """Fixed-code error safe for metadata-only operational logs."""


class BlobObjectReader(Protocol):
    async def read(self, request: AudioAssemblyRequest, chunk: AudioChunk) -> bytes: ...

    async def close(self) -> None: ...


class SessionKeyUnwrapper(Protocol):
    async def unwrap(self, audio_key: SessionAudioKey) -> bytearray: ...

    async def close(self) -> None: ...


class AudioAssemblyManifestProvider(Protocol):
    async def resolve(self, request: AudioAssemblyRequest) -> AudioAssemblyManifest | None: ...


class RepositoryAudioAssemblyManifestProvider:
    def __init__(self, repositories: RepositoryProvider) -> None:
        self._repositories = repositories

    async def resolve(self, request: AudioAssemblyRequest) -> AudioAssemblyManifest | None:
        async with self._repositories.transaction(request.tenant_id) as store:
            return await store.get_audio_assembly_manifest(
                request.tenant_id,
                request.session_id,
                job_id=request.job_id,
                lease_token=request.lease_token,
                now=datetime.now(UTC),
            )


class AzureBlobObjectReader:
    def __init__(
        self,
        *,
        account_url: str,
        container_name: str,
        credential: AsyncTokenCredential,
        client: BlobServiceClient | None = None,
    ) -> None:
        self._container_name = container_name
        self._credential = credential
        self._client = client or BlobServiceClient(
            account_url=account_url,
            credential=credential,
            # Object names live in the blob URL path; never hand them to the SDK logger.
            logging_enable=False,
        )

    async def read(self, request: AudioAssemblyRequest, chunk: AudioChunk) -> bytes:
        object_name = blob_name(
            request.tenant_id,
            request.session_id,
            chunk.object_id,
            AudioUploadGrantRequest(
                sequence_number=chunk.sequence_number,
                channel=chunk.channel,
            ),
        )
        try:
            downloader = await self._client.get_blob_client(
                container=self._container_name,
                blob=object_name,
            ).download_blob(
                offset=0,
                length=chunk.ciphertext_size_bytes + 1,
                max_concurrency=1,
            )
            return await downloader.readall()
        except AzureError:
            raise AudioAssemblyError("audio_blob_unavailable") from None

    async def close(self) -> None:
        await self._client.close()
        await self._credential.close()


class KeyVaultSessionKeyUnwrapper:
    def __init__(
        self,
        *,
        configured_key_id: str,
        credential: KeyVaultTokenCredential,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        normalized_key_id = versionless_key_id(configured_key_id)
        if normalized_key_id is None:
            raise ValueError("configured_key_id must be a versionless Azure Key Vault key ID")
        self._configured_key_id = normalized_key_id
        self._credential = credential
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=15,
            trust_env=False,
            follow_redirects=False,
        )

    async def unwrap(self, audio_key: SessionAudioKey) -> bytearray:
        authorized_key_id = versioned_key_id(
            self._configured_key_id,
            audio_key.key_version,
        )
        if authorized_key_id is None:
            raise AudioAssemblyError("audio_key_not_authorized")
        try:
            wrapped_dek = _base64url_decode(audio_key.wrapped_dek)
        except ValueError:
            raise AudioAssemblyError("audio_wrapped_key_invalid") from None
        if len(wrapped_dek) != 384:
            raise AudioAssemblyError("audio_wrapped_key_invalid")
        try:
            token = await self._credential.get_token(KEY_VAULT_SCOPE)
            response = await self._client.post(
                f"{authorized_key_id}/unwrapkey",
                params={"api-version": "7.4"},
                headers={"Authorization": f"Bearer {token.token}"},
                json={
                    "alg": "RSA-OAEP-256",
                    "value": _base64url_encode(wrapped_dek),
                },
            )
        except (AzureError, httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError):
            raise AudioAssemblyError("audio_key_unwrap_unavailable") from None
        if response.status_code != 200:
            raise AudioAssemblyError("audio_key_unwrap_rejected")
        try:
            payload = response.json()
            encoded_key = payload["value"]
            if not isinstance(encoded_key, str):
                raise ValueError
            content_key = bytearray(_base64url_decode(encoded_key))
        except (KeyError, TypeError, ValueError):
            raise AudioAssemblyError("audio_key_unwrap_invalid_response") from None
        if len(content_key) != 32:
            _zero(content_key)
            raise AudioAssemblyError("audio_key_invalid")
        return content_key

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
        await self._credential.close()


@dataclass(frozen=True)
class _WaveFormat:
    channels: int
    sample_width: int
    frame_rate: int
    compression_type: str


ACCEPTED_WAVE_FORMAT = _WaveFormat(
    channels=AUDIO_CHANNELS,
    sample_width=MEDIA_SAMPLE_WIDTH_BYTES,
    frame_rate=SAMPLE_RATE_HZ,
    compression_type=MEDIA_COMPRESSION_TYPE,
)


class EncryptedBlobAudioTrackAssembler:
    def __init__(
        self,
        *,
        manifests: AudioAssemblyManifestProvider,
        reader: BlobObjectReader,
        key_unwrapper: SessionKeyUnwrapper,
        maximum_plaintext_bytes: int = DEFAULT_MAXIMUM_PLAINTEXT_BYTES,
        temporary_directory: Path,
    ) -> None:
        self._manifests = manifests
        self._reader = reader
        self._key_unwrapper = key_unwrapper
        self._maximum_plaintext_bytes = maximum_plaintext_bytes
        self._temporary_directory = temporary_directory

    @asynccontextmanager
    async def assemble(
        self,
        request: AudioAssemblyRequest,
    ) -> AsyncGenerator[tuple[AudioTrack, ...]]:
        directory: Path | None = None
        track_readers: list[EncryptedAudioTrackReader] = []
        try:
            manifest = await self._manifests.resolve(request)
            if manifest is None or manifest.chunks != request.chunks:
                raise AudioAssemblyError("audio_assembly_not_authorized")
            self._validate_resource_limits(manifest)
            grouped = self._validate_and_group(request, manifest)
            content_key = await self._key_unwrapper.unwrap(manifest.audio_key)
            try:
                directory = Path(
                    tempfile.mkdtemp(
                        prefix="cosmaneura-scribe-assembly-",
                        dir=self._temporary_directory,
                    )
                )
                os.chmod(directory, 0o700)
                tracks = await self._assemble_tracks(
                    request,
                    grouped,
                    content_key,
                    directory,
                    track_readers,
                )
            finally:
                _zero(content_key)
            yield tracks
        except AudioAssemblyError:
            raise
        except Exception:
            raise AudioAssemblyError("audio_assembly_unavailable") from None
        finally:
            for reader in track_readers:
                reader.close()
            if directory is not None:
                await _cleanup_without_cancellation(directory)

    async def _assemble_tracks(
        self,
        request: AudioAssemblyRequest,
        grouped: dict[CaptureChannel, list[AudioChunk]],
        content_key: bytearray,
        directory: Path,
        track_readers: list[EncryptedAudioTrackReader],
    ) -> tuple[AudioTrack, ...]:
        tracks: list[AudioTrack] = []
        total_plaintext_bytes = 0
        seen_nonces: set[bytes] = set()
        decryptor = AESGCM(bytes(content_key))
        for channel in CaptureChannel:
            chunks = grouped.get(channel)
            if chunks is None:
                continue
            encrypted_path = directory / f"track-{len(tracks):02d}.enc"
            index: list[EncryptedWaveChunk] = []
            descriptor = os.open(encrypted_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb", closefd=False) as destination:
                    for chunk in chunks:
                        envelope = await self._reader.read(request, chunk)
                        self._verify_ciphertext(chunk, envelope)
                        try:
                            header, ciphertext = decode_envelope(envelope)
                            nonce = _base64url_decode(header.nonce)
                        except ValueError:
                            raise AudioAssemblyError("audio_envelope_invalid") from None
                        if len(nonce) != 12 or nonce in seen_nonces:
                            raise AudioAssemblyError("audio_nonce_invalid")
                        seen_nonces.add(nonce)
                        aad = chunk_additional_data(request, chunk)
                        try:
                            plaintext = bytearray(decryptor.decrypt(nonce, ciphertext, aad))
                        except InvalidTag:
                            raise AudioAssemblyError("audio_decryption_failed") from None
                        try:
                            total_plaintext_bytes += len(plaintext)
                            if total_plaintext_bytes > self._maximum_plaintext_bytes:
                                raise AudioAssemblyError("audio_plaintext_limit_exceeded")
                            pcm_offset, pcm_size = _wave_layout(plaintext)
                            index.append(EncryptedWaveChunk(
                                envelope_offset=destination.tell(), envelope_size=len(envelope),
                                sha256=chunk.sha256, nonce=nonce, additional_data=aad,
                                pcm_offset=pcm_offset, pcm_size=pcm_size,
                            ))
                            # Reuse capture encryption; no new file codec or nonce.
                            destination.write(envelope)
                        finally:
                            _zero(plaintext)
                    destination.flush()
                    os.fsync(destination.fileno())
            finally:
                os.close(descriptor)
            track_reader = EncryptedAudioTrackReader(
                path=encrypted_path, key=bytearray(content_key), chunks=tuple(index),
            )
            track_readers.append(track_reader)
            tracks.append(AudioTrack(
                object_id=chunks[0].object_id, channel=channel,
                local_path=encrypted_path, reader=track_reader,
            ))
        if not tracks:
            raise AudioAssemblyError("audio_chunks_missing")
        return tuple(tracks)

    @staticmethod
    def _validate_and_group(
        request: AudioAssemblyRequest,
        manifest: AudioAssemblyManifest,
    ) -> dict[CaptureChannel, list[AudioChunk]]:
        grouped: dict[CaptureChannel, list[AudioChunk]] = defaultdict(list)
        seen_objects: set[UUID] = set()
        seen_positions: set[tuple[CaptureChannel, int]] = set()
        for chunk in manifest.chunks:
            if chunk.session_id != request.session_id:
                raise AudioAssemblyError("audio_chunk_scope_invalid")
            position = (chunk.channel, chunk.sequence_number)
            if chunk.object_id in seen_objects or position in seen_positions:
                raise AudioAssemblyError("audio_chunk_sequence_invalid")
            seen_objects.add(chunk.object_id)
            seen_positions.add(position)
            grouped[chunk.channel].append(chunk)
        for chunks in grouped.values():
            chunks.sort(key=lambda chunk: chunk.sequence_number)
            if [chunk.sequence_number for chunk in chunks] != list(range(len(chunks))):
                raise AudioAssemblyError("audio_chunk_sequence_invalid")
        return dict(grouped)

    def _validate_resource_limits(self, manifest: AudioAssemblyManifest) -> None:
        if not manifest.chunks or len(manifest.chunks) > MAX_CHUNKS:
            raise AudioAssemblyError("audio_chunk_limit_exceeded")
        if any(chunk.ciphertext_size_bytes > MAX_ENVELOPE_BYTES for chunk in manifest.chunks):
            raise AudioAssemblyError("audio_ciphertext_limit_exceeded")
        envelope_allowance = len(manifest.chunks) * (MAX_HEADER_BYTES + 128)
        if sum(chunk.ciphertext_size_bytes for chunk in manifest.chunks) > (
            self._maximum_plaintext_bytes + envelope_allowance
        ):
            raise AudioAssemblyError("audio_ciphertext_limit_exceeded")

    @staticmethod
    def _verify_ciphertext(chunk: AudioChunk, envelope: bytes) -> None:
        if len(envelope) != chunk.ciphertext_size_bytes:
            raise AudioAssemblyError("audio_ciphertext_size_mismatch")
        actual = hashlib.sha256(envelope).hexdigest()
        if not hmac.compare_digest(actual.casefold(), chunk.sha256.casefold()):
            raise AudioAssemblyError("audio_ciphertext_digest_mismatch")

    async def close(self) -> None:
        await self._reader.close()
        await self._key_unwrapper.close()


def chunk_additional_data(request: AudioAssemblyRequest, chunk: AudioChunk) -> bytes:
    return capture_channel_additional_data(
        tenant_id=request.tenant_id,
        session_id=request.session_id,
        object_id=chunk.object_id,
        sequence_number=chunk.sequence_number,
        channel=chunk.channel.value,
    )


def _wave_layout(value: bytearray) -> tuple[int, int]:
    try:
        with io.BytesIO(value) as buffer, wave.open(buffer, "rb") as source:
            current = _WaveFormat(
                channels=source.getnchannels(), sample_width=source.getsampwidth(),
                frame_rate=source.getframerate(), compression_type=source.getcomptype(),
            )
            if current != ACCEPTED_WAVE_FORMAT:
                raise AudioAssemblyError("audio_wave_media_profile_unsupported")
            offset = buffer.tell()
            size = source.getnframes() * AUDIO_CHANNELS * MEDIA_SAMPLE_WIDTH_BYTES
            # Detect truncated/odd PCM rather than quietly shortening the visit.
            if size == 0 or len(source.readframes(source.getnframes() + 1)) != size:
                raise AudioAssemblyError("audio_wave_invalid")
            return offset, size
    except (EOFError, wave.Error):
        raise AudioAssemblyError("audio_wave_invalid") from None


async def _cleanup_without_cancellation(directory: Path) -> None:
    task = asyncio.create_task(asyncio.to_thread(_secure_cleanup_directory, directory))
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


def _secure_cleanup_directory(directory: Path) -> None:
    try:
        for path in directory.iterdir():
            if not path.is_file() or path.is_symlink():
                continue
            try:
                size = path.stat().st_size
                with path.open("r+b", buffering=0) as value:
                    remaining = size
                    block = b"\x00" * min(1_048_576, max(1, size))
                    while remaining:
                        length = min(remaining, len(block))
                        value.write(block[:length])
                        remaining -= length
                    value.flush()
                    os.fsync(value.fileno())
            except OSError:
                pass
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def _zero(value: bytearray) -> None:
    value[:] = b"\x00" * len(value)


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (ValueError, TypeError):
        raise ValueError("invalid base64url") from None


def build_audio_track_assembler(
    settings: Settings,
    repositories: RepositoryProvider,
) -> EncryptedBlobAudioTrackAssembler:
    if settings.storage_backend != "azure" or settings.storage_account_url is None:
        raise ValueError("encrypted Blob assembly requires the Azure storage backend")
    if settings.audio_encryption_key_id is None:
        raise ValueError("audio_encryption_key_id is required for encrypted Blob assembly")
    temporary_directory = settings.audio_assembly_encrypted_temp_directory
    if temporary_directory is None:
        raise ValueError("audio_assembly_encrypted_temp_directory is required")
    if not temporary_directory.is_dir() or temporary_directory.is_symlink():
        raise ValueError("audio assembly temporary directory must be a real directory")
    managed_identity_client_id = (
        str(settings.managed_identity_client_id)
        if settings.managed_identity_client_id is not None
        else None
    )
    blob_credential = DefaultAzureCredential(
        managed_identity_client_id=managed_identity_client_id,
        require_envvar=False,
    )
    key_credential = DefaultAzureCredential(
        managed_identity_client_id=managed_identity_client_id,
        require_envvar=False,
    )
    return EncryptedBlobAudioTrackAssembler(
        manifests=RepositoryAudioAssemblyManifestProvider(repositories),
        reader=AzureBlobObjectReader(
            account_url=str(settings.storage_account_url),
            container_name=settings.storage_container_name,
            credential=blob_credential,
        ),
        key_unwrapper=KeyVaultSessionKeyUnwrapper(
            configured_key_id=str(settings.audio_encryption_key_id),
            credential=key_credential,
        ),
        maximum_plaintext_bytes=settings.audio_assembly_max_plaintext_bytes,
        temporary_directory=temporary_directory,
    )
