"""Synthetic-only FastAPI/PostgreSQL host for the browser acceptance flow."""

from __future__ import annotations

import asyncio
import base64
import os
from typing import Annotated
from uuid import UUID

import uvicorn
from cosmaneura_scribe import database_bootstrap
from cosmaneura_scribe.main import (
    app,
    get_audio_encryption_key_provider,
    get_audio_storage,
    get_repository_provider,
)
from cosmaneura_scribe.migrations import upgrade_database
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.schemas import (
    AudioEncryptionPublicKey,
    AudioUploadGrant,
    AudioUploadGrantRequest,
    RsaPublicJwk,
)
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings, get_settings
from fastapi import Header, HTTPException, status
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.engine import make_url

TENANT_ID = UUID(os.environ["COSMANEURA_SCRIBE_E2E_TENANT_ID"])
APP_PASSWORD = "e2e-only-123!"


def _database_url() -> str:
    value = os.environ.get("COSMANEURA_SCRIBE_E2E_DATABASE_URL", "")
    if not (make_url(value).database or "").endswith("_test"):
        raise RuntimeError("browser E2E requires a disposable _test database")
    return value


class SyntheticKeyProvider:
    async def get_public_key(self) -> AudioEncryptionPublicKey:
        modulus = base64.urlsafe_b64encode(b"\x80" + b"m" * 383).rstrip(b"=").decode()
        return AudioEncryptionPublicKey(
            key_version="browser-e2e-key",
            public_jwk=RsaPublicJwk(n=modulus, e="AQAB"),
        )

    def versioned_key_id(self, key_version: str) -> str | None:
        if key_version != "browser-e2e-key":
            return None
        return f"https://scribe-test.vault.azure.net/keys/audio/{key_version}"

    async def close(self) -> None:
        return None


class SyntheticUploadStorage:
    async def issue_upload_grant(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        object_id: UUID,
        request: AudioUploadGrantRequest,
        expires_at=None,
    ) -> AudioUploadGrant:
        del tenant_id
        return AudioUploadGrant(
            object_id=object_id,
            session_id=session_id,
            sequence_number=request.sequence_number,
            channel=request.channel,
            upload_url=f"http://127.0.0.1:5173/real-upload/{object_id}?synthetic=true",
            expires_at=expires_at,
        )

    async def close(self) -> None:
        return None


owner_url = _database_url()
database_name = str(make_url(owner_url).database)
# Roles are cluster-wide; naming the role after the fresh database keeps grants
# from another disposable database on a reused local cluster out of its ACL check.
app_role = f"{database_name}_app"[:63]
owner_settings = Settings(
    repository_backend="postgres",
    database_url=SecretStr(owner_url),
    database_name=database_name,
    database_ssl=False,
    database_runtime_principal_name=app_role,
)
app_url = make_url(owner_url).set(username=app_role, password=APP_PASSWORD)
settings = Settings(
    capture_protocol_enabled=True,
    repository_backend="postgres",
    database_url=SecretStr(app_url.render_as_string(hide_password=False)),
    database_ssl=False,
    workflow_authentication_enabled=True,
    entra_tenant_id=UUID("11111111-1111-4111-8111-111111111113"),
    workflow_api_audience="11111111-1111-4111-8111-111111111114",
    trusted_platform_client_id=UUID("11111111-1111-4111-8111-111111111115"),
)


async def prepare_database() -> None:
    owner = build_postgres_provider(owner_settings)
    try:
        async with owner.engine.begin() as connection:
            existing = await connection.scalar(
                text(
                    "SELECT count(*) FROM pg_catalog.pg_class "
                    "WHERE relnamespace = 'public'::regnamespace"
                )
            )
            if existing != 0:
                raise RuntimeError("browser E2E requires a fresh disposable _test database")
            role_exists = await connection.scalar(
                text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role)"),
                {"role": app_role},
            )
            role = connection.dialect.identifier_preparer.quote(app_role)
            verb = "ALTER" if role_exists else "CREATE"
            await connection.execute(
                text(f"{verb} ROLE {role} LOGIN PASSWORD '{APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS")
            )
    finally:
        await owner.close()
    await upgrade_database(owner_settings)
    await database_bootstrap._grant_runtime_permissions(owner_settings)


asyncio.run(prepare_database())
provider = build_postgres_provider(settings)
# The runtime role may not read audit_events; evidence is read as the owner.
evidence_provider = build_postgres_provider(owner_settings)


def verified_tenant(
    tenant_id: Annotated[UUID, Header(alias="X-Tenant-ID")],
) -> UUID:
    if tenant_id != TENANT_ID:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Service caller is not authorized.",
        )
    return tenant_id


app.dependency_overrides[get_repository_provider] = lambda: provider
app.dependency_overrides[get_verified_tenant_id] = verified_tenant
app.dependency_overrides[get_settings] = lambda: settings
app.dependency_overrides[get_audio_encryption_key_provider] = SyntheticKeyProvider
app.dependency_overrides[get_audio_storage] = SyntheticUploadStorage


@app.get("/__e2e__/evidence")
async def evidence() -> dict[str, object]:
    async with evidence_provider.engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant, true)"),
            {"tenant": str(TENANT_ID)},
        )
        session = (
            await connection.execute(
                text(
                    "SELECT id, status FROM scribe_sessions "
                    "WHERE tenant_id=:tenant ORDER BY created_at DESC LIMIT 1"
                ),
                {"tenant": TENANT_ID},
            )
        ).mappings().one()
        chunks = await connection.scalar(
            text(
                "SELECT count(*) FROM audio_chunks "
                "WHERE tenant_id=:tenant AND session_id=:session"
            ),
            {"tenant": TENANT_ID, "session": session["id"]},
        )
        actions = (
            await connection.execute(
                text(
                    "SELECT action FROM audit_events WHERE tenant_id=:tenant "
                    "ORDER BY occurred_at, id"
                ),
                {"tenant": TENANT_ID},
            )
        ).scalars()
        return {
            "session_id": str(session["id"]),
            "status": session["status"],
            "chunk_count": chunks,
            "audit_actions": list(actions),
        }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=4175, log_level="warning")
