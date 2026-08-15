from __future__ import annotations

import asyncio
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .migrations import upgrade_database
from .postgres_repository import build_postgres_provider
from .settings import Settings, get_settings


@dataclass(frozen=True)
class _DatabasePrincipal:
    role_name: str
    object_id: UUID


def _database_principals(settings: Settings) -> tuple[_DatabasePrincipal, ...]:
    runtime_name = settings.database_runtime_principal_name
    runtime_object_id = settings.database_runtime_principal_object_id
    if runtime_name is None or runtime_object_id is None:
        raise RuntimeError("Runtime principal name and object ID are required for bootstrap")

    principals = [_DatabasePrincipal(runtime_name, runtime_object_id)]
    transcription_name = settings.database_transcription_principal_name
    transcription_object_id = settings.database_transcription_principal_object_id
    if transcription_name is not None and transcription_object_id is not None:
        principals.append(_DatabasePrincipal(transcription_name, transcription_object_id))
    return tuple(principals)


async def _ensure_database_principals(settings: Settings) -> None:
    principals = _database_principals(settings)

    admin_settings = settings.model_copy(update={"database_name": "postgres"})
    provider = build_postgres_provider(admin_settings)
    try:
        async with provider.engine.begin() as connection:
            for principal in principals:
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
                    {"role_name": principal.role_name},
                )
                if matching_oid is not None and str(matching_oid) != str(principal.object_id):
                    raise RuntimeError("Database role is mapped to a different Entra object")
                if matching_oid is None:
                    await connection.execute(
                        text(
                            """
                            SELECT pg_catalog.pgaadauth_create_principal_with_oid(
                                :role_name, :object_id, 'service', false, false
                            )
                            """
                        ),
                        {
                            "role_name": principal.role_name,
                            "object_id": str(principal.object_id),
                        },
                    )
    finally:
        await provider.close()


def _quoted_identifier(connection: AsyncConnection, value: str) -> str:
    return connection.dialect.identifier_preparer.quote(value)


async def _deny_implicit_future_permissions(settings: Settings) -> None:
    principals = _database_principals(settings)
    provider = build_postgres_provider(settings)
    try:
        async with provider.engine.begin() as connection:
            database = _quoted_identifier(connection, settings.database_name)
            application_roles = ", ".join(
                _quoted_identifier(connection, principal.role_name) for principal in principals
            )
            grantees = f"PUBLIC, {application_roles}"
            await connection.execute(
                text(f"REVOKE CONNECT, TEMPORARY ON DATABASE {database} FROM PUBLIC")
            )
            await connection.execute(text("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC"))
            for object_type in ("TABLES", "SEQUENCES", "ROUTINES"):
                await connection.execute(
                    text(f"REVOKE ALL PRIVILEGES ON ALL {object_type} IN SCHEMA public FROM PUBLIC")
                )
            for object_type in ("TABLES", "SEQUENCES", "ROUTINES"):
                await connection.execute(
                    text(
                        "ALTER DEFAULT PRIVILEGES "
                        f"REVOKE ALL PRIVILEGES ON {object_type} FROM {grantees}"
                    )
                )
                await connection.execute(
                    text(
                        "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                        f"REVOKE ALL PRIVILEGES ON {object_type} FROM {grantees}"
                    )
                )
    finally:
        await provider.close()


async def _grant_runtime_permissions(settings: Settings) -> None:
    role_name = settings.database_runtime_principal_name
    if role_name is None:
        raise RuntimeError("Runtime principal name is required for bootstrap")

    provider = build_postgres_provider(settings)
    try:
        async with provider.engine.begin() as connection:
            role = _quoted_identifier(connection, role_name)
            database = _quoted_identifier(connection, settings.database_name)
            await connection.execute(
                text(f"REVOKE ALL PRIVILEGES ON DATABASE {database} FROM {role}")
            )
            await connection.execute(text(f"REVOKE ALL PRIVILEGES ON SCHEMA public FROM {role}"))
            for object_type in ("TABLES", "SEQUENCES", "ROUTINES"):
                await connection.execute(
                    text(f"REVOKE ALL PRIVILEGES ON ALL {object_type} IN SCHEMA public FROM {role}")
                )
            await connection.execute(text(f"GRANT CONNECT ON DATABASE {database} TO {role}"))
            await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
            await connection.execute(
                text(
                    f"GRANT SELECT, INSERT ON consent_records, audio_chunks, "
                    f"audio_upload_grants, session_audio_keys, transcripts, "
                    f"idempotency_records TO {role}"
                )
            )
            await connection.execute(
                text(f"GRANT SELECT, INSERT, UPDATE ON scribe_sessions TO {role}")
            )
            await connection.execute(
                text(f"GRANT SELECT, INSERT, UPDATE ON transcript_deliveries TO {role}")
            )
            await connection.execute(
                text(f"GRANT SELECT, INSERT, UPDATE ON transcription_jobs TO {role}")
            )
            await connection.execute(text(f"GRANT INSERT ON audit_events TO {role}"))
    finally:
        await provider.close()


async def _grant_transcription_permissions(settings: Settings) -> None:
    role_name = settings.database_transcription_principal_name
    if role_name is None:
        return

    provider = build_postgres_provider(settings)
    try:
        async with provider.engine.begin() as connection:
            role = _quoted_identifier(connection, role_name)
            database = _quoted_identifier(connection, settings.database_name)
            await connection.execute(
                text(f"REVOKE ALL PRIVILEGES ON DATABASE {database} FROM {role}")
            )
            await connection.execute(text(f"REVOKE ALL PRIVILEGES ON SCHEMA public FROM {role}"))
            await connection.execute(
                text(f"REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {role}")
            )
            await connection.execute(
                text(f"REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {role}")
            )
            await connection.execute(
                text(f"REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM {role}")
            )
            await connection.execute(text(f"GRANT CONNECT ON DATABASE {database} TO {role}"))
            await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
            await connection.execute(
                text(
                    f"GRANT SELECT ON consent_records, audio_chunks, session_audio_keys, "
                    f"transcripts TO {role}"
                )
            )
            await connection.execute(text(f"GRANT INSERT ON transcripts TO {role}"))
            await connection.execute(text(f"GRANT SELECT, UPDATE ON scribe_sessions TO {role}"))
            await connection.execute(
                text(f"GRANT SELECT, INSERT, UPDATE ON transcription_jobs TO {role}")
            )
            await connection.execute(text(f"GRANT INSERT ON audit_events TO {role}"))
    finally:
        await provider.close()


async def bootstrap_database(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    if settings.repository_backend != "postgres":
        raise RuntimeError("Database bootstrap requires repository_backend=postgres")
    await _ensure_database_principals(settings)
    await _deny_implicit_future_permissions(settings)
    await upgrade_database(settings)
    await _grant_runtime_permissions(settings)
    await _grant_transcription_permissions(settings)


def main() -> None:
    asyncio.run(bootstrap_database())


if __name__ == "__main__":
    main()
