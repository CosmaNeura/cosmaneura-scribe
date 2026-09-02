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
    translation_name = settings.database_translation_principal_name
    translation_object_id = settings.database_translation_principal_object_id
    if translation_name is not None and translation_object_id is not None:
        principals.append(_DatabasePrincipal(translation_name, translation_object_id))
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
                        SELECT application_role.rolsuper
                            OR application_role.rolbypassrls
                            OR application_role.rolcreaterole
                            OR application_role.rolcreatedb
                            OR application_role.rolreplication
                            OR EXISTS (
                                SELECT 1
                                FROM pg_catalog.pg_auth_members AS membership
                                WHERE membership.roleid = application_role.oid
                                   OR membership.member = application_role.oid
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM pg_catalog.pg_database AS database
                                WHERE database.datdba = application_role.oid
                            )
                        FROM pg_catalog.pg_roles AS application_role
                        WHERE application_role.rolname = :role_name
                        """
                    ),
                    {"role_name": principal.role_name},
                )
                if unsafe_role is None:
                    raise RuntimeError("Database application role was not created")
                if unsafe_role:
                    raise RuntimeError(
                        "Database application role has unsafe privileges, memberships, "
                        "or ownership"
                    )
    finally:
        await provider.close()


async def _ensure_no_database_principal_public_ownership(settings: Settings) -> None:
    principals = _database_principals(settings)
    provider = build_postgres_provider(settings)
    try:
        async with provider.engine.begin() as connection:
            for principal in principals:
                owns_public_object = await connection.scalar(
                    text(
                        """
                        SELECT
                            EXISTS (
                                SELECT 1
                                FROM pg_catalog.pg_namespace AS namespace
                                WHERE namespace.nspname = 'public'
                                  AND namespace.nspowner = application_role.oid
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM pg_catalog.pg_class AS relation
                                JOIN pg_catalog.pg_namespace AS namespace
                                  ON namespace.oid = relation.relnamespace
                                WHERE namespace.nspname = 'public'
                                  AND relation.relowner = application_role.oid
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM pg_catalog.pg_proc AS routine
                                JOIN pg_catalog.pg_namespace AS namespace
                                  ON namespace.oid = routine.pronamespace
                                WHERE namespace.nspname = 'public'
                                  AND routine.proowner = application_role.oid
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM pg_catalog.pg_type AS database_type
                                JOIN pg_catalog.pg_namespace AS namespace
                                  ON namespace.oid = database_type.typnamespace
                                WHERE namespace.nspname = 'public'
                                  AND database_type.typowner = application_role.oid
                            )
                            OR EXISTS (
                                SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
                                WHERE dependency.refclassid = 'pg_authid'::regclass
                                  AND dependency.refobjid = application_role.oid
                                  AND dependency.deptype = 'o'
                            )
                        FROM pg_catalog.pg_roles AS application_role
                        WHERE application_role.rolname = :role_name
                        """
                    ),
                    {"role_name": principal.role_name},
                )
                if owns_public_object is None:
                    raise RuntimeError("Database application role was not created")
                if owns_public_object:
                    raise RuntimeError("Database application role owns database objects")
    finally:
        await provider.close()


def _quoted_identifier(connection: AsyncConnection, value: str) -> str:
    return connection.dialect.identifier_preparer.quote(value)


async def _ensure_no_acl_survivor(
    connection: AsyncConnection,
    role_name: str | None,
) -> None:
    if role_name is not None:
        survives = await connection.scalar(
            text(
                """
                SELECT EXISTS (
                    SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
                    JOIN pg_catalog.pg_roles AS role ON role.oid = dependency.refobjid
                    WHERE role.rolname = :role_name AND dependency.deptype = 'a'
                )
                """
            ),
            {"role_name": role_name},
        )
        if survives:
            raise RuntimeError("A surviving direct ACL remains for application role")
        return
    survives = await connection.scalar(
        text(
            """
            WITH scoped_acls AS (
                SELECT COALESCE(database.datacl, pg_catalog.acldefault('d', database.datdba)) AS acl
                FROM pg_catalog.pg_database AS database
                WHERE database.datname = current_database()
                UNION ALL SELECT COALESCE(
                    namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
                ) FROM pg_catalog.pg_namespace AS namespace
                WHERE namespace.nspname = 'public'
                UNION ALL SELECT COALESCE(relation.relacl, pg_catalog.acldefault(
                    (CASE WHEN relation.relkind = 'S' THEN 's' ELSE 'r' END)::"char",
                    relation.relowner
                )) FROM pg_catalog.pg_class AS relation
                WHERE relation.relnamespace = 'public'::regnamespace
                UNION ALL SELECT COALESCE(
                    attribute.attacl, pg_catalog.acldefault('c', relation.relowner)
                )
                FROM pg_catalog.pg_attribute AS attribute
                JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
                WHERE relation.relnamespace = 'public'::regnamespace
                UNION ALL SELECT COALESCE(
                    routine.proacl, pg_catalog.acldefault('f', routine.proowner)
                ) FROM pg_catalog.pg_proc AS routine
                WHERE routine.pronamespace = 'public'::regnamespace
            )
            SELECT EXISTS (
                SELECT 1 FROM scoped_acls
                CROSS JOIN LATERAL pg_catalog.aclexplode(scoped_acls.acl) AS privilege
                WHERE privilege.grantee = 0
            )
            """
        ),
        {},
    )
    if survives:
        raise RuntimeError("A surviving direct ACL remains for PUBLIC")


async def _ensure_no_application_default_privileges(
    connection: AsyncConnection,
    role_names: tuple[str, ...],
) -> None:
    survives = await connection.scalar(
        text(
            """
            SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
                CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS privilege
                WHERE defaults.defaclobjtype IN ('r', 'S', 'f')
                  AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
                  AND (privilege.grantee = 0 OR privilege.grantee = ANY (
                      SELECT role.oid FROM pg_catalog.pg_roles AS role
                      WHERE role.rolname = ANY (CAST(:role_names AS text[]))
                  ))
            )
            OR EXISTS (
                SELECT 1 FROM pg_catalog.pg_namespace AS namespace
                CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                    namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner)
                )) AS privilege
                WHERE namespace.nspname = 'public' AND privilege.privilege_type = 'CREATE'
                  AND privilege.grantee <> (
                      SELECT role.oid FROM pg_catalog.pg_roles AS role
                      WHERE role.rolname = current_user
                  )
                  AND NOT (
                      privilege.grantee = 'pg_database_owner'::regrole
                      AND EXISTS (SELECT 1 FROM pg_catalog.pg_database AS database
                          WHERE database.datname = current_database()
                            AND pg_catalog.pg_has_role(current_user, database.datdba, 'USAGE'))
                  )
            )
            """
        ),
        {"role_names": list(role_names)},
    )
    if survives:
        raise RuntimeError("Uncontrolled public-schema CREATE or default privileges remain")


def _translation_session_scope_policy_name(object_id: UUID) -> str:
    """Return the stable policy name for one translation workload identity."""

    return f"scribe_translation_scope_{object_id.hex}"


async def _replace_translation_session_scope_policy(
    connection: AsyncConnection,
    role_name: str,
    object_id: UUID,
) -> None:
    role = _quoted_identifier(connection, role_name)
    policy = _quoted_identifier(connection, _translation_session_scope_policy_name(object_id))
    scope = (
        "(ingest_mode = 'external_async_transcript' "
        "AND transcript_contract_version = '1.0' "
        "AND status IN ('translation_pending', 'review_required', 'transcript_ready'))"
    )
    # Replace only this identity's deterministic policy. Policies for retired
    # identities remain as a fail-closed boundary until their roles are removed.
    await connection.execute(text(f"DROP POLICY IF EXISTS {policy} ON public.scribe_sessions"))
    await connection.execute(
        text(
            f"CREATE POLICY {policy} ON public.scribe_sessions AS RESTRICTIVE FOR ALL "
            f"TO {role} USING {scope} WITH CHECK {scope}"
        )
    )


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
            await connection.execute(
                text(f"REVOKE ALL PRIVILEGES ON SCHEMA public FROM {grantees}")
            )
            for object_type in ("TABLES", "SEQUENCES", "ROUTINES"):
                await connection.execute(
                    text(f"REVOKE ALL PRIVILEGES ON ALL {object_type} IN SCHEMA public FROM PUBLIC")
                )
            await _ensure_no_acl_survivor(connection, None)
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
            await _ensure_no_application_default_privileges(
                connection,
                tuple(principal.role_name for principal in principals),
            )
    finally:
        await provider.close()


async def _grant_working_transcript_permissions(
    connection: AsyncConnection,
    role: str,
) -> None:
    await connection.execute(
        text(
            "GRANT SELECT (tenant_id, session_id, working_transcript_id, "
            "working_transcript_version, source_transcript_version, "
            "translation_input_count, review_input_count, working_fingerprint, created_at) "
            f"ON normalized_working_transcripts TO {role}"
        )
    )
    await connection.execute(
        text(
            "GRANT INSERT (tenant_id, session_id, working_transcript_id, "
            "working_transcript_version, source_transcript_version, schema_version, "
            "segment_count, blocker_count, translation_input_count, review_input_count, "
            f"total_content_chars, working_fingerprint) ON normalized_working_transcripts TO {role}"
        )
    )
    await connection.execute(
        text(
            "GRANT SELECT (tenant_id, session_id, working_transcript_version) "
            f"ON normalized_working_translation_inputs TO {role}"
        )
    )
    await connection.execute(
        text(
            "GRANT INSERT (tenant_id, session_id, working_transcript_version, "
            "source_transcript_version, source_segment_id, source_segment_version, "
            "translation_id, translation_version) "
            f"ON normalized_working_translation_inputs TO {role}"
        )
    )
    await connection.execute(
        text(
            "GRANT SELECT (tenant_id, session_id, working_transcript_version) "
            f"ON normalized_working_review_inputs TO {role}"
        )
    )
    await connection.execute(
        text(
            "GRANT INSERT (tenant_id, session_id, working_transcript_version, "
            "source_transcript_version, source_segment_id, source_segment_version, "
            "translation_id, translation_version, review_id) "
            f"ON normalized_working_review_inputs TO {role}"
        )
    )
    working_segment_columns = (
        "tenant_id, session_id, working_transcript_version, ordinal, "
        "source_transcript_version, source_segment_id, source_segment_version, "
        "source_locale, speaker_id, speaker_role, start_ms, end_ms, resolution, "
        "content, translation_id, translation_version, translation_review_id"
    )
    await connection.execute(
        text(
            f"GRANT SELECT ({working_segment_columns}) "
            f"ON normalized_working_segments TO {role}"
        )
    )
    await connection.execute(
        text(
            f"GRANT INSERT ({working_segment_columns}) "
            f"ON normalized_working_segments TO {role}"
        )
    )
    await connection.execute(
        text(
            "GRANT SELECT (tenant_id, session_id, working_transcript_version, ordinal, "
            "source_segment_id, source_segment_version, code) "
            f"ON normalized_working_blockers TO {role}"
        )
    )
    await connection.execute(
        text(
            "GRANT INSERT (tenant_id, session_id, working_transcript_version, ordinal, "
            "source_transcript_version, source_segment_id, source_segment_version, code) "
            f"ON normalized_working_blockers TO {role}"
        )
    )


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
            await _ensure_no_acl_survivor(connection, role_name)
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
            if settings.derived_writer_database_permissions_enabled:
                await connection.execute(
                    text(
                        "GRANT SELECT (working_transcript_id, "
                        "current_working_transcript_version) "
                        f"ON scribe_sessions TO {role}"
                    )
                )
                await connection.execute(
                    text(
                        "GRANT UPDATE (working_transcript_id, "
                        "current_working_transcript_version) "
                        f"ON scribe_sessions TO {role}"
                    )
                )
                await connection.execute(
                    text(
                        "GRANT SELECT (tenant_id, session_id, source_transcript_version, "
                        "source_segment_id, source_segment_version, translation_id, "
                        "translation_version, source_locale, target_locale, outcome, content, "
                        "failure_code, translation_adapter_id, "
                        "translation_model_profile_id, created_at) "
                        f"ON normalized_translation_attempts TO {role}"
                    )
                )
                review_columns = (
                    "tenant_id, session_id, source_transcript_version, source_segment_id, "
                    "source_segment_version, translation_id, translation_version, review_id, "
                    "decision, reviewer_actor_id, reviewed_at"
                )
                await connection.execute(
                    text(
                        f"GRANT SELECT ({review_columns}) "
                        f"ON normalized_translation_reviews TO {role}"
                    )
                )
                await connection.execute(
                    text(
                        f"GRANT INSERT ({review_columns}) "
                        f"ON normalized_translation_reviews TO {role}"
                    )
                )
                await _grant_working_transcript_permissions(connection, role)
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
            await _ensure_no_acl_survivor(connection, role_name)
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


async def _grant_translation_permissions(settings: Settings) -> None:
    role_name = settings.database_translation_principal_name
    object_id = settings.database_translation_principal_object_id
    if role_name is None and object_id is None:
        return
    if role_name is None or object_id is None:
        raise RuntimeError("Translation principal name and object ID must be configured together")

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
            await _ensure_no_acl_survivor(connection, role_name)
            await connection.execute(text("SET LOCAL lock_timeout = '5s'"))
            await connection.execute(text("SET LOCAL statement_timeout = '60s'"))
            await _replace_translation_session_scope_policy(
                connection,
                role_name,
                object_id,
            )
            if not settings.derived_writer_database_permissions_enabled:
                return

            await connection.execute(text(f"GRANT CONNECT ON DATABASE {database} TO {role}"))
            await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
            await connection.execute(
                text(
                    "GRANT SELECT (id, tenant_id, appointment_id, practitioner_id, "
                    "patient_id, modality, participant_regions, method, "
                    "all_parties_consented, granted_at, evidence_object_id, "
                    f"policy_version, revoked_at) ON consent_records TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT SELECT (id, tenant_id, appointment_id, practitioner_id, "
                    "patient_id, consent_record_id, modality, ingest_mode, status, created_at, "
                    "transcript_contract_version, creator_actor_id, language_mode, "
                    "transcription_adapter_id, transcription_model_profile_id, "
                    "normalization_profile_id, source_received_at, "
                    "transcript_content_expires_at, content_purged_at, "
                    "current_source_transcript_version, working_transcript_id, "
                    f"current_working_transcript_version) ON scribe_sessions TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT UPDATE (status, working_transcript_id, "
                    f"current_working_transcript_version) ON scribe_sessions TO {role}"
                )
            )
            await connection.execute(
                text(
                    "GRANT SELECT (tenant_id, session_id, source_transcript_version, "
                    "source_receipt_id, schema_version, language_mode, "
                    "transcription_adapter_id, transcription_model_profile_id, "
                    "normalization_profile_id, duration_ms, request_fingerprint, received_at, "
                    f"transcript_content_expires_at) ON normalized_source_transcripts TO {role}"
                )
            )
            source_segment_columns = (
                "tenant_id, session_id, source_transcript_version, ordinal, "
                "source_segment_id, source_segment_version, source_locale, speaker_id, "
                "speaker_role, content, start_ms, end_ms, locale_confidence"
            )
            await connection.execute(
                text(
                    f"GRANT SELECT ({source_segment_columns}) "
                    f"ON normalized_source_segments TO {role}"
                )
            )
            translation_columns = (
                "tenant_id, session_id, source_transcript_version, source_segment_id, "
                "source_segment_version, translation_id, translation_version, source_locale, "
                "target_locale, outcome, content, failure_code, translation_adapter_id, "
                "translation_model_profile_id"
            )
            await connection.execute(
                text(
                    f"GRANT SELECT ({translation_columns}, created_at) "
                    f"ON normalized_translation_attempts TO {role}"
                )
            )
            await connection.execute(
                text(
                    f"GRANT INSERT ({translation_columns}) "
                    f"ON normalized_translation_attempts TO {role}"
                )
            )
            review_columns = (
                "tenant_id, session_id, source_transcript_version, source_segment_id, "
                "source_segment_version, translation_id, translation_version, review_id, "
                "decision, reviewer_actor_id, reviewed_at"
            )
            await connection.execute(
                text(
                    f"GRANT SELECT ({review_columns}) "
                    f"ON normalized_translation_reviews TO {role}"
                )
            )
            await _grant_working_transcript_permissions(connection, role)
            await connection.execute(
                text(
                    "GRANT INSERT (id, tenant_id, action, entity_type, entity_id) "
                    f"ON audit_events TO {role}"
                )
            )
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
            await _ensure_no_acl_survivor(connection, role_name)
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
    await _ensure_no_database_principal_public_ownership(settings)
    await _deny_implicit_future_permissions(settings)
    await upgrade_database(settings)
    await _grant_runtime_permissions(settings)
    await _grant_transcription_permissions(settings)
    await _grant_delivery_reconciler_permissions(settings)
    await _grant_translation_permissions(settings)


def main() -> None:
    asyncio.run(bootstrap_database())


if __name__ == "__main__":
    main()
