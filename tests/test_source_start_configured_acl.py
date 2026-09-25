"""Offline PostgreSQL lifecycle and least-privilege regression evidence.

Use a fresh caller-owned *_test database. Retain its immutable source history.
No cloud identity, audio device, network provider or installed native app is used.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from conftest import verified_test_tenant
from cosmaneura_scribe import database_bootstrap
from cosmaneura_scribe.audio_assembly import (
    EncryptedBlobAudioTrackAssembler,
    RepositoryAudioAssemblyManifestProvider,
)
from cosmaneura_scribe.captured_source_runtime import (
    CapturedSourceRepositoryProvider,
    CapturedSourceRuntime,
    CapturedSourceUnavailable,
)
from cosmaneura_scribe.captured_transcription_worker import CapturedTranscriptionWorker
from cosmaneura_scribe.captured_translation_worker import CapturedTranslationWorker
from cosmaneura_scribe.main import (
    app,
    get_audio_encryption_key_provider,
    get_repository_provider,
)
from cosmaneura_scribe.normalized_source_persistence import CapturedSessionCreate
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings, get_settings
from cosmaneura_scribe.source_start_contract import (
    SourceStartCapability,
    SourceStartIntent,
    SourceStartReceipt,
    SourceStartRetirementReceipt,
    StartAction,
)
from cosmaneura_scribe.source_start_runtime import (
    SourceStartConflict,
    SourceStartRepositoryProvider,
    SourceStartRuntime,
    SourceStartUnavailable,
)
from cosmaneura_scribe.transcription_worker import TranscriptionWorkerError
from cosmaneura_scribe.translation_job_encryption import TranslationJobCipher
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from test_audio_assembly import WRAPPED_DEK, StaticKeyUnwrapper
from test_capture_protocol_api import CaptureKeyProvider
from test_captured_source_runtime import SPANISH, Trial
from test_captured_transcription_worker import CaptureHarness
from test_captured_transcription_worker import capture as capture
from test_encrypted_translation_jobs import _LocalKeys
from test_normalized_source_persistence import _consent, _draft
from test_translation_execution_v1 import _CountingAdapter

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


@dataclass
class Scope:
    settings: Settings
    tenant: UUID
    admin: AsyncEngine
    runtime: AsyncEngine
    speech: AsyncEngine
    translation: AsyncEngine

    async def query(self, engine: AsyncEngine, tenant_scope: UUID, sql: str, **params: object):
        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :scope, true)"),
                {"scope": str(tenant_scope)},
            )
            return await connection.execute(text(sql), params)

    async def trial(self, tenant: UUID | None = None) -> Trial:
        tenant = tenant or self.tenant
        provider = CapturedSourceRepositoryProvider(self.runtime)
        runtime = CapturedSourceRuntime(provider, enabled=True)
        consent = _consent()
        draft = CapturedSessionCreate(**asdict(_draft(consent)))
        async with provider.transaction(tenant) as store:
            await store.add_consent(tenant, consent)
        await runtime.admit(tenant_id=tenant, draft=draft)
        assert self.settings.database_url is not None
        return Trial(
            provider, runtime, tenant, consent, draft, self.settings.database_url.get_secret_value()
        )

    async def capture(
        self, tenant: UUID | None = None, *, reservation_count: int = 1,
    ) -> tuple[Trial, SourceStartIntent]:
        trial = await self.trial(tenant)
        tenant, draft, provider = trial.tenant, trial.draft, trial.provider
        settings = Settings(
            capture_protocol_enabled=True,
            repository_backend="postgres",
            database_url=self.settings.database_url,
            database_ssl=False,
            workflow_authentication_enabled=True,
            entra_tenant_id=uuid4(),
            workflow_api_audience=str(uuid4()),
            trusted_platform_client_id=uuid4(),
        )
        overrides = dict(app.dependency_overrides)
        app.dependency_overrides.update(
            {
                get_repository_provider: lambda: provider,
                get_settings: lambda: settings,
                get_verified_tenant_id: verified_test_tenant,
                get_audio_encryption_key_provider: CaptureKeyProvider,
            }
        )
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://synthetic.invalid",
                headers={"X-Tenant-ID": str(tenant)},
            ) as client:
                path = f"/v1/sessions/{draft.id}"
                key = await client.post(
                    f"{path}/audio-key",
                    json={
                        "key_version": "capture-key-version",
                        "wrapped_dek": WRAPPED_DEK,
                    },
                    headers={"Idempotency-Key": "source-key-0001"},
                )
                assert key.status_code == 201
                lease = await client.post(
                    f"{path}/capture-lease",
                    json={
                        "protocol_version": "1.0",
                    },
                    headers={"Idempotency-Key": "source-lease-0001"},
                )
                assert lease.status_code == 201
                current = lease.json()
                for first in range(0, reservation_count, 90):
                    reservation = await client.post(
                        f"{path}/chunk-reservations",
                        json={
                            "protocol_version": "1.0",
                            "capture_lease_id": current["lease_id"],
                            "capture_lease_generation": current["generation"],
                            "channel": "mixed",
                            "first_sequence_number": first,
                            "count": min(90, reservation_count - first),
                        },
                        headers={"Idempotency-Key": f"source-reserve-{first:04d}"},
                    )
                    assert reservation.status_code == 201
                    assert reservation.json()["capture_authorized_until"] == current["expires_at"]
        finally:
            app.dependency_overrides.clear()
            app.dependency_overrides.update(overrides)
        return trial, SourceStartIntent(
            attempt_id=uuid4(),
            source="desktop_companion",
            owner_proof=SecretStr("a" * 64),
            lease_id=current["lease_id"],
            lease_receipt_id=current["receipt_id"],
            lease_generation=current["generation"],
            capture_authorized_until=current["expires_at"],
        )

    def source(self) -> SourceStartRuntime:
        return SourceStartRuntime(
            SourceStartRepositoryProvider(self.runtime),
            tenant_ids=frozenset({self.tenant}),
            enabled=True,
        )


@pytest_asyncio.fixture
async def scope(postgres_urls: tuple[str, str]) -> AsyncIterator[Scope]:
    source_database = postgres_urls[0]
    database_name = make_url(source_database).database
    assert database_name is not None and database_name.endswith("_test")
    tenant, token = uuid4(), uuid4().hex
    roles = {stage: f"scribe_probe_{stage}_{token}" for stage in ("run", "stt", "trn")}
    settings = Settings(
        repository_backend="postgres",
        database_url=SecretStr(source_database),
        database_name=database_name,
        database_ssl=False,
        derived_writer_database_permissions_enabled=True,
        configured_worker_database_permissions_enabled=True,
        configured_capture_tenant_ids=frozenset({tenant}),
        database_runtime_principal_name=roles["run"],
        database_runtime_principal_object_id=uuid4(),
        database_transcription_principal_name=roles["stt"],
        database_transcription_principal_object_id=uuid4(),
        database_translation_principal_name=roles["trn"],
        database_translation_principal_object_id=uuid4(),
    )
    admin = create_async_engine(source_database, connect_args={"ssl": False})
    engines: list[AsyncEngine] = [admin]
    try:
        async with admin.begin() as connection:
            for role in roles.values():
                await connection.execute(
                    text(f"CREATE ROLE {role} NOLOGIN NOSUPERUSER NOBYPASSRLS")
                )
        await database_bootstrap._deny_implicit_future_permissions(settings)
        await database_bootstrap._grant_runtime_permissions(settings)
        await database_bootstrap._grant_transcription_permissions(settings)
        await database_bootstrap._grant_translation_permissions(settings)
        await database_bootstrap._grant_configured_worker_permissions(settings)
        for role in roles.values():
            engine = create_async_engine(
                source_database,
                connect_args={
                    "ssl": False,
                    "server_settings": {"role": role},
                },
            )
            engines.append(engine)
            async with engine.connect() as connection:
                assert await connection.scalar(text("SELECT current_user")) == role
                assert (
                    await connection.scalar(
                        text(
                            "SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles "
                            "WHERE rolname=current_user"
                        )
                    )
                    is True
                )
                assert (
                    await connection.scalar(
                        text(
                            "SELECT pg_get_userbyid(datdba) <> current_user "
                            "FROM pg_database WHERE datname=current_database()"
                        )
                    )
                    is True
                )
        yield Scope(settings, tenant, *engines)
    finally:
        for engine in reversed(engines):
            await engine.dispose()
        # Retain all generated roles, policies and immutable rows in the owned database.


@pytest_asyncio.fixture
async def trial(scope: Scope) -> Trial:
    # Override the imported capture harness's usual fixture, which deletes its rows.
    return await scope.trial()


async def _act(
    runtime: SourceStartRuntime,
    trial: Trial,
    intent: SourceStartIntent,
    action: StartAction,
    key: str | None = None,
):
    return await runtime.act(
        trial.tenant,
        trial.draft.id,
        trial.draft.creator_actor_id,
        key or f"source-{action}-0001",
        action,
        intent,
    )


async def test_runtime_grants_prepare_authorize_exact_replay_and_identity(scope: Scope) -> None:
    trial, intent = await scope.capture()
    runtime = scope.source()
    with pytest.raises(SourceStartUnavailable):
        await _act(
            SourceStartRuntime(runtime.repositories, tenant_ids=runtime.tenant_ids),
            trial,
            intent,
            "prepare",
        )
    prepared = await _act(runtime, trial, intent, "prepare")
    assert isinstance(prepared, SourceStartReceipt) and prepared.state == "prepared"
    assert await _act(runtime, trial, intent, "prepare") == prepared
    for actor in ("other_synthetic_actor", "invalid actor"):
        with pytest.raises(SourceStartUnavailable):
            await runtime.act(
                trial.tenant, trial.draft.id, actor, "foreign-actor-0001", "authorize", intent
            )
    with pytest.raises(SourceStartUnavailable):
        await runtime.act(
            uuid4(),
            trial.draft.id,
            trial.draft.creator_actor_id,
            "foreign-tenant-0001",
            "authorize",
            intent,
        )
    changed_proof = intent.model_copy(update={"owner_proof": SecretStr("b" * 64)})
    with pytest.raises(SourceStartConflict):
        await _act(runtime, trial, changed_proof, "authorize", "wrong-proof-0001")
    issued = await _act(runtime, trial, intent, "authorize")
    assert isinstance(issued, SourceStartCapability) and issued.receipt.state == "issued"
    assert await _act(runtime, trial, intent, "authorize") == issued
    assert await _act(runtime, trial, intent, "authorize", "new-replay-key-0001") == issued
    assert issued.receipt.expires_at is not None and issued.receipt.issued_at is not None
    assert (issued.receipt.expires_at - issued.receipt.issued_at).total_seconds() <= 15
    with pytest.raises(SourceStartConflict):
        await _act(
            runtime,
            trial,
            intent.model_copy(update={"attempt_id": uuid4()}),
            "prepare",
            "competing-start-0001",
        )
    rows = (
        await scope.query(
            scope.admin,
            trial.tenant,
            "SELECT state, owner_proof_sha256 FROM source_start_attempts "
            "WHERE tenant_id=:tenant AND session_id=:session",
            tenant=trial.tenant,
            session=trial.draft.id,
        )
    ).all()
    assert rows == [("issued", intent.proof_digest)]
    actions = (
        await scope.query(
            scope.admin,
            trial.tenant,
            "SELECT action FROM audit_events WHERE tenant_id=:tenant "
            "AND action LIKE 'source_start.%' ORDER BY occurred_at, id",
            tenant=trial.tenant,
        )
    ).scalars()
    assert list(actions) == ["source_start.prepared", "source_start.issued"]


async def test_stop_and_unstarted_retirement_are_terminal_and_survive_revocation(scope: Scope):
    trial, intent = await scope.capture()
    runtime = scope.source()
    await _act(runtime, trial, intent, "prepare")
    await _act(runtime, trial, intent, "authorize")
    stopped = await _act(runtime, trial, intent, "stop")
    assert isinstance(stopped, SourceStartReceipt) and stopped.state == "stopped"
    assert await _act(runtime, trial, intent, "stop") == stopped
    assert await _act(runtime, trial, intent, "prepare", "stopped-prepare-0001") == stopped
    with pytest.raises(SourceStartConflict):
        await _act(runtime, trial, intent, "authorize", "stopped-authorize-0001")
    unstarted = intent.model_copy(update={"attempt_id": uuid4()})
    retired = await _act(runtime, trial, unstarted, "stop", "retire-before-start-0001")
    assert isinstance(retired, SourceStartRetirementReceipt) and retired.state == "unstarted"
    assert await _act(runtime, trial, unstarted, "stop", "retire-before-start-0001") == retired
    for action in ("prepare", "authorize"):
        with pytest.raises(SourceStartConflict):
            await _act(runtime, trial, unstarted, action, f"retired-{action}-0001")
    await scope.query(
        scope.runtime,
        trial.tenant,
        "UPDATE consent_records SET revoked_at=clock_timestamp() "
        "WHERE tenant_id=:tenant AND id=:id",
        tenant=trial.tenant,
        id=trial.consent.id,
    )
    assert await _act(runtime, trial, intent, "stop") == stopped
    assert await _act(runtime, trial, unstarted, "stop", "retire-before-start-0001") == retired
    with pytest.raises(SourceStartUnavailable):
        await _act(
            runtime,
            trial,
            intent.model_copy(update={"attempt_id": uuid4()}),
            "prepare",
            "revoked-prepare-0001",
        )
    for sql in (
        "DELETE FROM source_start_attempts WHERE attempt_id=:attempt",
        "UPDATE source_start_attempts SET owner_proof_sha256='changed' WHERE attempt_id=:attempt",
        "DELETE FROM source_start_retirements WHERE attempt_id=:attempt",
    ):
        with pytest.raises(DBAPIError):
            await scope.query(scope.runtime, trial.tenant, sql, attempt=intent.attempt_id)
    assert (
        await scope.query(
            scope.admin,
            trial.tenant,
            "SELECT count(*) FROM source_start_attempts WHERE tenant_id=:tenant",
            tenant=trial.tenant,
        )
    ).scalar_one() == 1
    assert (
        await scope.query(
            scope.admin,
            trial.tenant,
            "SELECT count(*) FROM source_start_retirements WHERE tenant_id=:tenant",
            tenant=trial.tenant,
        )
    ).scalar_one() == 1


async def test_prepared_stop_cancels_and_wrong_proof_cannot_retire(scope: Scope):
    trial, intent = await scope.capture()
    runtime = scope.source()
    await _act(runtime, trial, intent, "prepare")
    changed_proof = intent.model_copy(update={"owner_proof": SecretStr("b" * 64)})
    with pytest.raises(SourceStartConflict):
        await _act(runtime, trial, changed_proof, "stop", "wrong-stop-proof-0001")
    stopped = await _act(runtime, trial, intent, "stop")
    assert isinstance(stopped, SourceStartReceipt) and stopped.state == "cancelled"
    assert await _act(runtime, trial, intent, "stop") == stopped
    with pytest.raises(SourceStartConflict):
        await _act(runtime, trial, intent, "authorize")


async def test_configured_worker_real_publication_translation_and_tenant_fences(scope: Scope):
    trial, _ = await scope.capture()
    foreign, _ = await scope.capture(uuid4())
    completion = await trial.processing()
    foreign_completion = await foreign.processing()
    speech = CapturedSourceRuntime(CapturedSourceRepositoryProvider(scope.speech), enabled=True)
    with pytest.raises(CapturedSourceUnavailable):
        await speech.publish_speech_result(
            tenant_id=foreign.tenant, session_id=foreign.draft.id, completion=foreign_completion
        )
    published = await speech.publish_speech_result(
        tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
    )
    assert published.working.status.value == "translation_pending"
    # Seed the foreign control through its runtime role; workers must still not see it.
    await foreign.runtime.publish_speech_result(
        tenant_id=foreign.tenant, session_id=foreign.draft.id, completion=foreign_completion
    )
    keys, adapter = _LocalKeys(), _CountingAdapter(expected_source=SPANISH)
    worker = CapturedTranslationWorker(
        repositories=CapturedSourceRepositoryProvider(scope.translation),
        translator=adapter,
        job_cipher=TranslationJobCipher(keys, keys),
        enabled=True,
    )
    with pytest.raises(CapturedSourceUnavailable):
        await worker.process(tenant_id=foreign.tenant, session_id=foreign.draft.id)
    await worker.process(tenant_id=trial.tenant, session_id=trial.draft.id)
    await worker.process(tenant_id=trial.tenant, session_id=trial.draft.id)
    assert adapter.call_count == 1
    jobs = (
        (
            await scope.query(
                scope.runtime,
                trial.tenant,
                "SELECT status FROM encrypted_translation_jobs WHERE tenant_id=:tenant",
                tenant=trial.tenant,
            )
        )
        .scalars()
        .all()
    )
    assert jobs == ["attempt_committed"]
    for engine, sql in (
        (scope.runtime, "SELECT ciphertext FROM encrypted_translation_jobs"),
        (scope.speech, "SELECT ciphertext FROM encrypted_translation_jobs"),
        (scope.translation, "SELECT wrapped_dek FROM session_audio_keys"),
        (scope.translation, "SELECT object_id FROM audio_chunks"),
        (scope.translation, "UPDATE transcription_jobs SET status='queued'"),
        (scope.speech, "UPDATE source_start_attempts SET state='stopped'"),
    ):
        with pytest.raises(DBAPIError):
            await scope.query(engine, trial.tenant, sql)
    for engine in (scope.speech, scope.translation):
        for table in (
            "consent_records",
            "scribe_sessions",
            "transcription_jobs",
            "normalized_source_transcripts",
            "normalized_source_segments",
            "normalized_source_receipt_keys",
        ):
            # Deliberately set a valid *foreign* tenant GUC; the fixed cohort remains restrictive.
            assert (
                await scope.query(
                    engine,
                    foreign.tenant,
                    f"SELECT count(*) FROM {table} WHERE tenant_id=:tenant",
                    tenant=foreign.tenant,
                )
            ).scalar_one() == 0
        with pytest.raises(DBAPIError):
            await scope.query(
                engine,
                foreign.tenant,
                "INSERT INTO audit_events(id,tenant_id,action,entity_type,entity_id) "
                "VALUES (:id,:tenant,'synthetic.probe','session',:session)",
                id=uuid4(),
                tenant=foreign.tenant,
                session=foreign.draft.id,
            )


async def test_configured_speech_worker_claims_decrypts_publishes_and_replays(
    scope: Scope,
    capture: CaptureHarness,
    tmp_path: Path,
) -> None:
    await capture.record()
    repositories = CapturedSourceRepositoryProvider(scope.speech)
    unwrapper = StaticKeyUnwrapper(capture.key)
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=RepositoryAudioAssemblyManifestProvider(repositories),
        reader=capture.reader,
        key_unwrapper=unwrapper,
        temporary_directory=tmp_path,
    )
    worker = CapturedTranscriptionWorker(
        repositories=repositories,
        assembler=assembler,
        transcriber=capture.speech,
        enabled=True,
    )
    try:
        with pytest.raises(TranscriptionWorkerError):
            await worker.process(tenant_id=uuid4(), session_id=capture.trial.draft.id)
        assert capture.speech.calls == 0 and unwrapper.calls == []
        outcome = await worker.process(tenant_id=scope.tenant, session_id=capture.trial.draft.id)
        assert outcome.already_completed is False
        assert capture.speech.calls == 1 and len(unwrapper.calls) == 1
        repeated = await worker.process(tenant_id=scope.tenant, session_id=capture.trial.draft.id)
        assert repeated.already_completed is True and repeated.job_id == outcome.job_id
        assert capture.speech.calls == 1 and len(unwrapper.calls) == 1
        assert (
            await scope.query(
                scope.runtime,
                scope.tenant,
                "SELECT status FROM transcription_jobs WHERE id=:id",
                id=outcome.job_id,
            )
        ).scalar_one() == "completed"
    finally:
        await assembler.close()


async def test_native_start_and_retirement_after_thousandth_chunk(scope: Scope):
    trial, first = await scope.capture(reservation_count=1081)
    runtime = scope.source()
    await _act(runtime, trial, first, "prepare")
    await _act(runtime, trial, first, "authorize")
    await _act(runtime, trial, first, "stop")
    late = first.model_copy(update={"attempt_id": uuid4(), "first_sequence_number": 1080})
    prepared = await _act(runtime, trial, late, "prepare", "late-source-prepare")
    assert isinstance(prepared, SourceStartReceipt) and prepared.first_sequence_number == 1080
    await _act(runtime, trial, late, "authorize", "late-source-authorize")
    stopped = await _act(runtime, trial, late, "stop", "late-source-stop")
    assert isinstance(stopped, SourceStartReceipt) and stopped.first_sequence_number == 1080
    unstarted = late.model_copy(update={"attempt_id": uuid4()})
    retired = await _act(runtime, trial, unstarted, "stop", "late-source-retire")
    assert isinstance(retired, SourceStartRetirementReceipt)
    assert retired.first_sequence_number == 1080
