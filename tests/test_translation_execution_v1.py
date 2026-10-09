from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.external_transcript_v1 import SourceLocale, TranslationOutcome
from cosmaneura_scribe.normalized_source_persistence import (
    ConfiguredExternalSessionStatus,
    NormalizedSourceSegmentRecord,
    VersionedExternalSessionCreate,
)
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.translation_adapter import (
    ReservedSpanishTranslation,
    SpanishToEnglishTranslationRequest,
    SpanishToEnglishTranslationResult,
)
from cosmaneura_scribe.translation_execution_v1 import (
    DurableTranslationJobRecordV1,
    DurableTranslationJobStatus,
    RepositoryCompletedTranslationJobCommitter,
    TranslationExecutionDisposition,
    execute_reserved_translation_job,
)
from cosmaneura_scribe.translation_job_v1 import CompletedTranslationJobV1
from test_translation_attempt_persistence import _seed_pending

TENANT_ID = UUID("10000000-0000-4000-8000-000000000001")
SESSION_ID = UUID("20000000-0000-4000-8000-000000000001")
TRANSLATION_ID = UUID("30000000-0000-4000-8000-000000000001")
SEGMENT_ID = UUID("40000000-0000-4000-8000-000000000001")
CALL_TOKEN = UUID("50000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 9, 4, 20, 0, tzinfo=UTC)
SOURCE_MARKER = "Texto clinico sintetico para traducir."
RESULT_MARKER = "Synthetic clinical text to translate."


def _reservation() -> ReservedSpanishTranslation:
    return ReservedSpanishTranslation(
        translation_id=TRANSLATION_ID,
        expected_source_transcript_version=2,
        source_segment_id=SEGMENT_ID,
        expected_source_segment_version=3,
        expected_previous_translation_version=1,
        source_locale=SourceLocale.SPANISH_US,
        source_content=SOURCE_MARKER,
    )


def _reserved_record() -> DurableTranslationJobRecordV1:
    return DurableTranslationJobRecordV1(
        tenant_id=TENANT_ID,
        session_id=SESSION_ID,
        reservation=_reservation(),
        status=DurableTranslationJobStatus.RESERVED,
        reserved_at=NOW - timedelta(minutes=1),
    )


class _CountingAdapter:
    adapter_id = "synthetic_es_en_adapter"
    model_profile_id = "synthetic_es_en_profile_v1"

    def __init__(self, *, expected_source: str = SOURCE_MARKER) -> None:
        self.call_count = 0
        self.expected_source = expected_source

    async def translate(
        self,
        request: SpanishToEnglishTranslationRequest,
    ) -> SpanishToEnglishTranslationResult:
        self.call_count += 1
        assert request.content == self.expected_source
        return SpanishToEnglishTranslationResult(content=RESULT_MARKER)


class _MemoryDurableStore:
    def __init__(
        self,
        record: DurableTranslationJobRecordV1,
        *,
        fail_result_store_once: bool = False,
        fail_commit_mark_once: bool = False,
    ) -> None:
        self.record = record
        self.fail_result_store_once = fail_result_store_once
        self.fail_commit_mark_once = fail_commit_mark_once

    async def reserve_translation_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        reservation: ReservedSpanishTranslation,
    ) -> DurableTranslationJobRecordV1:
        assert (tenant_id, session_id, reservation.translation_id) == (
            self.record.tenant_id,
            self.record.session_id,
            self.record.reservation.translation_id,
        )
        assert reservation == self.record.reservation
        return self.record

    async def get_translation_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
    ) -> DurableTranslationJobRecordV1 | None:
        if (
            tenant_id,
            session_id,
            translation_id,
        ) != (
            self.record.tenant_id,
            self.record.session_id,
            self.record.reservation.translation_id,
        ):
            return None
        return self.record

    async def claim_provider_call(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        provider_call_token: UUID,
    ) -> DurableTranslationJobRecordV1 | None:
        if self.record.status != DurableTranslationJobStatus.RESERVED:
            return None
        assert (tenant_id, session_id, translation_id) == (
            self.record.tenant_id,
            self.record.session_id,
            self.record.reservation.translation_id,
        )
        self.record = replace(
            self.record,
            status=DurableTranslationJobStatus.PROVIDER_CALL_STARTED,
            provider_call_token=provider_call_token,
            provider_call_started_at=NOW,
        )
        return self.record

    async def store_provider_result(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        provider_call_token: UUID,
        completed_job: CompletedTranslationJobV1,
    ) -> DurableTranslationJobRecordV1:
        assert (tenant_id, session_id, translation_id) == (
            self.record.tenant_id,
            self.record.session_id,
            self.record.reservation.translation_id,
        )
        assert self.record.status == DurableTranslationJobStatus.PROVIDER_CALL_STARTED
        assert self.record.provider_call_token == provider_call_token
        if self.fail_result_store_once:
            self.fail_result_store_once = False
            raise RuntimeError("synthetic_result_store_failure")
        self.record = replace(
            self.record,
            status=DurableTranslationJobStatus.PROVIDER_RESULT_STORED,
            completed_job=completed_job,
            provider_result_stored_at=NOW + timedelta(seconds=1),
        )
        return self.record

    async def mark_attempt_committed(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        completed_job_fingerprint: str,
    ) -> DurableTranslationJobRecordV1:
        assert (tenant_id, session_id, translation_id) == (
            self.record.tenant_id,
            self.record.session_id,
            self.record.reservation.translation_id,
        )
        assert self.record.status == DurableTranslationJobStatus.PROVIDER_RESULT_STORED
        assert self.record.completed_job is not None
        assert self.record.completed_job.fingerprint() == completed_job_fingerprint
        if self.fail_commit_mark_once:
            self.fail_commit_mark_once = False
            raise RuntimeError("synthetic_commit_mark_failure")
        self.record = replace(
            self.record,
            status=DurableTranslationJobStatus.ATTEMPT_COMMITTED,
            attempt_committed_at=NOW + timedelta(seconds=2),
        )
        return self.record


class _RecordingCommitter:
    def __init__(self, *, fail_once: bool = False) -> None:
        self.fail_once = fail_once
        self.fingerprints: list[str] = []

    async def commit_completed_translation_job(
        self,
        completed_job: CompletedTranslationJobV1,
    ) -> None:
        self.fingerprints.append(completed_job.fingerprint())
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError("synthetic_database_commit_failure")


class _WrongScopeStore(_MemoryDurableStore):
    async def get_translation_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
    ) -> DurableTranslationJobRecordV1 | None:
        del tenant_id, session_id, translation_id
        return replace(self.record, tenant_id=UUID(int=TENANT_ID.int + 1))


async def _execute(
    store: _MemoryDurableStore,
    adapter: _CountingAdapter,
    committer: _RecordingCommitter,
):
    return await execute_reserved_translation_job(
        store=store,
        adapter=adapter,
        committer=committer,
        tenant_id=TENANT_ID,
        session_id=SESSION_ID,
        translation_id=TRANSLATION_ID,
        provider_call_token=CALL_TOKEN,
    )


@pytest.mark.asyncio
async def test_first_execution_persists_result_before_committing_attempt() -> None:
    store = _MemoryDurableStore(_reserved_record())
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()

    receipt = await _execute(store, adapter, committer)

    assert receipt.disposition == TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
    assert store.record.status == DurableTranslationJobStatus.ATTEMPT_COMMITTED
    assert adapter.call_count == 1
    assert len(committer.fingerprints) == 1
    assert store.record.completed_job is not None
    assert store.record.completed_job.content == RESULT_MARKER
    assert SOURCE_MARKER not in repr(store.record)
    assert RESULT_MARKER not in str(store.record)


@pytest.mark.asyncio
async def test_database_failure_reuses_stored_result_without_provider_replay() -> None:
    store = _MemoryDurableStore(_reserved_record())
    adapter = _CountingAdapter()
    committer = _RecordingCommitter(fail_once=True)

    with pytest.raises(RuntimeError, match="synthetic_database_commit_failure"):
        await _execute(store, adapter, committer)
    assert store.record.status == DurableTranslationJobStatus.PROVIDER_RESULT_STORED
    assert adapter.call_count == 1
    stored_fingerprint = store.record.completed_job.fingerprint()  # type: ignore[union-attr]

    receipt = await _execute(store, adapter, committer)

    assert receipt.disposition == TranslationExecutionDisposition.STORED_RESULT_COMMITTED
    assert store.record.status == DurableTranslationJobStatus.ATTEMPT_COMMITTED
    assert adapter.call_count == 1
    assert committer.fingerprints == [stored_fingerprint, stored_fingerprint]


@pytest.mark.asyncio
async def test_lost_database_acknowledgement_replays_writer_not_provider() -> None:
    store = _MemoryDurableStore(_reserved_record(), fail_commit_mark_once=True)
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()

    with pytest.raises(RuntimeError, match="synthetic_commit_mark_failure"):
        await _execute(store, adapter, committer)
    assert store.record.status == DurableTranslationJobStatus.PROVIDER_RESULT_STORED
    assert adapter.call_count == 1

    receipt = await _execute(store, adapter, committer)

    assert receipt.disposition == TranslationExecutionDisposition.STORED_RESULT_COMMITTED
    assert adapter.call_count == 1
    assert len(committer.fingerprints) == 2
    assert committer.fingerprints[0] == committer.fingerprints[1]


@pytest.mark.asyncio
async def test_ambiguous_provider_outcome_is_never_automatically_replayed() -> None:
    store = _MemoryDurableStore(_reserved_record(), fail_result_store_once=True)
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()

    with pytest.raises(RuntimeError, match="synthetic_result_store_failure"):
        await _execute(store, adapter, committer)
    assert store.record.status == DurableTranslationJobStatus.PROVIDER_CALL_STARTED
    assert adapter.call_count == 1
    assert committer.fingerprints == []

    receipt = await _execute(store, adapter, committer)

    assert receipt.disposition == TranslationExecutionDisposition.PROVIDER_CALL_NOT_REPLAYED
    assert store.record.status == DurableTranslationJobStatus.PROVIDER_CALL_STARTED
    assert adapter.call_count == 1
    assert committer.fingerprints == []


@pytest.mark.asyncio
async def test_already_committed_job_is_a_noop() -> None:
    store = _MemoryDurableStore(_reserved_record())
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()
    first = await _execute(store, adapter, committer)

    replay = await _execute(store, adapter, committer)

    assert first.disposition == TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
    assert replay.disposition == TranslationExecutionDisposition.ALREADY_COMMITTED
    assert adapter.call_count == 1
    assert len(committer.fingerprints) == 1


@pytest.mark.asyncio
async def test_repository_committer_reaches_existing_derived_writer() -> None:
    repository = InMemoryRepository()
    tenant_id = uuid4()
    raw_draft, raw_spanish, _ = await _seed_pending(repository, tenant_id)
    draft = cast(VersionedExternalSessionCreate, raw_draft)
    spanish = cast(NormalizedSourceSegmentRecord, raw_spanish)
    reservation = ReservedSpanishTranslation(
        translation_id=uuid4(),
        expected_source_transcript_version=1,
        source_segment_id=spanish.source_segment_id,
        expected_source_segment_version=spanish.source_segment_version,
        expected_previous_translation_version=0,
        source_locale=spanish.source_locale,
        source_content=spanish.content,
    )
    store = _MemoryDurableStore(
        DurableTranslationJobRecordV1(
            tenant_id=tenant_id,
            session_id=draft.id,
            reservation=reservation,
            status=DurableTranslationJobStatus.RESERVED,
            reserved_at=NOW - timedelta(minutes=1),
        )
    )
    adapter = _CountingAdapter(expected_source=spanish.content)

    receipt = await execute_reserved_translation_job(
        store=store,
        adapter=adapter,
        committer=RepositoryCompletedTranslationJobCommitter(repository),
        tenant_id=tenant_id,
        session_id=draft.id,
        translation_id=reservation.translation_id,
        provider_call_token=uuid4(),
    )

    assert receipt.disposition == TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
    assert adapter.call_count == 1
    assert repository.versioned_external_sessions[(tenant_id, draft.id)].status == (
        ConfiguredExternalSessionStatus.REVIEW_REQUIRED
    )
    assert len(repository.normalized_translation_attempts) == 1


@pytest.mark.asyncio
async def test_store_scope_mismatch_fails_before_provider_call() -> None:
    store = _WrongScopeStore(_reserved_record())
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()

    with pytest.raises(ValueError, match="durable_translation_job_scope_conflict"):
        await _execute(store, adapter, committer)

    assert adapter.call_count == 0
    assert committer.fingerprints == []


def test_durable_job_rejects_completed_result_from_different_scope() -> None:
    reserved = _reserved_record()
    adapter_command_job = CompletedTranslationJobV1(
        schema_version="1.0",
        tenant_id=UUID(int=TENANT_ID.int + 1),
        session_id=SESSION_ID,
        translation_id=TRANSLATION_ID,
        expected_source_transcript_version=2,
        source_segment_id=SEGMENT_ID,
        expected_source_segment_version=3,
        expected_previous_translation_version=1,
        source_locale="es-US",
        target_locale="en-US",
        outcome=TranslationOutcome.SUCCEEDED,
        translation_adapter_id="synthetic_es_en_adapter",
        translation_model_profile_id="synthetic_es_en_profile_v1",
        content=RESULT_MARKER,
    )

    with pytest.raises(ValueError, match="does not match reservation"):
        replace(
            reserved,
            status=DurableTranslationJobStatus.PROVIDER_RESULT_STORED,
            provider_call_token=CALL_TOKEN,
            provider_call_started_at=NOW,
            completed_job=adapter_command_job,
            provider_result_stored_at=NOW,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "source_content",
        "source_transcript_version",
        "source_segment_version",
        "previous_translation_version",
        "reserved_at",
    ],
)
async def test_changed_reservation_at_claim_cannot_reach_provider(mutation: str) -> None:
    class ChangedClaimStore(_MemoryDurableStore):
        async def claim_provider_call(self, *args, **kwargs):
            claimed = await super().claim_provider_call(*args, **kwargs)
            assert claimed is not None
            fields = {
                "source_content": {"source_content": "Otro texto sintetico."},
                "source_transcript_version": {"expected_source_transcript_version": 4},
                "source_segment_version": {"expected_source_segment_version": 4},
                "previous_translation_version": {"expected_previous_translation_version": 2},
            }
            if mutation == "reserved_at":
                return replace(claimed, reserved_at=claimed.reserved_at - timedelta(seconds=1))
            return replace(claimed, reservation=replace(claimed.reservation, **fields[mutation]))

    store = ChangedClaimStore(_reserved_record())
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()

    with pytest.raises(ValueError, match="^durable_translation_job_reservation_conflict$"):
        await _execute(store, adapter, committer)

    assert adapter.call_count == 0
    assert committer.fingerprints == []


@pytest.mark.asyncio
@pytest.mark.parametrize("transition", ["lost_claim", "stored_result", "committed"])
async def test_each_store_transition_preserves_reserved_source(transition: str) -> None:
    class ChangedTransitionStore(_MemoryDurableStore):
        def changed(self, record):
            return replace(
                record,
                reservation=replace(record.reservation, source_content="Otro texto sintetico."),
            )

        async def claim_provider_call(self, *args, **kwargs):
            claimed = await super().claim_provider_call(*args, **kwargs)
            if transition == "lost_claim":
                assert claimed is not None
                self.record = self.changed(claimed)
                return None
            return claimed

        async def store_provider_result(self, *args, **kwargs):
            stored = await super().store_provider_result(*args, **kwargs)
            return self.changed(stored) if transition == "stored_result" else stored

        async def mark_attempt_committed(self, *args, **kwargs):
            committed = await super().mark_attempt_committed(*args, **kwargs)
            return self.changed(committed) if transition == "committed" else committed

    store = ChangedTransitionStore(_reserved_record())
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()

    with pytest.raises(ValueError, match="^durable_translation_job_reservation_conflict$"):
        await _execute(store, adapter, committer)

    assert adapter.call_count == (0 if transition == "lost_claim" else 1)
    assert len(committer.fingerprints) == (1 if transition == "committed" else 0)


@pytest.mark.asyncio
async def test_unchanged_competing_claim_does_not_repeat_provider() -> None:
    class LostClaimStore(_MemoryDurableStore):
        async def claim_provider_call(self, *args, **kwargs):
            await super().claim_provider_call(*args, **kwargs)
            return None

    store = LostClaimStore(_reserved_record())
    adapter = _CountingAdapter()
    committer = _RecordingCommitter()

    receipt = await _execute(store, adapter, committer)

    assert receipt.disposition == TranslationExecutionDisposition.PROVIDER_CALL_NOT_REPLAYED
    assert adapter.call_count == 0
    assert committer.fingerprints == []
