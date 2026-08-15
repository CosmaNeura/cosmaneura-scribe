from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest
from cosmaneura_scribe.main import app, get_repository, get_repository_provider
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.service_auth import (
    SCRIBE_WORKFLOW_ACCESS_ROLE,
    EntraTokenDecoder,
    EntraWorkflowAuthenticator,
    get_workflow_authenticator,
)
from cosmaneura_scribe.settings import Settings
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient
from jwt import InvalidAudienceError


def auth_settings() -> Settings:
    return Settings(
        workflow_authentication_enabled=True,
        entra_tenant_id=uuid4(),
        workflow_api_audience=str(uuid4()),
        trusted_platform_client_id=uuid4(),
    )


def valid_claims(settings: Settings) -> dict[str, object]:
    assert settings.entra_tenant_id is not None
    assert settings.trusted_platform_client_id is not None
    return {
        "tid": str(settings.entra_tenant_id),
        "azp": str(settings.trusted_platform_client_id),
        "idtyp": "app",
        "roles": [SCRIBE_WORKFLOW_ACCESS_ROLE],
    }


def credentials() -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials="access-token")


def assert_http_error(expected_status: int, call: object) -> None:
    with pytest.raises(HTTPException) as exc_info:
        call()  # type: ignore[operator]
    assert exc_info.value.status_code == expected_status


def test_workflow_authentication_fails_closed_when_disabled() -> None:
    authenticator = EntraWorkflowAuthenticator(Settings())
    assert_http_error(503, lambda: authenticator(None))


def test_workflow_authentication_requires_a_bearer_token() -> None:
    authenticator = EntraWorkflowAuthenticator(auth_settings(), decoder=lambda _: {})
    assert_http_error(401, lambda: authenticator(None))


@pytest.mark.parametrize(
    ("claim", "value", "expected_status"),
    [
        ("tid", str(uuid4()), 401),
        ("azp", str(uuid4()), 403),
        ("idtyp", "user", 403),
        ("roles", ["Scribe.Transcript.Write"], 403),
    ],
)
def test_workflow_authentication_rejects_untrusted_claims(
    claim: str,
    value: object,
    expected_status: int,
) -> None:
    settings = auth_settings()
    claims = valid_claims(settings)
    claims[claim] = value
    authenticator = EntraWorkflowAuthenticator(settings, decoder=lambda _: claims)

    assert_http_error(expected_status, lambda: authenticator(credentials()))


def test_workflow_authentication_accepts_the_exact_app_caller_and_role() -> None:
    settings = auth_settings()
    authenticator = EntraWorkflowAuthenticator(
        settings,
        decoder=lambda _: valid_claims(settings),
    )

    principal = authenticator(credentials())

    assert principal.client_id == settings.trusted_platform_client_id


def test_token_decoder_verifies_issuer_and_audience() -> None:
    settings = auth_settings()
    assert settings.entra_tenant_id is not None
    now = datetime.now(UTC)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = jwt.encode(
        {
            "aud": str(uuid4()),
            "exp": now + timedelta(minutes=5),
            "iat": now,
            "iss": f"https://login.microsoftonline.com/{settings.entra_tenant_id}/v2.0",
            "sub": str(uuid4()),
            "tid": str(settings.entra_tenant_id),
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "test-key"},
    )
    decoder = EntraTokenDecoder(settings)
    decoder.jwks_client = SimpleNamespace(
        get_signing_key_from_jwt=lambda _: SimpleNamespace(key=private_key.public_key())
    )

    with pytest.raises(InvalidAudienceError):
        decoder(token)


def test_v1_routes_fail_closed_but_health_stays_open() -> None:
    repository = InMemoryRepository()
    app.dependency_overrides[get_repository] = lambda: repository
    app.dependency_overrides[get_repository_provider] = lambda: repository
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        Settings()
    )
    try:
        with TestClient(app) as client:
            health = client.get("/healthz")
            workflow = client.post(
                "/v1/consents",
                headers={
                    "X-Tenant-ID": str(uuid4()),
                    "Idempotency-Key": "consent-key-0001",
                },
                json={},
            )
    finally:
        app.dependency_overrides.clear()

    assert health.status_code == 200
    assert workflow.status_code == 503
    assert workflow.json() == {"detail": "Service authentication is not configured."}


def test_validation_errors_do_not_echo_request_data(client: TestClient) -> None:
    sensitive_value = "Patient Name Must Never Echo"
    response = client.post(
        "/v1/consents",
        headers={
            "X-Tenant-ID": str(uuid4()),
            "Idempotency-Key": "consent-key-0002",
        },
        json={"appointment_id": sensitive_value},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Request validation failed."}
    assert sensitive_value not in response.text
