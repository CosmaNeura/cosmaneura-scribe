from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from conftest import RepositoryBackend
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


def _create_consent(client: TestClient, tenant_id: object, key: str) -> dict[str, object]:
    response = client.post(
        "/v1/consents",
        headers=headers(tenant_id, key),
        json=consent_body(),
    )
    assert response.status_code == 201
    return response.json()


def _session_body(consent_id: object, *, ingest_mode: str | None = None) -> dict[str, object]:
    body: dict[str, object] = {
        "appointment_id": "appointment_01kzy09rxaepjt63rb0pv1256p",
        "practitioner_id": "doctor_01kzy09rx9emh9n9q0p0e6neam",
        "patient_id": "patient_01kzy09rxben2txt3pfy34bn6h",
        "consent_record_id": consent_id,
        "modality": "virtual",
    }
    if ingest_mode is not None:
        body["ingest_mode"] = ingest_mode
    return body


def _transcript_body() -> dict[str, object]:
    return {
        "language_code": "en-US",
        "stt_provider": "external_async",
        "segments": [
            {
                "speaker_id": "speaker-1",
                "speaker_role": "unknown",
                "content": "Synthetic transcript fixture.",
                "start_ms": 0,
                "end_ms": 1000,
            }
        ],
    }


def test_default_ingest_mode_preserves_legacy_fingerprint_and_transition(
    client: TestClient,
) -> None:
    tenant_id = uuid4()
    consent = _create_consent(client, tenant_id, "consent-default-mode")
    session_url = "/v1/sessions"
    request_headers = headers(tenant_id, "session-default-mode")

    created = client.post(
        session_url,
        headers=request_headers,
        json=_session_body(consent["id"]),
    )
    replay = client.post(
        session_url,
        headers=request_headers,
        json=_session_body(consent["id"], ingest_mode="chunk_upload"),
    )

    assert created.status_code == 201
    assert created.json()["ingest_mode"] == "chunk_upload"
    assert replay.status_code == 201
    assert replay.json()["id"] == created.json()["id"]
    rejected = client.post(
        f"/v1/sessions/{created.json()['id']}/transcript",
        headers=headers(tenant_id, "transcript-default-mode"),
        json=_transcript_body(),
    )
    assert rejected.status_code == 409


def test_external_async_transcript_mode_accepts_only_consent_gated_transcript_path(
    client: TestClient,
) -> None:
    tenant_id = uuid4()
    consent = _create_consent(client, tenant_id, "consent-external-mode")
    created = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-external-mode"),
        json=_session_body(consent["id"], ingest_mode="external_async_transcript"),
    )

    assert created.status_code == 201
    session = created.json()
    assert session["ingest_mode"] == "external_async_transcript"
    chunk_grant = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "grant-external-mode"),
        json={"sequence_number": 0, "channel": "microphone"},
    )
    assert chunk_grant.status_code == 409

    transcript = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, "transcript-external-mode"),
        json=_transcript_body(),
    )
    assert transcript.status_code == 201
    assert transcript.json()["session_id"] == session["id"]


def test_consent_revocation_is_tenant_scoped_idempotent_and_audited_once(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    consent = _create_consent(client, tenant_id, "consent-to-revoke")
    session = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-before-revoke"),
        json=_session_body(consent["id"], ingest_mode="external_async_transcript"),
    ).json()
    url = f"/v1/consents/{consent['id']}/revocations"

    denied = client.post(url, headers=headers(other_tenant_id, "revoke-other-tenant"))
    first = client.post(url, headers=headers(tenant_id, "revoke-consent-key"))
    replay = client.post(url, headers=headers(tenant_id, "revoke-consent-key"))
    domain_replay = client.post(url, headers=headers(tenant_id, "revoke-consent-new-key"))

    assert denied.status_code == 404
    assert first.status_code == 200
    assert first.json()["revoked_at"] is not None
    assert replay.json() == first.json()
    assert domain_replay.json() == first.json()
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

    blocked_session = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-after-revoke"),
        json=_session_body(consent["id"], ingest_mode="external_async_transcript"),
    )
    blocked_transcript = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, "transcript-after-revoke"),
        json=_transcript_body(),
    )
    assert blocked_session.status_code == 409
    assert blocked_transcript.status_code == 409
