from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Protocol
from urllib.parse import quote
from uuid import UUID

from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob import BlobSasPermissions, generate_blob_sas
from azure.storage.blob.aio import BlobServiceClient

from .schemas import AudioUploadGrant, AudioUploadGrantRequest
from .settings import Settings


class AudioStorage(Protocol):
    async def issue_upload_grant(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
        request: AudioUploadGrantRequest,
        expires_at: datetime | None = None,
    ) -> AudioUploadGrant: ...

    async def close(self) -> None: ...


class InMemoryAudioStorage:
    def __init__(self, settings: Settings) -> None:
        self._ttl = timedelta(seconds=settings.upload_grant_ttl_seconds)

    async def issue_upload_grant(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
        request: AudioUploadGrantRequest,
        expires_at: datetime | None = None,
    ) -> AudioUploadGrant:
        expires_at = expires_at or datetime.now(UTC) + self._ttl
        path = _blob_name(tenant_id, session_id, object_id, request)
        return AudioUploadGrant(
            object_id=object_id,
            session_id=session_id,
            sequence_number=request.sequence_number,
            channel=request.channel,
            upload_url=f"https://storage.invalid/{quote(path)}?development-grant=true",
            expires_at=expires_at,
        )

    async def close(self) -> None:
        return None


class AzureBlobAudioStorage:
    def __init__(self, settings: Settings) -> None:
        if settings.storage_account_url is None:
            raise ValueError("Azure storage requires a storage account URL")
        account_host = settings.storage_account_url.host
        if not account_host:
            raise ValueError("Azure storage account URL must include a host")
        self._account_name = account_host.partition(".")[0]
        managed_identity_client_id = (
            str(settings.managed_identity_client_id)
            if settings.managed_identity_client_id is not None
            else None
        )
        self._credential = DefaultAzureCredential(
            managed_identity_client_id=managed_identity_client_id,
            require_envvar=False,
        )
        self._client = BlobServiceClient(
            account_url=str(settings.storage_account_url),
            credential=self._credential,
        )
        self._container_name = settings.storage_container_name
        self._ttl = timedelta(seconds=settings.upload_grant_ttl_seconds)

    async def issue_upload_grant(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
        request: AudioUploadGrantRequest,
        expires_at: datetime | None = None,
    ) -> AudioUploadGrant:
        now = datetime.now(UTC)
        expires_at = expires_at or now + self._ttl
        delegation_key = await self._client.get_user_delegation_key(
            key_start_time=now - timedelta(minutes=5),
            key_expiry_time=expires_at,
        )
        blob_name = _blob_name(tenant_id, session_id, object_id, request)
        sas = generate_blob_sas(
            account_name=self._account_name,
            container_name=self._container_name,
            blob_name=blob_name,
            user_delegation_key=delegation_key,
            permission=BlobSasPermissions(create=True, write=True),
            start=now - timedelta(minutes=5),
            expiry=expires_at,
        )
        blob_url = self._client.get_blob_client(
            container=self._container_name,
            blob=blob_name,
        ).url
        return AudioUploadGrant(
            object_id=object_id,
            session_id=session_id,
            sequence_number=request.sequence_number,
            channel=request.channel,
            upload_url=f"{blob_url}?{sas}",
            expires_at=expires_at,
        )

    async def close(self) -> None:
        await self._client.close()
        await self._credential.close()


def build_audio_storage(settings: Settings) -> AudioStorage:
    if settings.storage_backend == "azure":
        return AzureBlobAudioStorage(settings)
    return InMemoryAudioStorage(settings)


def _blob_name(
    tenant_id: UUID,
    session_id: UUID,
    object_id: UUID,
    request: AudioUploadGrantRequest,
) -> str:
    return (
        f"tenants/{tenant_id}/sessions/{session_id}/{request.channel.value}/"
        f"{request.sequence_number:08d}-{object_id}.enc"
    )
