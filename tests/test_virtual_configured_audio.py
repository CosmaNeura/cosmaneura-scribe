"""Native fictional speech through the configured desktop service path.

Real PostgreSQL, creator admission, capture API, envelopes and speech worker;
identity, blob storage, key unwrapping and recognition remain offline fixtures.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import asdict
from uuid import uuid4

import pytest
import pytest_asyncio
from cosmaneura_scribe.captured_source_runtime import (
    CapturedSourceRepositoryProvider,
    CapturedSourceRuntime,
)
from cosmaneura_scribe.external_transcript_v1 import TranscriptLanguageMode
from cosmaneura_scribe.normalized_source_persistence import CapturedSessionCreate
from cosmaneura_scribe.schemas import CaptureModality
from cosmaneura_scribe.transcript_review_service import CreatorTranscriptReviewService
from sqlalchemy.ext.asyncio import create_async_engine
from test_captured_source_runtime import Trial, _remove_owned_fixture_rows
from test_captured_transcription_worker import CaptureHarness
from test_captured_transcription_worker import capture as capture
from test_normalized_source_persistence import _consent, _draft
from test_virtual_modality_audio import NAMES, ROOT, ReadingRecognitionSubstitute, _native_pcm

pytestmark = [
    pytest.mark.postgres,
    pytest.mark.asyncio,
    pytest.mark.skipif(not ROOT, reason="Opt-in native fictional PCM is required"),
]


@pytest_asyncio.fixture(params=["in_person", "phone", "virtual"])
async def trial(
    postgres_urls: tuple[str, str], request: pytest.FixtureRequest
) -> AsyncIterator[Trial]:
    provider = CapturedSourceRepositoryProvider(
        create_async_engine(postgres_urls[1], connect_args={"ssl": False})
    )
    runtime = CapturedSourceRuntime(provider, enabled=True)
    tenant = uuid4()
    consent = _consent().model_copy(update={"modality": CaptureModality(request.param)})
    draft = CapturedSessionCreate(
        **asdict(_draft(consent, language_mode=TranscriptLanguageMode.ENGLISH))
    )
    try:
        async with provider.transaction(tenant) as store:
            await store.add_consent(tenant, consent)
        await runtime.admit(tenant_id=tenant, draft=draft)
        yield Trial(provider, runtime, tenant, consent, draft, postgres_urls[0])
    finally:
        await provider.close()
        await _remove_owned_fixture_rows(postgres_urls[0], tenant)


@pytest.mark.parametrize("name", NAMES)
async def test_native_fictional_audio_through_configured_desktop_worker(
    capture: CaptureHarness,
    name: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pcm = _native_pcm(name)
    assert len(pcm) == 480_000
    # Reuse the real capture harness with native PCM instead of constant samples.
    monkeypatch.setattr("test_captured_transcription_worker.FRAMES", (pcm[:320_000], pcm[320_000:]))
    speech = ReadingRecognitionSubstitute(pcm, capture.trial.consent.id, capture.trial.draft.id)
    # The configured worker correctly requires its admitted adapter identity.
    # This is an explicit offline substitute, not an Azure recognition result.
    speech.name = "azure_ai_speech"
    capture.speech = speech
    await capture.record()
    result = await capture.process()
    assert not result.already_completed and speech.calls == 1
    assert len(capture.reader.calls) == 2 and not list(capture.temp.iterdir())
    assert await capture.trial.counts() == (1, 1, 1)
    await capture.trial.provider.engine.dispose()
    recovered = await capture.process()
    assert recovered.already_completed and recovered.job_id == result.job_id
    assert speech.calls == 1 and len(capture.reader.calls) == 2
    assert await capture.trial.counts() == (1, 1, 1)
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        current = await store.lock_live_capture(capture.trial.tenant, capture.trial.draft.id)
        assert current.modality == capture.trial.draft.modality
    review = await CreatorTranscriptReviewService(capture.trial.provider, enabled=True).read(
        tenant_id=capture.trial.tenant,
        session_id=capture.trial.draft.id,
        creator_actor_id=capture.trial.draft.creator_actor_id,
    )
    assert len(review.working_transcript.segments) == 2
    assert not review.working_transcript.note_ready
