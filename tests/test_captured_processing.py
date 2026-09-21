from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from uuid import uuid4

import pytest
import pytest_asyncio
from cosmaneura_scribe.azure_speech_source import normalize_azure_source
from cosmaneura_scribe.captured_processing import (
    CapturedProcessingRuntime,
    CapturedProcessingUnavailable,
)
from cosmaneura_scribe.captured_processing import CapturedProcessingState as State
from cosmaneura_scribe.creator_review_contract_v1 import CreatorTranslationDecisionRequestV1
from cosmaneura_scribe.external_transcript_v1 import SourceLocale, TranslationReviewDecision
from cosmaneura_scribe.handoff import to_master_platform_payload_from_working_transcript
from cosmaneura_scribe.postgres_repository import PostgresRepositoryProvider
from cosmaneura_scribe.transcript_review_service import CreatorTranscriptReviewService
from cosmaneura_scribe.translation_adapter import (
    SpanishToEnglishTranslationRequest,
    SpanishToEnglishTranslationResult,
    TranslationAdapterError,
    TranslationAdapterFailureCode,
    plan_spanish_translation_work,
)
from cosmaneura_scribe.translation_job_encryption import TranslationJobCipher
from cryptography.hazmat.primitives import serialization
from test_captured_source_runtime import ENGLISH, SPANISH
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import CaptureHarness
from test_captured_transcription_worker import capture as capture
from test_encrypted_translation_jobs import _LocalKeys
from test_normalized_source_persistence import _expire_normalized_source

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


class Translator:
    adapter_id = "synthetic_dispatch_adapter"
    model_profile_id = "synthetic_dispatch_profile_v1"

    def __init__(self):
        self.calls: list[str] = []
        self.reject = False
        self.block = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def translate(self, request: SpanishToEnglishTranslationRequest):
        self.calls.append(request.content)
        self.started.set()
        if self.block:
            await self.release.wait()
        if self.reject:
            raise TranslationAdapterError(TranslationAdapterFailureCode.PROVIDER_REJECTED)
        return SpanishToEnglishTranslationResult("I do not have a fever.")


@dataclass
class Flow:
    capture: CaptureHarness
    translator: Translator
    cipher: TranslationJobCipher
    runtime: CapturedProcessingRuntime

    @property
    def scope(self):
        return dict(tenant_id=self.capture.trial.tenant, session_id=self.capture.trial.draft.id)

    def fresh(self, **kwargs):
        return CapturedProcessingRuntime(
            repositories=self.capture.trial.provider,
            assembler=self.capture.assembler,
            transcriber=self.capture.speech,
            translator=self.translator,
            job_cipher=self.cipher,
            enabled=True,
            **kwargs,
        )

    async def current(self):
        return await CreatorTranscriptReviewService(self.capture.trial.provider, enabled=True).read(
            **self.scope, creator_actor_id=self.capture.trial.draft.creator_actor_id
        )

    async def decide(self, decision=TranslationReviewDecision.ACCEPTED):
        service = CreatorTranscriptReviewService(self.capture.trial.provider, enabled=True)
        scope = {**self.scope, "creator_actor_id": self.capture.trial.draft.creator_actor_id}
        queue = await service.review_queue(**scope)
        for item in queue.items:
            await service.decide(
                **scope,
                review_id=uuid4(),
                reviewed_at=datetime.now(UTC),
                request=CreatorTranslationDecisionRequestV1(
                    schema_version="1.0",
                    expected_source_transcript_version=1,
                    source_segment_id=item.source_segment_id,
                    expected_source_segment_version=1,
                    translation_id=item.translation_id,
                    expected_translation_version=item.translation_version,
                    decision=decision,
                ),
            )

    async def counts(self):
        return tuple(
            (
                await self.capture.trial.query("""
            SELECT (SELECT count(*) FROM encrypted_translation_jobs
                    WHERE tenant_id = :tenant AND session_id = :session),
                   (SELECT count(*) FROM normalized_translation_attempts
                    WHERE tenant_id = :tenant AND session_id = :session),
                   (SELECT count(*) FROM normalized_translation_reviews
                    WHERE tenant_id = :tenant AND session_id = :session)
        """)
            ).one()
        )


@pytest_asyncio.fixture
async def flow(capture: CaptureHarness):
    translator, keys = Translator(), _LocalKeys()
    cipher = TranslationJobCipher(keys, keys)
    runtime = CapturedProcessingRuntime(
        repositories=capture.trial.provider,
        assembler=capture.assembler,
        transcriber=capture.speech,
        translator=translator,
        job_cipher=cipher,
        enabled=True,
    )
    return Flow(capture, translator, cipher, runtime)


async def test_discovery_capture_translation_manual_review_and_handoff(flow: Flow):
    await flow.capture.record()
    page = await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])
    assert len(page.receipts) == 1 and page.receipts[0].state == State.REVIEW_REQUIRED
    assert flow.capture.speech.calls == 1 and flow.translator.calls == [SPANISH]
    assert await flow.counts() == (1, 1, 0)
    actions = (
        (
            await flow.capture.trial.query(
                "SELECT action FROM audit_events WHERE tenant_id = :tenant"
            )
        )
        .scalars()
        .all()
    )
    assert "normalized_working_transcript.worker_read" in actions
    assert "normalized_working_transcript.creator_read" not in actions
    assert not (await flow.current()).working_transcript.note_ready
    assert not (await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])).receipts
    await flow.decide()
    current = await flow.current()
    assert current.working_transcript.note_ready
    assert [item.content for item in current.working_transcript.segments] == [
        "Any fever?",
        "I do not have a fever.",
        ENGLISH,
    ]
    assert current.bundle.source_transcript.segments[1].content == SPANISH
    assert to_master_platform_payload_from_working_transcript(
        encounter_id=flow.capture.trial.draft.appointment_id,
        session_id=flow.scope["session_id"],
        working_transcript=current.working_transcript,
    )
    await flow.capture.trial.provider.engine.dispose()
    assert (await flow.fresh().process(**flow.scope)).state == State.TRANSCRIPT_READY
    assert flow.capture.speech.calls == 1 and flow.translator.calls == [SPANISH]
    assert await flow.counts() == (1, 1, 1)


@pytest.mark.parametrize("fault", ["disabled", "tenant", "session", "revoked", "profile"])
async def test_denied_before_effects(flow: Flow, fault: str):
    await flow.capture.record()
    scope, runtime = flow.scope, flow.runtime
    if fault == "disabled":
        runtime = CapturedProcessingRuntime(
            repositories=flow.capture.trial.provider,
            assembler=flow.capture.assembler,
            transcriber=flow.capture.speech,
            translator=flow.translator,
            job_cipher=flow.cipher,
        )
    elif fault in {"tenant", "session"}:
        scope = {**scope, f"{fault}_id": uuid4()}
    elif fault == "revoked":
        async with flow.capture.trial.provider.transaction(scope["tenant_id"]) as store:
            await store.revoke_consent(scope["tenant_id"], flow.capture.trial.consent.id)
    else:
        flow.translator.model_profile_id = "invalid profile"
    with pytest.raises(CapturedProcessingUnavailable) as error:
        await runtime.process(**scope)
    assert error.value.__context__ is None
    assert flow.capture.speech.calls == 0 and flow.translator.calls == []
    assert await flow.counts() == (0, 0, 0)


async def test_recording_in_progress_is_not_processed(flow: Flow):
    assert (await flow.runtime.process(**flow.scope)).state == State.CAPTURE_PENDING
    assert not (await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])).receipts
    assert flow.capture.speech.calls == 0 and flow.translator.calls == []


async def test_translation_requires_completed_captured_speech_lineage(flow: Flow):
    await flow.capture.record()
    await flow.capture.process()
    await flow.capture.trial.query("""
        UPDATE transcription_jobs SET status = 'terminal'
        WHERE tenant_id = :tenant AND session_id = :session
    """)
    with pytest.raises(CapturedProcessingUnavailable):
        await flow.runtime.process(**flow.scope)
    assert flow.translator.calls == [] and await flow.counts() == (0, 0, 0)


async def test_competing_initial_reservation_and_processing_converge(flow: Flow):
    await flow.capture.record()
    await flow.capture.process()
    first, second = await asyncio.gather(
        *(flow.runtime._jobs.prepare_dispatch(**flow.scope) for _ in range(2))
    )
    assert first.executable_job_ids == second.executable_job_ids
    assert await flow.counts() == (1, 0, 0)
    flow.translator.block = True
    task = asyncio.create_task(flow.runtime.process(**flow.scope))
    await asyncio.wait_for(flow.translator.started.wait(), timeout=5)
    try:
        assert (await flow.fresh().process(**flow.scope)).state == State.TRANSLATION_UNCONFIRMED
        flow.translator.release.set()
        assert (await asyncio.wait_for(task, timeout=5)).state == State.REVIEW_REQUIRED
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert flow.capture.speech.calls == 1 and flow.translator.calls == [SPANISH]
    assert await flow.counts() == (1, 1, 0)


async def test_cancelled_model_call_is_never_automatically_replayed(flow: Flow):
    await flow.capture.record()
    flow.translator.block = True
    task = asyncio.create_task(flow.runtime.process(**flow.scope))
    try:
        await asyncio.wait_for(flow.translator.started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    flow.translator.block = False
    assert (await flow.fresh().process(**flow.scope)).state == State.TRANSLATION_UNCONFIRMED
    assert not (await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])).receipts
    assert flow.translator.calls == [SPANISH] and await flow.counts() == (1, 0, 0)


@pytest.mark.parametrize("rejected_by", ["provider", "creator"])
async def test_failed_or_rejected_attempt_requires_explicit_new_reservation(
    flow: Flow, rejected_by
):
    await flow.capture.record()
    flow.translator.reject = rejected_by == "provider"
    await flow.runtime.process(**flow.scope)
    if rejected_by == "creator":
        await flow.decide(TranslationReviewDecision.REJECTED)
    for _ in range(2):
        assert (await flow.fresh().process(**flow.scope)).state == State.TRANSLATION_RETRY_REQUIRED
    assert len(flow.translator.calls) == 1
    assert not (await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])).receipts
    current = await flow.current()
    candidate = plan_spanish_translation_work(current.bundle).candidates[0]
    assert candidate.expected_previous_translation_version == 1
    # Explicitly requested second attempt, not an automatic dispatcher decision.
    await flow.runtime._jobs.reserve_translation_job(
        **flow.scope, reservation=candidate.reserve(uuid4())
    )
    flow.translator.reject = False
    page = await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])
    assert page.receipts[0].state == State.REVIEW_REQUIRED
    assert (
        len(flow.translator.calls) == 2 and not (await flow.current()).working_transcript.note_ready
    )


@pytest.mark.parametrize("lost_at", ["reservation", "result", "mark", "after_mark"])
async def test_lost_replies_recover_without_duplicate_provider(flow: Flow, monkeypatch, lost_at):
    await flow.capture.record()
    method = {
        "reservation": "prepare_dispatch",
        "result": "store_provider_result",
        "mark": "mark_attempt_committed",
        "after_mark": "mark_attempt_committed",
    }[lost_at]
    original = getattr(flow.runtime._jobs, method)

    async def fail_once(*args, **kwargs):
        if lost_at != "mark":
            await original(*args, **kwargs)
        raise OSError("synthetic-lost-reply")

    with monkeypatch.context() as patch:
        patch.setattr(flow.runtime._jobs, method, fail_once)
        with pytest.raises(CapturedProcessingUnavailable):
            await flow.runtime.process(**flow.scope)
    assert len(flow.translator.calls) == (0 if lost_at == "reservation" else 1)
    if lost_at == "mark":
        # Human acceptance between a committed attempt and its bookkeeping recovery
        # must survive; neither the source nor the review may be reset.
        await flow.decide()
    await flow.capture.trial.provider.engine.dispose()
    expected = State.TRANSCRIPT_READY if lost_at == "mark" else State.REVIEW_REQUIRED
    assert (await flow.fresh().process(**flow.scope)).state == expected
    assert flow.translator.calls == [SPANISH]
    assert (await flow.counts())[:2] == (1, 1)


@pytest.mark.parametrize("fault", ["revoked", "expired", "stale_source"])
async def test_authority_rechecked_between_reservation_and_provider(flow: Flow, monkeypatch, fault):
    await flow.capture.record()
    original = flow.runtime._jobs.prepare_dispatch

    async def invalidate(*args, **kwargs):
        batch = await original(*args, **kwargs)
        if fault == "revoked":
            async with flow.capture.trial.provider.transaction(flow.scope["tenant_id"]) as store:
                await store.revoke_consent(flow.scope["tenant_id"], flow.capture.trial.consent.id)
        elif fault == "expired":
            await _expire_normalized_source(
                flow.capture.trial.provider,
                flow.scope["tenant_id"],
                flow.scope["session_id"],
                admin_url=flow.capture.trial.admin_url,
            )
        else:
            result = flow.capture.speech.result
            result = replace(
                result,
                segments=(
                    replace(result.segments[0], content="Was there any fever?"),
                    *result.segments[1:],
                ),
            )
            async with flow.capture.trial.provider.transaction(flow.scope["tenant_id"]) as store:
                await store.accept_normalized_source_transcript(
                    **flow.scope,
                    idempotency_key="explicit-source-correction-0001",
                    request=normalize_azure_source(result),
                )
                await store.publish_current_working_transcript(**flow.scope)
        return batch

    monkeypatch.setattr(flow.runtime._jobs, "prepare_dispatch", invalidate)
    with pytest.raises(CapturedProcessingUnavailable):
        await flow.runtime.process(**flow.scope)
    assert flow.translator.calls == [] and await flow.counts() == (1, 0, 0)
    if fault == "stale_source":
        assert (await flow.fresh().process(**flow.scope)).state == State.REVIEW_REQUIRED
        assert flow.translator.calls == [SPANISH] and await flow.counts() == (2, 1, 0)


@pytest.mark.parametrize("kind", ["unknown", "english"])
async def test_quality_blocked_and_english_source_never_call_translator(flow: Flow, kind):
    result = flow.capture.speech.result
    if kind == "unknown":
        result = replace(
            result,
            segments=tuple(
                replace(segment, source_locale=SourceLocale.UNKNOWN) for segment in result.segments
            ),
        )
    else:
        result = replace(result, segments=(result.segments[0], result.segments[2]))
    flow.capture.speech.result = result
    await flow.capture.record()
    expected = State.QUALITY_BLOCKED if kind == "unknown" else State.TRANSCRIPT_READY
    assert (await flow.runtime.process(**flow.scope)).state == expected
    assert flow.translator.calls == [] and await flow.counts() == (0, 0, 0)


async def test_bounded_batch_does_not_starve_unstarted_segments(flow: Flow):
    result = flow.capture.speech.result
    flow.capture.speech.result = replace(
        result,
        segments=tuple(
            replace(result.segments[1], start_ms=index * 1000, end_ms=index * 1000 + 800)
            for index in range(3)
        ),
    )
    await flow.capture.record()
    runtime = flow.fresh(max_translations=1)
    for expected in range(1, 4):
        page = await runtime.run_pending(tenant_id=flow.scope["tenant_id"])
        assert len(page.receipts) == 1
        assert len(flow.translator.calls) == expected
        assert (await flow.counts())[:2] == (expected, expected)
    assert page.receipts[0].state == State.REVIEW_REQUIRED


@pytest.mark.parametrize("retryable", [False, True])
async def test_exhausted_crash_lease_becomes_terminal_without_provider(flow: Flow, retryable):
    await flow.capture.trial.processing()
    await flow.capture.trial.query("""
        UPDATE transcription_jobs SET attempt_count = 3,
            lease_until = clock_timestamp() - INTERVAL '1 second'
        WHERE tenant_id = :tenant AND session_id = :session
    """)
    if retryable:
        await flow.capture.trial.query("""
            UPDATE transcription_jobs SET status = 'retryable',
                lease_token = NULL, lease_until = NULL
            WHERE tenant_id = :tenant AND session_id = :session
        """)
    page = await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])
    assert page.receipts[0].state == State.SPEECH_FAILED
    assert not (await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"])).receipts
    assert flow.capture.speech.calls == 0 and flow.translator.calls == []
    assert (await flow.runtime.process(**flow.scope)).state == State.SPEECH_FAILED
    assert (
        await flow.capture.trial.query(
            "SELECT count(*) FROM audit_events WHERE tenant_id = :tenant "
            "AND action = 'captured_speech.exhausted'"
        )
    ).scalar_one() == 1


async def test_discovery_is_bounded_and_cursor_advances(flow: Flow):
    await flow.capture.record()
    original = flow.capture.trial.draft
    flow.capture.trial.draft = replace(original, id=uuid4())
    await flow.capture.trial.runtime.admit(
        tenant_id=flow.scope["tenant_id"], draft=flow.capture.trial.draft
    )
    await flow.capture.record()
    first = await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"], limit=1)
    assert len(first.receipts) == 1 and first.next_after is not None
    second = await flow.runtime.run_pending(
        tenant_id=flow.scope["tenant_id"], limit=1, after=first.next_after
    )
    assert len(second.receipts) == 1
    assert first.receipts[0].session_id != second.receipts[0].session_id
    assert len(flow.translator.calls) == 2 and flow.capture.speech.calls == 2
    default = PostgresRepositoryProvider(flow.capture.trial.provider.engine)
    async with default.transaction(flow.scope["tenant_id"]) as store:
        assert await store.get_processing_working_transcript(**flow.scope) is None


@pytest.mark.parametrize("limit", [0, 33, True])
async def test_invalid_limits_do_not_start_work(flow: Flow, limit):
    with pytest.raises(ValueError):
        flow.fresh(max_translations=limit)
    with pytest.raises(CapturedProcessingUnavailable):
        await flow.runtime.run_pending(tenant_id=flow.scope["tenant_id"], limit=limit)
    assert flow.capture.speech.calls == 0 and flow.translator.calls == []


async def test_uncertain_first_segment_does_not_starve_other_work(flow: Flow):
    result = flow.capture.speech.result
    flow.capture.speech.result = replace(
        result,
        segments=tuple(
            replace(result.segments[1], start_ms=index * 1000, end_ms=index * 1000 + 800)
            for index in range(3)
        ),
    )
    await flow.capture.record()
    runtime = flow.fresh(max_translations=1)
    flow.translator.block = True
    task = asyncio.create_task(runtime.process(**flow.scope))
    try:
        await asyncio.wait_for(flow.translator.started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    flow.translator.block = False
    for count in (2, 3):
        page = await runtime.run_pending(tenant_id=flow.scope["tenant_id"])
        assert page.receipts[0].state == State.TRANSLATION_UNCONFIRMED
        assert len(flow.translator.calls) == count
    assert await flow.counts() == (3, 2, 0)
    assert not (await runtime.run_pending(tenant_id=flow.scope["tenant_id"])).receipts


async def test_fresh_process_discovers_and_commits_stored_result_without_model(
    flow: Flow, monkeypatch
):
    await flow.capture.record()

    async def lost_mark(*args, **kwargs):
        raise OSError("synthetic lost marker")

    with monkeypatch.context() as patch:
        patch.setattr(flow.runtime._jobs, "mark_attempt_committed", lost_mark)
        with pytest.raises(CapturedProcessingUnavailable):
            await flow.runtime.process(**flow.scope)
    # Synthetic test key only, passed over stdin instead of a command-line value.
    keys = flow.cipher._keys
    pem = keys.private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    program = """
import asyncio, os, sys
from uuid import UUID
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from sqlalchemy.ext.asyncio import create_async_engine
from cosmaneura_scribe.captured_source_runtime import CapturedSourceRepositoryProvider
from cosmaneura_scribe.captured_processing import CapturedProcessingRuntime
from cosmaneura_scribe.translation_job_encryption import TranslationJobCipher
sys.path.insert(0, "tests")
from test_encrypted_translation_jobs import _LocalKeys
class NoAudio:
    def assemble(self, request):
        raise AssertionError("unexpected audio")
class NoSpeech:
    name = "azure_ai_speech"
    async def transcribe(self, request):
        raise AssertionError("unexpected Speech")
class NoModel:
    adapter_id = "synthetic_dispatch_adapter"
    model_profile_id = "synthetic_dispatch_profile_v1"
    async def translate(self, request):
        raise AssertionError("unexpected model")
async def run():
    keys = _LocalKeys(load_pem_private_key(sys.stdin.buffer.read(), None))
    provider = CapturedSourceRepositoryProvider(create_async_engine(os.environ["TRIAL_DB"]))
    try:
        runtime = CapturedProcessingRuntime(repositories=provider, assembler=NoAudio(),
            transcriber=NoSpeech(), translator=NoModel(),
            job_cipher=TranslationJobCipher(keys, keys),
            enabled=True)
        page = await runtime.run_pending(tenant_id=UUID(os.environ["TRIAL_TENANT"]))
        assert len(page.receipts) == 1 and page.receipts[0].state.value == "review_required"
        assert not (await runtime.run_pending(tenant_id=UUID(os.environ["TRIAL_TENANT"]))).receipts
        print("stored-result-recovered-without-providers")
    finally:
        await provider.close()
asyncio.run(run())
"""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        program,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={
            **os.environ,
            "TRIAL_DB": flow.capture.trial.provider.engine.url.render_as_string(
                hide_password=False
            ),
            "TRIAL_TENANT": str(flow.scope["tenant_id"]),
        },
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(pem), timeout=20)
        assert process.returncode == 0
        assert output == b"stored-result-recovered-without-providers\n"
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert flow.translator.calls == [SPANISH] and await flow.counts() == (1, 1, 0)
