"""Explicit, inactive-by-default configuration for separate capture workers."""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import SettingsConfigDict

from .azure_translation import AzureTranslationProfile
from .settings import Settings
from .speech_private_network import IpNetwork, PrivateSpeechEndpointGuard


class CapturedWorkerSettings(Settings):
    model_config = SettingsConfigDict(
        env_file=None,
        env_prefix="COSMANEURA_SCRIBE_",
        extra="ignore",
        hide_input_in_errors=True,
    )

    captured_worker_enabled: bool = False
    captured_worker_stage: Literal["speech", "translation"] | None = None
    captured_worker_batch_size: int = Field(default=8, ge=1, le=32)
    # Parse separately: malformed diagnostics must never prevent worker startup.
    captured_speech_observation_scope: str | None = Field(default=None, repr=False)
    azure_translation_endpoint: str | None = None
    azure_translation_deployment: str | None = None
    azure_translation_private_endpoint_cidrs: tuple[IpNetwork, ...] = ()

    @model_validator(mode="after")
    def require_worker_bindings(self) -> CapturedWorkerSettings:
        if not self.captured_worker_enabled:
            return self
        stage = self.captured_worker_stage
        principal = (
            self.database_transcription_principal_name
            if stage == "speech"
            else self.database_translation_principal_name
        )
        if (
            stage is None
            or principal is None
            or self.database_user != principal
            or self.repository_backend != "postgres"
            or self.database_url is not None
            or not self.database_ssl
            or self.managed_identity_client_id is None
            or len(self.configured_capture_tenant_ids) != 1
            or self.transcription_job_enabled
            or self.configured_capture_enabled
            or self.external_ingest_admission_enabled
            or self.audio_encryption_key_id is None
        ):
            raise ValueError("captured_worker_bindings_invalid")
        if stage == "speech":
            if (
                self.transcription_backend != "azure"
                or self.storage_backend != "azure"
                or self.audio_assembly_encrypted_temp_directory is None
            ):
                raise ValueError("captured_worker_speech_bindings_invalid")
        else:
            if (
                self.transcription_backend != "none"
                or self.storage_backend != "memory"
                or self.azure_translation_endpoint is None
                or self.azure_translation_deployment is None
            ):
                raise ValueError("captured_worker_translation_bindings_invalid")
            profile = AzureTranslationProfile(
                self.azure_translation_endpoint, self.azure_translation_deployment
            )
            PrivateSpeechEndpointGuard(
                urlsplit(profile.endpoint).hostname or "",
                self.azure_translation_private_endpoint_cidrs,
            )
        return self
