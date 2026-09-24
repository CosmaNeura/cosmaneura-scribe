from __future__ import annotations

import asyncio
import base64
import os
import subprocess
import sys
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from conftest import postgres_settings
from cosmaneura_scribe import database_bootstrap
from cosmaneura_scribe.audio_assembly import AudioAssemblyError
from cosmaneura_scribe.derived_writer_transactions import (
    commit_creator_translation_review_and_publish,
)
from cosmaneura_scribe.external_transcript_v1 import SourceLocale, TranslationReviewDecision
from cosmaneura_scribe.postgres_repository import (
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.postgres_translation_jobs import PostgresTranslationJobStore
from cosmaneura_scribe.schemas import AudioEncryptionPublicKey, RsaPublicJwk, SessionAudioKey
from cosmaneura_scribe.translation_adapter import ReservedSpanishTranslation
from cosmaneura_scribe.translation_execution_v1 import (
    DurableTranslationJobStatus,
    RepositoryCompletedTranslationJobCommitter,
    TranslationExecutionDisposition,
    execute_reserved_translation_job,
)
from cosmaneura_scribe.translation_job_encryption import (
    TranslationJobCipher,
    TranslationJobStoreError,
    job_metadata,
)
from cosmaneura_scribe.translation_job_v1 import CompletedTranslationJobV1
from cosmaneura_scribe.translation_review_persistence import (
    CreatorTranslationReviewCommand,
    TranslationReviewPersistenceError,
)
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine
from test_database_bootstrap import _postgres_settings
from test_normalized_source_persistence import _expire_normalized_source
from test_translation_attempt_persistence import _command, _seed_pending
from test_translation_execution_v1 import _CountingAdapter, _reserved_record

from alembic import command


class _LocalKeys:
    """Generated, disposable test key. Never a runtime key provider."""

    def __init__(self, private: rsa.RSAPrivateKey | None = None) -> None:
        self.private = private or rsa.generate_private_key(public_exponent=65537, key_size=3072)
        self.unwrapped: list[bytearray] = []

    async def get_public_key(self) -> AudioEncryptionPublicKey:
        numbers = self.private.public_key().public_numbers()
        return AudioEncryptionPublicKey(
            key_version="synthetic_local_v1",
            public_jwk=RsaPublicJwk(
                n=base64.urlsafe_b64encode(numbers.n.to_bytes(384)).decode().rstrip("="),
                e="AQAB",
            ),
        )

    def versioned_key_id(self, key_version: str) -> str | None:
        return None

    async def unwrap(self, value: SessionAudioKey) -> bytearray:
        if value.key_version != "synthetic_local_v1":
            raise AudioAssemblyError("synthetic_key_unavailable")
        try:
            key = bytearray(
                self.private.decrypt(
                    base64.urlsafe_b64decode(value.wrapped_dek),
                    padding.OAEP(
                        mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
                    ),
                )
            )
        except ValueError:
            raise AudioAssemblyError("synthetic_unwrap_failed") from None
        self.unwrapped.append(key)
        return key

    async def close(self) -> None:
        pass


def test_cipher_roundtrip_fresh_keys_hidden_repr_and_zeroed_unwrapped_keys() -> None:
    async def scenario() -> None:
        keys = _LocalKeys()
        cipher = TranslationJobCipher(keys, keys)
        record = _reserved_record()
        expiry = record.reserved_at + timedelta(days=14)
        first = await cipher.seal(record, expires_at=expiry)
        second = await cipher.seal(record, expires_at=expiry)
        assert first != second and first.wrapped_dek != second.wrapped_dek
        assert record.reservation.source_content.encode() not in first.ciphertext
        restored = await cipher.open(first, metadata=job_metadata(record, expiry))
        assert restored == record
        assert all(key == bytearray(32) for key in keys.unwrapped)
        assert record.reservation.source_content not in repr((first, cipher, restored))

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "mutation",
    [
        "tenant",
        "session",
        "job",
        "expiry",
        "status",
        "ciphertext",
        "nonce",
        "wrapped_key",
        "key_version",
        "wrong_key",
    ],
)
def test_cipher_rejects_tampering(mutation: str) -> None:
    async def scenario() -> None:
        keys = _LocalKeys()
        cipher = TranslationJobCipher(keys, keys)
        record = _reserved_record()
        expiry = record.reserved_at + timedelta(days=14)
        envelope = await cipher.seal(record, expires_at=expiry)
        metadata = job_metadata(record, expiry)
        if mutation in {"tenant", "session", "job"}:
            metadata[
                {"tenant": "tenant_id", "session": "session_id", "job": "translation_id"}[mutation]
            ] = uuid4()
        elif mutation == "expiry":
            metadata["expires_at"] += timedelta(days=1)
        elif mutation == "status":
            metadata["status"] = "provider_call_started"
        elif mutation in {"ciphertext", "nonce"}:
            value = getattr(envelope, mutation)
            envelope = replace(envelope, **{mutation: bytes([value[0] ^ 1]) + value[1:]})
        elif mutation == "wrapped_key":
            envelope = replace(envelope, wrapped_dek="A" * 512)
        elif mutation == "key_version":
            envelope = replace(envelope, key_version="unapproved")
        else:
            wrong = _LocalKeys()
            cipher = TranslationJobCipher(wrong, wrong)
        with pytest.raises(TranslationJobStoreError) as error:
            await cipher.open(envelope, metadata=metadata)
        assert record.reservation.source_content not in str(error.value)
        assert error.value.__context__ is None and error.value.__cause__ is None
        assert all(key == bytearray(32) for key in keys.unwrapped)

    asyncio.run(scenario())


async def _setup(app_url: str):
    provider = build_postgres_provider(postgres_settings(app_url))
    tenant = uuid4()
    draft, spanish, _ = await _seed_pending(provider, tenant)
    reservation = ReservedSpanishTranslation(
        translation_id=uuid4(),
        expected_source_transcript_version=1,
        source_segment_id=spanish.source_segment_id,
        expected_source_segment_version=spanish.source_segment_version,
        expected_previous_translation_version=0,
        source_locale=SourceLocale.SPANISH_US,
        source_content=spanish.content,
    )
    keys = _LocalKeys()
    store = PostgresTranslationJobStore(provider.engine, TranslationJobCipher(keys, keys))
    return provider, tenant, draft, reservation, keys, store


async def _execute(store, provider, tenant, draft, reservation, adapter):
    return await execute_reserved_translation_job(
        store=store,
        adapter=adapter,
        committer=RepositoryCompletedTranslationJobCommitter(provider),
        tenant_id=tenant,
        session_id=draft.id,
        translation_id=reservation.translation_id,
        provider_call_token=uuid4(),
    )


@pytest.mark.postgres
def test_real_store_to_existing_attempt_and_creator_review(postgres_urls) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, keys, store = await _setup(postgres_urls[1])
        try:
            first = await store.reserve_translation_job(tenant, draft.id, reservation)
            assert await store.reserve_translation_job(tenant, draft.id, reservation) == first
            with pytest.raises(TranslationJobStoreError):
                await store.reserve_translation_job(
                    tenant,
                    draft.id,
                    replace(reservation, source_content="Synthetic mismatched source."),
                )
            with pytest.raises(TranslationJobStoreError):
                await store.reserve_translation_job(
                    tenant, draft.id, replace(reservation, translation_id=uuid4())
                )
            adapter = _CountingAdapter(expected_source=reservation.source_content)
            receipt = await _execute(store, provider, tenant, draft, reservation, adapter)
            assert receipt.disposition == TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
            assert adapter.call_count == 1
            reloaded = await store.get_translation_job(tenant, draft.id, reservation.translation_id)
            assert reloaded.status == DurableTranslationJobStatus.ATTEMPT_COMMITTED
            assert (
                await _execute(store, provider, tenant, draft, reservation, adapter)
            ).disposition == TranslationExecutionDisposition.ALREADY_COMMITTED
            assert adapter.call_count == 1
            review = CreatorTranslationReviewCommand(
                review_id=uuid4(),
                expected_source_transcript_version=1,
                source_segment_id=reservation.source_segment_id,
                expected_source_segment_version=1,
                translation_id=reservation.translation_id,
                expected_translation_version=1,
                decision=TranslationReviewDecision.ACCEPTED,
                reviewer_actor_id="not_the_creator",
                reviewed_at=datetime.now(UTC),
            )
            with pytest.raises(TranslationReviewPersistenceError):
                await commit_creator_translation_review_and_publish(
                    provider, tenant, draft.id, review
                )
            publication = await commit_creator_translation_review_and_publish(
                provider,
                tenant,
                draft.id,
                replace(review, reviewer_actor_id=draft.creator_actor_id),
            )
            assert publication.status.value == "transcript_ready"
            assert all(key == bytearray(32) for key in keys.unwrapped)
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :t, true)"), {"t": str(tenant)}
                )
                row = (
                    await connection.execute(text("SELECT * FROM encrypted_translation_jobs"))
                ).one()
                assert reservation.source_content not in str(row)
                assert adapter.expected_source.encode() not in row.ciphertext
                assert reloaded.completed_job.content.encode() not in row.ciphertext
                events = (
                    (
                        await connection.execute(
                            text(
                                "SELECT action FROM audit_events "
                                "WHERE tenant_id = :t AND entity_id = :id"
                            ),
                            {"t": tenant, "id": reservation.translation_id},
                        )
                    )
                    .scalars()
                    .all()
                )
                assert set(events) >= {
                    "translation_job.reserved",
                    "translation_job.provider_call_started",
                    "translation_job.provider_result_stored",
                    "translation_job.attempt_committed",
                }
        finally:
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_wrong_tenant_rls_and_competing_claims(postgres_urls) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, keys, store = await _setup(postgres_urls[1])
        other = build_postgres_provider(postgres_settings(postgres_urls[1]))
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            assert (
                await store.get_translation_job(uuid4(), draft.id, reservation.translation_id)
                is None
            )
            assert (
                await store.get_translation_job(tenant, uuid4(), reservation.translation_id) is None
            )
            async with other.engine.begin() as connection:
                assert (
                    await connection.execute(text("SELECT * FROM encrypted_translation_jobs"))
                ).all() == []
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :t, true)"), {"t": str(uuid4())}
                )
                assert (
                    await connection.execute(text("SELECT * FROM encrypted_translation_jobs"))
                ).all() == []
            second = PostgresTranslationJobStore(other.engine, TranslationJobCipher(keys, keys))
            winners = await asyncio.gather(
                *[
                    worker.claim_provider_call(
                        tenant, draft.id, reservation.translation_id, provider_call_token=uuid4()
                    )
                    for worker in (store, second)
                ]
            )
            assert sum(record is not None for record in winners) == 1
            adapter = _CountingAdapter(expected_source=reservation.source_content)
            assert (
                await _execute(second, other, tenant, draft, reservation, adapter)
            ).disposition == TranslationExecutionDisposition.PROVIDER_CALL_NOT_REPLAYED
            assert adapter.call_count == 0
        finally:
            await other.close()
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
@pytest.mark.parametrize(
    "failure", ["after_claim", "before_result", "after_result", "after_marker", "after_writer"]
)
def test_lost_acknowledgements_never_repeat_provider(postgres_urls, failure: str) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, keys, store = await _setup(postgres_urls[1])
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            adapter = _CountingAdapter(expected_source=reservation.source_content)

            class LostAckStore(PostgresTranslationJobStore):
                async def claim_provider_call(self, *args, **kwargs):
                    result = await super().claim_provider_call(*args, **kwargs)
                    if failure == "after_claim":
                        raise OSError("synthetic_lost_claim_ack")
                    return result

                async def store_provider_result(self, *args, **kwargs):
                    if failure == "before_result":
                        raise OSError("synthetic_lost_result")
                    result = await super().store_provider_result(*args, **kwargs)
                    if failure == "after_result":
                        raise OSError("synthetic_lost_result_ack")
                    return result

                async def mark_attempt_committed(self, *args, **kwargs):
                    if failure == "after_writer":
                        raise OSError("synthetic_lost_writer_ack")
                    result = await super().mark_attempt_committed(*args, **kwargs)
                    if failure == "after_marker":
                        raise OSError("synthetic_lost_marker_ack")
                    return result

            failing = LostAckStore(provider.engine, TranslationJobCipher(keys, keys))
            with pytest.raises(OSError):
                await _execute(failing, provider, tenant, draft, reservation, adapter)
            expected_calls = 0 if failure == "after_claim" else 1
            assert adapter.call_count == expected_calls
            receipt = await _execute(store, provider, tenant, draft, reservation, adapter)
            expected = (
                TranslationExecutionDisposition.PROVIDER_CALL_NOT_REPLAYED
                if failure in {"before_result", "after_claim"}
                else TranslationExecutionDisposition.ALREADY_COMMITTED
                if failure == "after_marker"
                else TranslationExecutionDisposition.STORED_RESULT_COMMITTED
            )
            assert receipt.disposition == expected and adapter.call_count == expected_calls
        finally:
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_revocation_wins_before_claim_and_blocks_read(postgres_urls) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, _, store = await _setup(postgres_urls[1])
        revoker = build_postgres_provider(postgres_settings(postgres_urls[1]))
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            async with revoker.transaction(tenant) as repository:
                await repository.revoke_consent(tenant, draft.consent_record_id)
                claim = asyncio.create_task(
                    store.claim_provider_call(
                        tenant, draft.id, reservation.translation_id, provider_call_token=uuid4()
                    )
                )
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(claim), timeout=0.1)
            with pytest.raises(TranslationJobStoreError, match="authority_invalid"):
                await claim
            with pytest.raises(TranslationJobStoreError, match="authority_invalid"):
                await store.get_translation_job(tenant, draft.id, reservation.translation_id)
        finally:
            await revoker.close()
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_expiry_cleanup_cascades_and_direct_reset_is_forbidden(postgres_urls) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, _, store = await _setup(postgres_urls[1])
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            for sql in (
                "DELETE FROM encrypted_translation_jobs WHERE tenant_id = :t",
                "UPDATE encrypted_translation_jobs SET status = 'reserved' WHERE tenant_id = :t",
            ):
                with pytest.raises(DBAPIError):
                    async with provider.engine.begin() as connection:
                        await connection.execute(
                            text("SELECT set_config('app.tenant_id', :t, true)"), {"t": str(tenant)}
                        )
                        await connection.execute(text(sql), {"t": tenant})
            await _expire_normalized_source(provider, tenant, draft.id, admin_url=postgres_urls[0])
            with pytest.raises(TranslationJobStoreError):
                await store.claim_provider_call(
                    tenant, draft.id, reservation.translation_id, provider_call_token=uuid4()
                )
            async with provider.transaction(tenant) as repository:
                result = await repository.purge_normalized_source_content(tenant, draft.id)
                assert result is not None
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :t, true)"), {"t": str(tenant)}
                )
                assert (
                    await connection.scalar(text("SELECT count(*) FROM encrypted_translation_jobs"))
                    == 0
                )
        finally:
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_no_commit_marker_without_exact_immutable_attempt(postgres_urls) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, _, store = await _setup(postgres_urls[1])
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            token = uuid4()
            await store.claim_provider_call(
                tenant, draft.id, reservation.translation_id, provider_call_token=token
            )
            completed = CompletedTranslationJobV1.from_command(
                tenant_id=tenant,
                session_id=draft.id,
                command=_command(
                    1, reservation.source_segment_id, 1, translation_id=reservation.translation_id
                ),
            )
            with pytest.raises(TranslationJobStoreError, match="result_conflict"):
                await store.store_provider_result(
                    tenant,
                    draft.id,
                    reservation.translation_id,
                    provider_call_token=uuid4(),
                    completed_job=completed,
                )
            await store.store_provider_result(
                tenant,
                draft.id,
                reservation.translation_id,
                provider_call_token=token,
                completed_job=completed,
            )
            with pytest.raises(TranslationJobStoreError, match="attempt_not_committed"):
                await store.mark_attempt_committed(
                    tenant,
                    draft.id,
                    reservation.translation_id,
                    completed_job_fingerprint=completed.fingerprint(),
                )
            with pytest.raises(TranslationJobStoreError, match="commit_conflict"):
                await store.mark_attempt_committed(
                    tenant,
                    draft.id,
                    reservation.translation_id,
                    completed_job_fingerprint="not_the_result",
                )
        finally:
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_fresh_process_reads_committed_ciphertext(postgres_urls, tmp_path: Path) -> None:
    async def prepare():
        provider, tenant, draft, reservation, keys, store = await _setup(postgres_urls[1])
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            await store.claim_provider_call(
                tenant, draft.id, reservation.translation_id, provider_call_token=uuid4()
            )
            key_path = tmp_path / "disposable-test-key.pem"
            with key_path.open("xb") as output:
                os.chmod(key_path, 0o600)
                output.write(
                    keys.private.private_bytes(
                        serialization.Encoding.PEM,
                        serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption(),
                    )
                )
            return tenant, draft.id, reservation.translation_id, key_path
        finally:
            await provider.close()

    tenant, session, job, key_path = asyncio.run(prepare())
    result = subprocess.run(
        [sys.executable, __file__, str(tenant), str(session), str(job), str(key_path)],
        env={
            **os.environ,
            "SCRIBE_DISPOSABLE_RESTART_URL": postgres_urls[1],
            "PYTHONPATH": os.pathsep.join(["services/api/src", "tests"]),
        },
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    assert result.stdout.strip() == "provider_call_started"


@pytest.mark.postgres
def test_used_expand_refuses_downgrade(historical_postgres_url) -> None:
    async def prepare() -> None:
        provider, tenant, draft, reservation, _, store = await _setup(historical_postgres_url)
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
        finally:
            await provider.close()

    asyncio.run(prepare())
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", historical_postgres_url.replace("%", "%%"))
    with pytest.raises(DBAPIError, match="translation job downgrade after it has been used"):
        command.downgrade(config, "0014")


@pytest.mark.postgres
@pytest.mark.parametrize("fault", ["ciphertext", "source_content", "source_pointer", "expiry"])
def test_database_faults_fail_before_provider(postgres_urls, fault: str) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, _, store = await _setup(postgres_urls[1])
        admin = create_async_engine(postgres_urls[0], connect_args={"ssl": False})
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            # Explicit fault injection in the disposable database, not a runtime grant.
            statements = {
                "ciphertext": "UPDATE encrypted_translation_jobs SET ciphertext = "
                "set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) "
                "WHERE tenant_id = :t AND session_id = :s",
                "source_content": "UPDATE normalized_source_segments SET content = "
                "'Synthetic changed Spanish source.' "
                "WHERE tenant_id = :t AND session_id = :s AND source_locale = 'es-US'",
                "source_pointer": "UPDATE scribe_sessions "
                "SET current_source_transcript_version = 2 "
                "WHERE tenant_id = :t AND id = :s",
                "expiry": "UPDATE encrypted_translation_jobs SET expires_at = expires_at + "
                "INTERVAL '1 day' WHERE tenant_id = :t AND session_id = :s",
            }
            async with admin.begin() as connection:
                await connection.execute(text("SET LOCAL session_replication_role = replica"))
                await connection.execute(text(statements[fault]), {"t": tenant, "s": draft.id})
            adapter = _CountingAdapter(expected_source=reservation.source_content)
            with pytest.raises(TranslationJobStoreError) as error:
                await _execute(store, provider, tenant, draft, reservation, adapter)
            assert adapter.call_count == 0
            assert error.value.__context__ is None
        finally:
            await admin.dispose()
            await provider.close()

    asyncio.run(scenario())


@pytest.mark.postgres
def test_transaction_error_drops_raw_sql_context(postgres_urls) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, _, store = await _setup(postgres_urls[1])
        try:
            await store.reserve_translation_job(tenant, draft.id, reservation)
            with pytest.raises(TranslationJobStoreError) as error:
                await store.reserve_translation_job(
                    tenant, draft.id, replace(reservation, translation_id=uuid4())
                )
            assert error.value.__context__ is None and error.value.__cause__ is None
        finally:
            await provider.close()

    asyncio.run(scenario())


def test_expand_keeps_explicit_reads_and_no_runtime_authority() -> None:
    migration = (
        Path(__file__).resolve().parents[1] / "alembic/versions/0018_encrypted_translation_jobs.py"
    ).read_text()
    assert "%ROWTYPE" not in migration and "SELECT *" not in migration
    assert "SECURITY DEFINER" not in migration and "GRANT " not in migration
    assert "CREATE ROLE" not in migration
    assert "FORCE ROW LEVEL SECURITY" in migration
    assert "ON DELETE CASCADE" in migration
    assert "DEFERRABLE INITIALLY DEFERRED" in migration
    assert "current_database()" in migration


@pytest.mark.postgres
def test_existing_translation_grants_plus_job_only_access_are_sufficient(postgres_urls) -> None:
    async def scenario() -> None:
        provider, tenant, draft, reservation, keys, _ = await _setup(postgres_urls[1])
        role = "scribe_encrypted_job_qualification"
        settings = _postgres_settings(
            postgres_urls[0], derived_permissions_enabled=True
        ).model_copy(update={"database_translation_principal_name": role})
        admin = create_async_engine(postgres_urls[0], connect_args={"ssl": False})
        worker = None
        try:
            async with admin.begin() as connection:
                await connection.execute(
                    text(f"CREATE ROLE {role} NOLOGIN NOSUPERUSER NOBYPASSRLS")
                )
            # Reuse the actual dormant grants only in this disposable database.
            await database_bootstrap._grant_translation_permissions(settings)
            async with admin.begin() as connection:
                await connection.execute(
                    text(f"GRANT SELECT, INSERT ON encrypted_translation_jobs TO {role}")
                )
                await connection.execute(
                    text(
                        "GRANT UPDATE (status, provider_call_started_at, "
                        "provider_result_stored_at, "
                        "attempt_committed_at, key_version, wrapped_dek, nonce, ciphertext) "
                        f"ON encrypted_translation_jobs TO {role}"
                    )
                )
                assert not await connection.scalar(
                    text(
                        "SELECT has_column_privilege(:role, 'consent_records', "
                        "'revoked_at', 'UPDATE')"
                    ),
                    {"role": role},
                )
                assert not await connection.scalar(
                    text(
                        "SELECT has_column_privilege(:role, 'normalized_translation_reviews', "
                        "'decision', 'INSERT')"
                    ),
                    {"role": role},
                )
                assert not await connection.scalar(
                    text(
                        "SELECT has_table_privilege(:role, 'encrypted_translation_jobs', 'DELETE')"
                    ),
                    {"role": role},
                )
            # Start each connection as the exact constrained NOLOGIN worker role.
            engine = create_async_engine(
                postgres_urls[0], connect_args={"ssl": False, "server_settings": {"role": role}}
            )
            worker = PostgresRepositoryProvider(engine)
            async with engine.connect() as connection:
                assert await connection.scalar(text("SELECT current_user")) == role
            store = PostgresTranslationJobStore(engine, TranslationJobCipher(keys, keys))
            await store.reserve_translation_job(tenant, draft.id, reservation)
            adapter = _CountingAdapter(expected_source=reservation.source_content)
            receipt = await _execute(store, worker, tenant, draft, reservation, adapter)
            assert receipt.disposition == TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
            assert adapter.call_count == 1
        finally:
            if worker is not None:
                await worker.close()
            async with admin.begin() as connection:
                policy = database_bootstrap._translation_session_scope_policy_name(
                    settings.database_translation_principal_object_id
                )
                await connection.execute(text(f"DROP POLICY IF EXISTS {policy} ON scribe_sessions"))
                await connection.execute(text(f"DROP OWNED BY {role}"))
                await connection.execute(text(f"DROP ROLE {role}"))
            await admin.dispose()
            await provider.close()

    asyncio.run(scenario())


async def _restart_probe() -> None:
    private = serialization.load_pem_private_key(
        await asyncio.to_thread(Path(sys.argv[4]).read_bytes), password=None
    )
    assert isinstance(private, rsa.RSAPrivateKey)
    keys = _LocalKeys(private)
    engine = create_async_engine(
        os.environ["SCRIBE_DISPOSABLE_RESTART_URL"], connect_args={"ssl": False}
    )
    try:
        store = PostgresTranslationJobStore(engine, TranslationJobCipher(keys, keys))
        record = await store.get_translation_job(*(UUID(value) for value in sys.argv[1:4]))
        assert record is not None
        print(record.status.value)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_restart_probe())
