from __future__ import annotations

from collections.abc import Sequence
from typing import Literal, Protocol
from uuid import UUID

import httpx
from azure.core.exceptions import AzureError
from azure.identity.aio import DefaultAzureCredential
from pydantic import ValidationError

from .schemas import (
    CaptureSession,
    LegacyTranscriptEntry,
    LegacyTranscriptPayload,
    MasterTranscriptDeliveryRequest,
    MasterTranscriptDeliveryResponse,
    MasterTranscriptSegment,
    SpeakerRole,
    Transcript,
    TranscriptSegment,
)
from .settings import Settings

ROLE_LABELS: dict[SpeakerRole, Literal["Doctor", "Patient", "Other", "Unknown"]] = {
    SpeakerRole.CLINICIAN: "Doctor",
    SpeakerRole.PATIENT: "Patient",
    SpeakerRole.OTHER: "Other",
    SpeakerRole.UNKNOWN: "Unknown",
}


class HandoffError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class HandoffDisabledError(HandoffError):
    pass


class HandoffRetryableError(HandoffError):
    pass


class HandoffRejectedError(HandoffError):
    pass


class HandoffConflictError(HandoffError):
    pass


class MasterPlatformHandoff(Protocol):
    async def deliver(
        self,
        payload: MasterTranscriptDeliveryRequest,
        *,
        idempotency_key: str,
    ) -> MasterTranscriptDeliveryResponse: ...

    async def close(self) -> None: ...


class DisabledMasterPlatformHandoff:
    async def deliver(
        self,
        payload: MasterTranscriptDeliveryRequest,
        *,
        idempotency_key: str,
    ) -> MasterTranscriptDeliveryResponse:
        del payload, idempotency_key
        raise HandoffDisabledError("handoff_disabled")

    async def close(self) -> None:
        return None


class HttpMasterPlatformHandoff:
    """Send transcripts with an app-only Entra token obtained via workload identity."""

    def __init__(
        self,
        *,
        base_url: str,
        scope: str,
        timeout_seconds: float,
        credential: DefaultAzureCredential,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._scope = scope
        self._credential = credential
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=timeout_seconds
        )

    async def deliver(
        self,
        payload: MasterTranscriptDeliveryRequest,
        *,
        idempotency_key: str,
    ) -> MasterTranscriptDeliveryResponse:
        try:
            access_token = await self._credential.get_token(self._scope)
            response = await self._client.post(
                "/service/v1/scribe/transcripts",
                headers={
                    "Authorization": f"Bearer {access_token.token}",
                    "Idempotency-Key": idempotency_key,
                },
                json=payload.model_dump(mode="json"),
            )
        except (AzureError, httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError):
            raise HandoffRetryableError("transport_unavailable") from None

        if response.status_code in {200, 201}:
            try:
                return MasterTranscriptDeliveryResponse.model_validate(response.json())
            except (ValueError, ValidationError):
                raise HandoffRetryableError("invalid_platform_response") from None
        if response.status_code == 409:
            raise HandoffConflictError("platform_conflict")
        if response.status_code in {408, 425, 429} or response.status_code >= 500:
            raise HandoffRetryableError(f"platform_http_{response.status_code}")
        raise HandoffRejectedError(f"platform_http_{response.status_code}")

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
        await self._credential.close()


def build_master_platform_handoff(settings: Settings) -> MasterPlatformHandoff:
    if not settings.master_platform_handoff_enabled:
        return DisabledMasterPlatformHandoff()
    if settings.master_platform_base_url is None or settings.master_platform_scope is None:
        raise ValueError("master platform handoff settings are incomplete")

    credential = DefaultAzureCredential(
        managed_identity_client_id=(
            str(settings.managed_identity_client_id)
            if settings.managed_identity_client_id is not None
            else None
        ),
        require_envvar=False,
    )
    return HttpMasterPlatformHandoff(
        base_url=str(settings.master_platform_base_url),
        scope=settings.master_platform_scope,
        timeout_seconds=settings.master_platform_timeout_seconds,
        credential=credential,
    )


def to_master_platform_payload(
    session: CaptureSession, transcript: Transcript
) -> MasterTranscriptDeliveryRequest:
    return to_master_platform_payload_parts(
        encounter_id=session.appointment_id,
        session_id=session.id,
        segments=transcript.segments,
    )


def to_master_platform_payload_parts(
    *,
    encounter_id: str,
    session_id: UUID,
    segments: Sequence[TranscriptSegment],
) -> MasterTranscriptDeliveryRequest:
    return MasterTranscriptDeliveryRequest(
        encounter_id=encounter_id,
        scribe_session_id=session_id,
        duration_seconds=(max(segment.end_ms for segment in segments) + 999) // 1000,
        segments=[
            MasterTranscriptSegment(
                speaker=ROLE_LABELS[segment.speaker_role],
                content=segment.content,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
            )
            for segment in segments
        ],
    )


def to_legacy_payload(session: CaptureSession, transcript: Transcript) -> LegacyTranscriptPayload:
    return LegacyTranscriptPayload(
        doctor_id=session.practitioner_id,
        appointment_id=session.appointment_id,
        patient_id=session.patient_id,
        duration=max(segment.end_ms for segment in transcript.segments) // 1000,
        transcript_data=[
            LegacyTranscriptEntry(
                speaker=ROLE_LABELS[segment.speaker_role],
                content=segment.content,
                startTime=segment.start_ms,
                endTime=segment.end_ms,
            )
            for segment in transcript.segments
        ],
    )
