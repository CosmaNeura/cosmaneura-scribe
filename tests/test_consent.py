from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from conftest import RepositoryBackend
from cosmaneura_scribe.main import app, get_master_platform_handoff
from cosmaneura_scribe.repository import (
    CaptureLeaseCloseReason,
    CaptureLeaseReceipt,
    CaptureLeaseRecord,
)
from cosmaneura_scribe.schemas import (
    MasterTranscriptDeliveryResponse,
    SessionAudioKey,
    SessionStatus,
)
from fastapi.testclient import TestClient


def headers(tenant_id: object, key: str) -> dict[str, str]:
    return {"X-Tenant-ID": str(tenant_id), "Idempotency-Key": key}


def consent_body(*, consented: bool = True) -> dict[str, object]:
    return {
        "appointment_id": "appointment_01kzy09rxaepjt63rb0pv1256p",
        "practitioner_id": "doctor_01kzy09rx9emh9n9q0p0e6neam",
        "patient_id": "patient_01kzy09rxben2txt3pfy34bn6h",
        "modality": "virtual",
        "participant_regions": ["FL", "OH"],
        "method": "pre_visit_form",
        "all_parties_consented": consented,
        "granted_at": datetime.now(UTC).isoformat(),
    }


def _create_consent(client: TestClient, tenant_id: UUID, key: str) -> dict[str, object]:
    response = client.post(
        "/v1/consents",
        headers=headers(tenant_id, key),
        json=consent_body(),
    )
    assert response.status_code == 201
    return response.json()


def _session_body(consent_id: object) -> dict[str, object]:
    body = consent_body()
    return {
        "appointment_id": body["appointment_id"],
        "practitioner_id": body["practitioner_id"],
        "patient_id": body["patient_id"],
        "consent_record_id": consent_id,
        "modality": body["modality"],
    }


def test_refuses_nonconsenting_record(client: TestClient) -> None:
    response = client.post(
        "/v1/consents",
        headers=headers(uuid4(), "consent-key-0001"),
        json=consent_body(consented=False),
    )
    assert response.status_code == 409


def test_session_requires_matching_consent(client: TestClient) -> None:
    tenant_id = uuid4()
    body = consent_body()
    consent = client.post(
        "/v1/consents", headers=headers(tenant_id, "consent-key-0002"), json=body
    ).json()
    response = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-key-0001"),
        json={
            "appointment_id": "appointment_01kzy0aa32f87qrme1w5jq2f8m",
            "practitioner_id": body["practitioner_id"],
            "patient_id": body["patient_id"],
            "consent_record_id": consent["id"],
            "modality": body["modality"],
        },
    )
    assert response.status_code == 409


def test_consent_revocation_is_tenant_hidden_idempotent_and_closes_capture(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    consent = _create_consent(client, tenant_id, "consent-revoke-create")
    consent_id = UUID(str(consent["id"]))
    session_response = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-before-revoke"),
        json=_session_body(str(consent_id)),
    )
    assert session_response.status_code == 201
    session_id = UUID(session_response.json()["id"])

    async def seed_active_lease() -> CaptureLeaseReceipt | None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.add_session_audio_key(
                tenant_id,
                SessionAudioKey(
                    session_id=session_id,
                    key_version="revocation-test-key",
                    wrapped_dek=base64.urlsafe_b64encode(b"w" * 384).decode(),
                    created_at=datetime.now(UTC),
                ),
            )
            return await store.issue_capture_lease(
                tenant_id,
                session_id,
                lease_id=uuid4(),
                receipt_id=uuid4(),
                duration=timedelta(minutes=15),
            )

    lease_receipt = repository_backend.run(seed_active_lease)
    assert lease_receipt is not None

    capture_before = client.post(
        f"/v1/sessions/{session_id}/chunks/upload-grant",
        headers=headers(tenant_id, "capture-before-revoke"),
        json={"sequence_number": 0, "channel": "microphone"},
    )
    assert capture_before.status_code == 201

    async def make_transcript_ready() -> None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            session = await store.lock_session(tenant_id, session_id)
            assert session is not None
            capturing = session.model_copy(update={"status": SessionStatus.CAPTURING})
            await store.update_session(tenant_id, capturing)
            await store.update_session(
                tenant_id,
                capturing.model_copy(update={"status": SessionStatus.UPLOADED}),
            )

    repository_backend.run(make_transcript_ready)
    transcript_body = {
        "language_code": "en-US",
        "stt_provider": "synthetic",
        "segments": [{
            "speaker_id": "speaker-1",
            "speaker_role": "unknown",
            "content": "Synthetic transcript fixture.",
            "start_ms": 0,
            "end_ms": 1000,
        }],
    }
    transcript_before = client.post(
        f"/v1/sessions/{session_id}/transcript",
        headers=headers(tenant_id, "transcript-before-revoke"),
        json=transcript_body,
    )
    assert transcript_before.status_code == 201

    class Handoff:
        async def deliver(self, *_: object, **__: object) -> MasterTranscriptDeliveryResponse:
            return MasterTranscriptDeliveryResponse(
                schema_version="1.0",
                transcript_id="ai_visit_transcript_revocation_test",
                disposition="created",
            )

    app.dependency_overrides[get_master_platform_handoff] = lambda: Handoff()
    delivered_before = client.post(
        f"/v1/sessions/{session_id}/deliver",
        headers=headers(tenant_id, "delivery-before-revoke"),
    )
    assert delivered_before.status_code == 200
    url = f"/v1/consents/{consent_id}/revocations"

    hidden = client.post(url, headers=headers(other_tenant_id, "revoke-other-tenant"))
    first = client.post(url, headers=headers(tenant_id, "revoke-consent-key"))
    same_key = client.post(url, headers=headers(tenant_id, "revoke-consent-key"))
    different_key = client.post(url, headers=headers(tenant_id, "revoke-consent-new-key"))

    assert hidden.status_code == 404
    assert first.status_code == 200
    assert first.json()["revoked_at"] is not None
    assert same_key.json() == first.json()
    assert different_key.json() == first.json()

    revocation_events = [
        event
        for event in repository_backend.audit_events(tenant_id)
        if event["action"] == "consent.revoked"
    ]
    assert len(revocation_events) == 1
    assert set(revocation_events[0]) == {
        "tenant_id",
        "action",
        "entity_type",
        "entity_id",
        "occurred_at",
    }

    async def persisted_lease() -> CaptureLeaseRecord | None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            return await store.get_capture_lease(tenant_id, session_id)

    lease = repository_backend.run(persisted_lease)
    assert lease is not None
    assert lease.closed_at is not None
    assert lease.close_reason == CaptureLeaseCloseReason.CONSENT_REVOKED

    blocked_session = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-after-revoke"),
        json=_session_body(str(consent_id)),
    )
    blocked_capture = client.post(
        f"/v1/sessions/{session_id}/chunks/upload-grant",
        headers=headers(tenant_id, "capture-after-revoke"),
        json={"sequence_number": 1, "channel": "microphone"},
    )
    blocked_transcript = client.post(
        f"/v1/sessions/{session_id}/transcript",
        headers=headers(tenant_id, "transcript-after-revoke"),
        json=transcript_body,
    )
    blocked_delivery = client.post(
        f"/v1/sessions/{session_id}/deliver",
        headers=headers(tenant_id, "delivery-after-revoke"),
    )
    for blocked in (
        blocked_session,
        blocked_capture,
        blocked_transcript,
        blocked_delivery,
    ):
        assert blocked.status_code == 409
        assert blocked.json() == {"detail": "The consent record is not valid for capture."}
