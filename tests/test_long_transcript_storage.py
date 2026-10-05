"""Accelerated synthetic long visits through the existing persistence fences."""

import asyncio
from pathlib import Path
from uuid import uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.external_transcript_v1 import (
    ExternalTranscriptBundleV1,
    NormalizedSourceTranscriptRequestV1,
    NormalizedSourceTranscriptSegmentV1,
    SourceLocale,
    TranscriptLanguageMode,
)
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.schemas import SpeakerRole
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from test_derived_translation_evidence_migration import (
    TRANSLATION_INSERT,
    _seed_source,
    _translation_parameters,
)
from test_external_transcript_v1 import _segment, _source, _translation
from test_normalized_source_persistence import _consent, _draft, _seed_configured_session
from test_working_transcript_migration import _publish, _set_status
from test_working_transcript_persistence import _working_counts

from alembic import command


def _long_request(count: int = 1800, characters: int = 250):
    return NormalizedSourceTranscriptRequestV1(
        schema_version="1.0",
        duration_ms=10_800_000,
        segments=tuple(
            NormalizedSourceTranscriptSegmentV1(
                speaker_slot=index % 2,
                speaker_role=SpeakerRole.CLINICIAN if index % 2 else SpeakerRole.PATIENT,
                source_locale=SourceLocale.ENGLISH_US,
                content=f"Fictional turn {index:04d}. ".ljust(characters, "x"),
                start_ms=index * 6000,
                end_ms=(index + 1) * 6000,
                locale_confidence=0.99,
            )
            for index in range(count)
        ),
    )


def test_normalized_source_bounds_separate_total_from_individual_segments() -> None:
    request = _long_request(5, 100_000)
    assert sum(len(segment.content) for segment in request.segments) == 500_000
    assert (
        NormalizedSourceTranscriptRequestV1.model_validate_json(request.model_dump_json())
        == request
    )
    with pytest.raises(ValidationError, match="normalized_source_content_too_large"):
        _long_request(6, 100_000)
    with pytest.raises(ValidationError, match="string_too_long"):
        _long_request(1, 100_001)
    segments = tuple(
        _segment(
            uuid4(),
            locale=SourceLocale.ENGLISH_US,
            content=segment.content,
            start_ms=segment.start_ms,
            end_ms=segment.end_ms,
        )
        for segment in request.segments
    )
    assert len(_source(*segments).segments) == 5
    excess = _segment(
        uuid4(), locale=SourceLocale.ENGLISH_US, content="x", start_ms=30_000, end_ms=30_001
    )
    with pytest.raises(ValidationError, match="source_transcript_content_too_large"):
        _source(*segments, excess)


def test_translation_history_has_its_own_bounded_aggregate() -> None:
    spanish = _segment(
        uuid4(), locale=SourceLocale.SPANISH_US, content="Ficción.", start_ms=0, end_ms=1000
    )
    translations = tuple(
        _translation(
            source_segment_id=spanish.source_segment_id,
            translation_id=uuid4(),
            translation_version=version,
            content="x" * 100_000,
        )
        for version in range(1, 6)
    )
    values = dict(
        source_transcript=_source(spanish),
        working_transcript_id=uuid4(),
        working_transcript_version=1,
    )
    assert len(ExternalTranscriptBundleV1(**values, translations=translations).translations) == 5
    extra = _translation(
        source_segment_id=spanish.source_segment_id,
        translation_id=uuid4(),
        translation_version=6,
        content="x",
    )
    with pytest.raises(ValidationError, match="translation_content_too_large"):
        ExternalTranscriptBundleV1(**values, translations=(*translations, extra))


def test_three_hour_source_publish_reopen_and_correction(
    repository_backend: RepositoryBackend,
) -> None:
    tenant, consent = uuid4(), _consent()
    draft = _draft(consent, language_mode=TranscriptLanguageMode.ENGLISH)
    request = _long_request()
    expected = tuple(segment.content for segment in request.segments)
    assert sum(map(len, expected)) == 450_000
    provider = repository_backend.provider

    async def scenario() -> None:
        await _seed_configured_session(provider, tenant, consent, draft)
        async with provider.transaction(tenant) as store:
            first = await store.accept_normalized_source_transcript(
                tenant, draft.id, idempotency_key="long-visit-source-0001", request=request
            )
            published = await store.publish_current_working_transcript(tenant, draft.id)
        assert first is not None and published is not None
        async with provider.transaction(tenant) as store:
            reopened = await store.get_creator_working_transcript(
                tenant, draft.id, creator_actor_id=draft.creator_actor_id
            )
        assert reopened is not None and reopened.working_transcript.note_ready
        assert tuple(item.content for item in reopened.working_transcript.segments) == expected
        assert reopened.bundle.source_transcript.duration_ms == 10_800_000
        correction = request.model_dump(mode="python")
        correction["segments"][-1]["content"] = "Fictional corrected final turn."
        corrected_request = NormalizedSourceTranscriptRequestV1.model_validate(correction)
        async with provider.transaction(tenant) as store:
            corrected = await store.accept_normalized_source_transcript(
                tenant,
                draft.id,
                idempotency_key="long-visit-source-0002",
                request=corrected_request,
            )
            revised = await store.publish_current_working_transcript(tenant, draft.id)
        assert corrected is not None and revised is not None
        assert (
            corrected.receipt.transcript_content_expires_at
            == first.receipt.transcript_content_expires_at
        )
        assert revised.working_transcript_id == published.working_transcript_id
        assert revised.working_transcript_version == published.working_transcript_version + 1
        async with provider.transaction(tenant) as store:
            replay = await store.accept_normalized_source_transcript(
                tenant, draft.id, idempotency_key="long-visit-source-0001", request=request
            )
            current = await store.get_creator_working_transcript(
                tenant, draft.id, creator_actor_id=draft.creator_actor_id
            )
        assert replay is not None and replay.receipt_body == first.receipt_body
        assert current is not None
        assert current.working_fingerprint != reopened.working_fingerprint
        assert tuple(item.content for item in current.working_transcript.segments) == (
            *expected[:-1],
            "Fictional corrected final turn.",
        )
        assert await _working_counts(provider, tenant, draft.id) == (2, 3600, 0)
        other_tenant = uuid4()
        async with provider.transaction(other_tenant) as store:
            assert (
                await store.get_creator_working_transcript(
                    other_tenant, draft.id, creator_actor_id=draft.creator_actor_id
                )
                is None
            )

    repository_backend.run(scenario)


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_reopens_large_translation_history(postgres_urls) -> None:
    engine = create_async_engine(postgres_urls[0], connect_args={"ssl": False})
    provider = build_postgres_provider(postgres_settings(postgres_urls[0]))
    tenant = uuid4()
    try:
        async with engine.begin() as connection:
            session, segment = await _seed_source(connection, tenant)
        async with engine.begin() as connection:
            await _set_status(connection, tenant, session, "translation_pending")
            for version in range(1, 6):
                await connection.execute(
                    text(TRANSLATION_INSERT),
                    _translation_parameters(
                        tenant, session, segment, version=version, content="x" * 100_000
                    ),
                )
        async with provider.transaction(tenant) as store:
            assert await store.publish_current_working_transcript(tenant, session) is not None
        async with provider.transaction(tenant) as store:
            reopened = await store.get_processing_working_transcript(tenant, session)
        assert reopened is not None
        assert sum(len(item.content or "") for item in reopened.bundle.translations) == 500_000
        assert not reopened.working_transcript.note_ready  # Translation review is still required.
    finally:
        await provider.close()
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_expanded_database_checks_remain_validated(postgres_urls) -> None:
    engine = create_async_engine(postgres_urls[0], connect_args={"ssl": False})
    try:
        async with engine.connect() as connection:
            rows = (
                await connection.execute(
                    text("""
                SELECT conname, convalidated, pg_get_constraintdef(oid)
                FROM pg_constraint WHERE conname IN (
                    'normalized_source_transcripts_total_content_chars_check',
                    'ck_working_transcript_content_size')
            """)
                )
            ).all()
        expected = {
            "normalized_source_transcripts_total_content_chars_check": "500000",
            "ck_working_transcript_content_size": "1000000",
        }
        assert len(rows) == 2
        for name, validated, definition in rows:
            assert validated and expected[name] in definition
    finally:
        await engine.dispose()


def test_expand_recovery_retains_long_transcripts() -> None:
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    revision = ScriptDirectory.from_config(config).get_revision("611c583b362a")
    assert revision is not None
    with pytest.raises(RuntimeError, match="retains larger transcript capacity"):
        revision.module.downgrade()


@pytest.mark.postgres
def test_upgrade_preserves_existing_source_and_working_rows(historical_postgres_url) -> None:
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", historical_postgres_url.replace("%", "%%"))
    command.upgrade(config, "227fcc9bf18d")
    tenant = uuid4()

    async def snapshot(*, seed=False):
        engine = create_async_engine(historical_postgres_url, connect_args={"ssl": False})
        try:
            if seed:
                async with engine.begin() as connection:
                    session, _ = await _seed_source(connection, tenant, locale="en-US")
                async with engine.begin() as connection:
                    # Seed the historical projection without invoking newer-schema writers.
                    await _publish(connection, tenant, session, uuid4(), 1, "transcript_ready")
            result = {}
            async with engine.connect() as connection:
                assert (
                    await connection.scalar(
                        text("SELECT to_regclass('public.creator_transcript_edits')")
                    )
                    is None
                )
                for table in (
                    "scribe_sessions",
                    "normalized_source_transcripts",
                    "normalized_source_segments",
                    "normalized_working_transcripts",
                    "normalized_working_segments",
                ):
                    # Fixed test-owned table names, never request input.
                    rows = (
                        (
                            await connection.execute(
                                text(
                                    f"SELECT to_jsonb(t) FROM {table} t WHERE tenant_id = :tenant"
                                ),
                                {"tenant": tenant},
                            )
                        )
                        .scalars()
                        .all()
                    )
                    assert rows
                    result[table] = rows
            return result
        finally:
            await engine.dispose()

    before = asyncio.run(snapshot(seed=True))
    command.upgrade(config, "611c583b362a")
    assert asyncio.run(snapshot()) == before
    with pytest.raises(RuntimeError, match="retains larger transcript capacity"):
        command.downgrade(config, "227fcc9bf18d")
    assert asyncio.run(snapshot()) == before
