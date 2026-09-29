"""Inactive-by-default standalone receiver composition for the selected staging Core.

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
from uuid import UUID

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

CORE_ORIGIN = "https://staging-app.cosmaneura.com"
ISSUER = "https://resolved-emu-53.clerk.accounts.dev"
ORIGINS = {"ios": "capacitor://localhost", "desktop": "app://cosmas"}


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

    @model_validator(mode="after")
    def require_bindings(self) -> ReceiverConfiguration:
        if not self.enabled:
            return self
        if (
            not self.platforms
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
            or re.fullmatch(
                r"[a-z0-9-]+\.postgres\.database\.azure\.com", self.database_host or ""
            )
            is None
            or re.fullmatch(r"[A-Za-z0-9_-]{1,63}", self.database_name or "") is None
            or re.fullmatch(r"[A-Za-z0-9_-]{1,63}", self.database_reader_role or "")
            is None
            or re.fullmatch(r"api://[0-9a-f-]{36}/\.default", self.core_scope or "")
            is None
            or re.fullmatch(
                r"[A-Za-z0-9._:/-]{8,160}", self.ingress_isolation_receipt or ""
            )
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
        origins = [
            value for key, value in scope.get("headers", []) if key.lower() == b"origin"
        ]
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
    from azure_ingress import ACA_PROFILE, STAGING_ORIGIN, AzureIngress
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
    credential = ManagedIdentityCredential(
        client_id=str(config.managed_identity_client_id)
    )
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
        core_connections = ProviderCoreConnections(CORE_ORIGIN)

        async def database_password() -> str:
            token = await credential.get_token(
                "https://ossrdbms-aad.database.windows.net/.default"
            )
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
            settings = ReceiverIdentitySettings(
                auth_mode="clerk_jwt",
                cosmas_env="synth_os",
                data_mode="synthetic",
                synth_seed=False,
                beta_box_id=str(config.beta_box_id),
                clerk_issuer=ISSUER,
                clerk_jwks_url=ISSUER + "/.well-known/jwks.json",
                clerk_audience=None,
                clerk_organization_id=None,
                workspace_native_synthetic_enabled=False,
                clerk_authorized_parties=origin,
                cors_allowed_origins=origin,
            )
            # Explicit clients give each verifier an owned, closable refresh loop.
            verifier = await run_in_threadpool(
                ClerkTokenVerifier,
                settings,
                jwks_client=PyJWKClient(
                    ISSUER + "/.well-known/jwks.json", cache_jwk_set=True, timeout=5
                ),
                start_background_refresh=True,
                core_provider_session=True,
                allow_native_session_without_origin=platform == "ios",
                allow_staging_desktop_session_without_origin=(
                    platform == "desktop" and config.desktop_native_session_without_origin
                ),
            )
            verifiers.append(verifier)
            if config.environment_id is None:
                raise RuntimeError("receiver_configuration_unavailable")
            profile = ReceiverProfile(
                STAGING_ORIGIN,
                CORE_ORIGIN,
                config.environment_id,
                frozenset({origin}),
                CORE_STAGING_PERSONAL,
            )
            apps[origin] = ProviderReceiver(
                profile, engine, settings, verifier, workload_token, enabled=True,
                core_connections=core_connections,
                encounter_creation_enabled=config.encounter_creation_enabled,
            ).app()
        return ReceiverResources(
            AzureIngress(OriginReceivers(apps), profile=ACA_PROFILE), close
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
