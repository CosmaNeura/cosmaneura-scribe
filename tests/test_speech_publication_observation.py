"""Synthetic scoped correlation; offline SDK responses are never live ASR evidence."""

from __future__ import annotations

import json
import logging
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from cosmaneura_scribe import safe_logging
from cosmaneura_scribe import scoped_speech_observation as scoped
from cosmaneura_scribe.captured_source_runtime import (
    CapturedSourcePublication,
    CapturedSourceUnavailable,
    CapturedSpeechCompletion,
)
from cosmaneura_scribe.captured_transcription_worker import CapturedTranscriptionWorker
from cosmaneura_scribe.external_transcript_v1 import NormalizedSourceTranscriptReceiptV1
from cosmaneura_scribe.normalized_source_persistence import (
    NormalizedSourceAcceptance,
)
from cosmaneura_scribe.normalized_source_persistence import (
    NormalizedSourceAcceptanceDisposition as Disposition,
)
from cosmaneura_scribe.schemas import CaptureChannel, TranscriptionJobStatus
from cosmaneura_scribe.speech_observation import SpeechResultObservation
from cosmaneura_scribe.transcription import AudioTrack, AzureSpeechTranscriber, TranscriptionRequest
from cosmaneura_scribe.transcription_worker import TranscriptionWorkerError
from test_captured_source_runtime import _result as source_result
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture
from test_scoped_speech_observation import observation, scope, seeded
from test_transcription import FakeAzureClient, _result


def observed(result, *, channel="mixed"):
    boundary = observation(
        phrase_count=len(result.segments),
        missing_speaker_count=0,
        distinct_non_null_speaker_count=len({s.provider_speaker_id for s in result.segments}),
        accepted_phrase_count=len(result.segments),
        accepted_missing_speaker_count=0,
        accepted_distinct_non_null_speaker_count=len(
            {s.provider_speaker_id for s in result.segments}
        ),
        accepted_distinct_speaker_count=len({s.provider_speaker_id for s in result.segments}),
    )
    return replace(result, observation=SpeechResultObservation((channel,), (boundary,)))


def setup():
    tenant, session, consent = uuid4(), uuid4(), uuid4()
    clock = [datetime.now(UTC)]
    factory = scoped.capture_speech_observer(
        scope(tenant, session, consent, issued_at=(clock[0] - timedelta(seconds=1)).isoformat()),
        tenant_id=tenant,
        clock=lambda: clock[0],
    )
    completion = CapturedSpeechCompletion(uuid4(), uuid4(), 1, observed(source_result()))
    receipt = NormalizedSourceTranscriptReceiptV1(
        schema_version="1.0",
        session_id=session,
        source_receipt_id=uuid4(),
        source_transcript_version=1,
        receipt_state="source_received",
        received_at=clock[0] - timedelta(seconds=1),
        transcript_content_expires_at=clock[0] + timedelta(hours=1),
    )
    publication = CapturedSourcePublication(
        NormalizedSourceAcceptance(receipt, Disposition.ACCEPTED),
        SimpleNamespace(),  # The diagnostic never reads working content.
    )
    return tenant, session, consent, factory, completion, publication, clock


def events(caplog, action="captured_speech.source_publication"):
    return [json.loads(r.message) for r in caplog.records if action in r.message]


def test_ephemeral_metadata_does_not_change_result_equality_or_repr():
    result = source_result()
    assert result.observation is None
    with_metadata = observed(result)
    assert result == with_metadata and repr(result) == repr(with_metadata)
    assert with_metadata.observation.boundaries[0].call_id not in repr(with_metadata)


def test_new_publication_closed_metadata_binds_actual_calls_and_receipt(caplog):
    tenant, session, consent, factory, completion, publication, _ = setup()
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        factory.publication(tenant, session, consent, completion, publication)
    (row,) = events(caplog)
    assert set(row) == safe_logging.SPEECH_PUBLICATION_FIELD_ALLOWLIST
    assert row["source_receipt_id"] == str(publication.source.receipt.source_receipt_id)
    assert row["job_id"] == str(completion.job_id) and row["attempt_count"] == 1
    assert row["source_transcript_version"] == 1 and row["result_segment_count"] == 3
    assert row["result_distinct_speaker_count"] == 2
    assert row["calls"] == [
        {
            "call_id": completion.result.observation.boundaries[0].call_id,
            "track_index": 0,
            "channel": "mixed",
            "accepted_phrase_count": 3,
            "accepted_distinct_speaker_count": 2,
        }
    ]
    for segment in completion.result.segments:
        assert segment.content not in caplog.text
    assert str(completion.lease_token) not in caplog.text


def test_completion_sink_failure_is_silent(monkeypatch, caplog):
    tenant, session, consent, factory, completion, publication, _ = setup()

    def fail(**kwargs):
        raise RuntimeError("synthetic diagnostic failure")

    monkeypatch.setattr(scoped, "log_speech_publication", fail)
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        factory.publication(tenant, session, consent, completion, publication)
    assert events(caplog) == []


@pytest.mark.parametrize(
    "disposition", [Disposition.REPLAYED, Disposition.CONVERGED, Disposition.CORRECTED]
)
def test_old_or_reused_receipt_never_attests_new_call(disposition, caplog):
    tenant, session, consent, factory, completion, publication, _ = setup()
    publication = replace(publication, source=replace(publication.source, disposition=disposition))
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        factory.publication(tenant, session, consent, completion, publication)
    assert events(caplog) == []


@pytest.mark.parametrize(
    "change", ["tenant", "session", "consent", "expiry", "receipt", "version", "metadata"]
)
def test_scope_expiry_receipt_and_missing_metadata_disable_only_event(change, caplog):
    tenant, session, consent, factory, completion, publication, clock = setup()
    if change == "tenant":
        tenant = uuid4()
    if change == "session":
        session = uuid4()
    if change == "consent":
        consent = uuid4()
    if change == "expiry":
        clock[0] += timedelta(hours=1)
    if change in {"receipt", "version"}:
        updates = (
            {"session_id": uuid4()} if change == "receipt" else {"source_transcript_version": 2}
        )
        publication = replace(
            publication,
            source=replace(
                publication.source, receipt=publication.source.receipt.model_copy(update=updates)
            ),
        )
    if change == "metadata":
        completion = replace(completion, result=source_result())
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        factory.publication(tenant, session, consent, completion, publication)
    assert events(caplog) == []


@pytest.mark.parametrize(
    "change",
    [
        "empty",
        "index",
        "channel",
        "count",
        "speakers",
        "duplicate_channel",
        "partial",
        "call_id",
        "job",
        "attempt",
        "future_receipt",
    ],
)
def test_invalid_or_partial_result_correlation_never_emits(change, caplog):
    tenant, session, consent, factory, completion, publication, _ = setup()
    result = completion.result
    metadata = result.observation
    boundary = metadata.boundaries[0]
    if change == "empty":
        metadata = replace(metadata, boundaries=())
    if change == "index":
        metadata = replace(metadata, boundaries=(replace(boundary, track_index=1),))
    if change == "channel":
        metadata = replace(metadata, track_channels=("private-content",))
    if change == "count":
        result = replace(result, segments=result.segments[:-1])
    if change == "speakers":
        result = replace(
            result, segments=tuple(replace(s, provider_speaker_id="one") for s in result.segments)
        )
    if change == "duplicate_channel":
        metadata = replace(
            metadata,
            track_channels=("mixed", "mixed"),
            boundaries=(boundary, replace(boundary, track_index=1)),
        )
    if change == "partial":
        metadata = replace(metadata, track_channels=("mixed", "microphone"))
    if change == "call_id":
        metadata = replace(metadata, boundaries=(replace(boundary, call_id="private"),))
    completion = replace(completion, result=replace(result, observation=metadata))
    if change == "job":
        completion = replace(completion, job_id=uuid4().int)
    if change == "attempt":
        completion = replace(completion, attempt_count=1001)
    if change == "future_receipt":
        publication = replace(
            publication,
            source=replace(
                publication.source,
                receipt=publication.source.receipt.model_copy(
                    update={"received_at": datetime.now(UTC) + timedelta(hours=1)}
                ),
            ),
        )
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        factory.publication(tenant, session, consent, completion, publication)
    assert events(caplog) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_sdk_result_carries_exact_callback_metadata_only_when_enabled(
    tmp_path, caplog, enabled
):
    tenant, _, session, path = await seeded(tmp_path)
    factory = (
        scoped.capture_speech_observer(
            scope(tenant, session.id, session.consent_record_id), tenant_id=tenant
        )
        if enabled
        else None
    )
    client = FakeAzureClient(
        [_result(text="Synthetic wording", speaker=0, offset_ms=0, duration_ms=100, confidence=1)]
    )
    provider = AzureSpeechTranscriber(client, max_speakers=4, observer_for_request=factory)
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        result = await provider.transcribe(
            TranscriptionRequest(
                session.id,
                session.consent_record_id,
                "en-US",
                (AudioTrack(uuid4(), CaptureChannel.MIXED, path),),
            )
        )
    assert len(client.requests) == 1
    if enabled:
        (row,) = events(caplog, "captured_speech.provider_boundary")
        assert result.observation.track_channels == ("mixed",)
        assert result.observation.boundaries[0].call_id == row["call_id"]
    else:
        assert (
            result.observation is None and events(caplog, "captured_speech.provider_boundary") == []
        )


@pytest.mark.asyncio
async def test_missing_one_track_observation_drops_correlation_without_repeating_calls(tmp_path):
    tenant, _, session, path = await seeded(tmp_path)
    factory = scoped.capture_speech_observer(
        scope(tenant, session.id, session.consent_record_id), tenant_id=tenant
    )
    selected = 0

    def for_request(request):
        nonlocal selected
        selected += 1
        return factory(request) if selected == 1 else None

    response = _result(
        text="Synthetic wording", speaker=0, offset_ms=0, duration_ms=100, confidence=1
    )
    client = FakeAzureClient([response, response])
    provider = AzureSpeechTranscriber(client, max_speakers=4, observer_for_request=for_request)
    result = await provider.transcribe(
        TranscriptionRequest(
            session.id,
            session.consent_record_id,
            "en-US",
            tuple(
                AudioTrack(uuid4(), channel, path)
                for channel in (CaptureChannel.MIXED, CaptureChannel.MICROPHONE)
            ),
        )
    )
    assert len(client.requests) == len(result.segments) == 2
    assert result.observation is None


def provider_worker(capture):
    tenant, draft = capture.trial.tenant, capture.trial.draft
    factory = scoped.capture_speech_observer(
        scope(tenant, draft.id, draft.consent_record_id), tenant_id=tenant
    )
    response = _result(
        text="Synthetic published source", speaker=0, offset_ms=0, duration_ms=1000, confidence=1
    )
    client = FakeAzureClient([response, response])
    provider = AzureSpeechTranscriber(client, max_speakers=4, observer_for_request=factory)
    worker = CapturedTranscriptionWorker(
        repositories=capture.trial.provider,
        assembler=capture.assembler,
        transcriber=provider,
        enabled=True,
        publication_observer=factory.publication,
    )
    return client, worker


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_actual_committed_source_event_and_completed_recovery(capture, caplog):
    await capture.record()
    client, worker = provider_worker(capture)
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        outcome = await capture.process(worker)
        recovered = await capture.process(worker)
    assert recovered.already_completed and recovered.job_id == outcome.job_id
    assert len(client.requests) == 1 and await capture.trial.counts() == (1, 1, 1)
    (publication,) = events(caplog)
    (boundary,) = events(caplog, "captured_speech.provider_boundary")
    assert publication["calls"][0]["call_id"] == boundary["call_id"]
    assert publication["job_id"] == str(outcome.job_id)
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        source = await store.get_current_normalized_source_transcript(
            capture.trial.tenant, capture.trial.draft.id
        )
        job = await store.transcription_job_for(capture.trial.tenant, capture.trial.draft.id)
    assert publication["source_receipt_id"] == str(source.source_receipt_id)
    assert publication["result_segment_count"] == len(source.segments) == 1
    assert job.status == TranscriptionJobStatus.COMPLETED and job.attempt_count == 1


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_diagnostic_failure_cannot_retry_committed_source(capture, monkeypatch, caplog):
    await capture.record()
    client, worker = provider_worker(capture)

    def fail(*args):
        raise RuntimeError("synthetic sink failure")

    worker._publication_observer = fail
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        await capture.process(worker)
        assert (await capture.process(worker)).already_completed
    assert len(client.requests) == 1 and events(caplog) == []
    assert await capture.trial.counts() == (1, 1, 1)


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_failed_publication_then_real_retry_only_attests_later_result(
    capture, monkeypatch, caplog
):
    await capture.record()
    client, worker = provider_worker(capture)
    original = worker._runtime.publish_speech_result

    async def fail(**kwargs):
        raise CapturedSourceUnavailable()

    monkeypatch.setattr(worker._runtime, "publish_speech_result", fail)
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(TranscriptionWorkerError):
            await capture.process(worker)
        assert events(caplog) == [] and await capture.trial.counts() == (0, 0, 0)
        monkeypatch.setattr(worker._runtime, "publish_speech_result", original)
        await capture.process(worker)
    (publication,) = events(caplog)
    earlier, later = events(caplog, "captured_speech.provider_boundary")
    assert len(client.requests) == 2 and publication["attempt_count"] == 2
    assert publication["calls"][0]["call_id"] == later["call_id"] != earlier["call_id"]
    assert await capture.trial.counts() == (1, 1, 1)


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_lost_commit_reply_remains_unattested_without_provider_replay(
    capture, monkeypatch, caplog
):
    await capture.record()
    client, worker = provider_worker(capture)
    original = worker._runtime.publish_speech_result

    async def lost_reply(**kwargs):
        await original(**kwargs)
        raise CapturedSourceUnavailable()

    monkeypatch.setattr(worker._runtime, "publish_speech_result", lost_reply)
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        with pytest.raises(TranscriptionWorkerError):
            await capture.process(worker)
        assert (await capture.process(worker)).already_completed
    assert len(client.requests) == 1 and events(caplog) == []
    assert await capture.trial.counts() == (1, 1, 1)


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_actual_idempotent_reuse_and_different_result_never_attest_new_call(trial, caplog):
    completion = await trial.processing()
    completion = replace(completion, result=observed(completion.result))
    factory = scoped.capture_speech_observer(
        scope(trial.tenant, trial.draft.id, trial.draft.consent_record_id), tenant_id=trial.tenant
    )
    with caplog.at_level(logging.INFO, logger="cosmaneura_scribe"):
        publication = await trial.runtime.publish_speech_result(
            tenant_id=trial.tenant, session_id=trial.draft.id, completion=completion
        )
        factory.publication(
            trial.tenant, trial.draft.id, trial.draft.consent_record_id, completion, publication
        )
        later = replace(completion, result=observed(completion.result))
        replay = await trial.runtime.publish_speech_result(
            tenant_id=trial.tenant, session_id=trial.draft.id, completion=later
        )
        assert replay.source.disposition == Disposition.REPLAYED
        assert replay.source.receipt == publication.source.receipt
        factory.publication(
            trial.tenant, trial.draft.id, trial.draft.consent_record_id, later, replay
        )
        changed = replace(
            later,
            result=replace(
                later.result,
                segments=(
                    replace(later.result.segments[0], content="Different synthetic source"),
                    *later.result.segments[1:],
                ),
            ),
        )
        with pytest.raises(CapturedSourceUnavailable):
            await trial.runtime.publish_speech_result(
                tenant_id=trial.tenant, session_id=trial.draft.id, completion=changed
            )
    (row,) = events(caplog)
    assert row["calls"][0]["call_id"] == completion.result.observation.boundaries[0].call_id
    assert row["calls"][0]["call_id"] != later.result.observation.boundaries[0].call_id
    assert await trial.counts() == (1, 1, 1)
