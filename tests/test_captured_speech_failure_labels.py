"""Closed operational labels never serialize provider, audio or database details."""

import pytest
from cosmaneura_scribe import captured_transcription_worker as module
from cosmaneura_scribe.audio_assembly import AudioAssemblyError
from cosmaneura_scribe.speech_private_network import PrivateSpeechEndpointUnavailable
from cosmaneura_scribe.transcription import AzureSpeechProviderError
from cosmaneura_scribe.transcription_worker import TranscriptionWorkerError
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (AudioAssemblyError("audio_blob_unavailable"), "CapturedAudioBlobUnavailable"),
        (AudioAssemblyError("audio_decryption_failed"), "CapturedAudioDecryptionFailed"),
        (AudioAssemblyError("audio_key_unwrap_rejected"), "CapturedAudioKeyUnwrapRejected"),
        (AudioAssemblyError("audio_wave_invalid"), "CapturedAudioWaveInvalid"),
        (AudioAssemblyError("private payload"), "CapturedAudioAssemblyFailed"),
        (AzureSpeechProviderError("speech_request_rejected"), "CapturedSpeechRequestRejected"),
        (AzureSpeechProviderError("private payload"), "CapturedSpeechProviderFailed"),
        (PrivateSpeechEndpointUnavailable("private hostname"),
         "CapturedSpeechPrivateEndpointUnavailable"),
        (RuntimeError("private database detail"), "CapturedSpeechProcessingFailed"),
        (ValueError("audio_blob_unavailable"), "CapturedSpeechProcessingFailed"),
    ],
)
def test_fixed_label_requires_known_exception_type(error, expected):
    assert module._safe_processing_failure_label(error) == expected


@pytest.mark.postgres
@pytest.mark.asyncio
@pytest.mark.parametrize("publication", [False, True])
async def test_observation_preserves_durable_failure_and_retry(capture, monkeypatch, publication):
    await capture.record()
    worker = capture.worker()
    events = []

    async def fail(**_kwargs):
        # A publication exception cannot be mistaken for an audio assembly failure.
        raise AudioAssemblyError("audio_blob_unavailable")

    target, name = (worker._runtime, "publish_speech_result") if publication else (
        worker, "_transcribe_with_heartbeat"
    )
    with monkeypatch.context() as patch:
        patch.setattr(target, name, fail)
        patch.setattr(module, "log_event", lambda **event: events.append(event))
        with pytest.raises(TranscriptionWorkerError) as raised:
            await capture.process(worker)
    assert raised.value.__context__ is None
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        job = await store.transcription_job_for(capture.trial.tenant, capture.trial.draft.id)
    assert job is not None and job.attempt_count == 1 and job.status.value == "retryable"
    assert job.last_error_code == (
        "captured_speech_publication_failed" if publication else "captured_speech_processing_failed"
    )
    assert events == [{
        "action": "captured_speech.failure_observed",
        "tenant_id": capture.trial.tenant,
        "entity_id": job.id,
        "error_class": "CapturedSpeechPublicationFailed" if publication else
        "CapturedAudioBlobUnavailable",
    }]
    assert await capture.trial.counts() == (0, 0, 0)
    await capture.process(worker)
    async with capture.trial.provider.transaction(capture.trial.tenant) as store:
        completed = await store.transcription_job_for(capture.trial.tenant, capture.trial.draft.id)
    assert completed is not None and completed.id == job.id and completed.attempt_count == 2
    assert completed.status.value == "completed" and await capture.trial.counts() == (1, 1, 1)
