"""Offline service responses through real disposable storage and existing contracts.

This is deliberately not a runtime: no admission/dispatch/reader is registered,
and no identity, network, microphone, model or Core service is contacted.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from azure.ai.transcription.models import TranscribedPhrase, TranscriptionResult
from conftest import postgres_settings
from cosmaneura_scribe.azure_speech_source import normalize_azure_source
from cosmaneura_scribe.derived_writer_transactions import (
    commit_creator_translation_review_and_publish,
)
from cosmaneura_scribe.external_transcript_v1 import (
    EnglishWorkingTranscriptV1,
    SourceLocale,
    TranscriptLanguageMode,
    WorkingTranscriptBlockerCode,
)
from cosmaneura_scribe.handoff import to_master_platform_payload_from_working_transcript
from cosmaneura_scribe.normalized_source_persistence import ConfiguredExternalSessionStatus
from cosmaneura_scribe.postgres_repository import (
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.postgres_translation_jobs import PostgresTranslationJobStore
from cosmaneura_scribe.schemas import CaptureChannel, SpeakerRole
from cosmaneura_scribe.transcription import (
    AudioTrack,
    AzureSpeechTranscriber,
    TranscriptionRequest,
)
from cosmaneura_scribe.translation_adapter import ReservedSpanishTranslation
from cosmaneura_scribe.translation_execution_v1 import (
    DurableTranslationJobStatus,
    RepositoryCompletedTranslationJobCommitter,
    TranslationExecutionDisposition,
    execute_reserved_translation_job,
)
from cosmaneura_scribe.translation_job_encryption import (
    TranslationJobCipher,
    TranslationJobStoreError,
)
from cosmaneura_scribe.translation_review_persistence import TranslationReviewPersistenceError
from sqlalchemy import text
from test_azure_translation import ENGLISH, SOURCE, adapter, body
from test_encrypted_translation_jobs import _LocalKeys
from test_normalized_source_persistence import _consent, _draft, _seed_configured_session
from test_transcription import FakeAzureClient, FakeEndpointGuard
from test_translation_review_persistence import _review_command

_PROVIDER = "Do you have a fever, and what dose do you take?"
_PATIENT_ENGLISH = "I am not sure when it started."


async def _saved_working(
    provider: PostgresRepositoryProvider,
    tenant: UUID,
    session: UUID,
) -> EnglishWorkingTranscriptV1:
    """Test-only direct persisted-row inspection, not an authorized runtime reader."""
    async with provider.engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant, true)"),
            {"tenant": str(tenant)},
        )
        header = (
            (
                await connection.execute(
                    text("""
                    SELECT working_transcript_id,
                           current_working_transcript_version AS working_transcript_version,
                           current_source_transcript_version AS source_transcript_version
                    FROM scribe_sessions WHERE tenant_id = :tenant AND id = :session
                """),
                    {"tenant": tenant, "session": session},
                )
            )
            .mappings()
            .one()
        )
        scope = {
            "tenant": tenant,
            "session": session,
            "version": header["working_transcript_version"],
        }
        segments = (
            (
                await connection.execute(
                    text("""
                    SELECT source_segment_id, source_segment_version, source_locale,
                           speaker_id, speaker_role, start_ms, end_ms, resolution, content,
                           translation_id, translation_version, translation_review_id
                    FROM normalized_working_segments
                    WHERE tenant_id = :tenant AND session_id = :session
                      AND working_transcript_version = :version ORDER BY ordinal
                """),
                    scope,
                )
            )
            .mappings()
            .all()
        )
        blockers = (
            (
                await connection.execute(
                    text("""
                    SELECT source_segment_id, code FROM normalized_working_blockers
                    WHERE tenant_id = :tenant AND session_id = :session
                      AND working_transcript_version = :version
                    ORDER BY source_segment_id, code
                """),
                    scope,
                )
            )
            .mappings()
            .all()
        )
    return EnglishWorkingTranscriptV1.model_validate_json(
        json.dumps(
            {
                **dict(header),
                "segments": [dict(row) for row in segments],
                "blockers": [dict(row) for row in blockers],
            },
            default=str,
        )
    )


@pytest.mark.postgres
@pytest.mark.parametrize(
    "mode",
    [
        "translated",
        "filtered",
        "refused",
        "incomplete",
        "unknown_locale",
        "overlap",
    ],
)
def test_mixed_speech_to_encrypted_job_review_and_saved_english_handoff(
    postgres_urls,
    tmp_path: Path,
    mode: str,
) -> None:
    async def scenario() -> None:
        provider = build_postgres_provider(postgres_settings(postgres_urls[1]))
        tenant, consent = uuid4(), _consent()
        draft = _draft(consent)
        # Consent is persisted before even the synthetic audio processing path.
        await _seed_configured_session(provider, tenant, consent, draft)
        path = tmp_path / "invented-sdk-transport-input.wav"
        path.write_bytes(b"offline SDK transport fixture; not recognized audio")
        phrases = [
            TranscribedPhrase(
                channel=0,
                speaker=1,
                offset_milliseconds=0,
                duration_milliseconds=900,
                text=_PROVIDER,
                locale="en-US",
                confidence=0.98,
            ),
            TranscribedPhrase(
                channel=0,
                speaker=2,
                offset_milliseconds=1_000,
                duration_milliseconds=1_000,
                text=SOURCE,
                locale=None if mode == "unknown_locale" else "es-US",
                confidence=0.97,
            ),
            TranscribedPhrase(
                channel=0,
                speaker=2,
                offset_milliseconds=1_900 if mode == "overlap" else 2_100,
                duration_milliseconds=900,
                text=_PATIENT_ENGLISH,
                locale="en-US",
                confidence=0.96,
            ),
        ]
        client = FakeAzureClient(
            [
                TranscriptionResult(
                    duration_milliseconds=3_000,
                    phrases=phrases,
                    combined_phrases=[],
                )
            ]
        )
        speech = AzureSpeechTranscriber(client, max_speakers=4, endpoint_guard=FakeEndpointGuard())
        keys = _LocalKeys()
        calls: list[httpx.Request] = []

        def model_response(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            payload = json.loads(request.content)
            assert json.loads(payload["messages"][1]["content"]) == {
                "source_locale": "es-US",
                "target_locale": "en-US",
                "transcript_segment": SOURCE,
            }
            if mode == "filtered":
                return httpx.Response(
                    400,
                    json={
                        "error": {
                            "code": "content_filter",
                            "innererror": {
                                "code": "ResponsibleAIPolicyViolation",
                            },
                        }
                    },
                )
            response = body()
            if mode == "refused":
                response["choices"][0]["message"]["refusal"] = "Synthetic refusal"
            if mode == "incomplete":
                response["choices"][0]["finish_reason"] = "length"
            return httpx.Response(200, json=response)

        translator = adapter(model_response)
        try:
            result = await speech.transcribe(
                TranscriptionRequest(
                    session_id=draft.id,
                    consent_record_id=consent.id,
                    language_code=TranscriptLanguageMode.ENGLISH_SPANISH,
                    tracks=(AudioTrack(uuid4(), CaptureChannel.MIXED, path),),
                )
            )
            assert client.requests[0].definition.locales == ["en-US", "es-US"]
            normalized = normalize_azure_source(result)
            assert [s.speaker_slot for s in normalized.segments] == [0, 1, 1]
            assert all(s.speaker_role == SpeakerRole.UNKNOWN for s in normalized.segments)
            async with provider.transaction(tenant) as repository:
                accepted = await repository.accept_normalized_source_transcript(
                    tenant,
                    draft.id,
                    idempotency_key="synthetic-service-seam-v1",
                    request=normalized,
                )
                assert accepted is not None
                source = await repository.get_current_normalized_source_transcript(tenant, draft.id)
                publication = await repository.publish_current_working_transcript(tenant, draft.id)
            assert source is not None and publication is not None
            assert [s.content for s in source.segments] == [_PROVIDER, SOURCE, _PATIENT_ENGLISH]
            assert source.segments[1].speaker_id == source.segments[2].speaker_id
            assert source.segments[0].speaker_id != source.segments[1].speaker_id
            initial = await _saved_working(provider, tenant, draft.id)
            assert not initial.note_ready
            with pytest.raises(ValueError, match="working_transcript_not_note_ready"):
                to_master_platform_payload_from_working_transcript(
                    encounter_id=draft.appointment_id,
                    session_id=draft.id,
                    working_transcript=initial,
                )
            segment = source.segments[1]
            reservation = ReservedSpanishTranslation(
                translation_id=uuid4(),
                expected_source_transcript_version=1,
                source_segment_id=segment.source_segment_id,
                expected_source_segment_version=segment.source_segment_version,
                expected_previous_translation_version=0,
                source_locale=SourceLocale.SPANISH_US,
                source_content=segment.content,
            )
            store = PostgresTranslationJobStore(provider.engine, TranslationJobCipher(keys, keys))
            if mode in {"unknown_locale", "overlap"}:
                assert publication.status == ConfiguredExternalSessionStatus.QUALITY_BLOCKED
                expected = (
                    WorkingTranscriptBlockerCode.SOURCE_LOCALE_UNKNOWN
                    if mode == "unknown_locale"
                    else WorkingTranscriptBlockerCode.SOURCE_OVERLAP
                )
                assert expected in {item.code for item in initial.blockers}
                with pytest.raises(TranslationJobStoreError):
                    await store.reserve_translation_job(tenant, draft.id, reservation)
                assert (
                    await store.get_translation_job(tenant, draft.id, reservation.translation_id)
                    is None
                )
                assert not calls
                return

            await store.reserve_translation_job(tenant, draft.id, reservation)
            execution = await execute_reserved_translation_job(
                store=store,
                adapter=translator,
                committer=RepositoryCompletedTranslationJobCommitter(provider),
                tenant_id=tenant,
                session_id=draft.id,
                translation_id=reservation.translation_id,
                provider_call_token=uuid4(),
            )
            assert (
                execution.disposition == TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
            )
            assert len(calls) == 1  # Neither English segment is sent to translation.
            # Dispose the connection pool; no in-memory job/projection survives as evidence.
            await provider.close()
            provider = build_postgres_provider(postgres_settings(postgres_urls[1]))
            store = PostgresTranslationJobStore(provider.engine, TranslationJobCipher(keys, keys))
            saved = await store.get_translation_job(tenant, draft.id, reservation.translation_id)
            assert (
                saved is not None and saved.status == DurableTranslationJobStatus.ATTEMPT_COMMITTED
            )
            replay = await execute_reserved_translation_job(
                store=store,
                adapter=translator,
                committer=RepositoryCompletedTranslationJobCommitter(provider),
                tenant_id=tenant,
                session_id=draft.id,
                translation_id=reservation.translation_id,
                provider_call_token=uuid4(),
            )
            assert replay.disposition == TranslationExecutionDisposition.ALREADY_COMMITTED
            assert len(calls) == 1
            before_review = await _saved_working(provider, tenant, draft.id)
            assert not before_review.note_ready
            command = _review_command(
                1,
                segment.source_segment_id,
                1,
                reservation.translation_id,
                1,
                draft.creator_actor_id,
            )
            if mode != "translated":
                assert WorkingTranscriptBlockerCode.TRANSLATION_FAILED in {
                    item.code for item in before_review.blockers
                }
                assert before_review.segments[1].content is None
                with pytest.raises(TranslationReviewPersistenceError):
                    await commit_creator_translation_review_and_publish(
                        provider,
                        tenant,
                        draft.id,
                        command,
                    )
            else:
                assert WorkingTranscriptBlockerCode.TRANSLATION_REVIEW_REQUIRED in {
                    item.code for item in before_review.blockers
                }
                with pytest.raises(TranslationReviewPersistenceError):
                    await commit_creator_translation_review_and_publish(
                        provider,
                        tenant,
                        draft.id,
                        replace(command, reviewer_actor_id="not_the_creating_provider"),
                    )
                review = await commit_creator_translation_review_and_publish(
                    provider,
                    tenant,
                    draft.id,
                    command,
                )
                assert (
                    review is not None
                    and review.status == ConfiguredExternalSessionStatus.TRANSCRIPT_READY
                )

            async with provider.transaction(tenant) as repository:
                retained = await repository.get_current_normalized_source_transcript(
                    tenant, draft.id
                )
            assert retained == source  # Spanish source/locale/timing/speaker evidence is immutable.
            final = await _saved_working(provider, tenant, draft.id)
            if mode == "translated":
                assert final.note_ready
                assert [s.content for s in final.segments] == [_PROVIDER, ENGLISH, _PATIENT_ENGLISH]
                assert [s.speaker_id for s in final.segments] == [
                    s.speaker_id for s in source.segments
                ]
                handoff = to_master_platform_payload_from_working_transcript(
                    encounter_id=draft.appointment_id,
                    session_id=draft.id,
                    working_transcript=final,
                )
                assert [s.content for s in handoff.segments] == [
                    _PROVIDER,
                    ENGLISH,
                    _PATIENT_ENGLISH,
                ]
                assert all(s.speaker == "Unknown" for s in handoff.segments)
            else:
                with pytest.raises(ValueError, match="working_transcript_not_note_ready"):
                    to_master_platform_payload_from_working_transcript(
                        encounter_id=draft.appointment_id,
                        session_id=draft.id,
                        working_transcript=final,
                    )
            assert len(calls) == 1
            assert all(key == bytearray(32) for key in keys.unwrapped)
        finally:
            await speech.close()
            await provider.close()

    asyncio.run(scenario())
