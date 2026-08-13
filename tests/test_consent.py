from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from fastapi.testclient import TestClient


def headers(tenant_id: object, key: str) -> dict[str, str]:
    return {"X-Tenant-ID": str(tenant_id), "Idempotency-Key": key}


def consent_body(*, consented: bool = True) -> dict[str, object]:
    return {
        "appointment_id": str(uuid4()),
        "practitioner_id": str(uuid4()),
        "patient_id": str(uuid4()),
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
            "appointment_id": str(uuid4()),
            "practitioner_id": body["practitioner_id"],
            "patient_id": body["patient_id"],
            "consent_record_id": consent["id"],
            "modality": body["modality"],
        },
    )
    assert response.status_code == 409
