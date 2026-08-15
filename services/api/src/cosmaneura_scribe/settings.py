from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .audio_keys import versionless_key_id


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="COSMANEURA_SCRIBE_",
        extra="ignore",
    )

    storage_backend: Literal["memory", "azure"] = "memory"
    storage_account_url: AnyHttpUrl | None = None
    storage_container_name: str = Field(default="audio", min_length=3, max_length=63)
    upload_grant_ttl_seconds: int = Field(default=900, ge=60, le=3600)
    managed_identity_client_id: UUID | None = None
    audio_encryption_key_id: AnyHttpUrl | None = None
    audio_assembly_encrypted_temp_directory: Path | None = None
    audio_assembly_max_plaintext_bytes: int = Field(
        default=64 * 1_024 * 1_024,
        ge=1_000_000,
        le=128 * 1_024 * 1_024,
    )

    workflow_authentication_enabled: bool = False
    entra_tenant_id: UUID | None = None
    workflow_api_audience: str | None = Field(default=None, min_length=1)
    trusted_platform_client_id: UUID | None = None

    master_platform_handoff_enabled: bool = False
    master_platform_base_url: AnyHttpUrl | None = None
    master_platform_scope: str | None = None
    master_platform_timeout_seconds: float = Field(default=15, ge=1, le=60)

    repository_backend: Literal["memory", "postgres"] = "memory"
    database_url: SecretStr | None = None
    database_host: str | None = None
    database_port: int = Field(default=5432, ge=1, le=65535)
    database_name: str = Field(default="cosmaneura_scribe", min_length=1, max_length=63)
    database_user: str | None = None
    database_ssl: bool = True
    database_pool_size: int = Field(default=5, ge=1, le=20)
    database_max_overflow: int = Field(default=5, ge=0, le=20)
    database_runtime_principal_name: str | None = None
    database_runtime_principal_object_id: UUID | None = None

    transcription_backend: Literal["none", "azure"] = "none"
    azure_speech_endpoint: AnyHttpUrl | None = None
    azure_speech_max_speakers: int = Field(default=4, ge=2, le=36)

    @model_validator(mode="after")
    def require_azure_settings(self) -> Settings:
        if (
            self.audio_encryption_key_id is not None
            and versionless_key_id(str(self.audio_encryption_key_id)) is None
        ):
            raise ValueError("audio_encryption_key_id must be a versionless Azure Key Vault key ID")
        if self.storage_backend == "azure" and self.storage_account_url is None:
            raise ValueError("storage_account_url is required for the Azure storage backend")
        if self.repository_backend == "postgres" and self.database_url is None:
            if self.database_host is None or self.database_user is None:
                raise ValueError(
                    "database_host and database_user are required for managed-identity PostgreSQL"
                )
        if self.master_platform_handoff_enabled:
            if self.master_platform_base_url is None or self.master_platform_scope is None:
                raise ValueError(
                    "master_platform_base_url and master_platform_scope are required "
                    "when handoff is enabled"
                )
            if not self.master_platform_scope.endswith("/.default"):
                raise ValueError("master_platform_scope must end with /.default")
        if self.workflow_authentication_enabled:
            if (
                self.entra_tenant_id is None
                or self.workflow_api_audience is None
                or self.trusted_platform_client_id is None
            ):
                raise ValueError(
                    "entra_tenant_id, workflow_api_audience, and trusted_platform_client_id "
                    "are required when workflow authentication is enabled"
                )
            try:
                UUID(self.workflow_api_audience)
            except ValueError as exc:
                raise ValueError(
                    "workflow_api_audience must be the v2 API application client ID UUID"
                ) from exc
        if self.transcription_backend == "azure" and self.azure_speech_endpoint is None:
            raise ValueError(
                "azure_speech_endpoint is required when Azure transcription is enabled"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
