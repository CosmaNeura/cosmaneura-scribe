from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.creator_review_contract_v1 import (
    CreatorReviewQueueStatus,
    CreatorTranslationDecisionRequestV1,
)
from cosmaneura_scribe.external_transcript_v1 import TranslationReviewDecision
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.transcript_review_service import (
    CreatorTranscriptReviewService,
    TranscriptReviewUnavailable,
)
from test_normalized_source_persistence import (
    _consent,
    _draft,
    _expire_normalized_source,
    _request,
    _seed_configured_session,
)
from test_translation_attempt_persistence import _command
from test_working_transcript_persistence import _working_counts


def test_creator_read_decide_retry_and_current_evidence(
    repository_backend: RepositoryBackend,
) -> None:
    async def scenario() -> None:
        provider = repository_backend.provider
        tenant, consent = uuid4(), _consent()
        draft = _draft(consent)
        await _seed_configured_session(provider, tenant, consent, draft)
        service = CreatorTranscriptReviewService(provider, enabled=True)
        scope = dict(tenant_id=tenant, session_id=draft.id, creator_actor_id=draft.creator_actor_id)
        with pytest.raises(TranscriptReviewUnavailable):
            await service.read(**scope)
        async with provider.transaction(tenant) as repository:
            await repository.accept_normalized_source_transcript(
                tenant,
                draft.id,
                idempotency_key="creator-read-source",
                request=_request(),
            )
        # Reading cannot implicitly publish or mark a source reviewed.
        with pytest.raises(TranscriptReviewUnavailable):
            await service.read(**scope)
        async with provider.transaction(tenant) as repository:
            publication = await repository.publish_current_working_transcript(tenant, draft.id)
        assert publication is not None
        counts = await _working_counts(provider, tenant, draft.id)
        initial = await service.read(**scope)
        assert not initial.working_transcript.note_ready
        assert (await service.review_queue(**scope)).status == CreatorReviewQueueStatus.NOT_READY
        assert await _working_counts(provider, tenant, draft.id) == counts
        for denied in (
            {**scope, "tenant_id": uuid4()},
            {**scope, "session_id": uuid4()},
            {**scope, "creator_actor_id": "different_verified_creator"},
            {**scope, "creator_actor_id": ""},
        ):
            with pytest.raises(TranscriptReviewUnavailable):
                await service.read(**denied)
        spanish = initial.bundle.source_transcript.segments[1]
        async with provider.transaction(tenant) as repository:
            attempt = await repository.record_translation_attempt_and_publish(
                tenant,
                draft.id,
                _command(1, spanish.source_segment_id, spanish.source_segment_version),
            )
        assert attempt is not None
        queue = await service.review_queue(**scope)
        assert queue.status == CreatorReviewQueueStatus.REVIEW_REQUIRED
        assert len(queue.items) == 1
        item = queue.items[0]
        assert item.source_content == spanish.content
        assert item.translated_content == "Synthetic English translation."
        decision = CreatorTranslationDecisionRequestV1(
            schema_version="1.0",
            expected_source_transcript_version=1,
            source_segment_id=item.source_segment_id,
            expected_source_segment_version=item.source_segment_version,
            translation_id=item.translation_id,
            expected_translation_version=item.translation_version,
            decision=TranslationReviewDecision.ACCEPTED,
        )
        review_id, reviewed_at = uuid4(), datetime.now(UTC)
        arguments = dict(request=decision, review_id=review_id, reviewed_at=reviewed_at)
        with pytest.raises(TranscriptReviewUnavailable):
            await service.decide(
                **{**scope, "creator_actor_id": "different_verified_creator"}, **arguments
            )
        await service.decide(**scope, **arguments)
        counts = await _working_counts(provider, tenant, draft.id)
        # Fresh service instance and exact request recover the same decision.
        service = CreatorTranscriptReviewService(provider, enabled=True)
        await service.decide(**scope, **arguments)
        assert await _working_counts(provider, tenant, draft.id) == counts
        current = await service.read(**scope)
        assert current.working_transcript.note_ready
        assert current.bundle.source_transcript == initial.bundle.source_transcript
        assert (await service.review_queue(**scope)).status == CreatorReviewQueueStatus.COMPLETE
        with pytest.raises(TranscriptReviewUnavailable):
            await service.decide(
                **scope,
                **{
                    **arguments,
                    "request": decision.model_copy(
                        update={"decision": TranslationReviewDecision.REJECTED},
                    ),
                },
            )
        async with provider.transaction(tenant) as repository:
            await repository.revoke_consent(tenant, consent.id)
        with pytest.raises(TranscriptReviewUnavailable):
            await service.read(**scope)
        with pytest.raises(TranscriptReviewUnavailable):
            await service.decide(**scope, **arguments)

    repository_backend.run(scenario)


def test_creator_read_rechecks_retention(
    repository_backend: RepositoryBackend,
    request: pytest.FixtureRequest,
) -> None:
    admin_url = (
        request.getfixturevalue("postgres_urls")[0]
        if repository_backend.name == "postgres"
        else None
    )

    async def scenario() -> None:
        provider = repository_backend.provider
        tenant, consent = uuid4(), _consent()
        draft = _draft(consent)
        await _seed_configured_session(provider, tenant, consent, draft)
        async with provider.transaction(tenant) as repository:
            await repository.accept_normalized_source_transcript(
                tenant,
                draft.id,
                idempotency_key="creator-expiry-source",
                request=_request(),
            )
            await repository.publish_current_working_transcript(tenant, draft.id)
        await _expire_normalized_source(provider, tenant, draft.id, admin_url=admin_url)
        with pytest.raises(TranscriptReviewUnavailable):
            await CreatorTranscriptReviewService(provider, enabled=True).read(
                tenant_id=tenant,
                session_id=draft.id,
                creator_actor_id=draft.creator_actor_id,
            )

    repository_backend.run(scenario)


def test_disabled_boundary_does_not_read_or_mutate() -> None:
    class UntouchedRepository(InMemoryRepository):
        def transaction(self, tenant_id):
            raise AssertionError("disabled path touched repository")

    async def scenario() -> None:
        service = CreatorTranscriptReviewService(UntouchedRepository())
        scope = dict(tenant_id=uuid4(), session_id=uuid4(), creator_actor_id="synthetic_creator")
        with pytest.raises(TranscriptReviewUnavailable):
            await service.read(**scope)
        with pytest.raises(TranscriptReviewUnavailable):
            await service.review_queue(**scope)

    asyncio.run(scenario())


def test_corrupt_projection_is_not_repaired_or_returned() -> None:
    async def scenario() -> None:
        provider = InMemoryRepository()
        tenant, consent = uuid4(), _consent()
        draft = _draft(consent)
        await _seed_configured_session(provider, tenant, consent, draft)
        async with provider.transaction(tenant) as repository:
            await repository.accept_normalized_source_transcript(
                tenant,
                draft.id,
                idempotency_key="creator-corrupt-source",
                request=_request(),
            )
            await repository.publish_current_working_transcript(tenant, draft.id)
        key = (tenant, draft.id, 1)
        provider.normalized_working_transcripts[key] = replace(
            provider.normalized_working_transcripts[key],
            working_fingerprint="0" * 64,
        )
        with pytest.raises(TranscriptReviewUnavailable) as failure:
            await CreatorTranscriptReviewService(provider, enabled=True).read(
                tenant_id=tenant,
                session_id=draft.id,
                creator_actor_id=draft.creator_actor_id,
            )
        assert failure.value.__cause__ is None and failure.value.__context__ is None
        assert provider.normalized_working_transcripts[key].working_fingerprint == "0" * 64

    asyncio.run(scenario())


@pytest.mark.parametrize("cancel", [False, True])
def test_safe_exception_boundary_preserves_cancellation(cancel: bool) -> None:
    class BrokenRepository(InMemoryRepository):
        async def get_creator_working_transcript(self, *args, **kwargs):
            if cancel:
                raise asyncio.CancelledError()
            raise RuntimeError("synthetic protected driver value")

    async def scenario() -> None:
        service = CreatorTranscriptReviewService(BrokenRepository(), enabled=True)
        expected = asyncio.CancelledError if cancel else TranscriptReviewUnavailable
        with pytest.raises(expected) as failure:
            await service.read(
                tenant_id=uuid4(),
                session_id=uuid4(),
                creator_actor_id="synthetic_creator",
            )
        assert failure.value.__cause__ is None and failure.value.__context__ is None
        assert "protected driver" not in str(failure.value)

    asyncio.run(scenario())
