from __future__ import annotations

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .migrations import upgrade_database
from .postgres_repository import build_postgres_provider
from .settings import Settings, get_settings


async def _ensure_runtime_principal(settings: Settings) -> None:
    role_name = settings.database_runtime_principal_name
    object_id = settings.database_runtime_principal_object_id
    if role_name is None or object_id is None:
        raise RuntimeError("Runtime principal name and object ID are required for bootstrap")

    admin_settings = settings.model_copy(update={"database_name": "postgres"})
    provider = build_postgres_provider(admin_settings)
    try:
        async with provider.engine.begin() as connection:
            matching_oid = await connection.scalar(
                text(
                    """
                    SELECT COALESCE(
                        to_jsonb(principal) ->> 'objectId',
                        to_jsonb(principal) ->> 'objectid'
                    )
                    FROM pg_catalog.pgaadauth_list_principals(false) AS principal
                    WHERE principal.rolename = :role_name
                    """
                ),
                {"role_name": role_name},
            )
            if matching_oid is not None and str(matching_oid) != str(object_id):
                raise RuntimeError("Runtime database role is mapped to a different Entra object")
            if matching_oid is None:
                await connection.execute(
                    text(
                        """
                        SELECT pg_catalog.pgaadauth_create_principal_with_oid(
                            :role_name, :object_id, 'service', false, false
                        )
                        """
                    ),
                    {"role_name": role_name, "object_id": str(object_id)},
                )
    finally:
        await provider.close()


def _quoted_identifier(connection: AsyncConnection, value: str) -> str:
    return connection.dialect.identifier_preparer.quote(value)


async def _grant_runtime_permissions(settings: Settings) -> None:
    role_name = settings.database_runtime_principal_name
    if role_name is None:
        raise RuntimeError("Runtime principal name is required for bootstrap")

    provider = build_postgres_provider(settings)
    try:
        async with provider.engine.begin() as connection:
            role = _quoted_identifier(connection, role_name)
            database = _quoted_identifier(connection, settings.database_name)
            await connection.execute(text(f"GRANT CONNECT ON DATABASE {database} TO {role}"))
            await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
            await connection.execute(
                text(
                    f"GRANT SELECT, INSERT ON consent_records, audio_chunks, "
                    f"audio_upload_grants, transcripts, idempotency_records TO {role}"
                )
            )
            await connection.execute(
                text(f"GRANT SELECT, INSERT, UPDATE ON scribe_sessions TO {role}")
            )
            await connection.execute(
                text(
                    f"GRANT SELECT, INSERT, UPDATE ON transcript_deliveries TO {role}"
                )
            )
            await connection.execute(text(f"GRANT INSERT ON audit_events TO {role}"))
    finally:
        await provider.close()


async def bootstrap_database(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    if settings.repository_backend != "postgres":
        raise RuntimeError("Database bootstrap requires repository_backend=postgres")
    await _ensure_runtime_principal(settings)
    await upgrade_database(settings)
    await _grant_runtime_permissions(settings)


def main() -> None:
    asyncio.run(bootstrap_database())


if __name__ == "__main__":
    main()
