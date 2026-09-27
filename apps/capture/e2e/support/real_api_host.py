"""Synthetic-only FastAPI/PostgreSQL host for the browser acceptance flow."""

from __future__ import annotations

import base64
import os
from typing import Annotated
from urllib.parse import urlsplit
from uuid import UUID

import uvicorn
from alembic.config import Config
from cosmaneura_scribe.main import (
    app,
    get_audio_encryption_key_provider,
    get_audio_storage,
    get_repository_provider,
)
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.schemas import (
    AudioEncryptionPublicKey,
    AudioUploadGrant,
    AudioUploadGrantRequest,
    RsaPublicJwk,
)
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings, get_settings
from fastapi import Header
from sqlalchemy import text

from alembic import command

TENANT_ID = UUID("11111111-1111-4111-8111-111111111112")


def _database_url() -> str:
    value = os.environ.get("COSMANEURA_SCRIBE_E2E_DATABASE_URL", "")
    if not (urlsplit(value).path or "").endswith("_test"):
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


database_url = _database_url()
alembic = Config("alembic.ini")
alembic.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
command.upgrade(alembic, "head")

settings = Settings(
    capture_protocol_enabled=True,
    repository_backend="postgres",
    database_url=database_url,
    database_ssl=False,
    workflow_authentication_enabled=True,
    entra_tenant_id=UUID("11111111-1111-4111-8111-111111111113"),
    workflow_api_audience="11111111-1111-4111-8111-111111111114",
    trusted_platform_client_id=UUID("11111111-1111-4111-8111-111111111115"),
)
provider = build_postgres_provider(settings)


def verified_tenant(
    tenant_id: Annotated[UUID, Header(alias="X-Tenant-ID")],
) -> UUID:
    if tenant_id != TENANT_ID:
        raise ValueError("unexpected synthetic tenant")
    return tenant_id


app.dependency_overrides[get_repository_provider] = lambda: provider
app.dependency_overrides[get_verified_tenant_id] = verified_tenant
app.dependency_overrides[get_settings] = lambda: settings
app.dependency_overrides[get_audio_encryption_key_provider] = SyntheticKeyProvider
app.dependency_overrides[get_audio_storage] = SyntheticUploadStorage


@app.get("/__e2e__/evidence")
async def evidence() -> dict[str, object]:
    async with provider.engine.begin() as connection:
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
