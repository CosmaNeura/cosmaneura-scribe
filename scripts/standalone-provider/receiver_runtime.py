"""Inactive-by-default standalone receiver composition for a sealed Core profile.

Reads one packaged/mounted configuration file. No environment fallback, account
provisioning, schema initialization, synthetic authentication, or deployment.
"""

from __future__ import annotations

import asyncio
import json
import re
import ssl
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

CORE_ORIGIN = "https://staging-app.cosmaneura.com"
ISSUER = "https://resolved-emu-53.clerk.accounts.dev"
ORIGINS = {"ios": "capacitor://localhost", "desktop": "app://cosmas"}


class ProductionReceiverBinding(BaseModel):
    """Owner-supplied deployment inputs, never environment/request fallbacks.

    A receipt reference is not approval or evidence by itself. The deployment
    flight plan requires review of its exact resource/identity/network binding.
    """

    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    core_origin: Literal["https://app.cosmaneura.com"]
    issuer: Literal["https://clerk.cosmaneura.com"]
    receiver_origin: str
    audience: str
    organization_id: str
    deployment_receipt_sha256: str
    session_claims_receipt_sha256: str
    protected_data_receipt_sha256: str

    @model_validator(mode="after")
    def exact_binding(self) -> ProductionReceiverBinding:
        origin = urlsplit(self.receiver_origin)
        host = origin.hostname or ""
        if (
            self.receiver_origin != "https://" + host
            or "staging" in host
            or host != host.lower()
            or not (
                re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.azurecontainerapps\.io", host)
                or re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.cosmaneura\.com", host)
            )
            or not re.fullmatch(r"[!-~]{1,255}", self.audience)
            or not re.fullmatch(r"org_[A-Za-z0-9_]{1,251}", self.organization_id)
            or not re.fullmatch(r"[0-9a-f]{64}", self.deployment_receipt_sha256)
            or not re.fullmatch(r"[0-9a-f]{64}", self.session_claims_receipt_sha256)
            or not re.fullmatch(r"[0-9a-f]{64}", self.protected_data_receipt_sha256)
        ):
            raise ValueError("receiver_production_binding_invalid")
        return self


class ReceiverConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    schema_version: Literal[1] = Field(default=1, alias="schema")
    enabled: bool = False
    encounter_creation_enabled: bool = False
    platforms: tuple[Literal["ios", "desktop"], ...] = ("ios", "desktop")
    desktop_native_session_without_origin: bool = False
    environment_id: UUID | None = None
    beta_box_id: UUID | None = None
    managed_identity_client_id: UUID | None = None
    database_host: str | None = None
    database_name: str | None = None
    database_reader_role: str | None = None
    core_scope: str | None = None
    ingress_isolation_receipt: str | None = None
    profile: Literal["core-staging-personal-v1", "core-production-organization-v1"] = (
        "core-staging-personal-v1"
    )
    production: ProductionReceiverBinding | None = None

    @model_validator(mode="after")
    def require_bindings(self) -> ReceiverConfiguration:
        if self.profile == "core-staging-personal-v1" and self.production is not None:
            raise ValueError("receiver_configuration_invalid")
        if (
            self.profile == "core-production-organization-v1"
            and self.desktop_native_session_without_origin
        ):
            raise ValueError("receiver_configuration_invalid")
        if not self.enabled:
            return self
        if (
            (self.profile == "core-production-organization-v1" and self.production is None)
            or not self.platforms
            or len(set(self.platforms)) != len(self.platforms)
            or (self.desktop_native_session_without_origin and "desktop" not in self.platforms)
            or any(
                value is None or value.int == 0
                for value in (
                    self.environment_id,
                    self.beta_box_id,
                    self.managed_identity_client_id,
                )
            )
            or re.fullmatch(r"[a-z0-9-]+\.postgres\.database\.azure\.com", self.database_host or "")
            is None
            or re.fullmatch(r"[A-Za-z0-9_-]{1,63}", self.database_name or "") is None
            or re.fullmatch(r"[A-Za-z0-9_-]{1,63}", self.database_reader_role or "") is None
            or re.fullmatch(r"api://[0-9a-f-]{36}/\.default", self.core_scope or "") is None
            or re.fullmatch(r"[A-Za-z0-9._:/-]{8,160}", self.ingress_isolation_receipt or "")
            is None
        ):
            raise ValueError("receiver_configuration_invalid")
        UUID((self.core_scope or "")[6:-9])
        return self


def load_configuration(path: Path) -> ReceiverConfiguration:
    def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate configuration field")
            result[key] = value
        return result

    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 16_384:
            raise ValueError("invalid configuration file")
        raw = path.read_bytes()
        if len(raw) > 16_384:
            raise ValueError("invalid configuration file")
        json.loads(raw, object_pairs_hook=unique)
        return ReceiverConfiguration.model_validate_json(raw)
    except (OSError, ValueError, TypeError):
        pass
    raise RuntimeError("receiver_configuration_unavailable") from None


def identity_arguments(config: ReceiverConfiguration, platform: str) -> tuple[dict, dict]:
    """Pure composition projection, including the unchanged strict verifier flags."""
    # These Settings are the standalone adapter's identity projection, not a
    # full OS application activation. Mode/receipt text grants no patient access;
    # the reviewed protected-data deployment and fresh Core authority are needed.
    origin = ORIGINS[platform]
    production = config.production if config.profile == "core-production-organization-v1" else None
    if config.profile == "core-production-organization-v1" and production is None:
        raise RuntimeError("receiver_configuration_unavailable")
    issuer = production.issuer if production else ISSUER
    settings = dict(
        auth_mode="clerk_jwt",
        cosmas_env="synth_os",
        data_mode="authorized_beta" if production else "synthetic",
        synth_seed=False,
        beta_box_id=str(config.beta_box_id),
        clerk_issuer=issuer,
        clerk_jwks_url=issuer + "/.well-known/jwks.json",
        clerk_audience=production.audience if production else None,
        clerk_organization_id=production.organization_id if production else None,
        workspace_native_synthetic_enabled=False,
        clerk_authorized_parties=origin,
        cors_allowed_origins=origin,
    )
    if production:
        # Existing OS settings permit these local transport origins only when
        # explicitly selected. Neither flag changes JWT or Core authority.
        settings["workspace_apple_local_transport_enabled"] = platform == "ios"
        settings["workspace_desktop_local_transport_enabled"] = platform == "desktop"
    verifier = dict(
        core_provider_session=production is None,
        allow_native_session_without_origin=production is None and platform == "ios",
        allow_staging_desktop_session_without_origin=(
            production is None
            and platform == "desktop"
            and config.desktop_native_session_without_origin
        ),
    )
    return settings, verifier


async def unavailable(scope: Scope, receive: Receive, send: Send) -> None:
    if scope["type"] == "websocket":
        await send({"type": "websocket.close", "code": 1008})
    else:
        await JSONResponse(
            {"detail": "provider_unavailable"},
            status_code=404,
            headers={"Cache-Control": "no-store"},
        )(scope, receive, send)


class OriginReceivers:
    def __init__(self, apps: dict[str, ASGIApp]) -> None:
        self._apps = {origin.encode("ascii"): app for origin, app in apps.items()}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        origins = [value for key, value in scope.get("headers", []) if key.lower() == b"origin"]
        app = self._apps.get(origins[0]) if len(origins) == 1 else None
        await (app or unavailable)(scope, receive, send)


@dataclass
class ReceiverResources:
    app: ASGIApp
    close: Callable[[], Awaitable[None]]


async def finish_close(close: Callable[[], Awaitable[None]]) -> None:
    async def invoke() -> None:
        await close()

    task = asyncio.create_task(invoke())
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


async def build_runtime(config: ReceiverConfiguration) -> ReceiverResources:
    # Lazy imports preserve the disabled path before any identity or provider
    # module initialization. These package locations are fixed in the image.
    from azure.identity.aio import ManagedIdentityCredential
    from azure_ingress import ACA_PROFILE, PRODUCTION_ACA_PROFILE, STAGING_ORIGIN, AzureIngress
    from cosmaneura_scribe.provider_core_connections import ProviderCoreConnections
    from cosmas_os.api.auth import CORE_STAGING_PERSONAL, ClerkTokenVerifier
    from cosmas_os.config import Settings
    from jwt import PyJWKClient
    from pydantic import SecretStr
    from pydantic_settings import SettingsConfigDict
    from receiver import ProviderReceiver, ReceiverProfile
    from sqlalchemy import URL, text
    from sqlalchemy.ext.asyncio import create_async_engine

    if not config.enabled:
        raise RuntimeError("receiver_disabled")
    production = config.production if config.profile == "core-production-organization-v1" else None
    core_origin = production.core_origin if production else CORE_ORIGIN
    receiver_origin = production.receiver_origin if production else STAGING_ORIGIN
    credential = ManagedIdentityCredential(client_id=str(config.managed_identity_client_id))
    verifiers: list[ClerkTokenVerifier] = []
    engine = None
    core_connections: ProviderCoreConnections | None = None

    async def close() -> None:
        # Do not leave credential transports or owned JWKS threads behind after
        # startup failure, SIGTERM, or shutdown. Shared OS verifiers are untouched.
        failed = False
        for verifier in verifiers:
            try:
                await run_in_threadpool(verifier.close)
            except Exception:
                failed = True
        try:
            if core_connections is not None:
                await core_connections.close()
        except Exception:
            failed = True
        try:
            if engine is not None:
                await engine.dispose()
        except Exception:
            failed = True
        try:
            await credential.close()
        except Exception:
            failed = True
        if failed:
            raise RuntimeError("receiver_shutdown_unavailable") from None

    try:
        core_connections = ProviderCoreConnections(core_origin)

        async def database_password() -> str:
            token = await credential.get_token("https://ossrdbms-aad.database.windows.net/.default")
            if not token.token or token.expires_on <= time() + 30:
                raise RuntimeError("receiver_database_credential_unavailable")
            return token.token

        engine = create_async_engine(
            URL.create(
                "postgresql+asyncpg",
                username=config.database_reader_role,
                host=config.database_host,
                port=5432,
                database=config.database_name,
            ),
            connect_args={
                "password": database_password,
                "ssl": ssl.create_default_context(),
                "timeout": 10,
                "server_settings": {
                    "application_name": "scribe-native-receiver",
                    "statement_timeout": "10000",
                    "lock_timeout": "2000",
                },
            },
            hide_parameters=True,
            pool_pre_ping=True,
            pool_size=2,
            max_overflow=0,
        )
        async with engine.connect() as connection:
            row = (
                await connection.execute(
                    text("""
                SELECT current_user AS principal, current_database() AS database,
                       rolsuper OR rolbypassrls OR rolcreaterole
                       OR rolcreatedb OR rolreplication AS unsafe
                FROM pg_roles WHERE rolname=current_user
            """)
                )
            ).one()
            if (
                row.principal != config.database_reader_role
                or row.database != config.database_name
                or row.unsafe
                or await connection.scalar(
                    text("SELECT has_schema_privilege(current_user,'public','CREATE')")
                )
            ):
                raise RuntimeError("receiver_database_principal_unavailable")
            for table in (
                "principals",
                "core_provider_accounts",
                "encounter_workspaces",
                "appointment_observations",
                "patient_links",
            ):
                row = (
                    await connection.execute(
                        text("""
                    SELECT has_table_privilege(current_user,:table,'SELECT') AS readable,
                           has_any_column_privilege(current_user,:table,'INSERT,UPDATE,REFERENCES')
                           OR has_table_privilege(current_user,:table,'DELETE,TRUNCATE,TRIGGER')
                           AS writable
                """),
                        {"table": table},
                    )
                ).one()
                if not row.readable or row.writable:
                    raise RuntimeError("receiver_database_permissions_unavailable")

        async def workload_token() -> SecretStr:
            token = await credential.get_token(config.core_scope or "")
            if not token.token or token.expires_on <= time() + 30:
                raise RuntimeError("receiver_core_credential_unavailable")
            return SecretStr(token.token)

        apps: dict[str, ASGIApp] = {}

        class ReceiverIdentitySettings(Settings):
            model_config = SettingsConfigDict(env_file=None, extra="ignore")

        for platform in config.platforms:
            origin = ORIGINS[platform]
            settings_arguments, verifier_arguments = identity_arguments(config, platform)
            settings = ReceiverIdentitySettings(**settings_arguments)
            # Explicit clients give each verifier an owned, closable refresh loop.
            verifier = await run_in_threadpool(
                ClerkTokenVerifier,
                settings,
                jwks_client=PyJWKClient(settings.clerk_jwks_url, cache_jwk_set=True, timeout=5),
                start_background_refresh=True,
                **verifier_arguments,
            )
            verifiers.append(verifier)
            if config.environment_id is None:
                raise RuntimeError("receiver_configuration_unavailable")
            profile = ReceiverProfile(
                receiver_origin,
                core_origin,
                config.environment_id,
                frozenset({origin}),
                "clerk-organization-v1" if production else CORE_STAGING_PERSONAL,
            )
            apps[origin] = ProviderReceiver(
                profile,
                engine,
                settings,
                verifier,
                workload_token,
                enabled=True,
                core_connections=core_connections,
                encounter_creation_enabled=config.encounter_creation_enabled,
                provider_trace_enabled=production is None,
            ).app()
        return ReceiverResources(
            AzureIngress(
                OriginReceivers(apps),
                profile=PRODUCTION_ACA_PROFILE if production else ACA_PROFILE,
                production_origin=receiver_origin if production else None,
            ),
            close,
        )
    except asyncio.CancelledError:
        await finish_close(close)
        raise
    except Exception:
        await finish_close(close)
    raise RuntimeError("receiver_startup_unavailable") from None


class ReceiverService:
    def __init__(self, configuration: Path) -> None:
        self._configuration = configuration
        self._active: ASGIApp = unavailable

        @asynccontextmanager
        async def lifespan(_: FastAPI) -> AsyncIterator[None]:
            resources: ReceiverResources | None = None
            config = load_configuration(self._configuration)
            try:
                if config.enabled:
                    resources = await build_runtime(config)
                    self._active = resources.app
                yield
            finally:
                self._active = unavailable
                if resources is not None:
                    await finish_close(resources.close)

        self._lifecycle = FastAPI(
            lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self._lifecycle(scope, receive, send)
        else:
            await self._active(scope, receive, send)
