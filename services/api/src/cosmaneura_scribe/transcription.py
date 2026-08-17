from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO, Protocol, cast
from urllib.parse import urlsplit
from uuid import UUID

from azure.ai.transcription.aio import TranscriptionClient
from azure.ai.transcription.models import (
    ProfanityFilterMode,
    TranscriptionContent,
    TranscriptionDiarizationOptions,
    TranscriptionOptions,
    TranscriptionResult,
)
from azure.core.exceptions import (
    ClientAuthenticationError,
    DecodeError,
    HttpResponseError,
    ServiceRequestError,
    ServiceResponseError,
)
from azure.identity.aio import DefaultAzureCredential

from .schemas import CaptureChannel
from .settings import Settings
from .speech_private_network import PrivateSpeechEndpointGuard


class AudioTrackReader(Protocol):
    def open(self) -> AbstractContextManager[BinaryIO]: ...


@dataclass(frozen=True)
class AudioTrack:
    """One assembled local audio track; paths and reader state must never be logged."""

    object_id: UUID
    channel: CaptureChannel
    local_path: Path = field(repr=False)
    reader: AudioTrackReader | None = field(default=None, repr=False, compare=False)

    def open(self) -> AbstractContextManager[BinaryIO]:
        if self.reader is not None:
            return self.reader.open()
        return cast(AbstractContextManager[BinaryIO], self.local_path.open("rb"))


@dataclass(frozen=True)
class TranscriptionRequest:
    session_id: UUID
    consent_record_id: UUID
    language_code: str
    tracks: tuple[AudioTrack, ...] = field(repr=False)

    def __post_init__(self) -> None:
        if not self.tracks:
            raise ValueError("at least one assembled audio track is required")


@dataclass(frozen=True)
class SttSegment:
    channel: CaptureChannel
    provider_speaker_id: str
    start_ms: int
    end_ms: int
    confidence: float | None
    content: str = field(repr=False)


@dataclass(frozen=True)
class SttResult:
    provider: str
    language_code: str
    duration_ms: int
    segments: tuple[SttSegment, ...] = field(repr=False)


class SpeechToTextProvider(Protocol):
    @property
    def name(self) -> str: ...

    async def transcribe(self, request: TranscriptionRequest) -> SttResult: ...

    async def close(self) -> None: ...


class AzureTranscriptionClient(Protocol):
    async def transcribe(
        self,
        body: TranscriptionContent,
        **kwargs: Any,
    ) -> TranscriptionResult: ...

    async def close(self) -> None: ...


class SpeechEndpointGuard(Protocol):
    async def verify(self) -> None: ...


class TranscriptionInputError(ValueError):
    """Sanitized failure raised when an assembled audio track cannot be read."""


class AzureSpeechProviderError(RuntimeError):
    """Fixed-code Azure Speech failure safe for durable state and logs."""


def _azure_speech_error_code(error: Exception) -> str:
    if isinstance(error, ClientAuthenticationError) and error.response is None:
        return "speech_credential_unavailable"
    if isinstance(error, ServiceRequestError):
        return "speech_service_transport_error"
    if isinstance(error, (ServiceResponseError, DecodeError)):
        return "speech_service_response_error"
    if isinstance(error, HttpResponseError):
        status_code = error.status_code
        if status_code == 401:
            return "speech_authentication_rejected"
        if status_code == 403:
            return "speech_authorization_rejected"
        if status_code == 404:
            return "speech_api_unavailable"
        if status_code in {400, 415, 422}:
            return "speech_request_rejected"
        if status_code in {408, 429}:
            return "speech_service_throttled"
        if status_code is not None and status_code >= 500:
            return "speech_service_unavailable"
        return "speech_service_response_error"
    return "speech_provider_unavailable"


class AzureSpeechTranscriber:
    def __init__(
        self,
        client: AzureTranscriptionClient,
        *,
        max_speakers: int,
        credential: DefaultAzureCredential | None = None,
        endpoint_guard: SpeechEndpointGuard | None = None,
    ) -> None:
        self._client = client
        self._max_speakers = max_speakers
        self._credential = credential
        self._endpoint_guard = endpoint_guard

    @property
    def name(self) -> str:
        return "azure_ai_speech"

    @classmethod
    def from_settings(cls, settings: Settings) -> AzureSpeechTranscriber:
        if settings.azure_speech_endpoint is None:
            raise ValueError("azure_speech_endpoint is required for Azure transcription")
        endpoint = str(settings.azure_speech_endpoint).rstrip("/")
        hostname = urlsplit(endpoint).hostname
        if hostname is None:
            raise ValueError("azure_speech_endpoint is required for Azure transcription")
        endpoint_guard = PrivateSpeechEndpointGuard(
            hostname,
            settings.azure_speech_private_endpoint_cidrs,
        )
        credential = DefaultAzureCredential(
            managed_identity_client_id=(
                str(settings.managed_identity_client_id)
                if settings.managed_identity_client_id is not None
                else None
            ),
            require_envvar=False,
        )
        client = TranscriptionClient(
            endpoint=endpoint,
            credential=credential,
            logging_enable=False,
        )
        return cls(
            client,
            max_speakers=settings.azure_speech_max_speakers,
            credential=credential,
            endpoint_guard=endpoint_guard,
        )

    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        segments: list[SttSegment] = []
        duration_ms = 0

        for track in request.tracks:
            if self._endpoint_guard is not None:
                await self._endpoint_guard.verify()
            options = TranscriptionOptions(
                locales=[request.language_code],
                profanity_filter_mode=ProfanityFilterMode.NONE,
                diarization_options=TranscriptionDiarizationOptions(
                    max_speakers=self._max_speakers,
                ),
            )
            try:
                with track.open() as audio_file:
                    result = await self._client.transcribe(
                        TranscriptionContent(definition=options, audio=audio_file),
                        logging_enable=False,
                    )
            except OSError:
                raise TranscriptionInputError("audio track unavailable") from None
            except (
                ClientAuthenticationError,
                DecodeError,
                HttpResponseError,
                ServiceRequestError,
                ServiceResponseError,
            ) as error:
                raise AzureSpeechProviderError(_azure_speech_error_code(error)) from None

            duration_ms = max(duration_ms, result.duration_milliseconds)
            for phrase in result.phrases:
                content = phrase.text.strip()
                if not content or phrase.duration_milliseconds <= 0:
                    continue
                speaker = (
                    str(phrase.speaker)
                    if phrase.speaker is not None
                    else f"channel-{track.channel.value}"
                )
                confidence = min(max(phrase.confidence, 0.0), 1.0)
                segments.append(
                    SttSegment(
                        channel=track.channel,
                        provider_speaker_id=speaker,
                        start_ms=phrase.offset_milliseconds,
                        end_ms=phrase.offset_milliseconds + phrase.duration_milliseconds,
                        confidence=confidence,
                        content=content,
                    )
                )

        segments.sort(
            key=lambda segment: (
                segment.start_ms,
                segment.end_ms,
                segment.channel.value,
                segment.provider_speaker_id,
            )
        )
        if not segments:
            raise ValueError("transcription returned no recognized speech")
        return SttResult(
            provider=self.name,
            language_code=request.language_code,
            duration_ms=duration_ms,
            segments=tuple(segments),
        )

    async def close(self) -> None:
        await self._client.close()
        if self._credential is not None:
            await self._credential.close()


def build_speech_to_text_provider(settings: Settings) -> SpeechToTextProvider:
    if settings.transcription_backend == "azure":
        return AzureSpeechTranscriber.from_settings(settings)
    raise ValueError("a speech-to-text backend must be explicitly configured")
