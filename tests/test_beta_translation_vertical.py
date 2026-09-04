from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

import pytest
from cosmaneura_scribe.derived_writer_transactions import (
    commit_creator_translation_review_and_publish,
    commit_translation_attempt_and_publish,
)
from cosmaneura_scribe.external_transcript_v1 import (
    NormalizedSourceTranscriptRequestV1,
    SourceLocale,
    TranslationReviewDecision,
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
from cosmaneura_scribe.translation_review_persistence import (
    CreatorTranslationReviewCommand,
)
from test_normalized_source_persistence import (
    _consent,
    _draft,
    _seed_configured_session,
)

_FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "beta" / "bilingual_source_to_handoff_v1.json"
)


class _SyntheticSpanishEnglishAdapter:
    adapter_id = "synthetic_es_en_adapter"
    model_profile_id = "synthetic_es_en_profile_v1"

    def __init__(self, *, expected_source: str, result: str) -> None:
        self.expected_source = expected_source
        self.result = result
        self.call_count = 0

    async def translate(
        self,
        request: SpanishToEnglishTranslationRequest,
    ) -> SpanishToEnglishTranslationResult:
        self.call_count += 1
        assert request.content == self.expected_source
        return SpanishToEnglishTranslationResult(content=self.result)


@pytest.mark.asyncio
async def test_synthetic_bilingual_source_reaches_reviewed_english_note_handoff() -> None:
    fixture = json.loads(_FIXTURE_PATH.read_text())
    source_request = NormalizedSourceTranscriptRequestV1.model_validate_json(
        json.dumps(fixture["source"])
    )
    expected_translation = cast(str, fixture["spanish_to_english_result"])
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
    spanish = cast(
        NormalizedSourceSegmentRecord,
        next(item for item in source.segments if item.source_locale == SourceLocale.SPANISH_US),
    )
    adapter = _SyntheticSpanishEnglishAdapter(
        expected_source=spanish.content,
        result=expected_translation,
    )

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
    attempt = await commit_translation_attempt_and_publish(
        provider,
        tenant_id,
        draft.id,
        prepared_attempt,
    )

    assert attempt is not None
    assert adapter.call_count == 1
    assert attempt.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED

    review = await commit_creator_translation_review_and_publish(
        provider,
        tenant_id,
        draft.id,
        CreatorTranslationReviewCommand(
            review_id=uuid4(),
            expected_source_transcript_version=attempt.source_transcript_version,
            source_segment_id=attempt.source_segment_id,
            expected_source_segment_version=attempt.source_segment_version,
            translation_id=attempt.translation_id,
            expected_translation_version=attempt.translation_version,
            decision=TranslationReviewDecision.ACCEPTED,
            reviewer_actor_id=draft.creator_actor_id,
            reviewed_at=datetime.now(UTC),
        ),
    )

    assert review is not None
    assert review.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
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
    assert spanish.content not in handoff.model_dump_json()
    assert {
        "normalized_translation_attempt.recorded",
        "normalized_translation_review.recorded",
        "normalized_working_transcript.published",
    }.issubset(
        {event.action for event in provider.audit_events if event.tenant_id == tenant_id}
    )
