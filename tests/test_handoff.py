from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from azure.core.credentials import AccessToken
from cosmaneura_scribe.handoff import (
    HandoffRetryableError,
    HttpMasterPlatformHandoff,
)
from cosmaneura_scribe.schemas import (
    MasterTranscriptDeliveryRequest,
    MasterTranscriptSegment,
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
