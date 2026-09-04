from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from azure.core.credentials import AccessToken
from cosmaneura_scribe.handoff import (
    DisabledMasterPlatformHandoff,
    HandoffConflictError,
    HandoffDisabledError,
    HandoffRejectedError,
    HandoffRetryableError,
    HttpMasterPlatformHandoff,
    to_legacy_payload,
    to_master_platform_payload,
)
from cosmaneura_scribe.schemas import (
    CaptureModality,
    CaptureSession,
    MasterTranscriptDeliveryRequest,
    MasterTranscriptSegment,
    SpeakerRole,
    Transcript,
    TranscriptSegment,
)
from cosmaneura_scribe.session_state_v1 import SessionStatus


class StaticCredential:
    def __init__(self) -> None:
        self.scopes: list[str] = []
        self.closed = False

    async def get_token(self, *scopes: str, **kwargs: object) -> AccessToken:
        del kwargs
        self.scopes.extend(scopes)
        return AccessToken("test-access-token", int(datetime.now(UTC).timestamp()) + 300)

    async def close(self) -> None:
        self.closed = True


def _payload() -> MasterTranscriptDeliveryRequest:
    return MasterTranscriptDeliveryRequest(
        encounter_id="appointment_01kzy09rxaepjt63rb0pv1256p",
        scribe_session_id=uuid4(),
        duration_seconds=2,
        segments=[
            MasterTranscriptSegment(
                speaker="Doctor",
                content="Synthetic fixture.",
                start_ms=0,
                end_ms=1200,
            )
        ],
    )


def _session() -> CaptureSession:
    return CaptureSession(
        id=uuid4(),
        appointment_id="appointment_01kzy09rxaepjt63rb0pv1256p",
        practitioner_id="practitioner_01kzy09rxaepjt63rb0pv1257q",
        patient_id="patient_01kzy09rxaepjt63rb0pv1258r",
        consent_record_id=uuid4(),
        modality=CaptureModality.VIRTUAL,
        status=SessionStatus.TRANSCRIPT_READY,
        created_at=datetime.now(UTC),
    )


def _transcript(*roles: SpeakerRole) -> Transcript:
    return Transcript(
        id=uuid4(),
        session_id=uuid4(),
        created_at=datetime.now(UTC),
        stt_provider="synthetic",
        segments=[
            TranscriptSegment(
                content=f"Synthetic fixture {index}.",
                start_ms=index * 1000,
                end_ms=index * 1000 + 1200,
                speaker_id=f"channel-0-speaker-{index}",
                speaker_role=role,
            )
            for index, role in enumerate(roles)
        ],
    )


async def _deliver_against(response: httpx.Response) -> None:
    credential = StaticCredential()

    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return response

    async with httpx.AsyncClient(
        base_url="https://platform.internal.example",
        transport=httpx.MockTransport(handler),
    ) as client:
        handoff = HttpMasterPlatformHandoff(
            base_url="https://platform.internal.example",
            scope="api://platform/.default",
            timeout_seconds=5,
            credential=credential,  # type: ignore[arg-type]
            client=client,
        )
        await handoff.deliver(_payload(), idempotency_key="stable-key-4000")


@pytest.mark.asyncio
async def test_http_handoff_uses_entra_default_scope_and_stable_key() -> None:
    credential = StaticCredential()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            201,
            json={
                "schema_version": "1.0",
                "transcript_id": "ai_visit_transcript_01kzy0c3m3e74q9s19kgjhrjra",
                "disposition": "created",
            },
        )

    async with httpx.AsyncClient(
        base_url="https://platform.internal.example",
        transport=httpx.MockTransport(handler),
    ) as client:
        handoff = HttpMasterPlatformHandoff(
            base_url="https://platform.internal.example",
            scope="api://platform/.default",
            timeout_seconds=5,
            credential=credential,  # type: ignore[arg-type]
            client=client,
        )
        result = await handoff.deliver(_payload(), idempotency_key="stable-key-1000")
        await handoff.close()

    assert result.disposition == "created"
    assert credential.scopes == ["api://platform/.default"]
    assert credential.closed
    assert len(seen) == 1
    assert seen[0].url.path == "/service/v1/scribe/transcripts"
    assert seen[0].headers["authorization"] == "Bearer test-access-token"
    assert seen[0].headers["idempotency-key"] == "stable-key-1000"
    body = json.loads(seen[0].content)
    assert set(body) == {
        "schema_version",
        "encounter_id",
        "scribe_session_id",
        "duration_seconds",
        "segments",
    }


@pytest.mark.asyncio
async def test_http_handoff_classifies_platform_unavailability_without_body() -> None:
    credential = StaticCredential()

    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(503, text="must not appear in the exception")

    async with httpx.AsyncClient(
        base_url="https://platform.internal.example",
        transport=httpx.MockTransport(handler),
    ) as client:
        handoff = HttpMasterPlatformHandoff(
            base_url="https://platform.internal.example",
            scope="api://platform/.default",
            timeout_seconds=5,
            credential=credential,  # type: ignore[arg-type]
            client=client,
        )
        with pytest.raises(HandoffRetryableError) as caught:
            await handoff.deliver(_payload(), idempotency_key="stable-key-2000")

    assert caught.value.code == "platform_http_503"
    assert "must not appear" not in str(caught.value)


@pytest.mark.asyncio
async def test_http_handoff_sanitizes_protocol_errors() -> None:
    credential = StaticCredential()
    sensitive = "protocol-detail-must-not-escape"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError(sensitive, request=request)

    async with httpx.AsyncClient(
        base_url="https://platform.internal.example",
        transport=httpx.MockTransport(handler),
    ) as client:
        handoff = HttpMasterPlatformHandoff(
            base_url="https://platform.internal.example",
            scope="api://platform/.default",
            timeout_seconds=5,
            credential=credential,  # type: ignore[arg-type]
            client=client,
        )
        with pytest.raises(HandoffRetryableError) as caught:
            await handoff.deliver(_payload(), idempotency_key="stable-key-3000")

    assert caught.value.code == "transport_unavailable"
    assert str(caught.value) == "transport_unavailable"
    assert sensitive not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__


@pytest.mark.asyncio
async def test_http_handoff_maps_platform_conflict_to_its_own_class() -> None:
    with pytest.raises(HandoffConflictError) as caught:
        await _deliver_against(httpx.Response(409, text="must not appear in the exception"))

    assert caught.value.code == "platform_conflict"
    assert "must not appear" not in str(caught.value)


@pytest.mark.asyncio
async def test_http_handoff_rejects_client_errors_without_retry() -> None:
    for status_code in (400, 401, 403, 404, 422):
        with pytest.raises(HandoffRejectedError) as caught:
            await _deliver_against(httpx.Response(status_code, text="rejection detail"))

        assert caught.value.code == f"platform_http_{status_code}"
        assert "rejection detail" not in str(caught.value)


@pytest.mark.asyncio
async def test_http_handoff_treats_bounded_transient_statuses_as_retryable() -> None:
    for status_code in (408, 425, 429, 500, 502, 504):
        with pytest.raises(HandoffRetryableError) as caught:
            await _deliver_against(httpx.Response(status_code, text="transient detail"))

        assert caught.value.code == f"platform_http_{status_code}"
        assert "transient detail" not in str(caught.value)


@pytest.mark.asyncio
async def test_http_handoff_treats_unusable_success_body_as_retryable() -> None:
    bodies = ("not-json", '{"schema_version": "1.0"}', '{"disposition": "invented"}')
    for status_code in (200, 201):
        for body in bodies:
            with pytest.raises(HandoffRetryableError) as caught:
                await _deliver_against(httpx.Response(status_code, text=body))

            assert caught.value.code == "invalid_platform_response"


@pytest.mark.asyncio
async def test_disabled_handoff_refuses_delivery_with_a_fixed_code() -> None:
    handoff = DisabledMasterPlatformHandoff()

    with pytest.raises(HandoffDisabledError) as caught:
        await handoff.deliver(_payload(), idempotency_key="stable-key-5000")

    assert caught.value.code == "handoff_disabled"
    assert await handoff.close() is None


def test_master_platform_payload_rounds_duration_up_to_cover_every_segment() -> None:
    transcript = _transcript(SpeakerRole.CLINICIAN, SpeakerRole.PATIENT)

    payload = to_master_platform_payload(_session(), transcript)

    last_segment_end_ms = transcript.segments[-1].end_ms
    assert last_segment_end_ms == 2200
    assert payload.duration_seconds == 3
    assert payload.duration_seconds * 1000 >= last_segment_end_ms


def test_master_platform_payload_maps_every_speaker_role_to_a_platform_label() -> None:
    transcript = _transcript(
        SpeakerRole.CLINICIAN,
        SpeakerRole.PATIENT,
        SpeakerRole.OTHER,
        SpeakerRole.UNKNOWN,
    )

    payload = to_master_platform_payload(_session(), transcript)

    assert [segment.speaker for segment in payload.segments] == [
        "Doctor",
        "Patient",
        "Other",
        "Unknown",
    ]


def test_master_platform_payload_carries_the_session_encounter_and_identifier() -> None:
    session = _session()
    transcript = _transcript(SpeakerRole.CLINICIAN)

    payload = to_master_platform_payload(session, transcript)

    assert payload.encounter_id == session.appointment_id
    assert payload.scribe_session_id == session.id
    body = payload.model_dump(mode="json")
    assert "practitioner_id" not in body
    assert "patient_id" not in body


def test_legacy_payload_truncates_duration_and_keeps_the_existing_entry_shape() -> None:
    session = _session()
    transcript = _transcript(SpeakerRole.CLINICIAN, SpeakerRole.UNKNOWN)

    payload = to_legacy_payload(session, transcript)

    assert payload.duration == 2
    assert payload.doctor_id == session.practitioner_id
    assert payload.appointment_id == session.appointment_id
    assert payload.patient_id == session.patient_id
    assert [entry.model_dump(mode="json") for entry in payload.transcript_data] == [
        {
            "speaker": "Doctor",
            "content": "Synthetic fixture 0.",
            "startTime": 0,
            "endTime": 1200,
        },
        {
            "speaker": "Unknown",
            "content": "Synthetic fixture 1.",
            "startTime": 1000,
            "endTime": 2200,
        },
    ]
