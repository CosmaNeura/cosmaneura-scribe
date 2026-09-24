from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.creator_review_contract_v1 import (
    CreatorReviewQueueStatus,
    CreatorTranslationDecisionRequestV1,
    build_creator_translation_review_queue,
)
from cosmaneura_scribe.derived_writer_transactions import (
    commit_creator_translation_review_and_publish,
    commit_translation_attempt_and_publish,
)
from cosmaneura_scribe.external_transcript_v1 import (
    NormalizedSourceTranscriptRequestV1,
    SourceLocale,
    TranslationOutcome,
    TranslationReviewDecision,
    WorkingTranscriptBlockerCode,
)
from cosmaneura_scribe.handoff import to_master_platform_payload_from_working_transcript
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
    prepare_spanish_to_english_attempt,
)
from cosmaneura_scribe.translation_attempt_persistence import (
    TranslationAttemptPersistenceCode,
    TranslationAttemptPersistenceError,
    TranslationAttemptWriteDisposition,
)
from cosmaneura_scribe.translation_fidelity import SYNTHETIC_CASES
from cosmaneura_scribe.translation_job_v1 import CompletedTranslationJobV1
from cosmaneura_scribe.translation_review_persistence import (
    TranslationReviewPersistenceCode,
    TranslationReviewPersistenceError,
)
from cosmaneura_scribe.working_transcript_persistence import (
    derive_persisted_working_transcript,
)
from test_azure_translation import adapter as _azure_adapter
from test_derived_writer_transactions import _FaultInjectingProvider
from test_normalized_source_persistence import (
    _consent,
    _draft,
    _request,
    _seed_configured_session,
)
from test_translation_attempt_persistence import _seed_pending

_FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "beta" / "bilingual_source_to_handoff_v1.json"
)


class _SyntheticSpanishEnglishAdapter:
    adapter_id = "synthetic_es_en_adapter"
    model_profile_id = "synthetic_es_en_profile_v1"

    def __init__(self, results: dict[str, str]) -> None:
        self.results = results
        self.call_count = 0

    async def translate(
        self,
        request: SpanishToEnglishTranslationRequest,
    ) -> SpanishToEnglishTranslationResult:
        self.call_count += 1
        return SpanishToEnglishTranslationResult(content=self.results[request.content])


@pytest.mark.asyncio
async def test_synthetic_bilingual_source_reaches_reviewed_english_note_handoff() -> None:
    fixture = json.loads(_FIXTURE_PATH.read_text())
    source_request = NormalizedSourceTranscriptRequestV1.model_validate_json(
        json.dumps(fixture["source"])
    )
    expected_translations = cast(dict[str, str], fixture["spanish_to_english_results"])
    provider = InMemoryRepository()
    tenant_id = uuid4()
    consent = _consent()
    draft = cast(VersionedExternalSessionCreate, _draft(consent))
    await _seed_configured_session(provider, tenant_id, consent, draft)
    async with provider.transaction(tenant_id) as store:
        assert await store.accept_normalized_source_transcript(
            tenant_id,
            draft.id,
            idempotency_key="synthetic-bilingual-source-v1",
            request=source_request,
        )
        source = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
        initial_working = await store.publish_current_working_transcript(tenant_id, draft.id)
    assert source is not None and initial_working is not None
    assert initial_working.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING
    spanish_segments = tuple(
        cast(NormalizedSourceSegmentRecord, item)
        for item in source.segments
        if item.source_locale == SourceLocale.SPANISH_US
    )
    assert len(spanish_segments) == 2
    adapter = _SyntheticSpanishEnglishAdapter(expected_translations)
    attempts = []
    for index, spanish in enumerate(spanish_segments):
        prepared_attempt = await prepare_spanish_to_english_attempt(
            adapter,
            ReservedSpanishTranslation(
                translation_id=uuid4(),
                expected_source_transcript_version=1,
                source_segment_id=spanish.source_segment_id,
                expected_source_segment_version=spanish.source_segment_version,
                expected_previous_translation_version=0,
                source_locale=spanish.source_locale,
                source_content=spanish.content,
            ),
        )
        completed_job = CompletedTranslationJobV1.from_command(
            tenant_id=tenant_id,
            session_id=draft.id,
            command=prepared_attempt,
        )
        recovered_job = CompletedTranslationJobV1.model_validate_json(
            completed_job.model_dump_json()
        )
        attempt = await commit_translation_attempt_and_publish(
            provider,
            recovered_job.tenant_id,
            recovered_job.session_id,
            recovered_job.to_command(),
        )
        assert attempt is not None
        expected_status = (
            ConfiguredExternalSessionStatus.REVIEW_REQUIRED
            if index == len(spanish_segments) - 1
            else ConfiguredExternalSessionStatus.TRANSLATION_PENDING
        )
        assert attempt.status == expected_status
        attempts.append(attempt)

    assert adapter.call_count == 2
    current_session = provider.versioned_external_sessions[(tenant_id, draft.id)]
    assert current_session.working_transcript_id is not None
    assert current_session.current_working_transcript_version is not None
    translation_records = tuple(
        record
        for key, record in provider.normalized_translation_attempts.items()
        if key[:3] == (tenant_id, draft.id, source.source_transcript_version)
    )
    review_bundle = derive_persisted_working_transcript(
        source,
        translation_records,
        (),
        working_transcript_id=current_session.working_transcript_id,
        working_transcript_version=current_session.current_working_transcript_version,
    ).bundle
    review_queue = build_creator_translation_review_queue(
        session_id=draft.id,
        bundle=review_bundle,
    )
    assert review_queue.status == CreatorReviewQueueStatus.REVIEW_REQUIRED
    assert len(review_queue.items) == len(attempts)

    review = None
    for index, item in enumerate(review_queue.items):
        decision = CreatorTranslationDecisionRequestV1(
            schema_version="1.0",
            expected_source_transcript_version=(
                review_queue.source_transcript_version
            ),
            source_segment_id=item.source_segment_id,
            expected_source_segment_version=item.source_segment_version,
            translation_id=item.translation_id,
            expected_translation_version=item.translation_version,
            decision=TranslationReviewDecision.ACCEPTED,
        )
        assert "reviewer_actor_id" not in decision.model_dump(mode="json")
        review = await commit_creator_translation_review_and_publish(
            provider,
            tenant_id,
            draft.id,
            decision.to_authorized_command(
                review_id=uuid4(),
                reviewer_actor_id=draft.creator_actor_id,
                reviewed_at=datetime.now(UTC),
            ),
        )
        assert review is not None
        expected_status = (
            ConfiguredExternalSessionStatus.TRANSCRIPT_READY
            if index == len(attempts) - 1
            else ConfiguredExternalSessionStatus.REVIEW_REQUIRED
        )
        assert review.status == expected_status

    assert review is not None
    working_key = (
        tenant_id,
        draft.id,
        review.current_working_transcript.working_transcript_version,
    )
    working = provider.normalized_working_transcripts[working_key].working_transcript
    assert working.note_ready

    handoff = to_master_platform_payload_from_working_transcript(
        encounter_id=draft.appointment_id,
        session_id=draft.id,
        working_transcript=working,
    )

    expected_handoff = fixture["expected_handoff"]
    assert handoff.duration_seconds == expected_handoff["duration_seconds"]
    assert [segment.model_dump(mode="json") for segment in handoff.segments] == (
        expected_handoff["segments"]
    )
    assert all(
        spanish.content not in handoff.model_dump_json() for spanish in spanish_segments
    )
    assert {
        "normalized_translation_attempt.recorded",
        "normalized_translation_review.recorded",
        "normalized_working_transcript.published",
    }.issubset(
        {event.action for event in provider.audit_events if event.tenant_id == tenant_id}
    )


@pytest.mark.asyncio
async def test_ambiguous_database_commit_replays_command_without_recalling_provider() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()
    raw_draft, raw_spanish, _ = await _seed_pending(provider, tenant_id)
    draft = cast(VersionedExternalSessionCreate, raw_draft)
    spanish = cast(NormalizedSourceSegmentRecord, raw_spanish)
    adapter = _SyntheticSpanishEnglishAdapter(
        {spanish.content: "Synthetic translation retained across database retry."}
    )
    prepared = await prepare_spanish_to_english_attempt(
        adapter,
        ReservedSpanishTranslation(
            translation_id=uuid4(),
            expected_source_transcript_version=1,
            source_segment_id=spanish.source_segment_id,
            expected_source_segment_version=spanish.source_segment_version,
            expected_previous_translation_version=0,
            source_locale=spanish.source_locale,
            source_content=spanish.content,
        ),
    )
    completed = CompletedTranslationJobV1.from_command(
        tenant_id=tenant_id,
        session_id=draft.id,
        command=prepared,
    )
    retrying_provider = _FaultInjectingProvider(provider, "lose_first_acknowledgement")

    publication = await commit_translation_attempt_and_publish(
        retrying_provider,
        completed.tenant_id,
        completed.session_id,
        completed.to_command(),
    )

    assert publication is not None
    assert publication.disposition == TranslationAttemptWriteDisposition.REPLAYED
    assert retrying_provider.transaction_calls == 2
    assert adapter.call_count == 1
    assert sum(
        1
        for key in provider.normalized_translation_attempts
        if key[:2] == (tenant_id, draft.id)
    ) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("intervening_change", ["consent_revoked", "source_corrected"])
async def test_completed_provider_result_fails_closed_after_authority_or_lineage_change(
    intervening_change: str,
) -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()
    raw_draft, raw_spanish, _ = await _seed_pending(provider, tenant_id)
    draft = cast(VersionedExternalSessionCreate, raw_draft)
    spanish = cast(NormalizedSourceSegmentRecord, raw_spanish)
    adapter = _SyntheticSpanishEnglishAdapter(
        {spanish.content: "Synthetic result that must not cross a stale boundary."}
    )
    prepared = await prepare_spanish_to_english_attempt(
        adapter,
        ReservedSpanishTranslation(
            translation_id=uuid4(),
            expected_source_transcript_version=1,
            source_segment_id=spanish.source_segment_id,
            expected_source_segment_version=spanish.source_segment_version,
            expected_previous_translation_version=0,
            source_locale=spanish.source_locale,
            source_content=spanish.content,
        ),
    )
    completed = CompletedTranslationJobV1.from_command(
        tenant_id=tenant_id,
        session_id=draft.id,
        command=prepared,
    )

    async with provider.transaction(tenant_id) as store:
        if intervening_change == "consent_revoked":
            assert await store.revoke_consent(tenant_id, draft.consent_record_id)
        else:
            assert await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="synthetic-source-correction-v2",
                request=_request(spanish_content="Contenido sintetico corregido."),
            )

    with pytest.raises(TranslationAttemptPersistenceError) as caught:
        await commit_translation_attempt_and_publish(
            provider,
            completed.tenant_id,
            completed.session_id,
            completed.to_command(),
        )

    expected_code = (
        TranslationAttemptPersistenceCode.CONSENT_INVALID
        if intervening_change == "consent_revoked"
        else TranslationAttemptPersistenceCode.STATE_CONFLICT
    )
    assert caught.value.code == expected_code
    assert adapter.call_count == 1
    assert not any(
        key[:2] == (tenant_id, draft.id)
        for key in provider.normalized_translation_attempts
    )


@pytest.mark.asyncio
async def test_content_filter_rejection_preserves_source_and_blocks_note_handoff() -> None:
    case = next(item for item in SYNTHETIC_CASES if item.case_id == "quoted_instruction")
    provider = InMemoryRepository()
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)
    async with provider.transaction(tenant_id) as store:
        assert await store.accept_normalized_source_transcript(
            tenant_id, draft.id, idempotency_key="synthetic-filter-source",
            request=_request(spanish_content=case.source),
        )
        source = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
        assert await store.publish_current_working_transcript(tenant_id, draft.id)
    assert source is not None
    spanish = next(
        item for item in source.segments if item.source_locale == SourceLocale.SPANISH_US
    )
    calls = 0

    def filtered_response(request):
        nonlocal calls
        calls += 1
        assert case.source in request.content.decode()
        return httpx.Response(400, json={"error": {
            "code": "content_filter", "innererror": {
                "code": "ResponsibleAIPolicyViolation",
                "content_filter_result": {"jailbreak": {"detected": True, "filtered": True}},
            },
        }})

    prepared = await prepare_spanish_to_english_attempt(
        _azure_adapter(filtered_response),
        ReservedSpanishTranslation(
            translation_id=uuid4(), expected_source_transcript_version=1,
            source_segment_id=spanish.source_segment_id,
            expected_source_segment_version=spanish.source_segment_version,
            expected_previous_translation_version=0,
            source_locale=spanish.source_locale, source_content=spanish.content,
        ),
    )
    assert calls == 1
    assert prepared.outcome == TranslationOutcome.FAILED
    assert prepared.failure_code == "provider_rejected" and prepared.content is None
    completed = CompletedTranslationJobV1.from_command(
        tenant_id=tenant_id, session_id=draft.id, command=prepared,
    )
    publication = await commit_translation_attempt_and_publish(
        provider, tenant_id, draft.id,
        CompletedTranslationJobV1.model_validate_json(completed.model_dump_json()).to_command(),
    )
    assert publication is not None
    assert publication.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING
    working = provider.normalized_working_transcripts[(
        tenant_id, draft.id, publication.current_working_transcript.working_transcript_version,
    )].working_transcript
    assert not working.note_ready
    assert WorkingTranscriptBlockerCode.TRANSLATION_FAILED in {
        blocker.code for blocker in working.blockers
    }
    async with provider.transaction(tenant_id) as store:
        assert await store.get_current_normalized_source_transcript(tenant_id, draft.id) == source
    with pytest.raises(ValueError, match="^working_transcript_not_note_ready$"):
        to_master_platform_payload_from_working_transcript(
            encounter_id=draft.appointment_id, session_id=draft.id, working_transcript=working,
        )
    decision = CreatorTranslationDecisionRequestV1(
        schema_version="1.0", expected_source_transcript_version=1,
        source_segment_id=spanish.source_segment_id,
        expected_source_segment_version=spanish.source_segment_version,
        translation_id=prepared.translation_id, expected_translation_version=1,
        decision=TranslationReviewDecision.ACCEPTED,
    )
    with pytest.raises(TranslationReviewPersistenceError) as rejected:
        await commit_creator_translation_review_and_publish(
            provider, tenant_id, draft.id,
            decision.to_authorized_command(
                review_id=uuid4(), reviewer_actor_id=draft.creator_actor_id,
                reviewed_at=datetime.now(UTC),
            ),
        )
    assert rejected.value.code == TranslationReviewPersistenceCode.STATE_CONFLICT
    assert calls == 1
