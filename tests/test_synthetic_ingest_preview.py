from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.local_ingest_preview import (
    LOCAL_FIXTURE_SESSION_ID,
    LOCAL_FIXTURE_STATUS,
    LOCAL_FIXTURE_TENANT_ID,
    build_local_ingest_preview_app,
    create_synthetic_ingest,
)
from cosmaneura_scribe.synthetic_ingest import (
    SyntheticIngestConflictError,
    SyntheticIngestSession,
    SyntheticIngestStore,
    persist_synthetic_ingest,
)
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
ATTACH_CONTRACT_PATH = ROOT / "contracts/scribe-ingest-preview-v0.json"


def _load_attach_contract() -> dict[str, Any]:
    return json.loads(ATTACH_CONTRACT_PATH.read_text())


def test_persist_writes_a_tenant_scoped_synthetic_session() -> None:
    store = SyntheticIngestStore()
    tenant_id = uuid4()
    session_id = uuid4()

    persisted = store.persist(
        tenant_id=tenant_id,
        session_id=session_id,
        status="transcript_ready",
        transcript_text="Synthetic test transcript.",
    )

    assert store.get(tenant_id=tenant_id, session_id=session_id) == persisted
    assert (
        store.persist(
            tenant_id=tenant_id,
            session_id=session_id,
            status="transcript_ready",
            transcript_text="Synthetic test transcript.",
        )
        is persisted
    )
    with pytest.raises(SyntheticIngestConflictError):
        store.persist(
            tenant_id=tenant_id,
            session_id=session_id,
            status="failed",
            transcript_text="Synthetic test transcript.",
        )
    assert store.get(tenant_id=tenant_id, session_id=session_id) == persisted
    with pytest.raises(ValueError, match="tenant_id is required"):
        store.persist(
            tenant_id=None,
            session_id=session_id,
            status="transcript_ready",
        )
    with pytest.raises(ValueError, match="session_id is required"):
        store.persist(
            tenant_id=tenant_id,
            session_id=None,
            status="transcript_ready",
        )
    with pytest.raises(ValueError, match="session_id is required"):
        store.get(tenant_id=tenant_id, session_id=None)


def test_preview_returns_the_persisted_session() -> None:
    store = SyntheticIngestStore()
    session_id = uuid4()
    expected = store.persist(
        tenant_id=LOCAL_FIXTURE_TENANT_ID,
        session_id=session_id,
        status=LOCAL_FIXTURE_STATUS,
        transcript_text="Synthetic injected-store transcript.",
    )
    preview_app = build_local_ingest_preview_app(store)

    with TestClient(preview_app) as client:
        response = client.get(
            f"/local/ingest-preview/{expected.id}",
            headers={"X-Tenant-ID": str(expected.tenant_id)},
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "id": str(session_id),
        "tenant_id": str(LOCAL_FIXTURE_TENANT_ID),
        "status": LOCAL_FIXTURE_STATUS,
        "transcript_text": "Synthetic injected-store transcript.",
    }


def test_preview_returns_404_for_a_missing_session() -> None:
    preview_app = build_local_ingest_preview_app(SyntheticIngestStore())

    with TestClient(preview_app) as client:
        response = client.get(
            f"/local/ingest-preview/{uuid4()}",
            headers={"X-Tenant-ID": str(LOCAL_FIXTURE_TENANT_ID)},
        )
        malformed = client.get(
            "/local/ingest-preview/not-a-session-id",
            headers={"X-Tenant-ID": str(LOCAL_FIXTURE_TENANT_ID)},
        )
        missing_session_id = client.get(
            "/local/ingest-preview/",
            headers={"X-Tenant-ID": str(LOCAL_FIXTURE_TENANT_ID)},
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Synthetic ingest session not found."}
    assert malformed.status_code == 404
    assert malformed.json() == response.json()
    assert missing_session_id.status_code == 404


def test_preview_fails_closed_for_a_cross_tenant_read() -> None:
    store = SyntheticIngestStore()
    create_synthetic_ingest(store)
    preview_app = build_local_ingest_preview_app(store)

    with TestClient(preview_app) as client:
        response = client.get(
            f"/local/ingest-preview/{LOCAL_FIXTURE_SESSION_ID}",
            headers={"X-Tenant-ID": str(uuid4())},
        )
        missing_tenant = client.get(
            f"/local/ingest-preview/{LOCAL_FIXTURE_SESSION_ID}",
        )

    assert response.status_code == 404
    assert missing_tenant.status_code == 404
    assert response.json() == {"detail": "Synthetic ingest session not found."}
    assert missing_tenant.json() == response.json()


def test_preview_get_matches_the_frozen_attach_contract() -> None:
    contract = _load_attach_contract()
    attach_schema = contract["attach_request"]
    get_contract = contract["preview_get"]
    success_contract = get_contract["responses"]["200"]
    fixture = contract["fixture"]
    attach_request = fixture["attach_request"]

    assert contract["contract_version"] == "scribe-ingest-preview-v0"
    assert contract["availability"] == "local-only"
    assert set(attach_schema["properties"]) == {
        "session_id",
        "status",
        "transcript_text",
    }
    assert set(attach_schema["required"]) == {"session_id", "status"}
    assert attach_schema["additionalProperties"] is False
    assert "tenant_id" not in attach_schema["properties"]
    assert set(attach_request) == set(attach_schema["properties"])
    assert set(success_contract["body"]["required"]) == {"id", "tenant_id", "status"}
    assert success_contract["body"]["additionalProperties"] is False
    assert set(fixture["get_response"]) == set(success_contract["body"]["properties"])
    assert set(SyntheticIngestSession.model_fields) == set(
        success_contract["body"]["properties"]
    )
    assert {
        field_name
        for field_name, field in SyntheticIngestSession.model_fields.items()
        if field.is_required()
    } == set(success_contract["body"]["required"])

    tenant_id = UUID(fixture["tenant_id"])
    session_id = UUID(attach_request["session_id"])
    store = SyntheticIngestStore()
    persist_synthetic_ingest(
        tenant_id=tenant_id,
        session_id=session_id,
        status=attach_request["status"],
        transcript_text=attach_request.get("transcript_text"),
        store=store,
    )
    preview_app = build_local_ingest_preview_app(store)

    with TestClient(preview_app) as client:
        response = client.request(
            get_contract["method"],
            get_contract["path"].format(session_id=session_id),
            headers={contract["tenant_context"]["name"]: str(tenant_id)},
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == success_contract["headers"]["Cache-Control"]
    assert response.headers["content-type"].split(";", maxsplit=1)[0] == success_contract[
        "content_type"
    ]
    assert response.json() == fixture["get_response"]


def test_preview_omits_the_optional_transcript_from_the_get_body() -> None:
    contract = _load_attach_contract()
    required_fields = set(contract["preview_get"]["responses"]["200"]["body"]["required"])
    store = SyntheticIngestStore()
    session_id = uuid4()
    persisted = persist_synthetic_ingest(
        tenant_id=LOCAL_FIXTURE_TENANT_ID,
        session_id=session_id,
        status=LOCAL_FIXTURE_STATUS,
        store=store,
    )
    preview_app = build_local_ingest_preview_app(store)

    with TestClient(preview_app) as client:
        response = client.get(
            f"/local/ingest-preview/{persisted.id}",
            headers={"X-Tenant-ID": str(persisted.tenant_id)},
        )

    assert response.status_code == 200
    assert set(response.json()) == required_fields
    assert "transcript_text" not in response.json()
