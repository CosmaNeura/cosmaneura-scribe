from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.external_transcript_v1 import (
    SourceLocale,
    TranslationOutcome,
    TranslationReviewDecision,
)
from cosmaneura_scribe.normalized_source_persistence import ConfiguredExternalSessionStatus
from cosmaneura_scribe.postgres_repository import (
    PostgresRepository,
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.translation_review_persistence import (
    CreatorTranslationReviewCommand,
    TranslationReviewPersistenceCode,
    TranslationReviewPersistenceError,
    TranslationReviewWriteDisposition,
)
from cosmaneura_scribe.working_transcript_persistence import (
    WorkingTranscriptPersistenceCode,
    WorkingTranscriptPersistenceError,
    WorkingTranscriptPublishDisposition,
)
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine
from test_normalized_source_persistence import _expire_normalized_source, _request
from test_translation_attempt_persistence import _command, _seed_pending


def _review_command(
    source_version: int,
    segment_id: UUID,
    segment_version: int,
    translation_id: UUID,
    translation_version: int,
    reviewer_actor_id: str,
    *,
    review_id: UUID | None = None,
    decision: TranslationReviewDecision = TranslationReviewDecision.ACCEPTED,
    reviewed_at: datetime | None = None,
) -> CreatorTranslationReviewCommand:
    return CreatorTranslationReviewCommand(
        review_id=review_id or uuid4(),
        expected_source_transcript_version=source_version,
        source_segment_id=segment_id,
        expected_source_segment_version=segment_version,
        translation_id=translation_id,
        expected_translation_version=translation_version,
        decision=decision,
        reviewer_actor_id=reviewer_actor_id,
        reviewed_at=reviewed_at or datetime.now(UTC),
    )


async def _seed_review_required(
    provider: object,
    tenant_id: UUID,
) -> tuple[object, object, object, object]:
    draft, spanish, english = await _seed_pending(provider, tenant_id)
    async with provider.transaction(tenant_id) as store:  # type: ignore[attr-defined]
        attempt = await store.record_translation_attempt_and_publish(
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
            _command(
                1,
                spanish.source_segment_id,  # type: ignore[attr-defined]
                spanish.source_segment_version,  # type: ignore[attr-defined]
            ),
        )
    assert attempt is not None
    assert attempt.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED
    return draft, spanish, english, attempt


async def _derived_counts(
    provider: object,
    tenant_id: UUID,
    session_id: UUID,
) -> tuple[int, int, int]:
    if isinstance(provider, InMemoryRepository):
        return (
            sum(
                1
                for key in provider.normalized_translation_reviews
                if key[:2] == (tenant_id, session_id)
            ),
            sum(
                1
                for key in provider.normalized_working_transcripts
                if key[:2] == (tenant_id, session_id)
            ),
            sum(
                1
                for event in provider.audit_events
                if event.tenant_id == tenant_id
                and event.action == "normalized_translation_review.recorded"
            ),
        )
    assert isinstance(provider, PostgresRepositoryProvider)
    async with provider.engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant, true)"),
            {"tenant": str(tenant_id)},
        )
        row = (
            await connection.execute(
                text(
                    """
                    SELECT
                      (SELECT count(*) FROM normalized_translation_reviews
                       WHERE tenant_id = :tenant AND session_id = :session),
                      (SELECT count(*) FROM normalized_working_transcripts
                       WHERE tenant_id = :tenant AND session_id = :session),
                      (SELECT count(*) FROM audit_events
                       WHERE tenant_id = :tenant
                         AND action = 'normalized_translation_review.recorded')
                    """
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one()
    return row[0], row[1], row[2]


def test_command_and_errors_hide_protected_fields_and_reject_raw_enums() -> None:
    marker = "synthetic_reviewer_marker"
    command = _review_command(1, uuid4(), 1, uuid4(), 1, marker)
    error = TranslationReviewPersistenceError(TranslationReviewPersistenceCode.IDENTITY_CONFLICT)
    assert marker not in repr(command)
    assert marker not in repr(error) and marker not in str(error)
    with pytest.raises(ValueError, match="translation reviewer identifier is invalid"):
        replace(command, reviewer_actor_id="invalid reviewer")
    with pytest.raises(ValueError, match="reviewed_at must include a UTC offset"):
        replace(command, reviewed_at=datetime.now())
    for raw_decision in ("accepted", "rejected", "unknown"):
        with pytest.raises(ValueError, match="translation review decision is invalid"):
            replace(command, decision=cast(TranslationReviewDecision, raw_decision))


def test_accept_replay_identity_and_creator_fences_are_backend_equivalent(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _, attempt = await _seed_review_required(
            repository_backend.provider,
            tenant_id,
        )
        command = _review_command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            attempt.translation_id,  # type: ignore[attr-defined]
            attempt.translation_version,  # type: ignore[attr-defined]
            draft.creator_actor_id,  # type: ignore[attr-defined]
        )
        with pytest.raises(TranslationReviewPersistenceError) as wrong_creator:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    replace(command, reviewer_actor_id="different_verified_actor"),
                )
        assert wrong_creator.value.code == TranslationReviewPersistenceCode.CREATOR_MISMATCH

        with pytest.raises(TranslationReviewPersistenceError) as predates:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    replace(command, reviewed_at=attempt.created_at - timedelta(seconds=1)),  # type: ignore[attr-defined]
                )
        assert predates.value.code == TranslationReviewPersistenceCode.EVIDENCE_INVALID

        async with repository_backend.provider.transaction(tenant_id) as store:
            first = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                command,
            )
        assert first is not None
        assert first.disposition == TranslationReviewWriteDisposition.RECORDED
        assert first.decision == TranslationReviewDecision.ACCEPTED
        assert first.reviewed_at == command.reviewed_at
        assert first.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
        assert (
            first.current_working_transcript.disposition
            == WorkingTranscriptPublishDisposition.REPLACED
        )
        counts = await _derived_counts(repository_backend.provider, tenant_id, draft.id)  # type: ignore[attr-defined]
        assert counts == (1, 3, 1)

        async with repository_backend.provider.transaction(tenant_id) as store:
            replay = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                command,
            )
        assert replay is not None
        assert replay.disposition == TranslationReviewWriteDisposition.REPLAYED
        assert replay.reviewed_at == first.reviewed_at
        assert replay.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
        assert (
            replay.current_working_transcript.disposition
            == WorkingTranscriptPublishDisposition.REPLAYED
        )
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == counts  # type: ignore[attr-defined]

        with pytest.raises(TranslationReviewPersistenceError) as time_conflict:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    replace(command, reviewed_at=command.reviewed_at + timedelta(seconds=1)),
                )
        assert time_conflict.value.code == TranslationReviewPersistenceCode.IDENTITY_CONFLICT

        with pytest.raises(TranslationReviewPersistenceError) as conflict:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    replace(command, decision=TranslationReviewDecision.REJECTED),
                )
        assert conflict.value.code == TranslationReviewPersistenceCode.IDENTITY_CONFLICT

        other_draft, other_spanish, _, other_attempt = await _seed_review_required(
            repository_backend.provider,
            tenant_id,
        )
        reused = _review_command(
            1,
            other_spanish.source_segment_id,  # type: ignore[attr-defined]
            other_spanish.source_segment_version,  # type: ignore[attr-defined]
            other_attempt.translation_id,  # type: ignore[attr-defined]
            other_attempt.translation_version,  # type: ignore[attr-defined]
            other_draft.creator_actor_id,  # type: ignore[attr-defined]
            review_id=command.review_id,
        )
        with pytest.raises(TranslationReviewPersistenceError) as cross_session:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    other_draft.id,  # type: ignore[attr-defined]
                    reused,
                )
        assert cross_session.value.code == TranslationReviewPersistenceCode.IDENTITY_CONFLICT
        assert await _derived_counts(repository_backend.provider, tenant_id, other_draft.id) == (  # type: ignore[attr-defined]
            0,
            2,
            1,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.revoke_consent(
                tenant_id,
                other_draft.consent_record_id,  # type: ignore[attr-defined]
            )
        with pytest.raises(TranslationReviewPersistenceError) as revoked:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    other_draft.id,  # type: ignore[attr-defined]
                    replace(reused, review_id=uuid4()),
                )
        assert revoked.value.code == TranslationReviewPersistenceCode.CONSENT_INVALID

    repository_backend.run(scenario)


def test_rejection_retry_late_replay_and_stale_target_are_backend_equivalent(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _, first_attempt = await _seed_review_required(
            repository_backend.provider,
            tenant_id,
        )
        rejected_command = _review_command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            first_attempt.translation_id,  # type: ignore[attr-defined]
            1,
            draft.creator_actor_id,  # type: ignore[attr-defined]
            decision=TranslationReviewDecision.REJECTED,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            rejected = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                rejected_command,
            )
        assert rejected is not None
        assert rejected.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING

        async with repository_backend.provider.transaction(tenant_id) as store:
            retry = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                _command(
                    1,
                    spanish.source_segment_id,  # type: ignore[attr-defined]
                    spanish.source_segment_version,  # type: ignore[attr-defined]
                    previous_version=1,
                ),
            )
        assert retry is not None and retry.translation_version == 2
        assert retry.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED

        async with repository_backend.provider.transaction(tenant_id) as store:
            late_replay = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                rejected_command,
            )
        assert late_replay is not None
        assert late_replay.disposition == TranslationReviewWriteDisposition.REPLAYED
        assert late_replay.reviewed_at == rejected.reviewed_at
        assert late_replay.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED
        assert late_replay.current_working_transcript.working_transcript_version == 4

        with pytest.raises(TranslationReviewPersistenceError) as stale:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    replace(rejected_command, review_id=uuid4()),
                )
        assert stale.value.code == TranslationReviewPersistenceCode.STATE_CONFLICT

        accepted_command = _review_command(
            1,
            retry.source_segment_id,
            retry.source_segment_version,
            retry.translation_id,
            retry.translation_version,
            draft.creator_actor_id,  # type: ignore[attr-defined]
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            accepted = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                accepted_command,
            )
        assert accepted is not None
        assert accepted.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == (2, 5, 2)  # type: ignore[attr-defined]

    repository_backend.run(scenario)


def test_failed_attempt_and_expired_or_purged_source_reject_reviews(
    repository_backend: RepositoryBackend,
    request: pytest.FixtureRequest,
) -> None:
    tenant_id = uuid4()
    admin_url = (
        request.getfixturevalue("postgres_urls")[0]
        if repository_backend.name == "postgres"
        else None
    )

    async def scenario() -> None:
        draft, spanish, _ = await _seed_pending(repository_backend.provider, tenant_id)
        async with repository_backend.provider.transaction(tenant_id) as store:
            failed = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                _command(
                    1,
                    spanish.source_segment_id,  # type: ignore[attr-defined]
                    spanish.source_segment_version,  # type: ignore[attr-defined]
                    outcome=TranslationOutcome.FAILED,
                ),
            )
        assert failed is not None
        command = _review_command(
            1,
            failed.source_segment_id,
            failed.source_segment_version,
            failed.translation_id,
            failed.translation_version,
            draft.creator_actor_id,  # type: ignore[attr-defined]
        )
        with pytest.raises(TranslationReviewPersistenceError) as invalid:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
        assert invalid.value.code == TranslationReviewPersistenceCode.STATE_CONFLICT
        await _expire_normalized_source(
            repository_backend.provider,
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
            admin_url=admin_url,
        )
        with pytest.raises(TranslationReviewPersistenceError) as expired:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
        assert expired.value.code == TranslationReviewPersistenceCode.RETENTION_EXPIRED
        async with repository_backend.provider.transaction(tenant_id) as store:
            purge = await store.purge_normalized_source_content(tenant_id, draft.id)  # type: ignore[attr-defined]
        assert purge is not None and purge.changed
        with pytest.raises(TranslationReviewPersistenceError) as purged:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
        assert purged.value.code == TranslationReviewPersistenceCode.RETENTION_EXPIRED

    repository_backend.run(scenario)


def test_multi_spanish_reviews_remain_required_until_final_acceptance(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        from test_normalized_source_persistence import _consent, _draft, _seed_configured_session

        consent = _consent()
        draft = _draft(consent)
        source_request = _request()
        second_spanish = source_request.segments[1].model_copy(
            update={
                "speaker_slot": 2,
                "content": "Segundo texto fuente sintetico.",
                "start_ms": 2_100,
                "end_ms": 3_000,
            }
        )
        source_request = source_request.model_copy(
            update={
                "duration_ms": 3_000,
                "segments": (*source_request.segments, second_spanish),
            }
        )
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="review-multi-spanish-source",
                request=source_request,
            )
            source = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
            assert await store.publish_current_working_transcript(tenant_id, draft.id)
        assert source is not None
        spanish_segments = [
            item for item in source.segments if item.source_locale == SourceLocale.SPANISH_US
        ]
        attempts = []
        for spanish in spanish_segments:
            async with repository_backend.provider.transaction(tenant_id) as store:
                attempt = await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,
                    _command(
                        1,
                        spanish.source_segment_id,
                        spanish.source_segment_version,
                    ),
                )
            assert attempt is not None
            attempts.append(attempt)
        assert attempts[-1].status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED

        rejected_command = _review_command(
            1,
            attempts[0].source_segment_id,
            attempts[0].source_segment_version,
            attempts[0].translation_id,
            attempts[0].translation_version,
            draft.creator_actor_id,
            decision=TranslationReviewDecision.REJECTED,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            rejected = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,
                rejected_command,
            )
        assert rejected is not None
        assert rejected.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING

        second_command = _review_command(
            1,
            attempts[1].source_segment_id,
            attempts[1].source_segment_version,
            attempts[1].translation_id,
            attempts[1].translation_version,
            draft.creator_actor_id,
        )
        with pytest.raises(TranslationReviewPersistenceError) as blocked:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,
                    second_command,
                )
        assert blocked.value.code == TranslationReviewPersistenceCode.STATE_CONFLICT

        async with repository_backend.provider.transaction(tenant_id) as store:
            retry = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                _command(
                    1,
                    attempts[0].source_segment_id,
                    attempts[0].source_segment_version,
                    previous_version=1,
                ),
            )
        assert retry is not None
        retry_command = _review_command(
            1,
            retry.source_segment_id,
            retry.source_segment_version,
            retry.translation_id,
            retry.translation_version,
            draft.creator_actor_id,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            partial = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,
                retry_command,
            )
        assert partial is not None
        assert partial.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED

        async with repository_backend.provider.transaction(tenant_id) as store:
            final = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,
                second_command,
            )
        assert final is not None
        assert final.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY

    repository_backend.run(scenario)


def test_memory_projector_failure_rolls_back_review_and_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _, attempt = await _seed_review_required(provider, tenant_id)
        command = _review_command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            attempt.translation_id,  # type: ignore[attr-defined]
            attempt.translation_version,  # type: ignore[attr-defined]
            draft.creator_actor_id,  # type: ignore[attr-defined]
        )

        async def fail_projector(*_: object) -> object:
            raise WorkingTranscriptPersistenceError(WorkingTranscriptPersistenceCode.STATE_CONFLICT)

        monkeypatch.setattr(provider, "publish_current_working_transcript", fail_projector)
        async with provider.transaction(tenant_id) as store:
            with pytest.raises(TranslationReviewPersistenceError):
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
        assert await _derived_counts(provider, tenant_id, draft.id) == (0, 2, 0)  # type: ignore[attr-defined]

    asyncio.run(scenario())


def test_memory_replay_rechecks_locked_session_creator() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _, attempt = await _seed_review_required(provider, tenant_id)
        command = _review_command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            attempt.translation_id,  # type: ignore[attr-defined]
            attempt.translation_version,  # type: ignore[attr-defined]
            draft.creator_actor_id,  # type: ignore[attr-defined]
        )
        async with provider.transaction(tenant_id) as store:
            assert await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                command,
            )
        current = provider.versioned_external_sessions[(tenant_id, draft.id)]  # type: ignore[attr-defined]
        provider.versioned_external_sessions[(tenant_id, draft.id)] = replace(  # type: ignore[attr-defined]
            current,
            creator_actor_id="different_verified_actor",
        )
        with pytest.raises(TranslationReviewPersistenceError) as mismatch:
            async with provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
        assert mismatch.value.code == TranslationReviewPersistenceCode.CREATOR_MISMATCH

    asyncio.run(scenario())


def test_memory_invalid_projection_postcondition_rolls_back() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _, attempt = await _seed_review_required(provider, tenant_id)
        command = _review_command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            attempt.translation_id,  # type: ignore[attr-defined]
            attempt.translation_version,  # type: ignore[attr-defined]
            draft.creator_actor_id,  # type: ignore[attr-defined]
        )
        real_projector = provider.publish_current_working_transcript

        async def wrong_status(*args: object) -> object:
            publication = await real_projector(*args)  # type: ignore[arg-type]
            assert publication is not None
            return replace(
                publication,
                status=ConfiguredExternalSessionStatus.TRANSLATION_PENDING,
            )

        provider.publish_current_working_transcript = wrong_status  # type: ignore[method-assign]
        async with provider.transaction(tenant_id) as store:
            with pytest.raises(TranslationReviewPersistenceError) as failed:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
        assert failed.value.code == TranslationReviewPersistenceCode.STATE_CONFLICT
        assert await _derived_counts(provider, tenant_id, draft.id) == (0, 2, 0)  # type: ignore[attr-defined]

    asyncio.run(scenario())


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_same_session_concurrency_converges_and_competing_decision_loses(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(admin_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    draft, spanish, _, attempt = await _seed_review_required(provider, tenant_id)
    command = _review_command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
        attempt.translation_id,  # type: ignore[attr-defined]
        attempt.translation_version,  # type: ignore[attr-defined]
        draft.creator_actor_id,  # type: ignore[attr-defined]
    )
    first_holds = asyncio.Event()
    release = asyncio.Event()

    async def write(candidate: CreatorTranslationReviewCommand, *, hold: bool = False) -> object:
        async with provider.transaction(tenant_id) as store:
            result = await store.record_creator_translation_review_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                candidate,
            )
            if hold:
                first_holds.set()
                await release.wait()
            return result

    try:
        first = asyncio.create_task(write(command, hold=True))
        await first_holds.wait()
        replay = asyncio.create_task(write(command))
        await asyncio.sleep(0.05)
        assert not replay.done()
        release.set()
        results = await asyncio.gather(first, replay)
        assert {item.disposition for item in results if item is not None} == {
            TranslationReviewWriteDisposition.RECORDED,
            TranslationReviewWriteDisposition.REPLAYED,
        }
        with pytest.raises(TranslationReviewPersistenceError) as competing:
            await write(
                replace(
                    command,
                    review_id=uuid4(),
                    decision=TranslationReviewDecision.REJECTED,
                )
            )
        assert competing.value.code == TranslationReviewPersistenceCode.STATE_CONFLICT
        assert await _derived_counts(provider, tenant_id, draft.id) == (1, 3, 1)  # type: ignore[attr-defined]
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_cross_session_review_id_race_is_identity_conflict(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(admin_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    first_draft, first_spanish, _, first_attempt = await _seed_review_required(
        provider,
        tenant_id,
    )
    second_draft, second_spanish, _, second_attempt = await _seed_review_required(
        provider,
        tenant_id,
    )
    review_id = uuid4()
    first_command = _review_command(
        1,
        first_spanish.source_segment_id,  # type: ignore[attr-defined]
        first_spanish.source_segment_version,  # type: ignore[attr-defined]
        first_attempt.translation_id,  # type: ignore[attr-defined]
        first_attempt.translation_version,  # type: ignore[attr-defined]
        first_draft.creator_actor_id,  # type: ignore[attr-defined]
        review_id=review_id,
    )
    second_command = _review_command(
        1,
        second_spanish.source_segment_id,  # type: ignore[attr-defined]
        second_spanish.source_segment_version,  # type: ignore[attr-defined]
        second_attempt.translation_id,  # type: ignore[attr-defined]
        second_attempt.translation_version,  # type: ignore[attr-defined]
        second_draft.creator_actor_id,  # type: ignore[attr-defined]
        review_id=review_id,
    )
    first_holds = asyncio.Event()
    release = asyncio.Event()

    async def first_write() -> object:
        async with provider.transaction(tenant_id) as store:
            result = await store.record_creator_translation_review_and_publish(
                tenant_id,
                first_draft.id,  # type: ignore[attr-defined]
                first_command,
            )
            first_holds.set()
            await release.wait()
            return result

    async def second_write() -> object:
        with pytest.raises(TranslationReviewPersistenceError) as conflict:
            async with provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    second_draft.id,  # type: ignore[attr-defined]
                    second_command,
                )
        return conflict.value.code

    try:
        winner = asyncio.create_task(first_write())
        await first_holds.wait()
        loser = asyncio.create_task(second_write())
        await asyncio.sleep(0.05)
        assert not loser.done()
        release.set()
        assert await loser == TranslationReviewPersistenceCode.IDENTITY_CONFLICT
        assert await winner is not None
        assert await _derived_counts(provider, tenant_id, first_draft.id) == (1, 3, 1)  # type: ignore[attr-defined]
        assert await _derived_counts(provider, tenant_id, second_draft.id) == (0, 2, 1)  # type: ignore[attr-defined]
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_projector_failure_rolls_back_review_and_audit(
    postgres_urls: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    draft, spanish, _, attempt = await _seed_review_required(provider, tenant_id)
    command = _review_command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
        attempt.translation_id,  # type: ignore[attr-defined]
        attempt.translation_version,  # type: ignore[attr-defined]
        draft.creator_actor_id,  # type: ignore[attr-defined]
    )

    async def fail_projector(self: PostgresRepository, *_: object) -> object:
        raise WorkingTranscriptPersistenceError(WorkingTranscriptPersistenceCode.STATE_CONFLICT)

    monkeypatch.setattr(PostgresRepository, "publish_current_working_transcript", fail_projector)
    try:
        with pytest.raises(TranslationReviewPersistenceError) as failed:
            async with provider.transaction(tenant_id) as store:
                await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
        assert failed.value.code == TranslationReviewPersistenceCode.STATE_CONFLICT
        assert await _derived_counts(provider, tenant_id, draft.id) == (0, 2, 0)  # type: ignore[attr-defined]
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_commit_fence_rolls_back_review_and_projection(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    draft, spanish, _, attempt = await _seed_review_required(provider, tenant_id)
    command = _review_command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
        attempt.translation_id,  # type: ignore[attr-defined]
        attempt.translation_version,  # type: ignore[attr-defined]
        draft.creator_actor_id,  # type: ignore[attr-defined]
    )
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(text("SET LOCAL session_replication_role = replica"))
            await connection.execute(
                text(
                    """
                    UPDATE scribe_sessions
                    SET transcript_content_expires_at = clock_timestamp() + INTERVAL '2 seconds'
                    WHERE tenant_id = :tenant AND id = :session
                    """
                ),
                {"tenant": tenant_id, "session": draft.id},  # type: ignore[attr-defined]
            )
        with pytest.raises(DBAPIError) as commit_failure:
            async with provider.transaction(tenant_id) as store:
                result = await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    command,
                )
                assert result is not None and isinstance(store, PostgresRepository)
                await store._session.execute(text("SELECT pg_sleep(2.1)"))
        assert "Synthetic" not in str(commit_failure.value)
        assert await _derived_counts(provider, tenant_id, draft.id) == (0, 2, 0)  # type: ignore[attr-defined]
    finally:
        await engine.dispose()
        await provider.close()


def test_writer_remains_internal_and_dormant() -> None:
    root = Path(__file__).resolve().parents[1]
    migrations = tuple((root / "alembic" / "versions").glob("*.py"))
    assert all(
        "record_creator_translation_review_and_publish" not in path.read_text()
        for path in migrations
    )
    assert (
        "record_creator_translation_review_and_publish"
        not in (root / "services" / "api" / "src" / "cosmaneura_scribe" / "main.py").read_text()
    )
    bootstrap = (
        root / "services" / "api" / "src" / "cosmaneura_scribe" / "database_bootstrap.py"
    ).read_text()
    assert "derived_writer_database_permissions_enabled" in bootstrap
    assert "_grant_translation_permissions" in bootstrap
