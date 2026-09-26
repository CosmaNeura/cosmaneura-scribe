from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.external_transcript_v1 import (
    TranslationOutcome,
    TranslationRecordV1,
    TranslationReviewDecision,
    TranslationReviewEvidenceV1,
)
from cosmaneura_scribe.normalized_source_persistence import (
    ConfiguredExternalSessionStatus,
    NormalizedSourceAcceptanceDisposition,
)
from cosmaneura_scribe.postgres_repository import (
    PostgresRepository,
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.working_transcript_persistence import (
    WorkingTranscriptPersistenceCode,
    WorkingTranscriptPersistenceError,
    WorkingTranscriptPublishDisposition,
    derive_persisted_working_transcript,
)
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine
from test_derived_translation_evidence_migration import (
    TRANSLATION_INSERT,
    _seed_source,
    _translation_parameters,
)
from test_normalized_source_persistence import (
    _audit_actions,
    _consent,
    _draft,
    _expire_normalized_source,
    _request,
    _seed_configured_session,
)
from test_working_transcript_migration import (
    _add_review,
    _add_translation,
    _set_status,
)


async def _working_counts(
    provider: object,
    tenant_id: UUID,
    session_id: UUID,
) -> tuple[int, int, int]:
    if isinstance(provider, InMemoryRepository):
        records = [
            value
            for key, value in provider.normalized_working_transcripts.items()
            if key[:2] == (tenant_id, session_id)
        ]
        return (
            len(records),
            sum(len(record.working_transcript.segments) for record in records),
            sum(len(record.working_transcript.blockers) for record in records),
        )
    assert isinstance(provider, PostgresRepositoryProvider)
    async with provider.engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
            {"tenant_id": str(tenant_id)},
        )
        row = (
            await connection.execute(
                text(
                    """
                    SELECT
                      (SELECT count(*) FROM normalized_working_transcripts
                       WHERE tenant_id = :tenant AND session_id = :session),
                      (SELECT count(*) FROM normalized_working_segments
                       WHERE tenant_id = :tenant AND session_id = :session),
                      (SELECT count(*) FROM normalized_working_blockers
                       WHERE tenant_id = :tenant AND session_id = :session)
                    """
                ),
                {"tenant": tenant_id, "session": session_id},
            )
        ).one()
        return row[0], row[1], row[2]


async def _postgres_projection_state(
    store: PostgresRepository,
    tenant_id: UUID,
    session_id: UUID,
) -> tuple[int, UUID | None, int | None, str]:
    row = (
        await store._session.execute(
            text(
                """
                SELECT current_source_transcript_version, working_transcript_id,
                       current_working_transcript_version, status
                FROM scribe_sessions
                WHERE tenant_id = :tenant AND id = :session
                """
            ),
            {"tenant": tenant_id, "session": session_id},
        )
    ).one()
    return row[0], row[1], row[2], row[3]


async def _sleep_past_expiry(
    store: PostgresRepository,
    tenant_id: UUID,
    session_id: UUID,
) -> None:
    await store._session.execute(
        text(
            """
            SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM
                transcript_content_expires_at - clock_timestamp()) + 0.05, 0))
            FROM scribe_sessions WHERE tenant_id = :tenant AND id = :session
            """
        ),
        {"tenant": tenant_id, "session": session_id},
    )


def test_publish_replay_rollback_expiry_and_purge_are_backend_equivalent(
    repository_backend: RepositoryBackend,
    request: pytest.FixtureRequest,
) -> None:
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    admin_url = (
        request.getfixturevalue("postgres_urls")[0]
        if repository_backend.name == "postgres"
        else None
    )

    async def scenario() -> None:
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.accept_normalized_source_transcript(
                tenant_id, draft.id, idempotency_key="working-source-0001", request=_request()
            ) is not None
        with pytest.raises(RuntimeError, match="synthetic rollback"):
            async with repository_backend.provider.transaction(tenant_id) as store:
                assert await store.publish_current_working_transcript(tenant_id, draft.id)
                raise RuntimeError("synthetic rollback")
        assert await _working_counts(repository_backend.provider, tenant_id, draft.id) == (0, 0, 0)

        async with repository_backend.provider.transaction(tenant_id) as store:
            first = await store.publish_current_working_transcript(tenant_id, draft.id)
        assert first is not None
        assert first.disposition == WorkingTranscriptPublishDisposition.PUBLISHED
        assert first.status == ConfiguredExternalSessionStatus.TRANSLATION_PENDING
        assert first.working_transcript_version == 1
        assert "synthetic" not in repr(first).lower()
        async with repository_backend.provider.transaction(tenant_id) as store:
            replay = await store.publish_current_working_transcript(tenant_id, draft.id)
        assert replay is not None
        assert replay.disposition == WorkingTranscriptPublishDisposition.REPLAYED
        assert replay.working_transcript_id == first.working_transcript_id
        assert replay.created_at == first.created_at
        assert await _working_counts(repository_backend.provider, tenant_id, draft.id) == (1, 2, 1)
        assert (await _audit_actions(repository_backend.provider, tenant_id)).count(
            "normalized_working_transcript.published"
        ) == 1

        await _expire_normalized_source(
            repository_backend.provider,
            tenant_id,
            draft.id,
            admin_url=admin_url,
        )
        with pytest.raises(WorkingTranscriptPersistenceError) as expired:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.publish_current_working_transcript(tenant_id, draft.id)
        assert expired.value.code == WorkingTranscriptPersistenceCode.RETENTION_EXPIRED
        async with repository_backend.provider.transaction(tenant_id) as store:
            purged = await store.purge_normalized_source_content(tenant_id, draft.id)
        assert purged is not None and purged.changed
        assert await _working_counts(repository_backend.provider, tenant_id, draft.id) == (0, 0, 0)

    repository_backend.run(scenario)


def test_memory_projects_all_evidence_and_preserves_identity_across_correction() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)

    async def scenario() -> None:
        await _seed_configured_session(provider, tenant_id, consent, draft)
        async with provider.transaction(tenant_id) as store:
            assert await store.accept_normalized_source_transcript(
                tenant_id, draft.id, idempotency_key="memory-source-0001", request=_request()
            ) is not None
            pending = await store.publish_current_working_transcript(tenant_id, draft.id)
        assert pending is not None
        source = provider.normalized_source_transcripts[(tenant_id, draft.id, 1)]
        spanish = next(segment for segment in source.segments if segment.source_locale == "es-US")
        translated_at = datetime.now(UTC)
        translation = TranslationRecordV1(
            translation_id=uuid4(),
            translation_version=1,
            source_segment_id=spanish.source_segment_id,
            source_segment_version=spanish.source_segment_version,
            content="Synthetic translated content.",
            outcome=TranslationOutcome.SUCCEEDED,
            translation_adapter_id="synthetic_adapter",
            translation_model_profile_id="synthetic_model",
            created_at=translated_at,
        )
        provider.normalized_translation_attempts[
            (tenant_id, draft.id, 1, translation.translation_id)
        ] = translation
        async with provider.transaction(tenant_id) as store:
            review_required = await store.publish_current_working_transcript(tenant_id, draft.id)
        assert review_required is not None
        assert review_required.status == ConfiguredExternalSessionStatus.REVIEW_REQUIRED
        review = TranslationReviewEvidenceV1(
            review_id=uuid4(),
            translation_id=translation.translation_id,
            translation_version=1,
            source_segment_id=spanish.source_segment_id,
            source_segment_version=spanish.source_segment_version,
            decision=TranslationReviewDecision.ACCEPTED,
            reviewer_actor_id=draft.creator_actor_id,
            reviewed_at=translated_at,
        )
        provider.normalized_translation_reviews[(tenant_id, draft.id, 1, review.review_id)] = review
        async with provider.transaction(tenant_id) as store:
            ready = await store.publish_current_working_transcript(tenant_id, draft.id)
        assert ready is not None
        assert ready.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
        record = provider.normalized_working_transcripts[(tenant_id, draft.id, 3)]
        expected = derive_persisted_working_transcript(
            source,
            (translation,),
            (review,),
            working_transcript_id=ready.working_transcript_id,
            working_transcript_version=3,
        )
        assert record.working_fingerprint == expected.working_fingerprint
        assert record.translation_inputs == (translation,) and record.review_inputs == (review,)

        async with provider.transaction(tenant_id) as store:
            correction = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="memory-source-0002",
                request=_request(spanish_content="Synthetic corrected source."),
            )
            corrected_projection = await store.publish_current_working_transcript(
                tenant_id, draft.id
            )
        assert correction is not None and corrected_projection is not None
        assert corrected_projection.working_transcript_id == ready.working_transcript_id
        assert corrected_projection.working_transcript_version == 4

    asyncio.run(scenario())


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_projects_preexisting_complete_evidence_exactly(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "translation_pending")
        translation_id, created_at = await _add_translation(
            connection, tenant_id, session_id, segment_id
        )
        await _add_translation(
            connection, tenant_id, session_id, segment_id, version=2, outcome="failed"
        )
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "review_required")
        await _add_review(
            connection,
            tenant_id,
            session_id,
            segment_id,
            translation_id,
            created_at,
            "accepted",
        )
    try:
        async with provider.transaction(tenant_id) as store:
            published = await store.publish_current_working_transcript(tenant_id, session_id)
            assert isinstance(store, PostgresRepository)
            source = await store._get_normalized_source_by_version(tenant_id, session_id, 1)
            translations = await store._get_working_translation_inputs(tenant_id, session_id, 1)
            reviews = await store._get_working_review_inputs(tenant_id, session_id, 1)
        assert published is not None
        assert source is not None
        expected = derive_persisted_working_transcript(
            source,
            translations,
            reviews,
            working_transcript_id=published.working_transcript_id,
            working_transcript_version=1,
        )
        assert published.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
        async with engine.begin() as connection:
            row = (
                await connection.execute(
                    text(
                        """
                        SELECT translation_input_count, review_input_count,
                               segment_count, blocker_count, total_content_chars,
                               working_fingerprint
                        FROM normalized_working_transcripts
                        WHERE tenant_id = :tenant AND session_id = :session
                        """
                    ),
                    {"tenant": tenant_id, "session": session_id},
                )
            ).one()
        assert row[:5] == (2, 1, 1, 0, len("Synthetic English translation."))
        assert row.working_fingerprint == expected.working_fingerprint
    finally:
        await provider.close()
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_concurrent_publish_converges_to_one_version(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, _ = await _seed_source(connection, tenant_id)
    provider = build_postgres_provider(
        postgres_settings(admin_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )

    winner_holds_lock = asyncio.Event()
    release_winner = asyncio.Event()

    async def publish(*, hold_lock: bool = False) -> object:
        async with provider.transaction(tenant_id) as store:
            result = await store.publish_current_working_transcript(tenant_id, session_id)
            if hold_lock:
                winner_holds_lock.set()
                await release_winner.wait()
            return result

    try:
        winner = asyncio.create_task(publish(hold_lock=True))
        await winner_holds_lock.wait()
        waiter = asyncio.create_task(publish())
        await asyncio.sleep(0.05)
        assert not waiter.done()
        release_winner.set()
        results = await asyncio.gather(winner, waiter)
        assert {result.disposition for result in results if result is not None} == {
            WorkingTranscriptPublishDisposition.PUBLISHED,
            WorkingTranscriptPublishDisposition.REPLAYED,
        }
        assert len({result.working_transcript_id for result in results if result is not None}) == 1
        assert await _working_counts(provider, tenant_id, session_id) == (1, 1, 1)
        async with engine.begin() as connection:
            audit_count = await connection.scalar(
                text(
                    "SELECT count(*) FROM audit_events WHERE tenant_id = :tenant "
                    "AND action = 'normalized_working_transcript.published'"
                ),
                {"tenant": tenant_id},
            )
        assert audit_count == 1
    finally:
        await provider.close()
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_correction_clears_pointer_and_preserves_identity_and_history(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, _ = await _seed_source(connection, tenant_id, locale="en-US")

    correction_request = _request(spanish_content="Synthetic corrected source.")
    try:
        async with provider.transaction(tenant_id) as store:
            published = await store.publish_current_working_transcript(tenant_id, session_id)
        assert published is not None
        assert published.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
        assert published.working_transcript_version == 1

        with pytest.raises(RuntimeError, match="synthetic correction rollback"):
            async with provider.transaction(tenant_id) as store:
                corrected = await store.accept_normalized_source_transcript(
                    tenant_id,
                    session_id,
                    idempotency_key="correction-source-0001",
                    request=correction_request,
                )
                assert corrected is not None
                assert corrected.disposition == NormalizedSourceAcceptanceDisposition.CORRECTED
                assert corrected.receipt.source_transcript_version == 2
                assert isinstance(store, PostgresRepository)
                assert await _postgres_projection_state(store, tenant_id, session_id) == (
                    2,
                    published.working_transcript_id,
                    None,
                    "source_received",
                )
                raise RuntimeError("synthetic correction rollback")

        async with provider.transaction(tenant_id) as store:
            assert isinstance(store, PostgresRepository)
            rolled_back = await _postgres_projection_state(store, tenant_id, session_id)
        assert rolled_back == (
            1,
            published.working_transcript_id,
            1,
            "transcript_ready",
        )
        assert await _working_counts(provider, tenant_id, session_id) == (1, 1, 0)

        async with provider.transaction(tenant_id) as store:
            corrected = await store.accept_normalized_source_transcript(
                tenant_id,
                session_id,
                idempotency_key="correction-source-0001",
                request=correction_request,
            )
        assert corrected is not None
        assert corrected.disposition == NormalizedSourceAcceptanceDisposition.CORRECTED
        assert corrected.receipt.source_transcript_version == 2

        async with provider.transaction(tenant_id) as store:
            assert isinstance(store, PostgresRepository)
            corrected_state = await _postgres_projection_state(store, tenant_id, session_id)
        assert corrected_state == (
            2,
            published.working_transcript_id,
            None,
            "source_received",
        )
        assert await _working_counts(provider, tenant_id, session_id) == (1, 1, 0)

        async with provider.transaction(tenant_id) as store:
            replacement = await store.publish_current_working_transcript(tenant_id, session_id)
        assert replacement is not None
        assert replacement.disposition == WorkingTranscriptPublishDisposition.REPLACED
        assert replacement.working_transcript_id == published.working_transcript_id
        assert replacement.working_transcript_version == 2
        assert replacement.source_transcript_version == 2
        assert await _working_counts(provider, tenant_id, session_id) == (2, 3, 1)

        async with engine.begin() as connection:
            versions = (
                await connection.execute(
                    text(
                        """
                        SELECT working_transcript_id, working_transcript_version,
                               source_transcript_version
                        FROM normalized_working_transcripts
                        WHERE tenant_id = :tenant AND session_id = :session
                        ORDER BY working_transcript_version
                        """
                    ),
                    {"tenant": tenant_id, "session": session_id},
                )
            ).all()
        assert versions == [
            (published.working_transcript_id, 1, 1),
            (published.working_transcript_id, 2, 2),
        ]
    finally:
        await provider.close()
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_correction_serializes_before_reprojection(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    provider = build_postgres_provider(
        postgres_settings(admin_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, _ = await _seed_source(connection, tenant_id, locale="en-US")
    async with provider.transaction(tenant_id) as store:
        first = await store.publish_current_working_transcript(tenant_id, session_id)
    assert first is not None

    correction_holds_lock = asyncio.Event()
    release_correction = asyncio.Event()

    async def correct() -> object:
        async with provider.transaction(tenant_id) as store:
            result = await store.accept_normalized_source_transcript(
                tenant_id,
                session_id,
                idempotency_key="correction-race-0001",
                request=_request(spanish_content="Synthetic serialized correction."),
            )
            correction_holds_lock.set()
            await release_correction.wait()
            return result

    async def project() -> object:
        async with provider.transaction(tenant_id) as store:
            return await store.publish_current_working_transcript(tenant_id, session_id)

    try:
        correction_task = asyncio.create_task(correct())
        await correction_holds_lock.wait()
        projector_task = asyncio.create_task(project())
        await asyncio.sleep(0.05)
        assert not projector_task.done()
        release_correction.set()
        correction, projection = await asyncio.gather(correction_task, projector_task)
        assert correction is not None
        assert projection is not None
        assert projection.disposition == WorkingTranscriptPublishDisposition.REPLACED
        assert projection.working_transcript_id == first.working_transcript_id
        assert projection.working_transcript_version == 2
        assert projection.source_transcript_version == 2
        assert await _working_counts(provider, tenant_id, session_id) == (2, 3, 1)
    finally:
        release_correction.set()
        await provider.close()
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_rejects_aggregate_evidence_before_projection(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, segment_id = await _seed_source(connection, tenant_id)
    async with engine.begin() as connection:
        await _set_status(connection, tenant_id, session_id, "translation_pending")
        for version in range(1, 7):
            await connection.execute(
                text(TRANSLATION_INSERT),
                _translation_parameters(
                    tenant_id,
                    session_id,
                    segment_id,
                    version=version,
                    content="x" * 100_000,
                ),
            )
    provider = build_postgres_provider(postgres_settings(admin_url))
    try:
        with pytest.raises(WorkingTranscriptPersistenceError) as invalid:
            async with provider.transaction(tenant_id) as store:
                await store.publish_current_working_transcript(tenant_id, session_id)
        assert invalid.value.code == WorkingTranscriptPersistenceCode.EVIDENCE_INVALID
        assert await _working_counts(provider, tenant_id, session_id) == (0, 0, 0)
    finally:
        await provider.close()
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_midflight_expiry_is_bounded_and_rolls_back(
    postgres_urls: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, _ = await _seed_source(
            connection, tenant_id, lifetime=timedelta(seconds=3)
        )
    reached_child_write = False
    original = PostgresRepository._insert_working_children

    async def delayed_children(
        self: PostgresRepository, *args: object, **kwargs: object
    ) -> None:
        nonlocal reached_child_write
        reached_child_write = True
        await _sleep_past_expiry(self, args[0], args[1])  # type: ignore[arg-type]
        return await original(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(PostgresRepository, "_insert_working_children", delayed_children)
    provider = build_postgres_provider(postgres_settings(admin_url))
    try:
        with pytest.raises(WorkingTranscriptPersistenceError) as expired:
            async with provider.transaction(tenant_id) as store:
                await store.publish_current_working_transcript(tenant_id, session_id)
        assert reached_child_write
        assert expired.value.code == WorkingTranscriptPersistenceCode.RETENTION_EXPIRED
        assert expired.value.__cause__ is None and expired.value.__suppress_context__
        assert await _working_counts(provider, tenant_id, session_id) == (0, 0, 0)
    finally:
        await provider.close()
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_commit_fence_rechecks_expiry_after_publish_returns(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    provider = build_postgres_provider(postgres_settings(admin_url))
    tenant_id = uuid4()
    async with engine.begin() as connection:
        session_id, _ = await _seed_source(
            connection, tenant_id, lifetime=timedelta(seconds=3)
        )
    published_before_expiry = False
    try:
        with pytest.raises(DBAPIError) as commit_failure:
            async with provider.transaction(tenant_id) as store:
                result = await store.publish_current_working_transcript(
                    tenant_id, session_id
                )
                assert isinstance(store, PostgresRepository) and result is not None
                published_before_expiry = True
                await _sleep_past_expiry(store, tenant_id, session_id)
        assert published_before_expiry
        assert "Synthetic" not in str(commit_failure.value)
        assert await _working_counts(provider, tenant_id, session_id) == (0, 0, 0)
        async with engine.begin() as connection:
            row = (
                await connection.execute(
                    text(
                        "SELECT status, working_transcript_id, "
                        "current_working_transcript_version FROM scribe_sessions "
                        "WHERE tenant_id = :tenant AND id = :session"
                    ),
                    {"tenant": tenant_id, "session": session_id},
                )
            ).one()
        assert row == ("source_received", None, None)
    finally:
        await provider.close()
        await engine.dispose()
