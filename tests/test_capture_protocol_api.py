from __future__ import annotations

import asyncio
import base64
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.main import app, get_audio_encryption_key_provider
from cosmaneura_scribe.schemas import AudioEncryptionPublicKey, RsaPublicJwk
from cosmaneura_scribe.settings import Settings, get_settings
from fastapi.testclient import TestClient


def _headers(tenant_id: UUID, key: str | None = None) -> dict[str, str]:
    result = {"X-Tenant-ID": str(tenant_id)}
    if key is not None:
        result["Idempotency-Key"] = key
    return result


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class CaptureKeyProvider:
    async def get_public_key(self) -> AudioEncryptionPublicKey:
        return AudioEncryptionPublicKey(
            key_version="capture-key-version",
            public_jwk=RsaPublicJwk(
                n=_base64url(b"\x80" + b"m" * 383),
                e="AQAB",
            ),
        )

    def versioned_key_id(self, key_version: str) -> str | None:
        if key_version != "capture-key-version":
            return None
        return f"https://scribe-test.vault.azure.net/keys/audio/{key_version}"

    async def close(self) -> None:
        return None


@pytest.fixture
def capture_client(client: TestClient) -> TestClient:
    app.dependency_overrides[get_settings] = lambda: Settings(
        capture_protocol_enabled=True,
        repository_backend="postgres",
        database_url="postgresql+asyncpg://test.invalid/capture_test",
        database_ssl=False,
        workflow_authentication_enabled=True,
        entra_tenant_id=UUID("00000000-0000-4000-8000-000000000001"),
        workflow_api_audience="00000000-0000-4000-8000-000000000002",
        trusted_platform_client_id=UUID("00000000-0000-4000-8000-000000000003"),
    )
    app.dependency_overrides[get_audio_encryption_key_provider] = CaptureKeyProvider
    return client


def _create_capture_session(client: TestClient, tenant_id: UUID, suffix: str) -> dict[str, object]:
    identity = {
        "appointment_id": f"appointment-{suffix}",
        "practitioner_id": f"practitioner-{suffix}",
        "patient_id": f"patient-{suffix}",
        "modality": "in_person",
    }
    consent = client.post(
        "/v1/consents",
        headers=_headers(tenant_id, f"consent-{suffix}-0001"),
        json={
            **identity,
            "participant_regions": ["FL"],
            "method": "verbal_attestation",
            "all_parties_consented": True,
            "granted_at": datetime.now(UTC).isoformat(),
        },
    )
    assert consent.status_code == 201
    session = client.post(
        "/v1/sessions",
        headers=_headers(tenant_id, f"session-{suffix}-0001"),
        json={**identity, "consent_record_id": consent.json()["id"]},
    )
    assert session.status_code == 201
    audio_key = client.post(
        f"/v1/sessions/{session.json()['id']}/audio-key",
        headers=_headers(tenant_id, f"audio-key-{suffix}-0001"),
        json={
            "key_version": "capture-key-version",
            "wrapped_dek": _base64url(b"w" * 384),
        },
    )
    assert audio_key.status_code == 201
    return session.json()


def _issue_lease(client: TestClient, tenant_id: UUID, session_id: object, suffix: str) -> dict:
    response = client.post(
        f"/v1/sessions/{session_id}/capture-lease",
        headers=_headers(tenant_id, f"lease-{suffix}-0001"),
        json={"protocol_version": "1.0"},
    )
    assert response.status_code == 201
    return response.json()


def _reserve(
    client: TestClient,
    tenant_id: UUID,
    session_id: object,
    lease: dict,
    *,
    key: str,
    first: int = 0,
    count: int = 1,
) -> dict:
    response = client.post(
        f"/v1/sessions/{session_id}/chunk-reservations",
        headers=_headers(tenant_id, key),
        json={
            "protocol_version": "1.0",
            "capture_lease_id": lease["lease_id"],
            "capture_lease_generation": lease["generation"],
            "channel": "microphone",
            "first_sequence_number": first,
            "count": count,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_capture_protocol_is_disabled_without_touching_capture_rows(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    lease_id = uuid4()
    object_id = uuid4()
    requests = (
        (
            "GET",
            f"/v1/sessions/{session_id}/capture-capabilities",
            None,
        ),
        (
            "POST",
            f"/v1/sessions/{session_id}/capture-lease",
            {"protocol_version": "1.0"},
        ),
        (
            "POST",
            f"/v1/sessions/{session_id}/capture-leases/{lease_id}/renew",
            {"protocol_version": "1.0", "expected_generation": 1},
        ),
        (
            "POST",
            f"/v1/sessions/{session_id}/chunk-reservations",
            {
                "protocol_version": "1.0",
                "capture_lease_id": str(lease_id),
                "capture_lease_generation": 1,
                "channel": "microphone",
                "first_sequence_number": 0,
                "count": 1,
            },
        ),
        (
            "POST",
            f"/v1/sessions/{session_id}/chunks/{object_id}/upload-authorization",
            {"protocol_version": "1.0"},
        ),
        (
            "GET",
            f"/v1/sessions/{session_id}/chunks/{object_id}",
            None,
        ),
        (
            "POST",
            f"/v1/sessions/{session_id}/capture-complete",
            {
                "protocol_version": "1.0",
                "capture_lease_id": str(lease_id),
                "capture_lease_generation": 1,
                "channels": [{"channel": "microphone", "final_sequence_number": 0}],
            },
        ),
    )
    for index, (method, path, body) in enumerate(requests):
        response = client.request(
            method,
            path,
            headers=_headers(tenant_id, f"disabled-capture-{index:04d}"),
            json=body,
        )
        assert response.status_code == 503
        assert response.json() == {"detail": "Capture protocol is disabled."}
    assert repository_backend.audit_events(tenant_id) == []


def test_capabilities_lease_renewal_and_canonical_reservations(
    capture_client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    session = _create_capture_session(capture_client, tenant_id, "contract")
    capability_response = capture_client.get(
        f"/v1/sessions/{session['id']}/capture-capabilities",
        headers=_headers(tenant_id),
    )
    assert capability_response.status_code == 200
    assert capability_response.headers["cache-control"] == "no-store"
    capabilities = capability_response.json()
    assert capabilities["protocol_version"] == "1.0"
    assert capabilities["media"] == {
        "media_type": "audio/wav",
        "encoding": "pcm_s16le",
        "channels": 1,
        "sample_rate_hz": 16000,
    }
    assert capabilities["target_chunk_duration_ms"] == 10_000
    assert capabilities["max_envelope_bytes"] == 327_680
    assert capabilities["max_reservations_per_batch"] == 90

    lease = _issue_lease(capture_client, tenant_id, session["id"], "contract")
    replay = capture_client.post(
        f"/v1/sessions/{session['id']}/capture-lease",
        headers=_headers(tenant_id, "lease-contract-0001"),
        json={"protocol_version": "1.0"},
    )
    assert replay.json() == lease

    renewed = capture_client.post(
        f"/v1/sessions/{session['id']}/capture-leases/{lease['lease_id']}/renew",
        headers=_headers(tenant_id, "renew-contract-0001"),
        json={"protocol_version": "1.0", "expected_generation": 1},
    )
    assert renewed.status_code == 200
    assert renewed.json()["generation"] == 2
    renew_replay = capture_client.post(
        f"/v1/sessions/{session['id']}/capture-leases/{lease['lease_id']}/renew",
        headers=_headers(tenant_id, "renew-contract-0001"),
        json={"protocol_version": "1.0", "expected_generation": 1},
    )
    assert renew_replay.json() == renewed.json()
    lease = renewed.json()

    first = _reserve(
        capture_client,
        tenant_id,
        session["id"],
        lease,
        key="reserve-contract-0001",
        count=2,
    )
    same_key = _reserve(
        capture_client,
        tenant_id,
        session["id"],
        lease,
        key="reserve-contract-0001",
        count=2,
    )
    another_key = _reserve(
        capture_client,
        tenant_id,
        session["id"],
        lease,
        key="reserve-contract-0002",
        count=2,
    )
    assert same_key == first
    assert [row["object_id"] for row in another_key["reservations"]] == [
        row["object_id"] for row in first["reservations"]
    ]
    assert [row["additional_authenticated_data"] for row in another_key["reservations"]] == [
        row["additional_authenticated_data"] for row in first["reservations"]
    ]

    remaining = capture_client.get(
        f"/v1/sessions/{session['id']}/capture-capabilities",
        headers=_headers(tenant_id),
    ).json()["remaining_aggregate_plaintext_bytes"]
    assert remaining == 64 * 1_024 * 1_024 - 2 * 327_680
    actions = repository_backend.audit_actions(tenant_id)
    assert actions.count("capture_lease.issued") == 1
    assert actions.count("capture_lease.renewed") == 1
    assert actions.count("audio_chunk_reservations.created") == 2


def test_upload_refresh_registration_receipt_and_contiguous_completion(
    capture_client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    session = _create_capture_session(capture_client, tenant_id, "upload")
    lease = _issue_lease(capture_client, tenant_id, session["id"], "upload")
    batch = _reserve(
        capture_client,
        tenant_id,
        session["id"],
        lease,
        key="reserve-upload-0001",
        count=2,
    )
    reservation = batch["reservations"][0]
    authorization_url = (
        f"/v1/sessions/{session['id']}/chunks/{reservation['object_id']}"
        "/upload-authorization"
    )
    authorization = capture_client.post(
        authorization_url,
        headers=_headers(tenant_id, "authorize-upload-0001"),
        json={"protocol_version": "1.0"},
    )
    replay = capture_client.post(
        authorization_url,
        headers=_headers(tenant_id, "authorize-upload-0001"),
        json={"protocol_version": "1.0"},
    )
    assert authorization.status_code == 201
    assert authorization.headers["cache-control"] == "no-store"
    assert replay.json() == authorization.json()
    assert authorization.json()["object_id"] == reservation["object_id"]
    assert (
        authorization.json()["additional_authenticated_data"]
        == reservation["additional_authenticated_data"]
    )
    overlapping_authorization = capture_client.post(
        authorization_url,
        headers=_headers(tenant_id, "authorize-upload-0002"),
        json={"protocol_version": "1.0"},
    )
    assert overlapping_authorization.status_code == 409

    registration_body = {
        "sequence_number": 0,
        "channel": "microphone",
        "object_id": reservation["object_id"],
        "sha256": "a" * 64,
        "ciphertext_size_bytes": 320_128,
    }
    registered = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=_headers(tenant_id, "register-upload-0001"),
        json=registration_body,
    )
    assert registered.status_code == 201
    new_key_replay = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=_headers(tenant_id, "register-upload-0002"),
        json=registration_body,
    )
    assert new_key_replay.json() == registered.json()
    changed_body = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=_headers(tenant_id, "register-upload-0001"),
        json={**registration_body, "sha256": "b" * 64},
    )
    assert changed_body.status_code == 409

    receipt = capture_client.get(
        f"/v1/sessions/{session['id']}/chunks/{reservation['object_id']}",
        headers=_headers(tenant_id),
    )
    assert receipt.status_code == 200
    assert receipt.json()["state"] == "registered"
    assert receipt.json()["registration"]["chunk_id"] == registered.json()["id"]
    assert "upload_url" not in receipt.text

    refused = capture_client.post(
        authorization_url,
        headers=_headers(tenant_id, "authorize-upload-0002"),
        json={"protocol_version": "1.0"},
    )
    assert refused.status_code == 409

    completed = capture_client.post(
        f"/v1/sessions/{session['id']}/capture-complete",
        headers=_headers(tenant_id, "complete-upload-0001"),
        json={
            "protocol_version": "1.0",
            "capture_lease_id": lease["lease_id"],
            "capture_lease_generation": lease["generation"],
            "channels": [{"channel": "microphone", "final_sequence_number": 0}],
        },
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "uploaded"
    wrong_lease_replay = capture_client.post(
        f"/v1/sessions/{session['id']}/capture-complete",
        headers=_headers(tenant_id, "complete-upload-0002"),
        json={
            "protocol_version": "1.0",
            "capture_lease_id": str(uuid4()),
            "capture_lease_generation": lease["generation"],
            "channels": [{"channel": "microphone", "final_sequence_number": 0}],
        },
    )
    assert wrong_lease_replay.status_code == 409
    unused_authorization = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks/{batch['reservations'][1]['object_id']}"
        "/upload-authorization",
        headers=_headers(tenant_id, "authorize-unused-0001"),
        json={"protocol_version": "1.0"},
    )
    assert unused_authorization.status_code == 409
    # The unused pre-reserved sequence 1 is a suffix, not a hole in the declared final range.
    replay_after_close = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=_headers(tenant_id, "register-upload-0003"),
        json=registration_body,
    )
    assert replay_after_close.status_code == 201
    assert replay_after_close.json() == registered.json()
    assert repository_backend.audit_actions(tenant_id).count("audio_chunk.registered") == 1


def test_expired_authorization_refresh_keeps_the_reservation_binding(
    capture_client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    session = _create_capture_session(capture_client, tenant_id, "expired-authorization")
    lease = _issue_lease(
        capture_client,
        tenant_id,
        session["id"],
        "expired-authorization",
    )
    batch = _reserve(
        capture_client,
        tenant_id,
        session["id"],
        lease,
        key="reserve-expired-authorization-0001",
    )
    reservation = batch["reservations"][0]
    expired_receipt_id = uuid4()

    async def seed_expired_authorization() -> None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            receipt = await store.add_upload_authorization_receipt(
                tenant_id,
                UUID(str(session["id"])),
                UUID(reservation["object_id"]),
                receipt_id=expired_receipt_id,
                duration=timedelta(milliseconds=250),
            )
            assert receipt is not None
        await asyncio.sleep(0.3)
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert not await store.is_upload_authorization_active(
                tenant_id,
                expired_receipt_id,
            )

    repository_backend.run(seed_expired_authorization)
    refreshed = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks/{reservation['object_id']}"
        "/upload-authorization",
        headers=_headers(tenant_id, "authorize-expired-authorization-0001"),
        json={"protocol_version": "1.0"},
    )

    assert refreshed.status_code == 201
    assert refreshed.json()["object_id"] == reservation["object_id"]
    assert (
        refreshed.json()["additional_authenticated_data"]
        == reservation["additional_authenticated_data"]
    )


def test_protocol_rejects_gaps_cross_tenant_receipts_and_legacy_allocator(
    capture_client: TestClient,
) -> None:
    tenant_id = uuid4()
    session = _create_capture_session(capture_client, tenant_id, "negative")
    lease = _issue_lease(capture_client, tenant_id, session["id"], "negative")
    gap = capture_client.post(
        f"/v1/sessions/{session['id']}/chunk-reservations",
        headers=_headers(tenant_id, "reserve-negative-gap"),
        json={
            "protocol_version": "1.0",
            "capture_lease_id": lease["lease_id"],
            "capture_lease_generation": lease["generation"],
            "channel": "microphone",
            "first_sequence_number": 2,
            "count": 1,
        },
    )
    assert gap.status_code == 409

    batch = _reserve(
        capture_client,
        tenant_id,
        session["id"],
        lease,
        key="reserve-negative-0001",
        count=2,
    )
    object_id = batch["reservations"][0]["object_id"]
    hidden = capture_client.get(
        f"/v1/sessions/{session['id']}/chunks/{object_id}",
        headers=_headers(uuid4()),
    )
    assert hidden.status_code == 404

    legacy = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=_headers(tenant_id, "legacy-negative-0001"),
        json={"sequence_number": 0, "channel": "microphone"},
    )
    assert legacy.status_code == 410

    second = batch["reservations"][1]
    unauthorized_registration = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=_headers(tenant_id, "register-negative-0001"),
        json={
            "sequence_number": 1,
            "channel": "microphone",
            "object_id": second["object_id"],
            "sha256": "c" * 64,
            "ciphertext_size_bytes": 320_128,
        },
    )
    assert unauthorized_registration.status_code == 409
    second_authorization = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks/{second['object_id']}"
        "/upload-authorization",
        headers=_headers(tenant_id, "authorize-negative-0001"),
        json={"protocol_version": "1.0"},
    )
    assert second_authorization.status_code == 201
    registered_second = capture_client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=_headers(tenant_id, "register-negative-0002"),
        json={
            "sequence_number": 1,
            "channel": "microphone",
            "object_id": second["object_id"],
            "sha256": "c" * 64,
            "ciphertext_size_bytes": 320_128,
        },
    )
    assert registered_second.status_code == 201
    noncontiguous = capture_client.post(
        f"/v1/sessions/{session['id']}/capture-complete",
        headers=_headers(tenant_id, "complete-negative-0001"),
        json={
            "protocol_version": "1.0",
            "capture_lease_id": lease["lease_id"],
            "capture_lease_generation": lease["generation"],
            "channels": [{"channel": "microphone", "final_sequence_number": 1}],
        },
    )
    assert noncontiguous.status_code == 409
    legacy_complete = capture_client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=_headers(tenant_id, "legacy-complete-negative"),
    )
    assert legacy_complete.status_code == 410


def test_openapi_declares_the_versioned_capture_surface_and_mutation_headers() -> None:
    document = app.openapi()
    mutation_operations = (
        ("/v1/sessions/{session_id}/capture-lease", "post"),
        ("/v1/sessions/{session_id}/capture-leases/{lease_id}/renew", "post"),
        ("/v1/sessions/{session_id}/chunk-reservations", "post"),
        (
            "/v1/sessions/{session_id}/chunks/{object_id}/upload-authorization",
            "post",
        ),
        ("/v1/sessions/{session_id}/capture-complete", "post"),
    )
    for path, method in mutation_operations:
        operation = document["paths"][path][method]
        parameters = {
            (parameter["in"], parameter["name"]): parameter
            for parameter in operation["parameters"]
        }
        assert parameters[("header", "Idempotency-Key")]["required"] is True
        assert parameters[("header", "X-Tenant-ID")]["required"] is True
        assert operation["security"] == [{"HTTPBearer": []}]

    for path in (
        "/v1/sessions/{session_id}/capture-capabilities",
        "/v1/sessions/{session_id}/chunks/{object_id}",
    ):
        assert document["paths"][path]["get"]["security"] == [{"HTTPBearer": []}]
