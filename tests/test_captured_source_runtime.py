from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from cosmaneura_scribe import captured_source_runtime as runtime_module
from cosmaneura_scribe.captured_source_runtime import (
    CapturedSourceRepository,
    CapturedSourceRepositoryProvider,
    CapturedSourceRuntime,
    CapturedSourceUnavailable,
    CapturedSpeechCompletion,
)
from cosmaneura_scribe.creator_review_contract_v1 import CreatorTranslationDecisionRequestV1
from cosmaneura_scribe.external_transcript_v1 import (
    SourceLocale,
    TranscriptLanguageMode,
    TranslationReviewDecision,
)
from cosmaneura_scribe.handoff import to_master_platform_payload_from_working_transcript
from cosmaneura_scribe.normalized_source_persistence import (
    CapturedSessionCreate,
    ConfiguredExternalSessionStatus,
)
from cosmaneura_scribe.postgres_repository import PostgresRepositoryProvider
from cosmaneura_scribe.postgres_translation_jobs import PostgresTranslationJobStore
from cosmaneura_scribe.repository import CaptureIngestModeError
from cosmaneura_scribe.schemas import CaptureChannel, ConsentRecord, SessionAudioKey, SpeakerRole
from cosmaneura_scribe.session_state_v1 import SessionIngestMode
from cosmaneura_scribe.transcript_review_service import (
    CreatorTranscriptReviewService,
    TranscriptReviewUnavailable,
)
from cosmaneura_scribe.transcription import SttResult, SttSegment
from cosmaneura_scribe.translation_adapter import ReservedSpanishTranslation
from cosmaneura_scribe.translation_execution_v1 import (
    RepositoryCompletedTranslationJobCommitter,
    TranslationExecutionDisposition,
    execute_reserved_translation_job,
)
from cosmaneura_scribe.translation_job_encryption import (
    TranslationJobCipher,
    TranslationJobStoreError,
)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from test_encrypted_translation_jobs import _LocalKeys
from test_normalized_source_persistence import _consent, _draft, _expire_normalized_source
from test_translation_execution_v1 import RESULT_MARKER, _CountingAdapter

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]
ROOT = Path(__file__).resolve().parents[1]
SPANISH = "No tengo fiebre."
ENGLISH = "I am not sure when it started."


def _result() -> SttResult:
    return SttResult(
        provider="azure_ai_speech",
        language_code="en-US+es-US",
        duration_ms=3000,
        segments=(
            SttSegment(
                CaptureChannel.MIXED, "1", 0, 900, 0.98, "Any fever?", SourceLocale.ENGLISH_US
            ),
            SttSegment(
                CaptureChannel.MIXED, "2", 1000, 1900, 0.97, SPANISH, SourceLocale.SPANISH_US
            ),
            SttSegment(
                CaptureChannel.MIXED, "2", 2100, 3000, 0.96, ENGLISH, SourceLocale.ENGLISH_US
            ),
        ),
    )


@dataclass
class Trial:
    provider: CapturedSourceRepositoryProvider
    runtime: CapturedSourceRuntime
    tenant: UUID
    consent: ConsentRecord
    draft: CapturedSessionCreate
    admin_url: str

    async def processing(self) -> CapturedSpeechCompletion:
        completion = CapturedSpeechCompletion(uuid4(), uuid4(), 1, _result())
        async with self.provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant, true)"),
                {"tenant": str(self.tenant)},
            )
            for status in ("capturing", "uploaded", "processing"):
                await connection.execute(
                    text(
                        "UPDATE scribe_sessions SET status = :status "
                        "WHERE tenant_id = :tenant AND id = :session"
                    ),
                    {"tenant": self.tenant, "session": self.draft.id, "status": status},
                )
            await connection.execute(
                text("""
                INSERT INTO transcription_jobs (
                    id, tenant_id, session_id, status, attempt_count, lease_token, lease_until
                ) VALUES (:job, :tenant, :session, 'processing', 1, :token,
                          clock_timestamp() + INTERVAL '5 minutes')
            """),
                {
                    "job": completion.job_id,
                    "tenant": self.tenant,
                    "session": self.draft.id,
                    "token": completion.lease_token,
                },
            )
        return completion

    async def query(self, sql: str, **params: object):
        async with self.provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant, true)"),
                {"tenant": str(self.tenant)},
            )
            return await connection.execute(
                text(sql), {"tenant": self.tenant, "session": self.draft.id, **params}
            )

    async def counts(self) -> tuple[int, int, int]:
        return tuple(
            (
                await self.query("""
            SELECT (SELECT count(*) FROM normalized_source_transcripts
                    WHERE tenant_id = :tenant AND session_id = :session),
                   (SELECT count(*) FROM normalized_working_transcripts
                    WHERE tenant_id = :tenant AND session_id = :session),
                   (SELECT count(*) FROM normalized_source_receipt_keys
                    WHERE tenant_id = :tenant AND session_id = :session)
        """)
            ).one()
        )


async def _remove_owned_fixture_rows(admin_url: str, tenant: UUID) -> None:
    # Fresh disposable database only, exact generated tenant only, after assertions.
    # This is deliberately not a production retention or deletion implementation.
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            assert (await connection.scalar(text("SELECT current_database()"))).endswith("_test")
            tables = (
                (
                    await connection.execute(
                        text("""
                SELECT table_name FROM information_schema.columns
                WHERE table_schema = 'public' AND column_name = 'tenant_id'
                ORDER BY table_name
            """)
                    )
                )
                .scalars()
                .all()
            )
            await connection.execute(text("SET LOCAL session_replication_role = replica"))
            for table in tables:
                quoted = connection.dialect.identifier_preparer.quote(table)
                await connection.execute(
                    text(f"DELETE FROM public.{quoted} WHERE tenant_id = :tenant"),
                    {"tenant": tenant},
                )
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def trial(postgres_urls: tuple[str, str]) -> AsyncIterator[Trial]:
    provider = CapturedSourceRepositoryProvider(
        create_async_engine(postgres_urls[1], connect_args={"ssl": False})
    )
    runtime = CapturedSourceRuntime(provider, enabled=True)
    tenant, consent = uuid4(), _consent()
    draft = CapturedSessionCreate(**asdict(_draft(consent)))
    try:
        async with provider.transaction(tenant) as repository:
            await repository.add_consent(tenant, consent)
        await runtime.admit(tenant_id=tenant, draft=draft)
        yield Trial(provider, runtime, tenant, consent, draft, postgres_urls[0])
    finally:
        await provider.close()
        await _remove_owned_fixture_rows(postgres_urls[0], tenant)


async def test_default_off_admission_exact_replay_and_conflicting_identity(trial: Trial) -> None:
    disabled = CapturedSourceRuntime(trial.provider)
    with pytest.raises(CapturedSourceUnavailable):
        await disabled.admit(tenant_id=trial.tenant, draft=trial.draft)
    current = await trial.runtime.admit(tenant_id=trial.tenant, draft=trial.draft)
    assert current.ingest_mode == SessionIngestMode.CHUNK_UPLOAD
    assert current.transcription_adapter_id == "azure_ai_speech"
    assert current.status == ConfiguredExternalSessionStatus.CREATED
    for field, value in (
        ("creator_actor_id", "other_creator"),
        ("patient_id", "other_patient"),
        ("language_mode", TranscriptLanguageMode.ENGLISH),
    ):
        with pytest.raises(CapturedSourceUnavailable) as error:
            await trial.runtime.admit(
                tenant_id=trial.tenant, draft=replace(trial.draft, **{field: value})
            )
        assert error.value.__context__ is None and error.value.__cause__ is None
    assert (
        await trial.query(
            "SELECT count(*) FROM audit_events WHERE tenant_id = :tenant "
            "AND action = 'captured_session.admitted'"
        )
    ).scalar_one() == 1


async def test_atomic_publication_preserves_capture_identity_and_default_read_fences(trial: Trial):
    completion = await trial.processing()
    published = await trial.runtime.publish_speech_result(
        tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
    )
    assert published.working.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING
    assert await trial.counts() == (1, 1, 1)
    job = (
        await trial.query(
            "SELECT status, lease_token, lease_until FROM transcription_jobs "
            "WHERE tenant_id = :tenant AND session_id = :session"
        )
    ).one()
    assert tuple(job) == ("completed", None, None)
    async with trial.provider.transaction(trial.tenant) as repository:
        assert await repository.get_versioned_external_session(trial.tenant, trial.draft.id) is None
        assert await repository.get_session(trial.tenant, trial.draft.id) is None
    default = PostgresRepositoryProvider(trial.provider.engine)
    async with default.transaction(trial.tenant) as repository:
        assert (
            await repository.get_current_normalized_source_transcript(trial.tenant, trial.draft.id)
            is None
        )
        with pytest.raises(CaptureIngestModeError):
            await repository.add_session_audio_key(
                trial.tenant,
                SessionAudioKey(
                    session_id=trial.draft.id,
                    key_version="synthetic_key",
                    wrapped_dek="A" * 512,
                    created_at=datetime.now(UTC),
                ),
            )
    assert SPANISH not in repr(completion) + repr(published)
    assert str(completion.lease_token) not in completion.receipt_key


@pytest.mark.parametrize(
    "fault",
    [
        "wrong_tenant",
        "wrong_session",
        "wrong_job",
        "wrong_token",
        "wrong_attempt",
        "expired_lease",
        "revoked",
        "provider",
        "language",
        "unstarted",
        "disabled",
    ],
)
async def test_publication_denies_invalid_authority_without_partial_source(
    trial: Trial, fault: str
):
    completion = (
        await trial.processing()
        if fault != "unstarted"
        else CapturedSpeechCompletion(uuid4(), uuid4(), 1, _result())
    )
    tenant, session, service = trial.tenant, trial.draft.id, trial.runtime
    if fault == "wrong_tenant":
        tenant = uuid4()
    elif fault == "wrong_session":
        session = uuid4()
    elif fault in {"wrong_job", "wrong_token", "wrong_attempt"}:
        field = {
            "wrong_job": "job_id",
            "wrong_token": "lease_token",
            "wrong_attempt": "attempt_count",
        }[fault]
        completion = replace(completion, **{field: 2 if fault == "wrong_attempt" else uuid4()})
    elif fault == "expired_lease":
        await trial.query(
            "UPDATE transcription_jobs SET lease_until = clock_timestamp() "
            "- INTERVAL '1 second' WHERE tenant_id = :tenant AND session_id = :session"
        )
    elif fault == "revoked":
        async with trial.provider.transaction(trial.tenant) as repository:
            await repository.revoke_consent(trial.tenant, trial.consent.id)
    elif fault in {"provider", "language"}:
        completion = replace(
            completion,
            result=replace(
                completion.result,
                **{"provider" if fault == "provider" else "language_code": "unadmitted"},
            ),
        )
    elif fault == "disabled":
        service = CapturedSourceRuntime(trial.provider)
    with pytest.raises(CapturedSourceUnavailable) as error:
        await service.publish_speech_result(
            tenant_id=tenant, session_id=session, completion=completion
        )
    assert error.value.__context__ is None and error.value.__cause__ is None
    assert str(error.value) == "captured_source_unavailable"
    assert await trial.counts() == (0, 0, 0)


async def test_completed_retry_is_exact_and_cannot_correct_source(trial: Trial) -> None:
    completion = await trial.processing()
    first = await trial.runtime.publish_speech_result(
        tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
    )
    await trial.provider.engine.dispose()
    second = await CapturedSourceRuntime(trial.provider, enabled=True).publish_speech_result(
        tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
    )
    assert first.source.receipt_body == second.source.receipt_body
    assert first.working.working_transcript_id == second.working.working_transcript_id
    assert await trial.counts() == (1, 1, 1)
    changed = replace(completion.result.segments[1], content="Fuente diferente.")
    for altered in (
        replace(completion, lease_token=uuid4()),
        replace(completion, attempt_count=2),
        replace(
            completion,
            result=replace(
                completion.result,
                segments=(completion.result.segments[0], changed, completion.result.segments[2]),
            ),
        ),
    ):
        with pytest.raises(CapturedSourceUnavailable):
            await trial.runtime.publish_speech_result(
                tenant_id=trial.tenant, session_id=trial.draft.id, completion=altered
            )
    assert await trial.counts() == (1, 1, 1)
    assert (
        await trial.query(
            "SELECT count(*) FROM audit_events WHERE tenant_id = :tenant "
            "AND action = 'captured_speech.completed'"
        )
    ).scalar_one() == 1


async def test_simultaneous_completion_converges_without_second_source(trial: Trial) -> None:
    completion = await trial.processing()

    async def publish():
        return await trial.runtime.publish_speech_result(
            tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
        )

    first, second = await asyncio.gather(publish(), publish())
    assert first.source.receipt_body == second.source.receipt_body
    assert await trial.counts() == (1, 1, 1)


async def test_lost_commit_reply_recovers_saved_result_without_provider_call(trial: Trial) -> None:
    class LostReply(CapturedSourceRepositoryProvider):
        lose = True

        @asynccontextmanager
        async def transaction(self, tenant_id: UUID):
            async with super().transaction(tenant_id) as repository:
                yield repository
            if self.lose:
                self.lose = False
                raise RuntimeError("synthetic lost commit reply")

    completion = await trial.processing()
    uncertain = CapturedSourceRuntime(LostReply(trial.provider.engine), enabled=True)
    with pytest.raises(CapturedSourceUnavailable):
        await uncertain.publish_speech_result(
            tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
        )
    assert await trial.counts() == (1, 1, 1)
    recovered = await trial.runtime.publish_speech_result(
        tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
    )
    assert recovered.source.disposition.value == "replayed"
    assert await trial.counts() == (1, 1, 1)


@pytest.mark.parametrize("fault", ["projection_failure", "lease_expires", "cancel"])
async def test_publication_rolls_back_source_projection_and_job_on_failure(
    trial: Trial,
    monkeypatch: pytest.MonkeyPatch,
    fault: str,
) -> None:
    class FaultRepository(CapturedSourceRepository):
        async def publish_current_working_transcript(self, tenant_id: UUID, session_id: UUID):
            result = await super().publish_current_working_transcript(tenant_id, session_id)
            if fault == "cancel":
                raise asyncio.CancelledError()
            if fault == "projection_failure":
                raise RuntimeError("synthetic failure after protected projection write")
            await self._session.execute(
                text(
                    "UPDATE transcription_jobs SET lease_until = "
                    "clock_timestamp() - INTERVAL '1 second' WHERE tenant_id = :tenant "
                    "AND session_id = :session"
                ),
                {"tenant": tenant_id, "session": session_id},
            )
            return result

    completion = await trial.processing()
    monkeypatch.setattr(runtime_module, "CapturedSourceRepository", FaultRepository)
    with pytest.raises(asyncio.CancelledError if fault == "cancel" else CapturedSourceUnavailable):
        await trial.runtime.publish_speech_result(
            tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
        )
    assert await trial.counts() == (0, 0, 0)
    assert (
        await trial.query(
            "SELECT status FROM transcription_jobs "
            "WHERE tenant_id = :tenant AND session_id = :session"
        )
    ).scalar_one() == "processing"


async def test_captured_speech_encrypted_execution_creator_review_and_english_handoff(trial: Trial):
    completion = await trial.processing()
    await trial.runtime.publish_speech_result(
        tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
    )
    service = CreatorTranscriptReviewService(trial.provider, enabled=True)
    scope = dict(
        tenant_id=trial.tenant,
        session_id=trial.draft.id,
        creator_actor_id=trial.draft.creator_actor_id,
    )
    current = await service.read(**scope)
    source = current.bundle.source_transcript
    assert [s.content for s in source.segments] == ["Any fever?", SPANISH, ENGLISH]
    assert all(s.speaker_role == SpeakerRole.UNKNOWN for s in source.segments)
    assert source.segments[1].speaker_id == source.segments[2].speaker_id
    assert source.transcription_adapter_id == "azure_ai_speech"
    assert not current.working_transcript.note_ready
    spanish = source.segments[1]
    reservation = ReservedSpanishTranslation(
        uuid4(), 1, spanish.source_segment_id, 1, 0, SourceLocale.SPANISH_US, spanish.content
    )
    keys = _LocalKeys()
    cipher = TranslationJobCipher(keys, keys)
    default = PostgresTranslationJobStore(trial.provider.engine, cipher)
    with pytest.raises(TranslationJobStoreError):
        await default.reserve_translation_job(trial.tenant, trial.draft.id, reservation)
    store = PostgresTranslationJobStore(
        trial.provider.engine, cipher, normalized_ingest_mode=SessionIngestMode.CHUNK_UPLOAD
    )
    await store.reserve_translation_job(trial.tenant, trial.draft.id, reservation)
    adapter = _CountingAdapter(expected_source=SPANISH)

    async def execute():
        return await execute_reserved_translation_job(
            store=store,
            adapter=adapter,
            committer=RepositoryCompletedTranslationJobCommitter(trial.provider),
            tenant_id=trial.tenant,
            session_id=trial.draft.id,
            translation_id=reservation.translation_id,
            provider_call_token=uuid4(),
        )

    assert (
        await execute()
    ).disposition == TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
    await trial.provider.engine.dispose()
    assert (await execute()).disposition == TranslationExecutionDisposition.ALREADY_COMMITTED
    assert adapter.call_count == 1
    queue = await service.review_queue(**scope)
    item = queue.items[0]
    decision = CreatorTranslationDecisionRequestV1(
        schema_version="1.0",
        expected_source_transcript_version=1,
        source_segment_id=item.source_segment_id,
        expected_source_segment_version=1,
        translation_id=item.translation_id,
        expected_translation_version=1,
        decision=TranslationReviewDecision.ACCEPTED,
    )
    with pytest.raises(TranscriptReviewUnavailable):
        await service.decide(
            **{**scope, "creator_actor_id": "other_creator"},
            request=decision,
            review_id=uuid4(),
            reviewed_at=datetime.now(UTC),
        )
    await service.decide(
        **scope, request=decision, review_id=uuid4(), reviewed_at=datetime.now(UTC)
    )
    reviewed = await service.read(**scope)
    assert reviewed.bundle.source_transcript == source
    assert [s.content for s in reviewed.working_transcript.segments] == [
        "Any fever?",
        RESULT_MARKER,
        ENGLISH,
    ]
    assert reviewed.working_transcript.note_ready
    assert to_master_platform_payload_from_working_transcript(
        encounter_id=trial.draft.appointment_id,
        session_id=trial.draft.id,
        working_transcript=reviewed.working_transcript,
    )
    await _expire_normalized_source(
        trial.provider, trial.tenant, trial.draft.id, admin_url=trial.admin_url
    )
    with pytest.raises(TranscriptReviewUnavailable):
        await service.read(**scope)
    with pytest.raises(CapturedSourceUnavailable):
        await trial.runtime.publish_speech_result(
            tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
        )
    async with trial.provider.transaction(trial.tenant) as repository:
        purged = await repository.purge_normalized_source_content(trial.tenant, trial.draft.id)
    assert purged is not None and purged.changed
    assert await trial.counts() == (0, 0, 0)
    assert (
        await trial.query(
            "SELECT count(*) FROM encrypted_translation_jobs "
            "WHERE tenant_id = :tenant AND session_id = :session"
        )
    ).scalar_one() == 0


@pytest.mark.parametrize("kind", ["unknown", "overlap", "english"])
async def test_source_evidence_drives_quality_and_english_only_readiness(trial: Trial, kind: str):
    completion = await trial.processing()
    segments = list(completion.result.segments)
    expected = ConfiguredExternalSessionStatus.QUALITY_BLOCKED
    if kind == "unknown":
        segments[1] = replace(segments[1], source_locale=SourceLocale.UNKNOWN)
    elif kind == "overlap":
        segments[1] = replace(segments[1], start_ms=800)
    else:
        segments[1] = replace(
            segments[1], source_locale=SourceLocale.ENGLISH_US, content="No fever."
        )
        expected = ConfiguredExternalSessionStatus.TRANSCRIPT_READY
    completion = replace(completion, result=replace(completion.result, segments=tuple(segments)))
    published = await trial.runtime.publish_speech_result(
        tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
    )
    assert published.working.status == expected
    current = await CreatorTranscriptReviewService(trial.provider, enabled=True).read(
        tenant_id=trial.tenant,
        session_id=trial.draft.id,
        creator_actor_id=trial.draft.creator_actor_id,
    )
    assert current.working_transcript.note_ready == (kind == "english")
    assert (
        await trial.query(
            "SELECT count(*) FROM encrypted_translation_jobs "
            "WHERE tenant_id = :tenant AND session_id = :session"
        )
    ).scalar_one() == 0


async def test_consent_revocation_closes_configured_capture_lease(trial: Trial) -> None:
    await trial.query(
        """
        INSERT INTO capture_leases (tenant_id, session_id, lease_id, generation, expires_at)
        VALUES (:tenant, :session, :lease, 1, clock_timestamp() + INTERVAL '5 minutes')
    """,
        lease=uuid4(),
    )
    async with trial.provider.transaction(trial.tenant) as repository:
        await repository.revoke_consent(trial.tenant, trial.consent.id)
    row = (
        await trial.query(
            "SELECT closed_at, close_reason FROM capture_leases "
            "WHERE tenant_id = :tenant AND session_id = :session"
        )
    ).one()
    assert row.closed_at is not None and row.close_reason == "consent_revoked"
    with pytest.raises(CapturedSourceUnavailable):
        await trial.runtime.admit(tenant_id=trial.tenant, draft=trial.draft)


async def test_real_process_exit_after_commit_and_fresh_process_receipt_recovery(trial: Trial):
    completion = await trial.processing()
    root = ROOT
    # Only this disposable test URL and opaque fixture IDs enter the owned child.
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": f"{root / 'services/api/src'}{os.pathsep}{root / 'tests'}",
        "CAPTURED_TEST_DB_URL": trial.provider.engine.url.render_as_string(hide_password=False),
        "CAPTURED_TEST_TENANT": str(trial.tenant),
        "CAPTURED_TEST_SESSION": str(trial.draft.id),
        "CAPTURED_TEST_JOB": str(completion.job_id),
        "CAPTURED_TEST_TOKEN": str(completion.lease_token),
    }
    script = """
import asyncio, os
from uuid import UUID
from sqlalchemy.ext.asyncio import create_async_engine
from cosmaneura_scribe.captured_source_runtime import (
    CapturedSourceRepositoryProvider, CapturedSourceRuntime, CapturedSpeechCompletion)
from test_captured_source_runtime import _result
async def run():
    provider = CapturedSourceRepositoryProvider(create_async_engine(
        os.environ['CAPTURED_TEST_DB_URL'], connect_args={'ssl': False}))
    result = await CapturedSourceRuntime(provider, enabled=True).publish_speech_result(
        tenant_id=UUID(os.environ['CAPTURED_TEST_TENANT']),
        session_id=UUID(os.environ['CAPTURED_TEST_SESSION']),
        completion=CapturedSpeechCompletion(UUID(os.environ['CAPTURED_TEST_JOB']),
            UUID(os.environ['CAPTURED_TEST_TOKEN']), 1, _result()))
    if os.environ['CAPTURED_TEST_EXIT'] == '1':
        os._exit(0)  # Real owned-process exit after commit, without returning a receipt.
    print(result.source.disposition.value)
    await provider.close()
asyncio.run(run())
"""
    for exit_after_commit, expected in (("1", ""), ("0", "replayed\n")):
        process = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, "-c", script],
            cwd=root,
            env={**environment, "CAPTURED_TEST_EXIT": exit_after_commit},
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        assert process.returncode == 0
        assert process.stdout == expected
    assert await trial.counts() == (1, 1, 1)
