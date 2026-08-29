from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from cosmaneura_scribe.beta_ingest_store import BetaIngestStore
from cosmaneura_scribe.beta_preview_host import (
    LOCAL_BETA_TENANT_ID,
    create_beta_preview_app,
)
from cosmaneura_scribe.settings import Settings
from fastapi.testclient import TestClient

_INGESTS_PATH = "/api/beta/ingests"


def _headers(
    *,
    tenant_id: UUID = LOCAL_BETA_TENANT_ID,
    idempotency_key: str | None = None,
) -> dict[str, str]:
    headers = {"X-Tenant-ID": str(tenant_id)}
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key
    return headers


def test_persisted_synthetic_ingest_can_be_listed_and_previewed() -> None:
    ingest_id = UUID("11111111-1111-4111-8111-111111111111")
    created_at = datetime(2026, 8, 29, 16, 30, tzinfo=UTC)
    store = BetaIngestStore(clock=lambda: created_at, id_factory=lambda: ingest_id)

    with TestClient(create_beta_preview_app(enabled=True, store=store)) as client:
        empty = client.get(_INGESTS_PATH, headers=_headers())
        created = client.post(
            _INGESTS_PATH,
            headers=_headers(idempotency_key="founder-path-001"),
            json={"include_transcript": True},
        )
        listed = client.get(_INGESTS_PATH, headers=_headers())
        preview = client.get(f"{_INGESTS_PATH}/{ingest_id}", headers=_headers())

    assert empty.status_code == 200
    assert empty.json() == {"ingests": []}
    assert created.status_code == 201
    assert created.headers["location"] == f"{_INGESTS_PATH}/{ingest_id}"
    assert created.json()["id"] == str(ingest_id)
    assert created.json()["status"] == "ready_for_review"
    assert len(created.json()["transcript"]["segments"]) == 3
    assert listed.status_code == 200
    assert listed.json()["ingests"] == [created.json()]
    assert preview.status_code == 200
    assert preview.json() == created.json()
    assert preview.headers["cache-control"] == "no-store"
    assert store.get(tenant_id=LOCAL_BETA_TENANT_ID, ingest_id=ingest_id) is not None
    assert [
        event.action for event in store.audit_events_for_tenant(tenant_id=LOCAL_BETA_TENANT_ID)
    ] == ["beta_preview.synthetic_ingest_created"]


def test_preview_returns_404_for_missing_and_cross_tenant_reads() -> None:
    store = BetaIngestStore()
    with TestClient(create_beta_preview_app(enabled=True, store=store)) as client:
        created = client.post(
            _INGESTS_PATH,
            headers=_headers(idempotency_key="tenant-isolation-001"),
            json={"include_transcript": True},
        )
        ingest_id = created.json()["id"]

        missing = client.get(f"{_INGESTS_PATH}/{uuid4()}", headers=_headers())
        malformed = client.get(f"{_INGESTS_PATH}/missing-id", headers=_headers())
        cross_tenant = client.get(
            f"{_INGESTS_PATH}/{ingest_id}",
            headers=_headers(tenant_id=uuid4()),
        )
        missing_tenant = client.get(f"{_INGESTS_PATH}/{ingest_id}")

    for response in (missing, malformed, cross_tenant, missing_tenant):
        assert response.status_code == 404
        assert response.json() == {"detail": "Synthetic session was not found."}


def test_idempotency_replays_one_write_and_rejects_changed_payload() -> None:
    store = BetaIngestStore()
    headers = _headers(idempotency_key="same-request-001")
    with TestClient(create_beta_preview_app(enabled=True, store=store)) as client:
        first = client.post(
            _INGESTS_PATH,
            headers=headers,
            json={"include_transcript": False},
        )
        replay = client.post(
            _INGESTS_PATH,
            headers=headers,
            json={"include_transcript": False},
        )
        conflict = client.post(
            _INGESTS_PATH,
            headers=headers,
            json={"include_transcript": True},
        )

    assert first.status_code == 201
    assert first.json()["status"] == "processing"
    assert first.json()["transcript"] is None
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert conflict.status_code == 409
    assert len(store.list_for_tenant(tenant_id=LOCAL_BETA_TENANT_ID)) == 1
    assert len(store.audit_events_for_tenant(tenant_id=LOCAL_BETA_TENANT_ID)) == 1


def test_post_requires_an_idempotency_key() -> None:
    with TestClient(create_beta_preview_app(enabled=True)) as client:
        response = client.post(
            _INGESTS_PATH,
            headers=_headers(),
            json={"include_transcript": True},
        )

    assert response.status_code == 422


def test_configured_preview_latch_is_dark_by_default() -> None:
    assert Settings().beta_preview_host_enabled is False

    with TestClient(create_beta_preview_app(enabled=False)) as client:
        response = client.get(_INGESTS_PATH, headers=_headers())

    assert response.status_code == 404


def test_local_health_is_explicitly_synthetic_and_not_cacheable() -> None:
    with TestClient(create_beta_preview_app(enabled=True)) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mode": "synthetic-local-beta"}
    assert response.headers["cache-control"] == "no-store"
