from __future__ import annotations

from functools import lru_cache
from typing import Literal
from uuid import UUID

from pydantic import AnyHttpUrl, Field, model_validator
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

    @model_validator(mode="after")
    def require_azure_settings(self) -> Settings:
        if self.storage_backend == "azure" and self.storage_account_url is None:
            raise ValueError("storage_account_url is required for the Azure storage backend")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
