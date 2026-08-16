from __future__ import annotations

from functools import lru_cache
from ipaddress import IPv4Network, IPv6Network
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .audio_keys import versionless_key_id

_PRIVATE_API_IPV4_NETWORKS = (
    IPv4Network("10.0.0.0/8"),
    IPv4Network("172.16.0.0/12"),
    IPv4Network("192.168.0.0/16"),
)


def _is_exact_azure_speech_endpoint(value: AnyHttpUrl) -> bool:
    parsed = urlsplit(str(value))
    hostname = parsed.hostname
    if hostname is None:
        return False
    suffix = ".cognitiveservices.azure.com"
    account_name = hostname.casefold().removesuffix(suffix)
    return (
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and parsed.port is None
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
        and hostname.casefold() == f"{account_name}{suffix}"
        and account_name.isascii()
        and 1 <= len(account_name) <= 64
        and account_name[0].isalnum()
        and account_name[-1].isalnum()
        and all(character.isalnum() or character == "-" for character in account_name)
    )


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
    private_api_acceptance_enabled: bool = False
    private_api_acceptance_invocation_enabled: bool = False
    private_api_acceptance_base_url: AnyHttpUrl | None = None
    private_api_acceptance_tenant_id: UUID | None = None
    private_api_acceptance_private_endpoint_cidrs: tuple[IPv4Network | IPv6Network, ...] = ()
    private_api_acceptance_timeout_seconds: float = Field(default=15, ge=1, le=60)

    master_platform_handoff_enabled: bool = False
    master_platform_base_url: AnyHttpUrl | None = None
    master_platform_scope: str | None = None
    master_platform_timeout_seconds: float = Field(default=15, ge=1, le=60)
    delivery_pending_timeout_seconds: int = Field(default=300, ge=30, le=86_400)
    delivery_retry_delay_seconds: int = Field(default=60, ge=1, le=86_400)
    delivery_reconciler_max_deliveries: int = Field(default=25, ge=1, le=100)
    delivery_reconciler_job_enabled: bool = False

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
    database_transcription_principal_name: str | None = None
    database_transcription_principal_object_id: UUID | None = None
    database_delivery_reconciler_principal_name: str | None = None
    database_delivery_reconciler_principal_object_id: UUID | None = None

    transcription_backend: Literal["none", "azure"] = "none"
    azure_speech_endpoint: AnyHttpUrl | None = None
    azure_speech_private_endpoint_cidrs: tuple[IPv4Network | IPv6Network, ...] = ()
    azure_speech_max_speakers: int = Field(default=4, ge=2, le=36)
    speech_smoke_enabled: bool = False
    transcription_job_enabled: bool = False
    transcription_job_language_code: str = Field(
        default="en-US",
        min_length=2,
        max_length=16,
        pattern=r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$",
    )

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
        if (self.database_transcription_principal_name is None) != (
            self.database_transcription_principal_object_id is None
        ):
            raise ValueError(
                "database_transcription_principal_name and "
                "database_transcription_principal_object_id must be configured together"
            )
        if self.database_transcription_principal_name is not None:
            if (
                self.database_transcription_principal_name == self.database_runtime_principal_name
                or self.database_transcription_principal_object_id
                == self.database_runtime_principal_object_id
            ):
                raise ValueError(
                    "the transcription database principal must be distinct from the runtime"
                )
        if (self.database_delivery_reconciler_principal_name is None) != (
            self.database_delivery_reconciler_principal_object_id is None
        ):
            raise ValueError(
                "database_delivery_reconciler_principal_name and "
                "database_delivery_reconciler_principal_object_id must be configured together"
            )
        if self.database_delivery_reconciler_principal_name is not None:
            principal_names = {
                self.database_runtime_principal_name,
                self.database_transcription_principal_name,
            }
            principal_object_ids = {
                self.database_runtime_principal_object_id,
                self.database_transcription_principal_object_id,
            }
            if (
                self.database_delivery_reconciler_principal_name in principal_names
                or self.database_delivery_reconciler_principal_object_id in principal_object_ids
            ):
                raise ValueError(
                    "the delivery reconciler database principal must be distinct from other roles"
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
        if (
            self.private_api_acceptance_invocation_enabled
            and not self.private_api_acceptance_enabled
        ):
            raise ValueError(
                "private_api_acceptance_invocation_enabled requires private_api_acceptance_enabled"
            )
        if self.private_api_acceptance_enabled:
            if (
                self.private_api_acceptance_base_url is None
                or self.private_api_acceptance_tenant_id is None
                or self.private_api_acceptance_tenant_id.int == 0
                or self.managed_identity_client_id is None
                or self.workflow_api_audience is None
                or not self.private_api_acceptance_private_endpoint_cidrs
            ):
                raise ValueError(
                    "private API acceptance requires its base URL, nonzero synthetic tenant, "
                    "private address, managed identity client ID, and workflow API audience"
                )
            parsed_acceptance_url = urlsplit(str(self.private_api_acceptance_base_url))
            if (
                parsed_acceptance_url.scheme != "https"
                or parsed_acceptance_url.username is not None
                or parsed_acceptance_url.password is not None
                or parsed_acceptance_url.port is not None
                or parsed_acceptance_url.path not in {"", "/"}
                or parsed_acceptance_url.query
                or parsed_acceptance_url.fragment
            ):
                raise ValueError("private_api_acceptance_base_url must be an exact HTTPS origin")
            try:
                UUID(self.workflow_api_audience)
            except ValueError as exc:
                raise ValueError(
                    "private API acceptance requires the bare workflow API client ID UUID"
                ) from exc
            acceptance_networks = self.private_api_acceptance_private_endpoint_cidrs
            if (
                len(acceptance_networks) != 1
                or not isinstance(acceptance_networks[0], IPv4Network)
                or acceptance_networks[0].prefixlen != 32
                or not any(
                    acceptance_networks[0].subnet_of(private_network)
                    for private_network in _PRIVATE_API_IPV4_NETWORKS
                )
            ):
                raise ValueError(
                    "private API acceptance requires one exact private environment host CIDR"
                )
        if self.transcription_backend == "azure":
            if self.azure_speech_endpoint is None:
                raise ValueError(
                    "azure_speech_endpoint is required when Azure transcription is enabled"
                )
            if not _is_exact_azure_speech_endpoint(self.azure_speech_endpoint):
                raise ValueError(
                    "azure_speech_endpoint must be an exact Azure Cognitive Services HTTPS origin"
                )
            if not self.azure_speech_private_endpoint_cidrs:
                raise ValueError(
                    "azure_speech_private_endpoint_cidrs are required when Azure "
                    "transcription is enabled"
                )
        if self.transcription_job_enabled:
            if self.repository_backend != "postgres":
                raise ValueError("the transcription job requires the PostgreSQL repository")
            if self.storage_backend != "azure":
                raise ValueError("the transcription job requires the Azure storage backend")
            if self.transcription_backend != "azure":
                raise ValueError("the transcription job requires the Azure transcription backend")
            if self.managed_identity_client_id is None:
                raise ValueError("managed_identity_client_id is required for the transcription job")
            if self.audio_encryption_key_id is None:
                raise ValueError("audio_encryption_key_id is required for the transcription job")
            if self.audio_assembly_encrypted_temp_directory is None:
                raise ValueError(
                    "audio_assembly_encrypted_temp_directory is required for the transcription job"
                )
        if self.delivery_reconciler_job_enabled:
            if self.repository_backend != "postgres":
                raise ValueError("the delivery reconciler job requires the PostgreSQL repository")
            if not self.master_platform_handoff_enabled:
                raise ValueError("the delivery reconciler job requires master platform handoff")
            if self.managed_identity_client_id is None:
                raise ValueError(
                    "managed_identity_client_id is required for the delivery reconciler job"
                )
        if self.speech_smoke_enabled:
            if self.transcription_backend != "azure":
                raise ValueError("the Speech smoke job requires the Azure transcription backend")
            if self.managed_identity_client_id is None:
                raise ValueError("managed_identity_client_id is required for the Speech smoke job")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
