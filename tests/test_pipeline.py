from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from cosmaneura_scribe.handoff import HandoffRetryableError
from cosmaneura_scribe.main import app, get_master_platform_handoff
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.schemas import (
    MasterTranscriptDeliveryRequest,
    MasterTranscriptDeliveryResponse,
)
from fastapi.testclient import TestClient


def headers(tenant_id: object, key: str) -> dict[str, str]:
    return {"X-Tenant-ID": str(tenant_id), "Idempotency-Key": key}


def create_session(
    client: TestClient, tenant_id: object
) -> tuple[dict[str, object], dict[str, object]]:
    identity = {
        "appointment_id": "appointment_01kzy09rxaepjt63rb0pv1256p",
        "practitioner_id": "doctor_01kzy09rx9emh9n9q0p0e6neam",
        "patient_id": "patient_01kzy09rxben2txt3pfy34bn6h",
        "modality": "virtual",
    }
    consent = client.post(
        "/v1/consents",
        headers=headers(tenant_id, "consent-key-1000"),
        json={
            **identity,
            "participant_regions": ["FL", "OH"],
            "method": "pre_visit_form",
            "all_parties_consented": True,
            "granted_at": datetime.now(UTC).isoformat(),
        },
    ).json()
    session = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-key-1000"),
        json={**identity, "consent_record_id": consent["id"]},
    ).json()
    return identity, session


class RecordingHandoff:
    def __init__(self, *, failures: int = 0) -> None:
        self.failures = failures
        self.requests: list[MasterTranscriptDeliveryRequest] = []
        self.idempotency_keys: list[str] = []

    async def deliver(
        self,
        payload: MasterTranscriptDeliveryRequest,
        *,
        idempotency_key: str,
    ) -> MasterTranscriptDeliveryResponse:
        self.requests.append(payload)
        self.idempotency_keys.append(idempotency_key)
        if self.failures:
            self.failures -= 1
            raise HandoffRetryableError("platform_http_503")
        return MasterTranscriptDeliveryResponse(
            schema_version="1.0",
            transcript_id="ai_visit_transcript_01kzy0c3m3e74q9s19kgjhrjra",
            disposition="created",
        )

    async def close(self) -> None:
        return None


@pytest.fixture
def handoff_client(client: TestClient) -> tuple[TestClient, RecordingHandoff]:
    handoff = RecordingHandoff()
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    return client, handoff


def create_ready_transcript(
    client: TestClient, tenant_id: object
) -> tuple[dict[str, object], dict[str, object]]:
    identity, session = create_session(client, tenant_id)
    grant = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "delivery-grant-key-1000"),
        json={"sequence_number": 0, "channel": "microphone"},
    ).json()
    client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "delivery-chunk-key-1000"),
        json={
            "sequence_number": 0,
            "channel": "microphone",
            "object_id": grant["object_id"],
            "sha256": "b" * 64,
            "ciphertext_size_bytes": 4096,
        },
    )
    client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=headers(tenant_id, "delivery-complete-key-1000"),
    )
    transcript = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, "delivery-transcript-key-1000"),
        json={
            "language_code": "en-US",
            "stt_provider": "test_adapter",
            "segments": [
                {
                    "speaker_id": "channel-mic",
                    "speaker_role": "clinician",
                    "content": "Synthetic contract fixture.",
                    "start_ms": 0,
                    "end_ms": 1200,
                }
            ],
        },
    )
    assert transcript.status_code == 201
    return identity, session


def test_consent_gated_pipeline_and_legacy_handoff(
    client: TestClient, repository: InMemoryRepository
) -> None:
    tenant_id = uuid4()
    identity, session = create_session(client, tenant_id)
    grant = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "grant-key-1000"),
        json={"sequence_number": 0, "channel": "microphone"},
    ).json()
    chunk_body = {
        "sequence_number": 0,
        "channel": "microphone",
        "object_id": grant["object_id"],
        "sha256": "a" * 64,
        "ciphertext_size_bytes": 4096,
    }
    first_chunk = client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "chunk-key-1000"),
        json=chunk_body,
    )
    replay = client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "chunk-key-1000"),
        json=chunk_body,
    )
    assert replay.json()["id"] == first_chunk.json()["id"]

    complete = client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=headers(tenant_id, "complete-key-1000"),
    )
    assert complete.json()["status"] == "uploaded"

    transcript_body = {
        "language_code": "en-US",
        "stt_provider": "azure_speech",
        "segments": [
            {
                "speaker_id": "channel-mic",
                "speaker_role": "clinician",
                "content": "How have you been feeling?",
                "start_ms": 0,
                "end_ms": 1200,
                "confidence": 0.97,
            },
            {
                "speaker_id": "channel-system",
                "speaker_role": "patient",
                "content": "Much better this week.",
                "start_ms": 1400,
                "end_ms": 2900,
                "confidence": 0.95,
            },
        ],
    }
    transcript = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, "transcript-key-1000"),
        json=transcript_body,
    )
    assert transcript.status_code == 201

    handoff = client.post(
        f"/v1/sessions/{session['id']}/handoff",
        headers=headers(tenant_id, "handoff-key-1000"),
    )
    payload = handoff.json()
    assert payload["doctor_id"] == identity["practitioner_id"]
    assert payload["transcript_data"][0] == {
        "speaker": "Doctor",
        "content": "How have you been feeling?",
        "startTime": 0,
        "endTime": 1200,
    }
    assert payload["transcript_data"][1]["speaker"] == "Patient"
    assert all(not hasattr(event, "content") for event in repository.audit_events)


def test_upload_grant_is_short_lived_idempotent_and_metadata_only(
    client: TestClient, repository: InMemoryRepository
) -> None:
    tenant_id = uuid4()
    _, session = create_session(client, tenant_id)
    request = {"sequence_number": 0, "channel": "microphone"}

    first = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "grant-key-1000"),
        json=request,
    )
    replay = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "grant-key-1000"),
        json=request,
    )

    assert first.status_code == 201
    assert replay.json() == first.json()
    assert first.json()["upload_url"].startswith("https://storage.invalid/")
    assert [event.action for event in repository.audit_events].count(
        "audio_upload_grant.issued"
    ) == 1
    assert all(not hasattr(event, "upload_url") for event in repository.audit_events)


def test_tenant_isolation_hides_session(client: TestClient) -> None:
    owner_tenant = uuid4()
    _, session = create_session(client, owner_tenant)
    response = client.get(
        f"/v1/sessions/{session['id']}/transcript",
        headers={"X-Tenant-ID": str(uuid4())},
    )
    assert response.status_code == 404


def test_session_cannot_complete_without_audio(client: TestClient) -> None:
    tenant_id = uuid4()
    _, session = create_session(client, tenant_id)
    response = client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=headers(tenant_id, "complete-key-2000"),
    )
    assert response.status_code == 409


def test_audio_registration_must_match_an_issued_grant(client: TestClient) -> None:
    tenant_id = uuid4()
    _, session = create_session(client, tenant_id)
    response = client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "chunk-key-unguarded"),
        json={
            "sequence_number": 0,
            "channel": "microphone",
            "object_id": str(uuid4()),
            "sha256": "a" * 64,
            "ciphertext_size_bytes": 4096,
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "Audio object does not have an upload grant."


def test_readiness_reports_repository_health(client: TestClient) -> None:
    response = client.get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_idempotency_key_rejects_a_different_request(client: TestClient) -> None:
    tenant_id = uuid4()
    first = {
        "appointment_id": "appointment-idempotency",
        "practitioner_id": "practitioner-idempotency",
        "patient_id": "patient-idempotency",
        "modality": "virtual",
        "participant_regions": ["FL"],
        "method": "pre_visit_form",
        "all_parties_consented": True,
        "granted_at": datetime.now(UTC).isoformat(),
    }
    request_headers = headers(tenant_id, "consent-conflict-1000")

    assert client.post("/v1/consents", headers=request_headers, json=first).status_code == 201
    conflict = client.post(
        "/v1/consents",
        headers=request_headers,
        json={**first, "appointment_id": "appointment-changed"},
    )

    assert conflict.status_code == 409
    assert conflict.json()["detail"] == (
        "Idempotency-Key was already used with a different request."
    )


def test_master_platform_delivery_is_source_agnostic_and_idempotent(
    handoff_client: tuple[TestClient, RecordingHandoff],
    repository: InMemoryRepository,
) -> None:
    client, handoff = handoff_client
    tenant_id = uuid4()
    identity, session = create_ready_transcript(client, tenant_id)
    url = f"/v1/sessions/{session['id']}/deliver"
    request_headers = headers(tenant_id, "master-delivery-key-1000")

    first = client.post(url, headers=request_headers)
    replay = client.post(url, headers=request_headers)

    assert first.status_code == 200
    assert first.json()["status"] == "delivered"
    assert first.json()["attempt_count"] == 1
    assert replay.json() == first.json()
    assert len(handoff.requests) == 1
    outbound = handoff.requests[0].model_dump(mode="json")
    assert outbound["encounter_id"] == identity["appointment_id"]
    assert outbound["scribe_session_id"] == session["id"]
    assert outbound["segments"][0]["speaker"] == "Doctor"
    assert "practitioner_id" not in outbound
    assert "patient_id" not in outbound
    assert "scheduling_provider" not in outbound
    assert handoff.idempotency_keys == [f"scribe-{session['id']}-v1"]
    assert [event.action for event in repository.audit_events].count(
        "transcript.delivery_attempted"
    ) == 1
    assert [event.action for event in repository.audit_events].count("transcript.delivered") == 1


def test_retryable_delivery_records_failure_and_reuses_outbound_key(
    client: TestClient,
    repository: InMemoryRepository,
) -> None:
    handoff = RecordingHandoff(failures=1)
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    tenant_id = uuid4()
    _, session = create_ready_transcript(client, tenant_id)
    url = f"/v1/sessions/{session['id']}/deliver"
    request_headers = headers(tenant_id, "master-delivery-retry-1000")

    first = client.post(url, headers=request_headers)
    retry = client.post(url, headers=request_headers)

    assert first.status_code == 503
    assert first.json()["status"] == "retryable"
    assert first.json()["last_error_code"] == "platform_http_503"
    assert retry.status_code == 200
    assert retry.json()["status"] == "delivered"
    assert retry.json()["attempt_count"] == 2
    assert len(set(handoff.idempotency_keys)) == 1
    persisted = next(iter(repository.deliveries.values()))
    assert persisted.status == "delivered"
    assert persisted.attempt_count == 2
    assert [event.action for event in repository.audit_events].count(
        "transcript.delivery_retryable"
    ) == 1
