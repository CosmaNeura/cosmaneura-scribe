"""Fixed loopback Scribe child for the existing Core API/worker containers."""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import uvicorn
from cosmaneura_scribe.captured_worker_settings import CapturedWorkerSettings
from cosmaneura_scribe.core_ai_network import CORE_POSTGRES_HOST
from cosmaneura_scribe.safe_logging import configure_private_api_acceptance_logging
from cosmaneura_scribe.settings import Settings
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import SettingsConfigDict
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

API_CONFIGURATION = "SCRIBE_BUNDLE_API_CONFIGURATION_JSON"
WORKER_CONFIGURATION = "SCRIBE_BUNDLE_WORKER_CONFIGURATION_JSON"
RUNTIME_ROOT = Path("/opt/scribe")
RUNTIME_PORT = 8021
KEY_ID = "https://cosmaneura-scribe-prod.vault.azure.net/keys/session-audio-wrapping"
BLOB_ORIGIN = "https://cosmaneurascribeprod.blob.core.windows.net/"
API_CLIENT_ID = UUID("c7bae168-fbf5-4658-b0d9-dd4b5373a1be")
SPEECH_CLIENT_ID = UUID("5696041c-ee89-4ef5-bc5d-fdf846cd7364")
TRANSLATION_CLIENT_ID = UUID("39d00a14-ca79-4cbf-8821-3e2af90ea0e2")
_PRINCIPALS = {
    "api": ("cosmaneura-prod-scribe-workflow", UUID("8fecefc9-1577-4afa-b353-83beb5f793f7")),
    "speech": ("cosmaneura-prod-health-services", UUID("36cc13e3-293b-45a6-9819-4cee01458de6")),
    "translation": (
        "cosmaneura-scribe-production-runtime",
        UUID("3f712a80-f393-49d0-ab42-6a40bc50dfbd"),
    ),
}
WORKER_TEMP = RUNTIME_ROOT / "encrypted-audio"


class BundleAPISettings(Settings):
    model_config = SettingsConfigDict(
        env_file=None, env_prefix="COSMANEURA_SCRIBE_", extra="ignore"
    )


_PROFILES = {
    "api": BundleAPISettings,
    "speech": CapturedWorkerSettings,
    "translation": CapturedWorkerSettings,
}


class BundleUnavailable(RuntimeError):
    """One fixed failure code; no configuration/provider diagnostics."""


class BundleConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    schema_version: Literal[1]
    enabled: bool = False
    environment: dict[str, str] = Field(default_factory=dict)


def load_environment(
    raw: str, profile: Literal["api", "speech", "translation"]
) -> dict[str, str] | None:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError
            result[key] = value
        return result

    try:
        if not raw or len(raw.encode()) > 32_768:
            raise ValueError
        configuration = BundleConfiguration.model_validate(
            json.loads(raw, object_pairs_hook=unique)
        )
        if not configuration.enabled:
            if configuration.environment:
                raise ValueError
            return None
        model = _PROFILES[profile]
        allowed = {
            "COSMANEURA_SCRIBE_" + key.upper()
            for key in model.model_fields
            if key != "database_url"
        }
        if set(configuration.environment) - allowed:
            raise ValueError
        # BaseSettings parses JSON collection environment values, not constructor
        # strings. Use its environment source under the fixed isolated child only.
        prior = dict(os.environ)
        try:
            for key in tuple(os.environ):
                if key.startswith("COSMANEURA_SCRIBE_"):
                    del os.environ[key]
            os.environ.update(configuration.environment)
            settings = model()
        finally:
            os.environ.clear()
            os.environ.update(prior)
        expected_client = {
            "api": API_CLIENT_ID,
            "speech": SPEECH_CLIENT_ID,
            "translation": TRANSLATION_CLIENT_ID,
        }[profile]
        principal, principal_id = _PRINCIPALS[profile]
        selected_name = (
            settings.database_runtime_principal_name
            if profile == "api"
            else settings.database_transcription_principal_name
            if profile == "speech"
            else settings.database_translation_principal_name
        )
        selected_id = (
            settings.database_runtime_principal_object_id
            if profile == "api"
            else settings.database_transcription_principal_object_id
            if profile == "speech"
            else settings.database_translation_principal_object_id
        )
        if (
            settings.repository_backend != "postgres"
            or settings.database_url is not None
            or settings.database_host != CORE_POSTGRES_HOST
            or settings.database_name != "cosmaneura_scribe"
            or not settings.database_ssl
            or settings.managed_identity_client_id != expected_client
            or str(settings.audio_encryption_key_id) != KEY_ID
            or settings.database_pool_size != (2 if profile == "api" else 1)
            or settings.database_max_overflow != 0
            or settings.database_user != principal
            or selected_name != principal
            or selected_id != principal_id
        ):
            raise ValueError
        if profile == "api":
            if (
                not settings.workflow_authentication_enabled
                or settings.transcription_backend != "none"
                or settings.transcription_job_enabled
                or settings.trusted_platform_client_id != API_CLIENT_ID
                or settings.entra_tenant_id is None
                or settings.entra_tenant_id.int == 0
                or settings.workflow_api_audience is None
                or UUID(settings.workflow_api_audience).int == 0
            ):
                raise ValueError
        else:
            if (
                not isinstance(settings, CapturedWorkerSettings)
                or not settings.captured_worker_enabled
                or settings.captured_worker_stage != profile
                or not settings.existing_core_public_ai_enabled
                or settings.captured_worker_batch_size != 1
            ):
                raise ValueError
        if profile in {"api", "speech"} and (
            settings.storage_backend != "azure"
            or str(settings.storage_account_url) != BLOB_ORIGIN
            or settings.storage_container_name != "audio"
        ):
            raise ValueError
        if profile == "speech" and settings.audio_assembly_encrypted_temp_directory != WORKER_TEMP:
            raise ValueError
        return configuration.environment | {"AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential"}
    except Exception:
        raise BundleUnavailable("scribe_core_bundle_configuration_unavailable") from None


@asynccontextmanager
async def _running(app: ASGIApp):
    incoming: asyncio.Queue[Message] = asyncio.Queue()
    outgoing: asyncio.Queue[Message] = asyncio.Queue()

    async def invoke() -> None:
        await app(
            {"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}},
            incoming.get,
            outgoing.put,
        )

    task = asyncio.create_task(invoke())
    try:
        await incoming.put({"type": "lifespan.startup"})
        message = await asyncio.wait_for(outgoing.get(), 15)
        if message.get("type") != "lifespan.startup.complete":
            raise BundleUnavailable("scribe_core_bundle_startup_unavailable")
        yield
        await incoming.put({"type": "lifespan.shutdown"})
        message = await asyncio.wait_for(outgoing.get(), 15)
        if message.get("type") != "lifespan.shutdown.complete":
            raise BundleUnavailable("scribe_core_bundle_shutdown_unavailable")
        await task
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


class ScribeChild:
    def __init__(self, api: ASGIApp | None, receiver: ASGIApp):
        self.api, self.receiver = api, receiver

        @asynccontextmanager
        async def lifespan(_: FastAPI):
            async with AsyncExitStack() as stack:
                if api is not None:
                    await stack.enter_async_context(_running(api))
                await stack.enter_async_context(_running(receiver))
                yield

        self.lifecycle = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.lifecycle(scope, receive, send)
        elif (
            scope["type"] == "http"
            and scope.get("path") == "/__core_bundle_health"
            and scope.get("method") == "GET"
        ):
            await Response(status_code=204, headers={"Cache-Control": "no-store"})(
                scope, receive, send
            )
        elif scope.get("path", "").startswith("/provider/v1/"):
            await self.receiver(scope, receive, send)
        elif self.api is not None and scope.get("path", "").startswith("/v1/"):
            await self.api(scope, receive, send)
        else:
            await Response(status_code=404, headers={"Cache-Control": "no-store"})(
                scope, receive, send
            )


def api_main() -> None:
    # Imports are deliberately local. Disabled profiles cannot initialize a
    # registry, PostgreSQL provider, identity verifier or production SDK client.
    from image_entrypoint import CONFIGURATION_PATH, materialize_configuration, provider_environment
    from receiver_runtime import ReceiverService, load_configuration

    try:
        if os.geteuid() != 10001 or os.getegid() != 10001:
            raise ValueError
        environment = load_environment(os.environ.pop(API_CONFIGURATION, ""), "api")
        configuration, contract = provider_environment(os.environb)
        materialize_configuration(configuration, contract)
        for name in tuple(os.environ):
            if name.startswith("COSMANEURA_SCRIBE_PROVIDER_"):
                del os.environ[name]
        receiver_config = load_configuration(CONFIGURATION_PATH)
        if receiver_config.authority_backend != "core-provider-context-v1":
            raise ValueError
        api = None
        if environment is not None:
            os.environ.update(environment)
            from cosmaneura_scribe.main import app

            api = app
        configure_private_api_acceptance_logging()
        uvicorn.run(
            ScribeChild(api, ReceiverService(CONFIGURATION_PATH)),
            host="127.0.0.1",
            port=RUNTIME_PORT,
            proxy_headers=False,
            forwarded_allow_ips="",
            access_log=False,
            server_header=False,
            log_level="warning",
            log_config=None,
        )
    except Exception:
        raise BundleUnavailable("scribe_core_bundle_startup_unavailable") from None


def worker_main(stage: Literal["speech", "translation"]) -> None:
    try:
        if os.geteuid() != 10001 or os.getegid() != 10001:
            raise ValueError
        environment = load_environment(os.environ.pop(WORKER_CONFIGURATION, ""), stage)
        if environment is None:
            return
        os.environ.update(environment)
        settings = CapturedWorkerSettings()
        if stage == "speech":
            WORKER_TEMP.mkdir(mode=0o700, exist_ok=True)
            if (
                WORKER_TEMP.is_symlink()
                or not WORKER_TEMP.is_dir()
                or WORKER_TEMP.stat().st_uid != os.getuid()
                or WORKER_TEMP.stat().st_mode & 0o077
            ):
                raise ValueError
        from cosmaneura_scribe.captured_worker_job_runner import run_captured_worker
        from cosmaneura_scribe.transcription_job_runner import run_job_with_signal_cancellation

        tenant = next(iter(settings.configured_capture_tenant_ids))

        async def run() -> bool:
            return await run_captured_worker(arguments=[str(tenant), "--pending"])

        configure_private_api_acceptance_logging()
        asyncio.run(run_job_with_signal_cancellation(run))
    except (asyncio.CancelledError, KeyboardInterrupt):
        raise SystemExit(130) from None
    except Exception:
        raise BundleUnavailable("scribe_core_bundle_worker_unavailable") from None


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["api"]:
        api_main()
    elif sys.argv[1:] == ["speech"]:
        worker_main("speech")
    elif sys.argv[1:] == ["translation"]:
        worker_main("translation")
    else:
        raise BundleUnavailable("scribe_core_bundle_target_unavailable")
