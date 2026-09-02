from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import cast
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.external_transcript_v1 import (
    SourceLocale,
    TranslationOutcome,
    TranslationRecordV1,
    TranslationReviewDecision,
    TranslationReviewEvidenceV1,
)
from cosmaneura_scribe.normalized_source_persistence import ConfiguredExternalSessionStatus
from cosmaneura_scribe.postgres_repository import (
    PostgresRepository,
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.translation_attempt_persistence import (
    TranslationAttemptCommand,
    TranslationAttemptPersistenceCode,
    TranslationAttemptPersistenceError,
    TranslationAttemptWriteDisposition,
)
from cosmaneura_scribe.working_transcript_persistence import (
    WorkingTranscriptPersistenceCode,
    WorkingTranscriptPersistenceError,
    WorkingTranscriptPublishDisposition,
)
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine
from test_normalized_source_persistence import (
    _consent,
    _draft,
    _expire_normalized_source,
    _request,
    _seed_configured_session,
)


def _command(
    source_version: int,
    segment_id: UUID,
    segment_version: int,
    *,
    translation_id: UUID | None = None,
    previous_version: int = 0,
    outcome: TranslationOutcome = TranslationOutcome.SUCCEEDED,
    content: str | None = "Synthetic English translation.",
) -> TranslationAttemptCommand:
    return TranslationAttemptCommand(
        translation_id=translation_id or uuid4(),
        expected_source_transcript_version=source_version,
        source_segment_id=segment_id,
        expected_source_segment_version=segment_version,
        expected_previous_translation_version=previous_version,
        outcome=outcome,
        content=content if outcome == TranslationOutcome.SUCCEEDED else None,
        failure_code=None if outcome == TranslationOutcome.SUCCEEDED else "adapter_unavailable",
        translation_adapter_id="synthetic_translation_adapter",
        translation_model_profile_id="synthetic_translation_profile_v1",
    )


async def _seed_pending(
    provider: object,
    tenant_id: UUID,
) -> tuple[object, object, object]:
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)
    async with provider.transaction(tenant_id) as store:  # type: ignore[attr-defined]
        assert await store.accept_normalized_source_transcript(
            tenant_id,
            draft.id,
            idempotency_key=f"source-{uuid4()}",
            request=_request(),
        )
        source = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
        initial = await store.publish_current_working_transcript(tenant_id, draft.id)
    assert source is not None and initial is not None
    assert initial.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING
    spanish = next(
        item for item in source.segments if item.source_locale == SourceLocale.SPANISH_US
    )
    english = next(
        item for item in source.segments if item.source_locale == SourceLocale.ENGLISH_US
    )
    return draft, spanish, english


async def _derived_counts(
    provider: object,
    tenant_id: UUID,
    session_id: UUID,
) -> tuple[int, int, int]:
    if isinstance(provider, InMemoryRepository):
        return (
            sum(
                1
                for key in provider.normalized_translation_attempts
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
                and event.action == "normalized_translation_attempt.recorded"
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
                      (SELECT count(*) FROM normalized_translation_attempts
                       WHERE tenant_id = :tenant AND session_id = :session),
                      (SELECT count(*) FROM normalized_working_transcripts
                       WHERE tenant_id = :tenant AND session_id = :session),
                      (SELECT count(*) FROM audit_events
                       WHERE tenant_id = :tenant
                         AND action = 'normalized_translation_attempt.recorded')
                    """
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one()
    return row[0], row[1], row[2]


def test_command_and_failures_hide_protected_text() -> None:
    marker = "Synthetic secret translation marker"
    command = _command(1, uuid4(), 1, content=marker)
    error = TranslationAttemptPersistenceError(TranslationAttemptPersistenceCode.IDENTITY_CONFLICT)
    assert marker not in repr(command)
    assert marker not in repr(error) and marker not in str(error)
    with pytest.raises(ValueError, match="successful translation result is invalid"):
        replace(command, content="   ")
    with pytest.raises(ValueError, match="failed translation result is invalid"):
        replace(command, outcome=TranslationOutcome.FAILED, failure_code="Bad-Code")
    for raw_outcome in ("succeeded", "failed", "unknown"):
        with pytest.raises(ValueError, match="translation outcome is invalid"):
            replace(
                command,
                outcome=cast(TranslationOutcome, raw_outcome),
                content=None,
                failure_code="adapter_unavailable",
            )


def test_success_replay_conflict_and_lineage_are_backend_equivalent(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _ = await _seed_pending(repository_backend.provider, tenant_id)
        command = _command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            first = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                command,
            )
        assert first is not None
        assert first.disposition == TranslationAttemptWriteDisposition.RECORDED
        assert first.translation_version == 1
        assert first.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED
        assert (
            first.current_working_transcript.disposition
            == WorkingTranscriptPublishDisposition.REPLACED
        )
        assert first.current_working_transcript.working_transcript_version == 2
        counts = await _derived_counts(repository_backend.provider, tenant_id, draft.id)  # type: ignore[attr-defined]
        assert counts == (1, 2, 1)

        async with repository_backend.provider.transaction(tenant_id) as store:
            replay = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                command,
            )
        assert replay is not None
        assert replay.disposition == TranslationAttemptWriteDisposition.REPLAYED
        assert replay.created_at == first.created_at
        assert (
            replay.current_working_transcript.disposition
            == WorkingTranscriptPublishDisposition.REPLAYED
        )
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == counts  # type: ignore[attr-defined]

        with pytest.raises(TranslationAttemptPersistenceError) as conflict:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    replace(command, content="Synthetic conflicting English translation."),
                )
        assert conflict.value.code == TranslationAttemptPersistenceCode.IDENTITY_CONFLICT
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == counts  # type: ignore[attr-defined]

        other_draft, other_spanish, _ = await _seed_pending(
            repository_backend.provider,
            tenant_id,
        )
        cross_session = _command(
            1,
            other_spanish.source_segment_id,  # type: ignore[attr-defined]
            other_spanish.source_segment_version,  # type: ignore[attr-defined]
            translation_id=command.translation_id,
        )
        with pytest.raises(TranslationAttemptPersistenceError) as reused:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    other_draft.id,  # type: ignore[attr-defined]
                    cross_session,
                )
        assert reused.value.code == TranslationAttemptPersistenceCode.IDENTITY_CONFLICT
        assert await _derived_counts(repository_backend.provider, tenant_id, other_draft.id) == (  # type: ignore[attr-defined]
            0,
            1,
            1,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.revoke_consent(
                tenant_id,
                other_draft.consent_record_id,  # type: ignore[attr-defined]
            )
        with pytest.raises(TranslationAttemptPersistenceError) as revoked:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    other_draft.id,  # type: ignore[attr-defined]
                    cross_session,
                )
        assert revoked.value.code == TranslationAttemptPersistenceCode.CONSENT_INVALID

    repository_backend.run(scenario)


def test_failed_retry_and_invalid_targets_are_backend_equivalent(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, english = await _seed_pending(repository_backend.provider, tenant_id)
        failed = _command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            outcome=TranslationOutcome.FAILED,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            first = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                failed,  # type: ignore[attr-defined]
            )
        assert first is not None and first.translation_version == 1
        assert first.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING

        retry = _command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            previous_version=1,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            second = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                retry,  # type: ignore[attr-defined]
            )
        assert second is not None and second.translation_version == 2
        assert second.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED

        async with repository_backend.provider.transaction(tenant_id) as store:
            replayed_failure = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                failed,
            )
        assert replayed_failure is not None
        assert replayed_failure.disposition == TranslationAttemptWriteDisposition.REPLAYED
        assert replayed_failure.translation_version == 1
        assert replayed_failure.created_at == first.created_at
        assert replayed_failure.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED
        assert (
            replayed_failure.current_working_transcript.disposition
            == WorkingTranscriptPublishDisposition.REPLAYED
        )
        assert replayed_failure.current_working_transcript.working_transcript_version == 3

        invalid_commands = (
            _command(
                2,
                spanish.source_segment_id,  # type: ignore[attr-defined]
                spanish.source_segment_version,  # type: ignore[attr-defined]
            ),
            _command(
                1,
                english.source_segment_id,  # type: ignore[attr-defined]
                english.source_segment_version,  # type: ignore[attr-defined]
            ),
        )
        expected_codes = (
            TranslationAttemptPersistenceCode.STATE_CONFLICT,
            TranslationAttemptPersistenceCode.STATE_CONFLICT,
        )
        for command, code in zip(invalid_commands, expected_codes, strict=True):
            with pytest.raises(TranslationAttemptPersistenceError) as invalid:
                async with repository_backend.provider.transaction(tenant_id) as store:
                    await store.record_translation_attempt_and_publish(
                        tenant_id,
                        draft.id,
                        command,  # type: ignore[attr-defined]
                    )
            assert invalid.value.code == code
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == (2, 3, 2)  # type: ignore[attr-defined]

    repository_backend.run(scenario)


def test_missing_projection_and_expiry_write_nothing(
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
        consent = _consent()
        draft = _draft(consent)
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="translation-source-only",
                request=_request(),
            )
            source = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
        assert source is not None
        spanish = next(
            item for item in source.segments if item.source_locale == SourceLocale.SPANISH_US
        )
        command = _command(1, spanish.source_segment_id, spanish.source_segment_version)
        with pytest.raises(TranslationAttemptPersistenceError) as unprojected:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(tenant_id, draft.id, command)
        assert unprojected.value.code == TranslationAttemptPersistenceCode.STATE_CONFLICT
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == (0, 0, 0)

        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.publish_current_working_transcript(tenant_id, draft.id)
        non_spanish = _command(
            1,
            next(
                item.source_segment_id
                for item in source.segments
                if item.source_locale == SourceLocale.ENGLISH_US
            ),
            1,
        )
        with pytest.raises(TranslationAttemptPersistenceError) as invalid:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,
                    non_spanish,
                )
        assert invalid.value.code == TranslationAttemptPersistenceCode.EVIDENCE_INVALID
        failed = _command(
            1,
            spanish.source_segment_id,
            spanish.source_segment_version,
            outcome=TranslationOutcome.FAILED,
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            attempt = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                failed,
            )
        assert attempt is not None
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == (1, 2, 1)
        await _expire_normalized_source(
            repository_backend.provider,
            tenant_id,
            draft.id,
            admin_url=admin_url,
        )
        with pytest.raises(TranslationAttemptPersistenceError) as expired:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(tenant_id, draft.id, command)
        assert expired.value.code == TranslationAttemptPersistenceCode.RETENTION_EXPIRED
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == (1, 2, 1)

        async with repository_backend.provider.transaction(tenant_id) as store:
            purge = await store.purge_normalized_source_content(tenant_id, draft.id)
        assert purge is not None and purge.changed
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == (0, 0, 1)
        with pytest.raises(TranslationAttemptPersistenceError) as purged:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(tenant_id, draft.id, command)
        assert purged.value.code == TranslationAttemptPersistenceCode.RETENTION_EXPIRED

    repository_backend.run(scenario)


def test_unreviewed_success_cannot_be_superseded_while_other_segment_is_pending(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        consent = _consent()
        draft = _draft(consent)
        request = _request()
        second_spanish = request.segments[1].model_copy(
            update={
                "speaker_slot": 2,
                "content": "Segundo texto fuente sintetico.",
                "start_ms": 2_100,
                "end_ms": 3_000,
            }
        )
        request = request.model_copy(
            update={"duration_ms": 3_000, "segments": (*request.segments, second_spanish)}
        )
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="multi-spanish-source",
                request=request,
            )
            source = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
            assert await store.publish_current_working_transcript(tenant_id, draft.id)
        assert source is not None
        spanish = next(item for item in source.segments if item.start_ms == 1_000)
        first = _command(1, spanish.source_segment_id, spanish.source_segment_version)
        async with repository_backend.provider.transaction(tenant_id) as store:
            written = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                first,
            )
        assert written is not None
        assert written.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING
        with pytest.raises(TranslationAttemptPersistenceError) as conflict:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,
                    _command(1, spanish.source_segment_id, 1, previous_version=1),
                )
        assert conflict.value.code == TranslationAttemptPersistenceCode.STATE_CONFLICT
        assert await _derived_counts(repository_backend.provider, tenant_id, draft.id) == (1, 2, 1)

    repository_backend.run(scenario)


def test_memory_rejected_attempt_retries_and_accepted_attempt_is_terminal() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _ = await _seed_pending(provider, tenant_id)
        command = _command(1, spanish.source_segment_id, spanish.source_segment_version)  # type: ignore[attr-defined]
        async with provider.transaction(tenant_id) as store:
            first = await store.record_translation_attempt_and_publish(tenant_id, draft.id, command)  # type: ignore[attr-defined]
        assert first is not None
        review = TranslationReviewEvidenceV1(
            review_id=uuid4(),
            translation_id=command.translation_id,
            translation_version=1,
            source_segment_id=command.source_segment_id,
            source_segment_version=command.expected_source_segment_version,
            decision=TranslationReviewDecision.REJECTED,
            reviewer_actor_id=draft.creator_actor_id,  # type: ignore[attr-defined]
            reviewed_at=first.created_at,
        )
        provider.normalized_translation_reviews[(tenant_id, draft.id, 1, review.review_id)] = review  # type: ignore[attr-defined]
        async with provider.transaction(tenant_id) as store:
            rejected = await store.publish_current_working_transcript(tenant_id, draft.id)  # type: ignore[attr-defined]
            retry = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                _command(1, command.source_segment_id, 1, previous_version=1),
            )
        assert rejected is not None and retry is not None
        assert retry.translation_version == 2

        accepted = review.model_copy(
            update={
                "review_id": uuid4(),
                "decision": TranslationReviewDecision.ACCEPTED,
            }
        )
        provider.normalized_translation_reviews = {
            (tenant_id, draft.id, 1, accepted.review_id): accepted  # type: ignore[attr-defined]
        }
        provider.normalized_translation_attempts = {
            key: value
            for key, value in provider.normalized_translation_attempts.items()
            if value.translation_version == 1
        }
        provider.normalized_working_transcripts = {
            key: value
            for key, value in provider.normalized_working_transcripts.items()
            if key[2] <= 2
        }
        current = provider.versioned_external_sessions[(tenant_id, draft.id)]  # type: ignore[attr-defined]
        provider.versioned_external_sessions[(tenant_id, draft.id)] = replace(  # type: ignore[attr-defined]
            current,
            status=ConfiguredExternalSessionStatus.REVIEW_REQUIRED,
            current_working_transcript_version=2,
        )
        async with provider.transaction(tenant_id) as store:
            ready = await store.publish_current_working_transcript(tenant_id, draft.id)  # type: ignore[attr-defined]
        assert (
            ready is not None and ready.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
        )
        with pytest.raises(TranslationAttemptPersistenceError) as terminal:
            async with provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    _command(1, command.source_segment_id, 1, previous_version=1),
                )
        assert terminal.value.code == TranslationAttemptPersistenceCode.STATE_CONFLICT

    asyncio.run(scenario())


def test_memory_rejects_any_accepted_review_even_with_malformed_later_failure() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _ = await _seed_pending(provider, tenant_id)
        first_command = _command(1, spanish.source_segment_id, spanish.source_segment_version)  # type: ignore[attr-defined]
        async with provider.transaction(tenant_id) as store:
            first = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                first_command,  # type: ignore[attr-defined]
            )
        assert first is not None
        accepted = TranslationReviewEvidenceV1(
            review_id=uuid4(),
            translation_id=first.translation_id,
            translation_version=1,
            source_segment_id=first.source_segment_id,
            source_segment_version=first.source_segment_version,
            decision=TranslationReviewDecision.ACCEPTED,
            reviewer_actor_id=draft.creator_actor_id,  # type: ignore[attr-defined]
            reviewed_at=first.created_at,
        )
        later_failure = TranslationRecordV1(
            translation_id=uuid4(),
            translation_version=2,
            source_segment_id=first.source_segment_id,
            source_segment_version=first.source_segment_version,
            outcome=TranslationOutcome.FAILED,
            failure_code="adapter_unavailable",
            translation_adapter_id="synthetic_translation_adapter",
            translation_model_profile_id="synthetic_translation_profile_v1",
            created_at=first.created_at,
        )
        provider.normalized_translation_reviews[(tenant_id, draft.id, 1, accepted.review_id)] = (
            accepted  # type: ignore[attr-defined]
        )
        provider.normalized_translation_attempts[
            (tenant_id, draft.id, 1, later_failure.translation_id)
        ] = later_failure  # type: ignore[attr-defined]
        current = provider.versioned_external_sessions[(tenant_id, draft.id)]  # type: ignore[attr-defined]
        provider.versioned_external_sessions[(tenant_id, draft.id)] = replace(  # type: ignore[attr-defined]
            current,
            status=ConfiguredExternalSessionStatus.TRANSLATION_PENDING,
        )
        with pytest.raises(TranslationAttemptPersistenceError) as blocked:
            async with provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,  # type: ignore[attr-defined]
                    _command(1, first.source_segment_id, 1, previous_version=2),
                )
        assert blocked.value.code == TranslationAttemptPersistenceCode.STATE_CONFLICT

    asyncio.run(scenario())


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_rejected_success_retries_and_accepted_success_is_terminal(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    draft, spanish, _ = await _seed_pending(provider, tenant_id)
    first_command = _command(1, spanish.source_segment_id, spanish.source_segment_version)  # type: ignore[attr-defined]
    try:
        async with provider.transaction(tenant_id) as store:
            first = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                first_command,  # type: ignore[attr-defined]
            )
        assert first is not None
        async with provider.transaction(tenant_id) as store:
            assert isinstance(store, PostgresRepository)
            await store._session.execute(
                text(
                    """
                    INSERT INTO normalized_translation_reviews (
                        tenant_id, session_id, source_transcript_version,
                        source_segment_id, source_segment_version,
                        translation_id, translation_version, review_id,
                        decision, reviewer_actor_id, reviewed_at
                    ) VALUES (
                        :tenant, :session, 1, :segment, 1, :translation, 1,
                        :review, 'rejected', :reviewer, clock_timestamp()
                    )
                    """
                ),
                {
                    "tenant": tenant_id,
                    "session": draft.id,  # type: ignore[attr-defined]
                    "segment": first.source_segment_id,
                    "translation": first.translation_id,
                    "review": uuid4(),
                    "reviewer": draft.creator_actor_id,  # type: ignore[attr-defined]
                },
            )
            rejected = await store.publish_current_working_transcript(tenant_id, draft.id)  # type: ignore[attr-defined]
        assert rejected is not None
        assert rejected.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING

        retry_command = _command(
            1,
            first.source_segment_id,
            first.source_segment_version,
            previous_version=1,
        )
        async with provider.transaction(tenant_id) as store:
            retry = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                retry_command,  # type: ignore[attr-defined]
            )
        assert retry is not None and retry.translation_version == 2
        async with provider.transaction(tenant_id) as store:
            assert isinstance(store, PostgresRepository)
            await store._session.execute(
                text(
                    """
                    INSERT INTO normalized_translation_reviews (
                        tenant_id, session_id, source_transcript_version,
                        source_segment_id, source_segment_version,
                        translation_id, translation_version, review_id,
                        decision, reviewer_actor_id, reviewed_at
                    ) VALUES (
                        :tenant, :session, 1, :segment, 1, :translation, 2,
                        :review, 'accepted', :reviewer, clock_timestamp()
                    )
                    """
                ),
                {
                    "tenant": tenant_id,
                    "session": draft.id,  # type: ignore[attr-defined]
                    "segment": retry.source_segment_id,
                    "translation": retry.translation_id,
                    "review": uuid4(),
                    "reviewer": draft.creator_actor_id,  # type: ignore[attr-defined]
                },
            )
            ready = await store.publish_current_working_transcript(tenant_id, draft.id)  # type: ignore[attr-defined]
        assert ready is not None
        assert ready.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY

        with pytest.raises(TranslationAttemptPersistenceError) as terminal:
            async with provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,
                    _command(1, retry.source_segment_id, 1, previous_version=2),  # type: ignore[attr-defined]
                )
        assert terminal.value.code == TranslationAttemptPersistenceCode.STATE_CONFLICT
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_same_session_concurrency_records_once_and_replays(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(admin_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    draft, spanish, _ = await _seed_pending(provider, tenant_id)
    command = _command(1, spanish.source_segment_id, spanish.source_segment_version)  # type: ignore[attr-defined]
    first_holds = asyncio.Event()
    release = asyncio.Event()

    async def write(*, hold: bool = False) -> object:
        async with provider.transaction(tenant_id) as store:
            result = await store.record_translation_attempt_and_publish(
                tenant_id,
                draft.id,
                command,  # type: ignore[attr-defined]
            )
            if hold:
                first_holds.set()
                await release.wait()
            return result

    try:
        first = asyncio.create_task(write(hold=True))
        await first_holds.wait()
        second = asyncio.create_task(write())
        await asyncio.sleep(0.05)
        assert not second.done()
        release.set()
        results = await asyncio.gather(first, second)
        assert {result.disposition for result in results if result is not None} == {
            TranslationAttemptWriteDisposition.RECORDED,
            TranslationAttemptWriteDisposition.REPLAYED,
        }
        assert await _derived_counts(provider, tenant_id, draft.id) == (1, 2, 1)  # type: ignore[attr-defined]
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_cross_session_translation_id_race_is_identity_conflict(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(admin_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    first_draft, first_spanish, _ = await _seed_pending(provider, tenant_id)
    second_draft, second_spanish, _ = await _seed_pending(provider, tenant_id)
    translation_id = uuid4()
    first_command = _command(
        1,
        first_spanish.source_segment_id,
        first_spanish.source_segment_version,
        translation_id=translation_id,  # type: ignore[attr-defined]
    )
    second_command = _command(
        1,
        second_spanish.source_segment_id,
        second_spanish.source_segment_version,
        translation_id=translation_id,  # type: ignore[attr-defined]
    )
    first_holds = asyncio.Event()
    release = asyncio.Event()

    async def first_write() -> object:
        async with provider.transaction(tenant_id) as store:
            result = await store.record_translation_attempt_and_publish(
                tenant_id,
                first_draft.id,
                first_command,  # type: ignore[attr-defined]
            )
            first_holds.set()
            await release.wait()
            return result

    async def second_write() -> object:
        with pytest.raises(TranslationAttemptPersistenceError) as conflict:
            async with provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    second_draft.id,
                    second_command,  # type: ignore[attr-defined]
                )
        return conflict.value.code

    try:
        winner = asyncio.create_task(first_write())
        await first_holds.wait()
        loser = asyncio.create_task(second_write())
        await asyncio.sleep(0.05)
        assert not loser.done()
        release.set()
        assert await loser == TranslationAttemptPersistenceCode.IDENTITY_CONFLICT
        assert await winner is not None
        assert await _derived_counts(provider, tenant_id, first_draft.id) == (1, 2, 1)  # type: ignore[attr-defined]
        assert await _derived_counts(provider, tenant_id, second_draft.id) == (0, 1, 1)  # type: ignore[attr-defined]
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_projector_failure_rolls_back_attempt_and_audit(
    postgres_urls: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    draft, spanish, _ = await _seed_pending(provider, tenant_id)
    command = _command(1, spanish.source_segment_id, spanish.source_segment_version)  # type: ignore[attr-defined]

    async def fail_projector(self: PostgresRepository, *_: object) -> object:
        raise WorkingTranscriptPersistenceError(WorkingTranscriptPersistenceCode.STATE_CONFLICT)

    monkeypatch.setattr(PostgresRepository, "publish_current_working_transcript", fail_projector)
    try:
        with pytest.raises(TranslationAttemptPersistenceError) as failed:
            async with provider.transaction(tenant_id) as store:
                await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,
                    command,  # type: ignore[attr-defined]
                )
        assert failed.value.code == TranslationAttemptPersistenceCode.STATE_CONFLICT
        assert await _derived_counts(provider, tenant_id, draft.id) == (0, 1, 0)  # type: ignore[attr-defined]
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_commit_fence_rolls_back_attempt_and_projection(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    draft, spanish, _ = await _seed_pending(provider, tenant_id)
    command = _command(1, spanish.source_segment_id, spanish.source_segment_version)  # type: ignore[attr-defined]
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
                result = await store.record_translation_attempt_and_publish(
                    tenant_id,
                    draft.id,
                    command,  # type: ignore[attr-defined]
                )
                assert result is not None and isinstance(store, PostgresRepository)
                await store._session.execute(text("SELECT pg_sleep(2.1)"))
        assert "Synthetic" not in str(commit_failure.value)
        assert await _derived_counts(provider, tenant_id, draft.id) == (0, 1, 0)  # type: ignore[attr-defined]
    finally:
        await engine.dispose()
        await provider.close()
