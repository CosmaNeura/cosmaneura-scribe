from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

pytestmark = pytest.mark.postgres

ROOT = Path(__file__).resolve().parents[1]
LEGACY_CHILD_ROOTS = (
    "audio_chunks",
    "audio_upload_grants",
    "session_audio_keys",
    "transcripts",
    "transcript_deliveries",
    "transcription_jobs",
    "capture_leases",
    "audio_chunk_reservation_batches",
    "audio_chunk_reservations",
    "capture_channel_finalizations",
)


async def _reject(
    connection: AsyncConnection,
    statement: str,
    parameters: dict[str, object],
    match: str,
) -> None:
    savepoint = await connection.begin_nested()
    with pytest.raises(DBAPIError, match=match):
        await connection.execute(text(statement), parameters)
    await savepoint.rollback()


async def _seed_session(
    connection: AsyncConnection,
    tenant_id: UUID,
    *,
    configured: bool,
) -> UUID:
    consent_id = uuid4()
    session_id = uuid4()
    await connection.execute(
        text(
            """
            INSERT INTO consent_records (
                id, tenant_id, appointment_id, practitioner_id, patient_id,
                modality, participant_regions, method, all_parties_consented,
                granted_at, policy_version
            ) VALUES (
                :consent_id, :tenant_id, 'authority-appointment',
                'authority-practitioner', 'authority-patient', 'virtual', ARRAY['FL'],
                'pre_visit_form', true, statement_timestamp(), 'authority-policy-v1'
            )
            """
        ),
        {"consent_id": consent_id, "tenant_id": tenant_id},
    )
    configuration: dict[str, str | None] = {
        "contract": "1.0",
        "creator": "actor_authority_test",
        "language": "en-US+es-US",
        "adapter": "stt_adapter_v1",
        "model": "stt_model_v1",
        "normalizer": "normalizer_v1",
    }
    if not configured:
        configuration = dict.fromkeys(configuration)
    await connection.execute(
        text(
            """
            INSERT INTO scribe_sessions (
                id, tenant_id, appointment_id, practitioner_id, patient_id,
                consent_record_id, modality, status, ingest_mode,
                transcript_contract_version, creator_actor_id, language_mode,
                transcription_adapter_id, transcription_model_profile_id,
                normalization_profile_id
            ) VALUES (
                :session_id, :tenant_id, 'authority-appointment',
                'authority-practitioner', 'authority-patient', :consent_id,
                'virtual', 'created', 'external_async_transcript', :contract,
                :creator, :language, :adapter, :model, :normalizer
            )
            """
        ),
        {
            "session_id": session_id,
            "tenant_id": tenant_id,
            "consent_id": consent_id,
            **configuration,
        },
    )
    return session_id


def _legacy_root_inserts(
    tenant_id: UUID,
    session_id: UUID,
) -> Iterable[tuple[str, str, dict[str, object]]]:
    lease_id, batch_id = uuid4(), uuid4()
    common = {"tenant_id": tenant_id, "session_id": session_id}
    return (
        (
            "capture_leases",
            """
            INSERT INTO capture_leases (
                tenant_id, session_id, lease_id, generation, expires_at
            ) VALUES (
                :tenant_id, :session_id, :lease_id, 1,
                statement_timestamp() + INTERVAL '5 minutes'
            )
            """,
            {**common, "lease_id": lease_id},
        ),
        (
            "audio_chunk_reservation_batches",
            """
            INSERT INTO audio_chunk_reservation_batches (
                id, tenant_id, session_id, lease_id, lease_generation,
                requested_protocol_version, item_count, capture_authorized_until
            ) VALUES (
                :id, :tenant_id, :session_id, :lease_id, 1, '1.0', 1,
                statement_timestamp() + INTERVAL '4 minutes'
            )
            """,
            {**common, "id": batch_id, "lease_id": lease_id},
        ),
        (
            "audio_chunk_reservations",
            """
            INSERT INTO audio_chunk_reservations (
                object_id, tenant_id, session_id, sequence_number, channel,
                protocol_version, additional_data, plaintext_budget_bytes
            ) VALUES (
                :object_id, :tenant_id, :session_id, 0, 'microphone',
                '1.0', decode('aa', 'hex'), 327680
            )
            """,
            {**common, "object_id": uuid4()},
        ),
        (
            "audio_chunks",
            """
            INSERT INTO audio_chunks (
                id, tenant_id, session_id, sequence_number, channel,
                object_id, sha256, ciphertext_size_bytes
            ) VALUES (
                :id, :tenant_id, :session_id, 1, 'microphone',
                :object_id, :sha256, 64
            )
            """,
            {**common, "id": uuid4(), "object_id": uuid4(), "sha256": "a" * 64},
        ),
        (
            "audio_upload_grants",
            """
            INSERT INTO audio_upload_grants (
                object_id, tenant_id, session_id, sequence_number, channel, expires_at
            ) VALUES (
                :object_id, :tenant_id, :session_id, 2, 'system_audio',
                statement_timestamp() + INTERVAL '5 minutes'
            )
            """,
            {**common, "object_id": uuid4()},
        ),
        (
            "session_audio_keys",
            """
            INSERT INTO session_audio_keys (
                tenant_id, session_id, key_version, wrapped_dek
            ) VALUES (:tenant_id, :session_id, 'synthetic-key-v1', :wrapped_dek)
            """,
            {**common, "wrapped_dek": "a" * 512},
        ),
        (
            "transcripts",
            """
            INSERT INTO transcripts (
                id, tenant_id, session_id, language_code, stt_provider, segments
            ) VALUES (:id, :tenant_id, :session_id, 'en-US', 'synthetic', '[]'::jsonb)
            """,
            {**common, "id": uuid4()},
        ),
        (
            "transcript_deliveries",
            """
            INSERT INTO transcript_deliveries (
                id, tenant_id, session_id, idempotency_key, payload_sha256, status
            ) VALUES (
                :id, :tenant_id, :session_id, 'authority-delivery-key', :sha256, 'pending'
            )
            """,
            {**common, "id": uuid4(), "sha256": "b" * 64},
        ),
        (
            "transcription_jobs",
            """
            INSERT INTO transcription_jobs (
                id, tenant_id, session_id, status, attempt_count,
                lease_token, lease_until
            ) VALUES (
                :id, :tenant_id, :session_id, 'processing', 1,
                :lease_token, statement_timestamp() + INTERVAL '5 minutes'
            )
            """,
            {**common, "id": uuid4(), "lease_token": uuid4()},
        ),
        (
            "capture_channel_finalizations",
            """
            INSERT INTO capture_channel_finalizations (
                tenant_id, session_id, channel, last_sequence_number
            ) VALUES (:tenant_id, :session_id, 'system_audio', 2)
            """,
            common,
        ),
    )


def test_normalized_source_authority_migration_has_one_head() -> None:
    script = ScriptDirectory.from_config(Config("alembic.ini"))
    assert script.get_heads() == ["0012"]
    migration = (ROOT / "alembic/versions/0011_normalized_source_authority.py").read_text()
    assert "GRANT " not in migration
    assert "CREATE ROLE" not in migration
    assert "current_database() !~ '_test$'" in migration


@pytest.mark.asyncio
async def test_legacy_child_roots_are_discriminated_and_legacy_behavior_is_unchanged(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
            {"tenant_id": str(tenant_id)},
        )
        configured_id = await _seed_session(connection, tenant_id, configured=True)
        legacy_id = await _seed_session(connection, tenant_id, configured=False)

        configured_inserts = tuple(_legacy_root_inserts(tenant_id, configured_id))
        assert {table for table, _, _ in configured_inserts} == set(LEGACY_CHILD_ROOTS)
        for _, statement, parameters in configured_inserts:
            await _reject(
                connection,
                statement,
                parameters,
                "legacy child root requires an unconfigured session",
            )

        legacy_inserts = tuple(_legacy_root_inserts(tenant_id, legacy_id))
        for _, statement, parameters in legacy_inserts:
            await connection.execute(text(statement), parameters)
        for table, _, _ in legacy_inserts:
            assert (
                await connection.scalar(
                    text(
                        f"SELECT count(*) FROM {table} "
                        "WHERE tenant_id = :tenant_id AND session_id = :session_id"
                    ),
                    {"tenant_id": tenant_id, "session_id": legacy_id},
                )
                == 1
            )

        await _reject(
            connection,
            """
            UPDATE audio_upload_grants SET session_id = :configured_id
            WHERE tenant_id = :tenant_id AND session_id = :legacy_id
            """,
            {
                "tenant_id": tenant_id,
                "legacy_id": legacy_id,
                "configured_id": configured_id,
            },
            "legacy child root requires an unconfigured session",
        )
    await engine.dispose()


@pytest.mark.asyncio
async def test_guard_inventory_forced_rls_and_cross_tenant_failure_are_exact(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, app_url = postgres_urls
    tenant_id, other_tenant_id = uuid4(), uuid4()
    admin = create_async_engine(admin_url, connect_args={"ssl": False})
    async with admin.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
            {"tenant_id": str(other_tenant_id)},
        )
        other_session_id = await _seed_session(connection, other_tenant_id, configured=False)
        guards = await connection.execute(
            text(
                """
                SELECT relation.relname
                FROM pg_catalog.pg_trigger AS trigger
                JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
                JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'public'
                  AND trigger.tgname LIKE '%_legacy_session_only'
                  AND NOT trigger.tgisinternal
                """
            )
        )
        assert {str(row.relname) for row in guards} == set(LEGACY_CHILD_ROOTS)
        rls = await connection.execute(
            text(
                """
                SELECT relname, relrowsecurity, relforcerowsecurity
                FROM pg_catalog.pg_class
                WHERE relnamespace = 'public'::regnamespace
                  AND relname = ANY(:tables)
                """
            ),
            {"tables": list(LEGACY_CHILD_ROOTS)},
        )
        assert {(str(row.relname), row.relrowsecurity, row.relforcerowsecurity) for row in rls} == {
            (table, True, True) for table in LEGACY_CHILD_ROOTS
        }
        assert not await connection.scalar(
            text(
                "SELECT has_function_privilege("
                "'public', 'public.enforce_legacy_child_session_discriminator()', 'EXECUTE')"
            )
        )
    await admin.dispose()

    app = create_async_engine(app_url, connect_args={"ssl": False})
    try:
        async with app.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            assert (
                await connection.scalar(
                    text("SELECT count(*) FROM scribe_sessions WHERE id = :session_id"),
                    {"session_id": other_session_id},
                )
                == 0
            )
            await _reject(
                connection,
                """
                INSERT INTO audio_upload_grants (
                    object_id, tenant_id, session_id, sequence_number, channel, expires_at
                ) VALUES (
                    :object_id, :tenant_id, :session_id, 0, 'microphone',
                    statement_timestamp() + INTERVAL '5 minutes'
                )
                """,
                {
                    "object_id": uuid4(),
                    "tenant_id": other_tenant_id,
                    "session_id": other_session_id,
                },
                "legacy child root requires an unconfigured session|row-level security",
            )
            await _reject(
                connection,
                """
                INSERT INTO audio_upload_grants (
                    object_id, tenant_id, session_id, sequence_number, channel, expires_at
                ) VALUES (
                    :object_id, :tenant_id, :session_id, 0, 'microphone',
                    statement_timestamp() + INTERVAL '5 minutes'
                )
                """,
                {
                    "object_id": uuid4(),
                    "tenant_id": tenant_id,
                    "session_id": uuid4(),
                },
                "legacy child root requires an unconfigured session",
            )
    finally:
        await app.dispose()
