from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.main import app, get_repository_provider
from cosmaneura_scribe.repository import InMemoryRepository, Repository
from cosmaneura_scribe.service_auth import (
    SCRIBE_WORKFLOW_ACCESS_ROLE,
    EntraWorkflowAuthenticator,
    get_workflow_authenticator,
)
from cosmaneura_scribe.session_state_v1 import SessionIngestMode
from cosmaneura_scribe.settings import Settings, get_settings
from fastapi.testclient import TestClient

BETA_TENANT_ID = UUID("10000000-0000-4000-8000-000000000001")
ENTRA_TENANT_ID = UUID("20000000-0000-4000-8000-000000000001")
WORKFLOW_AUDIENCE = "30000000-0000-4000-8000-000000000001"
PLATFORM_CLIENT_ID = UUID("40000000-0000-4000-8000-000000000001")
CREATE_OPERATION = "session.external_transcript.create"


class RejectingRepositoryProvider:
    def __init__(self) -> None:
        self.transaction_calls = 0

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncIterator[Repository]:
        del tenant_id
        self.transaction_calls += 1
        raise AssertionError("denied admission opened a repository transaction")
        yield InMemoryRepository()  # pragma: no cover

    async def health(self) -> None:
        return None

    async def close(self) -> None:
        return None


def _settings(
    tenant_id: UUID = BETA_TENANT_ID,
    *,
    enabled: bool = True,
) -> Settings:
    return Settings(
        repository_backend="postgres",
        database_url="postgresql+asyncpg://test.invalid/external_ingest_test",
        database_ssl=False,
        workflow_authentication_enabled=True,
        entra_tenant_id=ENTRA_TENANT_ID,
        workflow_api_audience=WORKFLOW_AUDIENCE,
        trusted_platform_client_id=PLATFORM_CLIENT_ID,
        external_ingest_admission_enabled=enabled,
        external_ingest_beta_tenant_ids=frozenset({tenant_id}),
    )


def _claims() -> dict[str, object]:
    return {
        "aud": WORKFLOW_AUDIENCE,
        "iss": f"https://login.microsoftonline.com/{ENTRA_TENANT_ID}/v2.0",
        "tid": str(ENTRA_TENANT_ID),
        "ver": "2.0",
        "azp": str(PLATFORM_CLIENT_ID),
        "idtyp": "app",
        "roles": [SCRIBE_WORKFLOW_ACCESS_ROLE],
    }


def _headers(
    tenant_id: UUID,
    key: str,
    *,
    bearer: bool = False,
) -> dict[str, str]:
    headers = {
        "X-Tenant-ID": str(tenant_id),
        "Idempotency-Key": key,
    }
    if bearer:
        headers["Authorization"] = "Bearer synthetic-workload-token"
    return headers


def _identity(suffix: str = "one") -> dict[str, str]:
    return {
        "appointment_id": f"synthetic-appointment-{suffix}",
        "practitioner_id": f"synthetic-practitioner-{suffix}",
        "patient_id": f"synthetic-patient-{suffix}",
        "modality": "virtual",
    }


def _consent(
    client: TestClient,
    tenant_id: UUID,
    *,
    key: str,
    identity: dict[str, str],
    bearer: bool = False,
) -> dict[str, object]:
    response = client.post(
        "/v1/consents",
        headers=_headers(tenant_id, key, bearer=bearer),
        json={
            **identity,
            "participant_regions": ["FL"],
            "method": "pre_visit_form",
            "all_parties_consented": True,
            "granted_at": datetime.now(UTC).isoformat(),
        },
    )
    assert response.status_code == 201
    return response.json()


def _session_body(
    consent: dict[str, object],
    identity: dict[str, str],
) -> dict[str, object]:
    return {**identity, "consent_record_id": consent["id"]}


@pytest.fixture
def beta_tenant_id() -> UUID:
    return uuid4()


def test_disabled_and_nonadmitted_tenants_are_opaque_before_repository_access(
    client: TestClient,
    beta_tenant_id: UUID,
) -> None:
    provider = RejectingRepositoryProvider()
    app.dependency_overrides[get_repository_provider] = lambda: provider
    body = {
        **_identity(),
        "consent_record_id": str(uuid4()),
    }

    app.dependency_overrides[get_settings] = lambda: _settings(
        beta_tenant_id,
        enabled=False,
    )
    disabled = client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, "external-disabled-0001"),
        json=body,
    )

    app.dependency_overrides[get_settings] = lambda: _settings(uuid4())
    nonadmitted = client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, "external-nonadmitted-0001"),
        json=body,
    )

    assert disabled.status_code == nonadmitted.status_code == 404
    assert disabled.json() == nonadmitted.json() == {
        "detail": "External transcript session creation is unavailable."
    }
    assert "WWW-Authenticate" not in disabled.headers
    assert "WWW-Authenticate" not in nonadmitted.headers
    assert provider.transaction_calls == 0


def test_external_admission_reuses_existing_workflow_auth_before_repository_access(
    app_client: TestClient,
    beta_tenant_id: UUID,
) -> None:
    settings = _settings(beta_tenant_id)
    provider = RejectingRepositoryProvider()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_repository_provider] = lambda: provider
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings,
        decoder=lambda _: _claims(),
    )
    body = {
        **_identity(),
        "consent_record_id": str(uuid4()),
    }

    missing = app_client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, "external-auth-missing"),
        json=body,
    )
    assert missing.status_code == 401
    assert "WWW-Authenticate" in missing.headers

    invalid_claims = _claims() | {"roles": ["Other.Role"]}
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings,
        decoder=lambda _: invalid_claims,
    )
    wrong_role = app_client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, "external-auth-role", bearer=True),
        json=body,
    )
    assert wrong_role.status_code == 403
    assert "WWW-Authenticate" in wrong_role.headers
    assert provider.transaction_calls == 0


def test_allowed_workload_creates_replays_and_completes_external_session(
    app_client: TestClient,
    repository_backend: RepositoryBackend,
    beta_tenant_id: UUID,
) -> None:
    settings = _settings(beta_tenant_id)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings,
        decoder=lambda _: _claims(),
    )
    identity = _identity()
    consent = _consent(
        app_client,
        beta_tenant_id,
        key="external-consent-0001",
        identity=identity,
        bearer=True,
    )
    body = _session_body(consent, identity)
    shared_key = "external-session-shared-0001"

    created = app_client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, shared_key, bearer=True),
        json=body,
    )
    replay = app_client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, shared_key, bearer=True),
        json=body,
    )
    ordinary = app_client.post(
        "/v1/sessions",
        headers=_headers(beta_tenant_id, shared_key, bearer=True),
        json=body,
    )

    assert created.status_code == replay.status_code == ordinary.status_code == 201
    assert replay.json() == created.json()
    assert set(created.json()) == {
        "appointment_id",
        "practitioner_id",
        "patient_id",
        "consent_record_id",
        "modality",
        "id",
        "ingest_mode",
        "status",
        "created_at",
    }
    assert created.json()["ingest_mode"] == SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT
    assert ordinary.json()["id"] != created.json()["id"]
    assert ordinary.json()["ingest_mode"] == SessionIngestMode.CHUNK_UPLOAD

    app.dependency_overrides[get_settings] = lambda: _settings(
        beta_tenant_id,
        enabled=False,
    )
    blocked_replay = app_client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, shared_key, bearer=True),
        json=body,
    )
    assert blocked_replay.status_code == 404

    transcript = app_client.post(
        f"/v1/sessions/{created.json()['id']}/transcript",
        headers=_headers(beta_tenant_id, "external-transcript-0001", bearer=True),
        json={
            "language_code": "en-US",
            "stt_provider": "synthetic_external_beta",
            "segments": [
                {
                    "speaker_id": "speaker-1",
                    "speaker_role": "patient",
                    "content": "Synthetic transcript fixture.",
                    "start_ms": 0,
                    "end_ms": 1_000,
                }
            ],
        },
    )
    assert transcript.status_code == 201

    persisted = repository_backend.session_for(
        beta_tenant_id,
        UUID(created.json()["id"]),
    )
    assert persisted is not None
    assert persisted.status.value == "transcript_ready"
    assert persisted.ingest_mode == SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT
    assert repository_backend.audit_actions(beta_tenant_id) == [
        "consent.recorded",
        "scribe_session.external_transcript_created",
        "scribe_session.created",
        "transcript.created",
    ]


def test_external_session_idempotency_conflicts_on_a_changed_valid_request(
    client: TestClient,
    repository_backend: RepositoryBackend,
    beta_tenant_id: UUID,
) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(beta_tenant_id)
    first_identity = _identity("first")
    second_identity = _identity("second")
    first_consent = _consent(
        client,
        beta_tenant_id,
        key="external-consent-first",
        identity=first_identity,
    )
    second_consent = _consent(
        client,
        beta_tenant_id,
        key="external-consent-second",
        identity=second_identity,
    )
    shared_key = "external-conflict-key-0001"

    first = client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, shared_key),
        json=_session_body(first_consent, first_identity),
    )
    conflict = client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, shared_key),
        json=_session_body(second_consent, second_identity),
    )

    assert first.status_code == 201
    assert conflict.status_code == 409

    async def assert_original_claim() -> None:
        async with repository_backend.provider.transaction(beta_tenant_id) as store:
            claim = await store.get_idempotency(
                tenant_id=beta_tenant_id,
                operation=CREATE_OPERATION,
                key=shared_key,
            )
            assert claim is not None
            assert claim.entity_id == UUID(first.json()["id"])

    repository_backend.run(assert_original_claim)
    assert repository_backend.audit_actions(beta_tenant_id) == [
        "consent.recorded",
        "consent.recorded",
        "scribe_session.external_transcript_created",
    ]


def test_external_session_creation_rejects_cross_tenant_and_revoked_consent(
    client: TestClient,
    repository_backend: RepositoryBackend,
    beta_tenant_id: UUID,
) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(beta_tenant_id)
    other_tenant_id = uuid4()
    cross_identity = _identity("cross-tenant")
    cross_consent = _consent(
        client,
        other_tenant_id,
        key="external-cross-consent",
        identity=cross_identity,
    )
    cross_tenant = client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, "external-cross-session"),
        json=_session_body(cross_consent, cross_identity),
    )
    assert cross_tenant.status_code == 409
    assert cross_tenant.json() == {"detail": "A valid consent record is required."}

    revoked_identity = _identity("revoked")
    revoked_consent = _consent(
        client,
        beta_tenant_id,
        key="external-revoked-consent",
        identity=revoked_identity,
    )
    revoked = client.post(
        f"/v1/consents/{revoked_consent['id']}/revocations",
        headers=_headers(beta_tenant_id, "external-revoke-consent"),
    )
    assert revoked.status_code == 200
    rejected = client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, "external-revoked-session"),
        json=_session_body(revoked_consent, revoked_identity),
    )
    assert rejected.status_code == 409

    async def assert_no_failed_claims() -> None:
        async with repository_backend.provider.transaction(beta_tenant_id) as store:
            for key in ("external-cross-session", "external-revoked-session"):
                assert (
                    await store.get_idempotency(
                        tenant_id=beta_tenant_id,
                        operation=CREATE_OPERATION,
                        key=key,
                    )
                    is None
                )

    repository_backend.run(assert_no_failed_claims)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("ingest_mode", "chunk_upload"),
        ("tenant_id", str(BETA_TENANT_ID)),
        ("patient_name", "Synthetic Person"),
        ("date_of_birth", "2000-01-01"),
    ],
)
def test_external_session_request_rejects_authority_and_phi_fields(
    client: TestClient,
    repository_backend: RepositoryBackend,
    beta_tenant_id: UUID,
    field: str,
    value: str,
) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(beta_tenant_id)
    response = client.post(
        "/v1/external-transcript-sessions",
        headers=_headers(beta_tenant_id, f"external-extra-{field}"),
        json={
            **_identity(),
            "consent_record_id": str(uuid4()),
            field: value,
        },
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Request validation failed."}
    assert repository_backend.audit_actions(beta_tenant_id) == []


def test_external_session_openapi_contract_is_strict_and_authenticated() -> None:
    operation = app.openapi()["paths"]["/v1/external-transcript-sessions"]["post"]
    parameters = {
        (parameter["name"], parameter["in"]): parameter
        for parameter in operation["parameters"]
    }
    request_reference = operation["requestBody"]["content"]["application/json"]["schema"][
        "$ref"
    ]
    request_schema_name = request_reference.rsplit("/", maxsplit=1)[-1]
    request_schema = app.openapi()["components"]["schemas"][request_schema_name]
    response_schema = app.openapi()["components"]["schemas"]["CaptureSession"]

    assert operation["security"] == [{"HTTPBearer": []}]
    assert parameters[("X-Tenant-ID", "header")]["required"] is True
    assert parameters[("Idempotency-Key", "header")]["required"] is True
    assert request_schema["additionalProperties"] is False
    assert set(request_schema["properties"]) == {
        "appointment_id",
        "practitioner_id",
        "patient_id",
        "consent_record_id",
        "modality",
    }
    assert set(response_schema["properties"]) == {
        "appointment_id",
        "practitioner_id",
        "patient_id",
        "consent_record_id",
        "modality",
        "id",
        "ingest_mode",
        "status",
        "created_at",
    }
    assert all(
        not schema_name.startswith("VersionedExternalSession")
        for schema_name in app.openapi()["components"]["schemas"]
    )
