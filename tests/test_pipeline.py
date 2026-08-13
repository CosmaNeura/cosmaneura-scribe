from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from cosmaneura_scribe.repository import InMemoryRepository
from fastapi.testclient import TestClient


def headers(tenant_id: object, key: str) -> dict[str, str]:
    return {"X-Tenant-ID": str(tenant_id), "Idempotency-Key": key}


def create_session(
    client: TestClient, tenant_id: object
) -> tuple[dict[str, object], dict[str, object]]:
    identity = {
        "appointment_id": str(uuid4()),
        "practitioner_id": str(uuid4()),
        "patient_id": str(uuid4()),
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


def test_consent_gated_pipeline_and_legacy_handoff(
    client: TestClient, repository: InMemoryRepository
) -> None:
    tenant_id = uuid4()
    identity, session = create_session(client, tenant_id)
    chunk_body = {
        "sequence_number": 0,
        "channel": "microphone",
        "object_id": str(uuid4()),
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
