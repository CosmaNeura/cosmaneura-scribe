from __future__ import annotations

from uuid import uuid4

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
    SyntheticIngestStore,
)
from fastapi.testclient import TestClient


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

    assert response.status_code == 404
    assert response.json() == {"detail": "Synthetic ingest session not found."}
    assert malformed.status_code == 404
    assert malformed.json() == response.json()


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
