from __future__ import annotations

import json
import traceback
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from azure.core.credentials import AccessToken
from cosmaneura_scribe.external_transcript_v1 import (
    EnglishWorkingTranscriptSegmentV1,
    EnglishWorkingTranscriptV1,
    SourceLocale,
    WorkingSegmentResolution,
    WorkingTranscriptBlockerCode,
    WorkingTranscriptBlockerV1,
)
from cosmaneura_scribe.handoff import (
    HandoffRetryableError,
    HttpMasterPlatformHandoff,
    to_master_platform_payload_from_working_transcript,
)
from cosmaneura_scribe.schemas import (
    MasterTranscriptDeliveryRequest,
    MasterTranscriptSegment,
    SpeakerRole,
)


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


def _working_transcript(*, note_ready: bool) -> EnglishWorkingTranscriptV1:
    spanish_segment_id = uuid4()
    return EnglishWorkingTranscriptV1(
        working_transcript_id=uuid4(),
        working_transcript_version=3,
        source_transcript_version=1,
        segments=(
            EnglishWorkingTranscriptSegmentV1(
                source_segment_id=uuid4(),
                source_segment_version=1,
                source_locale=SourceLocale.ENGLISH_US,
                speaker_id=uuid4(),
                speaker_role=SpeakerRole.CLINICIAN,
                start_ms=0,
                end_ms=900,
                resolution=WorkingSegmentResolution.ENGLISH_SOURCE,
                content="Synthetic English clinician statement.",
            ),
            EnglishWorkingTranscriptSegmentV1(
                source_segment_id=spanish_segment_id,
                source_segment_version=1,
                source_locale=SourceLocale.SPANISH_US,
                speaker_id=uuid4(),
                speaker_role=SpeakerRole.PATIENT,
                start_ms=1000,
                end_ms=2100,
                resolution=(
                    WorkingSegmentResolution.SPANISH_TRANSLATION
                    if note_ready
                    else WorkingSegmentResolution.UNRESOLVED
                ),
                content="Synthetic English patient statement." if note_ready else None,
                translation_id=uuid4() if note_ready else None,
                translation_version=1 if note_ready else None,
                translation_review_id=uuid4() if note_ready else None,
            ),
        ),
        blockers=(
            ()
            if note_ready
            else (
                WorkingTranscriptBlockerV1(
                    source_segment_id=spanish_segment_id,
                    code=WorkingTranscriptBlockerCode.TRANSLATION_MISSING,
                ),
            )
        ),
    )


def test_note_ready_working_transcript_maps_to_existing_english_handoff() -> None:
    session_id = uuid4()

    payload = to_master_platform_payload_from_working_transcript(
        encounter_id="appointment_synthetic_beta_01",
        session_id=session_id,
        working_transcript=_working_transcript(note_ready=True),
    )

    assert payload.scribe_session_id == session_id
    assert payload.duration_seconds == 3
    assert [(segment.speaker, segment.content) for segment in payload.segments] == [
        ("Doctor", "Synthetic English clinician statement."),
        ("Patient", "Synthetic English patient statement."),
    ]


def test_unreviewed_working_transcript_cannot_enter_note_handoff() -> None:
    with pytest.raises(ValueError, match="working_transcript_not_note_ready"):
        to_master_platform_payload_from_working_transcript(
            encounter_id="appointment_synthetic_beta_01",
            session_id=uuid4(),
            working_transcript=_working_transcript(note_ready=False),
        )


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


@pytest.mark.parametrize("status_code", [200, 201])
@pytest.mark.asyncio
async def test_http_handoff_sanitizes_invalid_success_responses(
    status_code: int,
) -> None:
    credential = StaticCredential()
    sensitive = "synthetic-leak-marker"

    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(status_code, json={"unexpected_detail": sensitive})

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
            await handoff.deliver(_payload(), idempotency_key="stable-key-4000")

    rendered_traceback = "".join(
        traceback.format_exception(type(caught.value), caught.value, caught.value.__traceback__)
    )
    assert caught.value.code == "invalid_platform_response"
    assert str(caught.value) == "invalid_platform_response"
    assert sensitive not in rendered_traceback
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__
