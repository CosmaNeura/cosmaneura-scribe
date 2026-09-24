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
    reconciler_name = settings.database_delivery_reconciler_principal_name
    reconciler_object_id = settings.database_delivery_reconciler_principal_object_id
    if reconciler_name is not None and reconciler_object_id is not None:
        principals.append(_DatabasePrincipal(reconciler_name, reconciler_object_id))
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
                unsafe_role = await connection.scalar(
                    text(
                        """
                        SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb
                        FROM pg_catalog.pg_roles
                        WHERE rolname = :role_name
                        """
                    ),
                    {"role_name": principal.role_name},
                )
                if unsafe_role is None:
                    raise RuntimeError("Database application role was not created")
                if unsafe_role:
                    raise RuntimeError("Database application role has unsafe privileges")
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
                    f"idempotency_records, capture_leases, capture_lease_receipts, "
                    f"audio_chunk_reservation_batches, audio_chunk_reservations, "
                    f"audio_chunk_reservation_batch_items, "
                    f"audio_upload_authorization_receipts, "
                    f"capture_channel_finalizations TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT SELECT, INSERT ON normalized_source_transcripts, "
                    "normalized_source_segments, normalized_source_receipt_keys "
                    f"TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT UPDATE (generation, renewed_at, expires_at, closed_at, close_reason) "
                    f"ON capture_leases TO {role}"
                )
            )
            await connection.execute(
                text(f"GRANT UPDATE (revoked_at) ON consent_records TO {role}")
            )
            await connection.execute(
                text(
                    "GRANT SELECT (id, tenant_id, appointment_id, practitioner_id, "
                    "patient_id, consent_record_id, modality, ingest_mode, status, created_at, "
                    "transcript_contract_version, creator_actor_id, language_mode, "
                    "transcription_adapter_id, transcription_model_profile_id, "
                    "normalization_profile_id, source_received_at, "
                    "transcript_content_expires_at, content_purged_at, "
                    f"current_source_transcript_version) ON scribe_sessions TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT INSERT (id, tenant_id, appointment_id, practitioner_id, "
                    "patient_id, consent_record_id, modality, ingest_mode, status, created_at, "
                    "transcript_contract_version, creator_actor_id, language_mode, "
                    "transcription_adapter_id, transcription_model_profile_id, "
                    f"normalization_profile_id) ON scribe_sessions TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT UPDATE (status, source_received_at, "
                    "transcript_content_expires_at, current_source_transcript_version) "
                    f"ON scribe_sessions TO {role}"
                )
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
            await connection.execute(
                text(
                    "GRANT SELECT (id, tenant_id, appointment_id, practitioner_id, "
                    "patient_id, consent_record_id, modality, ingest_mode, status, created_at, "
                    f"transcript_contract_version) ON scribe_sessions TO {role}"
                )
            )
            await connection.execute(
                text(f"GRANT UPDATE (status) ON scribe_sessions TO {role}")
            )
            await connection.execute(
                text(f"GRANT SELECT, INSERT, UPDATE ON transcription_jobs TO {role}")
            )
            await connection.execute(text(f"GRANT INSERT ON audit_events TO {role}"))
    finally:
        await provider.close()


async def _grant_delivery_reconciler_permissions(settings: Settings) -> None:
    role_name = settings.database_delivery_reconciler_principal_name
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
                    "GRANT SELECT (id, tenant_id, appointment_id, practitioner_id, patient_id, "
                    "modality, all_parties_consented, revoked_at) "
                    f"ON consent_records TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT SELECT (id, tenant_id, appointment_id, practitioner_id, patient_id, "
                    "consent_record_id, modality, status, transcript_contract_version) "
                    f"ON scribe_sessions TO {role}"
                )
            )
            await connection.execute(
                text(f"GRANT SELECT (id, tenant_id, session_id, segments) ON transcripts TO {role}")
            )
            await connection.execute(
                text(
                    "GRANT SELECT (id, tenant_id, session_id, idempotency_key, payload_sha256, "
                    "status, attempt_count, platform_transcript_id, last_error_code, updated_at) "
                    f"ON transcript_deliveries TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT UPDATE (status, attempt_count, platform_transcript_id, "
                    f"last_error_code, updated_at) ON transcript_deliveries TO {role}"
                )
            )
            await connection.execute(
                text(f"GRANT UPDATE (status) ON scribe_sessions TO {role}")
            )
            await connection.execute(
                text(
                    "GRANT INSERT (id, tenant_id, action, entity_type, entity_id) "
                    f"ON audit_events TO {role}"
                )
            )
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
    await _grant_delivery_reconciler_permissions(settings)


def main() -> None:
    asyncio.run(bootstrap_database())


if __name__ == "__main__":
    main()
