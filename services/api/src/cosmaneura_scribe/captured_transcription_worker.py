"""Explicit, default-off capture-to-bilingual worker; no environment registration."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from .audio_assembly import AudioAssemblyError
from .azure_speech_source import normalize_azure_source
from .captured_source_runtime import (
    CapturedSourceRepositoryProvider,
    CapturedSourceRuntime,
    CapturedSourceUnavailable,
    CapturedSpeechCompletion,
)
from .consent import ConsentError
from .normalized_source_persistence import CapturedPreSourceStatus
from .safe_logging import log_event
from .schemas import SessionStatus, TranscriptionJob, TranscriptionJobStatus
from .speech_private_network import PrivateSpeechEndpointUnavailable
from .transcription import AzureSpeechProviderError, SpeechToTextProvider, TranscriptionInputError
from .transcription_worker import (
    AudioTrackAssembler,
    LeasedAudioTranscription,
    TranscriptionWorkerError,
)


@dataclass(frozen=True)
class CapturedTranscriptionOutcome:
    session_id: UUID
    job_id: UUID
    already_completed: bool


def _safe_processing_failure_label(error: Exception) -> str:
    """Closed labels only; never log an exception, provider payload or audio data."""
    if isinstance(error, PrivateSpeechEndpointUnavailable):
        return "CapturedSpeechPrivateEndpointUnavailable"
    if isinstance(error, AudioAssemblyError):
        return {
            "audio_blob_unavailable": "CapturedAudioBlobUnavailable",
            "audio_assembly_not_authorized": "CapturedAudioAssemblyNotAuthorized",
            "audio_key_not_authorized": "CapturedAudioKeyNotAuthorized",
            "audio_wrapped_key_invalid": "CapturedAudioWrappedKeyInvalid",
            "audio_key_unwrap_unavailable": "CapturedAudioKeyUnwrapUnavailable",
            "audio_key_unwrap_rejected": "CapturedAudioKeyUnwrapRejected",
            "audio_key_unwrap_invalid_response": "CapturedAudioKeyUnwrapInvalidResponse",
            "audio_key_invalid": "CapturedAudioKeyInvalid",
            "audio_decryption_failed": "CapturedAudioDecryptionFailed",
            "audio_ciphertext_size_mismatch": "CapturedAudioCiphertextSizeMismatch",
            "audio_ciphertext_digest_mismatch": "CapturedAudioCiphertextDigestMismatch",
            "audio_wave_invalid": "CapturedAudioWaveInvalid",
            "audio_wave_media_profile_unsupported": "CapturedAudioMediaUnsupported",
        }.get(str(error), "CapturedAudioAssemblyFailed")
    if isinstance(error, AzureSpeechProviderError):
        return {
            "speech_credential_unavailable": "CapturedSpeechCredentialUnavailable",
            "speech_service_transport_error": "CapturedSpeechTransportFailed",
            "speech_service_response_error": "CapturedSpeechResponseInvalid",
            "speech_authentication_rejected": "CapturedSpeechAuthenticationRejected",
            "speech_authorization_rejected": "CapturedSpeechAuthorizationRejected",
            "speech_api_unavailable": "CapturedSpeechApiUnavailable",
            "speech_request_rejected": "CapturedSpeechRequestRejected",
            "speech_service_throttled": "CapturedSpeechThrottled",
            "speech_service_unavailable": "CapturedSpeechServiceUnavailable",
        }.get(str(error), "CapturedSpeechProviderFailed")
    return "CapturedSpeechProcessingFailed"


class CapturedTranscriptionWorker(LeasedAudioTranscription):
    def __init__(
        self,
        *,
        repositories: CapturedSourceRepositoryProvider,
        assembler: AudioTrackAssembler,
        transcriber: SpeechToTextProvider,
        enabled: bool = False,
        lease_duration: timedelta = timedelta(minutes=15),
        heartbeat_interval: timedelta | None = None,
        max_attempts: int = 3,
    ) -> None:
        super().__init__(
            repositories=repositories,
            assembler=assembler,
            transcriber=transcriber,
            lease_duration=lease_duration,
            heartbeat_interval=heartbeat_interval,
            max_attempts=max_attempts,
        )
        self._captures = repositories
        self._runtime = CapturedSourceRuntime(repositories, enabled=enabled)
        self._enabled = enabled is True

    async def process(self, *, tenant_id: UUID, session_id: UUID) -> CapturedTranscriptionOutcome:
        if not self._enabled:
            raise TranscriptionWorkerError("captured_transcription_disabled")
        try:
            return await self._process_capture(tenant_id, session_id)
        except Exception:
            pass
        # No raw provider/database exception retained on the public failure. Task
        # cancellation propagates, and the shared runner cancels/joins child work.
        raise TranscriptionWorkerError("captured_transcription_unavailable")

    async def _process_capture(
        self, tenant_id: UUID, session_id: UUID
    ) -> CapturedTranscriptionOutcome:
        token, now = uuid4(), datetime.now(UTC)
        async with self._captures.transaction(tenant_id) as store:
            configured = await store.lock_live_capture(tenant_id, session_id)
            previous = await store.transcription_job_for(tenant_id, session_id)
            if previous is not None and previous.status == TranscriptionJobStatus.COMPLETED:
                if not await store.recover_completed_speech(tenant_id, session_id, previous):
                    raise CapturedSourceUnavailable()
                return CapturedTranscriptionOutcome(session_id, previous.id, True)
            if self._transcriber.name != configured.transcription_adapter_id:
                raise CapturedSourceUnavailable()
            if configured.status not in {
                CapturedPreSourceStatus.UPLOADED,
                CapturedPreSourceStatus.PROCESSING,
            }:
                raise CapturedSourceUnavailable()
            session = await store.lock_session(tenant_id, session_id)
            if session is None:
                raise CapturedSourceUnavailable()
            chunks = tuple(await store.chunks_for(tenant_id, session_id))
            finalizations = await store.capture_finalizations_for(tenant_id, session_id)
            declared = {item.channel: item.last_sequence_number for item in finalizations}
            if not chunks or not declared or set(declared) != {item.channel for item in chunks}:
                raise CapturedSourceUnavailable()
            for channel, last in declared.items():
                if sorted(c.sequence_number for c in chunks if c.channel == channel) != list(
                    range(last + 1)
                ):
                    raise CapturedSourceUnavailable()
            job = await store.claim_transcription_job(
                tenant_id,
                session_id,
                job_id=uuid4(),
                lease_token=token,
                now=now,
                lease_until=now + self._lease_duration,
                max_attempts=self._max_attempts,
            )
            if job is None:
                raise CapturedSourceUnavailable()
            if session.status == SessionStatus.UPLOADED:
                await store.update_session(
                    tenant_id, session.model_copy(update={"status": SessionStatus.PROCESSING})
                )
            await store.audit(
                tenant_id=tenant_id,
                action="captured_speech.claimed",
                entity_type="transcription_job",
                entity_id=job.id,
            )

        # Keep the failing boundary actionable without persisting provider errors
        # or protected source data. These labels do not change retry policy.
        failure = "captured_speech_processing_failed"
        terminal = False
        error_class: str | None = None
        try:
            result = await self._transcribe_with_heartbeat(
                tenant_id=tenant_id,
                session=session,
                chunks=chunks,
                language_code=configured.language_mode.value,
                job_id=job.id,
                lease_token=token,
            )
            if result.language_code != configured.language_mode.value:
                raise TranscriptionInputError("speech_source_language_mode_conflict")
            if any(segment.channel not in declared for segment in result.segments):
                raise TranscriptionInputError("speech_source_channel_conflict")
            normalize_azure_source(result)
            failure = "captured_speech_publication_failed"
            await self._runtime.publish_speech_result(
                tenant_id=tenant_id,
                session_id=session_id,
                completion=CapturedSpeechCompletion(job.id, token, job.attempt_count, result),
            )
            return CapturedTranscriptionOutcome(session_id, job.id, False)
        except ConsentError:
            failure, terminal = "captured_speech_consent_invalid", True
        except TranscriptionInputError:
            failure, terminal = "captured_speech_source_invalid", True
        except TranscriptionWorkerError:
            # Lease loss belongs to the current owner; do not overwrite its job.
            raise
        except Exception as error:
            error_class = (
                "CapturedSpeechPublicationFailed"
                if failure == "captured_speech_publication_failed"
                else _safe_processing_failure_label(error)
            )
        await self._fail_attempt(tenant_id, session_id, job, token, failure, terminal)
        if error_class is not None:
            log_event(
                action="captured_speech.failure_observed",
                entity_id=job.id,
                tenant_id=tenant_id,
                error_class=error_class,
            )
        raise CapturedSourceUnavailable()

    async def _fail_attempt(
        self,
        tenant_id: UUID,
        session_id: UUID,
        job: TranscriptionJob,
        token: UUID,
        code: str,
        terminal: bool,
    ) -> None:
        terminal = terminal or job.attempt_count >= self._max_attempts
        async with self._captures.transaction(tenant_id) as store:
            # This lock also orders consent -> session. Recording a failed attempt
            # must remain possible after consent is revoked; it processes no audio.
            session = await store.lock_session(tenant_id, session_id)
            if session is None or session.status != SessionStatus.PROCESSING:
                return
            failed = job.model_copy(
                update={
                    "status": TranscriptionJobStatus.TERMINAL
                    if terminal
                    else TranscriptionJobStatus.RETRYABLE,
                    "lease_token": None,
                    "lease_until": None,
                    "last_error_code": code,
                    "updated_at": datetime.now(UTC),
                }
            )
            if await store.update_transcription_job(tenant_id, failed, expected_lease_token=token):
                await store.audit(
                    tenant_id=tenant_id,
                    action="captured_speech.failed" if terminal else "captured_speech.retryable",
                    entity_type="transcription_job",
                    entity_id=job.id,
                )
        # An exhausted provider job is terminal, not a fabricated source or clinical
        # integrity failure. No source/ready state is created; no in-process retry.
