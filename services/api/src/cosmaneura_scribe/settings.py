from __future__ import annotations

from functools import lru_cache
from typing import Literal
from uuid import UUID

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    @model_validator(mode="after")
    def require_azure_settings(self) -> Settings:
        if self.storage_backend == "azure" and self.storage_account_url is None:
            raise ValueError("storage_account_url is required for the Azure storage backend")
        if self.repository_backend == "postgres" and self.database_url is None:
            if self.database_host is None or self.database_user is None:
                raise ValueError(
                    "database_host and database_user are required for managed-identity PostgreSQL"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
