from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import jwt
import pytest
from cosmaneura_scribe.main import app
from cosmaneura_scribe.safe_logging import LOG_FIELD_ALLOWLIST, LOGGER_NAME
from cosmaneura_scribe.service_auth import (
    SCRIBE_WORKFLOW_ACCESS_ROLE,
    AuthFailureReason,
    EntraTokenDecoder,
    EntraWorkflowAuthenticator,
    get_workflow_authenticator,
)
from cosmaneura_scribe.settings import Settings
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient
from httpx import Response
from jwt import PyJWKClientConnectionError


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
        "aud": settings.workflow_api_audience,
        "iss": f"https://login.microsoftonline.com/{settings.entra_tenant_id}/v2.0",
        "tid": str(settings.entra_tenant_id),
        "ver": "2.0",
        "azp": str(settings.trusted_platform_client_id),
        "idtyp": "app",
        "roles": [SCRIBE_WORKFLOW_ACCESS_ROLE],
    }


def credentials() -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials="access-token")


def signed_token(
    settings: Settings,
    private_key: rsa.RSAPrivateKey,
    *,
    audience: str | None = None,
    roles: list[str] | None = None,
    overrides: dict[str, object] | None = None,
    remove: tuple[str, ...] = (),
) -> str:
    assert settings.entra_tenant_id is not None
    assert settings.trusted_platform_client_id is not None
    now = datetime.now(UTC)
    claims: dict[str, object] = {
        "aud": audience or settings.workflow_api_audience,
        "exp": now + timedelta(minutes=5),
        "iat": now,
        "iss": f"https://login.microsoftonline.com/{settings.entra_tenant_id}/v2.0",
        "sub": str(settings.trusted_platform_client_id),
        "tid": str(settings.entra_tenant_id),
        "ver": "2.0",
        "azp": str(settings.trusted_platform_client_id),
        "idtyp": "app",
        "roles": roles if roles is not None else [SCRIBE_WORKFLOW_ACCESS_ROLE],
    }
    if overrides is not None:
        claims.update(overrides)
    for claim in remove:
        claims.pop(claim, None)
    return jwt.encode(
        claims,
        private_key,
        algorithm="RS256",
        headers={"kid": "test-key"},
    )


def consent_request(
    client: TestClient,
    *,
    tenant_id: UUID,
    token: str,
    key: str,
) -> Response:
    return client.post(
        "/v1/consents",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Tenant-ID": str(tenant_id),
            "Idempotency-Key": key,
        },
        json={
            "appointment_id": "appointment-auth-integration",
            "practitioner_id": "practitioner-auth-integration",
            "patient_id": "patient-auth-integration",
            "modality": "virtual",
            "participant_regions": ["FL", "OH"],
            "method": "pre_visit_form",
            "all_parties_consented": True,
            "granted_at": "2026-08-15T12:00:00Z",
        },
    )


def real_authenticator(
    settings: Settings,
    private_key: rsa.RSAPrivateKey,
) -> EntraWorkflowAuthenticator:
    decoder = EntraTokenDecoder(settings)
    decoder.jwks_client = SimpleNamespace(
        get_signing_key_from_jwt=lambda _: SimpleNamespace(key=private_key.public_key())
    )
    return EntraWorkflowAuthenticator(settings, decoder=decoder)


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


def test_authenticator_preserves_strict_issuer_and_audience_checks() -> None:
    settings = auth_settings()
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    authenticator = real_authenticator(settings, private_key)

    with pytest.raises(HTTPException) as audience_error:
        authenticator(
            HTTPAuthorizationCredentials(
                scheme="Bearer",
                credentials=signed_token(
                    settings,
                    private_key,
                    audience=str(uuid4()),
                ),
            )
        )
    with pytest.raises(HTTPException) as issuer_error:
        authenticator(
            HTTPAuthorizationCredentials(
                scheme="Bearer",
                credentials=signed_token(
                    settings,
                    private_key,
                    overrides={"iss": f"https://login.microsoftonline.com/{uuid4()}/v2.0"},
                ),
            )
        )

    assert audience_error.value.status_code == 401
    assert audience_error.value.headers == {
        "WWW-Authenticate": ('Bearer error="invalid_token", error_description="audience_mismatch"')
    }
    assert issuer_error.value.status_code == 401
    assert issuer_error.value.headers == {
        "WWW-Authenticate": ('Bearer error="invalid_token", error_description="issuer_mismatch"')
    }


@pytest.mark.parametrize(
    ("failure", "expected_status", "expected_reason"),
    [
        ("issuer", 401, AuthFailureReason.ISSUER_MISMATCH),
        ("audience", 401, AuthFailureReason.AUDIENCE_MISMATCH),
        ("v1", 401, AuthFailureReason.TOKEN_VERSION_V1),
        ("idtyp", 403, AuthFailureReason.IDTYP_MISSING),
        ("azp", 403, AuthFailureReason.AZP_MISMATCH),
        ("role", 403, AuthFailureReason.ROLE_MISSING),
    ],
)
def test_signed_tokens_report_specific_non_phi_failure_reasons(
    app_client: TestClient,
    failure: str,
    expected_status: int,
    expected_reason: AuthFailureReason,
) -> None:
    settings = auth_settings()
    assert settings.entra_tenant_id is not None
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    overrides: dict[str, object] = {}
    remove: tuple[str, ...] = ()
    if failure == "issuer":
        overrides["iss"] = f"https://login.microsoftonline.com/{uuid4()}/v2.0"
    elif failure == "audience":
        overrides["aud"] = str(uuid4())
    elif failure == "v1":
        overrides.update(
            {
                "ver": "1.0",
                "iss": f"https://sts.windows.net/{settings.entra_tenant_id}/",
                "aud": f"api://{settings.workflow_api_audience}",
            }
        )
    elif failure == "idtyp":
        remove = ("idtyp",)
    elif failure == "azp":
        overrides["azp"] = str(uuid4())
    else:
        overrides["roles"] = []
    app.dependency_overrides[get_workflow_authenticator] = lambda: real_authenticator(
        settings, private_key
    )

    response = consent_request(
        app_client,
        tenant_id=uuid4(),
        token=signed_token(
            settings,
            private_key,
            overrides=overrides,
            remove=remove,
        ),
        key=f"auth-reason-{failure}-0001",
    )

    bearer_error = "insufficient_scope" if expected_status == 403 else "invalid_token"
    assert response.status_code == expected_status
    assert response.headers["WWW-Authenticate"] == (
        f'Bearer error="{bearer_error}", error_description="{expected_reason.value}"'
    )


def test_v1_routes_fail_closed_but_health_stays_open(app_client: TestClient) -> None:
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        Settings()
    )
    health = app_client.get("/healthz")
    workflow = app_client.post(
        "/v1/consents",
        headers={
            "X-Tenant-ID": str(uuid4()),
            "Idempotency-Key": "consent-key-0001",
        },
        json={},
    )

    assert health.status_code == 200
    assert workflow.status_code == 503
    assert workflow.json() == {"detail": "Service authentication is not configured."}


def test_real_authenticator_rejects_wrong_audience_with_401(app_client: TestClient) -> None:
    settings = auth_settings()
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    app.dependency_overrides[get_workflow_authenticator] = lambda: real_authenticator(
        settings, private_key
    )

    response = consent_request(
        app_client,
        tenant_id=uuid4(),
        token=signed_token(settings, private_key, audience=str(uuid4())),
        key="auth-wrong-audience-0001",
    )

    assert response.status_code == 401


def test_real_authenticator_rejects_missing_role_with_403(app_client: TestClient) -> None:
    settings = auth_settings()
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    app.dependency_overrides[get_workflow_authenticator] = lambda: real_authenticator(
        settings, private_key
    )

    response = consent_request(
        app_client,
        tenant_id=uuid4(),
        token=signed_token(settings, private_key, roles=[]),
        key="auth-missing-role-0001",
    )

    assert response.status_code == 403


def test_real_authenticator_reports_jwks_outage_with_503(app_client: TestClient) -> None:
    settings = auth_settings()
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    decoder = EntraTokenDecoder(settings)

    def unavailable_jwks(_: str) -> object:
        raise PyJWKClientConnectionError("synthetic JWKS outage")

    decoder.jwks_client = SimpleNamespace(get_signing_key_from_jwt=unavailable_jwks)
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings, decoder=decoder
    )

    response = consent_request(
        app_client,
        tenant_id=uuid4(),
        token=signed_token(settings, private_key),
        key="auth-jwks-outage-0001",
    )

    assert response.status_code == 503
    assert response.headers["WWW-Authenticate"] == (
        'Bearer error="temporarily_unavailable", error_description="jwks_unavailable"'
    )


def test_real_authenticator_accepts_exact_caller_and_role(app_client: TestClient) -> None:
    settings = auth_settings()
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    app.dependency_overrides[get_workflow_authenticator] = lambda: real_authenticator(
        settings, private_key
    )

    response = consent_request(
        app_client,
        tenant_id=uuid4(),
        token=signed_token(settings, private_key),
        key="auth-success-0001",
    )

    assert response.status_code == 201


def test_token_diagnostics_reports_checks_without_claim_values(app_client: TestClient) -> None:
    settings = auth_settings()
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    app.dependency_overrides[get_workflow_authenticator] = lambda: real_authenticator(
        settings, private_key
    )

    response = app_client.get(
        "/v1/diagnostics/token",
        headers={"Authorization": f"Bearer {signed_token(settings, private_key)}"},
    )

    expected_fields = {
        "signature_valid",
        "lifetime_valid",
        "token_version_v2",
        "issuer_valid",
        "audience_valid",
        "tenant_valid",
        "idtyp_app",
        "azp_valid",
        "role_present",
    }
    assert response.status_code == 200
    assert response.json() == dict.fromkeys(expected_fields, True)
    assert all(isinstance(value, bool) for value in response.json().values())


def test_failure_logs_are_structured_and_exclude_sensitive_values(
    app_client: TestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    settings = auth_settings()
    sensitive_values = (
        "Patient Jane Doe",
        "1970-01-01",
        "synthetic transcript text",
        "tenant/session/chunk.enc",
        "https://storage.example/audio?sig=synthetic-sas",
        "synthetic-access-token",
    )

    def explode(_: str) -> dict[str, object]:
        raise RuntimeError(" ".join(sensitive_values))

    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings,
        decoder=explode,
    )
    response = consent_request(
        app_client,
        tenant_id=uuid4(),
        token=sensitive_values[-1],
        key="auth-sensitive-log-0001",
    )

    application_records = [record for record in caplog.records if record.name == LOGGER_NAME]
    assert response.status_code == 500
    assert application_records
    for record in application_records:
        payload = json.loads(record.getMessage())
        assert set(payload) == LOG_FIELD_ALLOWLIST
    rendered = "\n".join(record.getMessage() for record in application_records)
    assert all(value not in rendered for value in sensitive_values)


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
