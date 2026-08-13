from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

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
