from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache
from typing import Annotated, Any
from uuid import UUID

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import (
    InvalidAudienceError,
    InvalidIssuerError,
    PyJWKClient,
    PyJWKClientError,
    PyJWTError,
)

from .safe_logging import log_event
from .schemas import TokenDiagnostics
from .settings import Settings, get_settings

SCRIBE_WORKFLOW_ACCESS_ROLE = "Scribe.Workflow.Access"


@dataclass(frozen=True)
class EntraServicePrincipal:
    client_id: UUID
    diagnostics: TokenDiagnostics


class AuthFailureReason(StrEnum):
    AUTH_NOT_CONFIGURED = "auth_not_configured"
    BEARER_MISSING = "bearer_missing"
    JWKS_UNAVAILABLE = "jwks_unavailable"
    TOKEN_INVALID = "token_invalid"
    TOKEN_VERSION_V1 = "token_version_v1"
    TOKEN_VERSION_INVALID = "token_version_invalid"
    ISSUER_MISMATCH = "issuer_mismatch"
    AUDIENCE_MISMATCH = "audience_mismatch"
    TENANT_MISMATCH = "tenant_mismatch"
    IDTYP_MISSING = "idtyp_missing"
    AZP_MISMATCH = "azp_mismatch"
    ROLE_MISSING = "role_missing"


TokenDecoder = Callable[[str], dict[str, Any]]


class EntraTokenDecoder:
    """Verify Entra v2 access tokens using the tenant's published signing keys."""

    def __init__(self, settings: Settings):
        if settings.entra_tenant_id is None:
            raise ValueError("Entra tenant is not configured")
        self.settings = settings
        tenant_id = str(settings.entra_tenant_id)
        self.issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
        self.jwks_client = PyJWKClient(
            f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys",
            cache_keys=True,
        )

    def __call__(self, token: str) -> dict[str, Any]:
        signing_key = self.jwks_client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={
                "require": ["exp", "iat", "sub"],
                "verify_aud": False,
                "verify_iss": False,
            },
        )


def _authentication_error(
    settings: Settings,
    reason: AuthFailureReason,
    status_code: int = status.HTTP_401_UNAUTHORIZED,
) -> HTTPException:
    log_event(
        action="workflow_auth.rejected",
        tenant_id=settings.entra_tenant_id,
        error_class=reason.value,
    )
    if status_code == status.HTTP_403_FORBIDDEN:
        bearer_error = "insufficient_scope"
        detail = "Service caller is not authorized."
    elif status_code == status.HTTP_503_SERVICE_UNAVAILABLE:
        bearer_error = "temporarily_unavailable"
        detail = (
            "Service authentication is not configured."
            if reason == AuthFailureReason.AUTH_NOT_CONFIGURED
            else "Service authentication is temporarily unavailable."
        )
    else:
        bearer_error = "invalid_token"
        detail = "Service authentication failed."
    return HTTPException(
        status_code=status_code,
        detail=detail,
        headers={
            "WWW-Authenticate": (
                f'Bearer error="{bearer_error}", error_description="{reason.value}"'
            )
        },
    )


class EntraWorkflowAuthenticator:
    """Authorize the exact app-only platform caller with the workflow role."""

    def __init__(self, settings: Settings, decoder: TokenDecoder | None = None):
        self.settings = settings
        if decoder is not None:
            self.decoder = decoder
        elif (
            settings.entra_tenant_id is not None
            and settings.workflow_api_audience is not None
            and settings.trusted_platform_client_id is not None
        ):
            self.decoder = EntraTokenDecoder(settings)
        else:
            self.decoder = None

    def __call__(
        self,
        credentials: HTTPAuthorizationCredentials | None,
    ) -> EntraServicePrincipal:
        if (
            not self.settings.workflow_authentication_enabled
            or self.settings.entra_tenant_id is None
            or self.settings.workflow_api_audience is None
            or self.settings.trusted_platform_client_id is None
        ):
            raise _authentication_error(
                self.settings,
                AuthFailureReason.AUTH_NOT_CONFIGURED,
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        if credentials is None or credentials.scheme.lower() != "bearer":
            raise _authentication_error(self.settings, AuthFailureReason.BEARER_MISSING)

        decoder = self.decoder
        if decoder is None:
            raise _authentication_error(
                self.settings,
                AuthFailureReason.AUTH_NOT_CONFIGURED,
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            claims = decoder(credentials.credentials)
        except PyJWKClientError:
            raise _authentication_error(
                self.settings,
                AuthFailureReason.JWKS_UNAVAILABLE,
                status.HTTP_503_SERVICE_UNAVAILABLE,
            ) from None
        except InvalidIssuerError:
            raise _authentication_error(
                self.settings,
                AuthFailureReason.ISSUER_MISMATCH,
            ) from None
        except InvalidAudienceError:
            raise _authentication_error(
                self.settings,
                AuthFailureReason.AUDIENCE_MISMATCH,
            ) from None
        except (PyJWTError, ValueError, TypeError):
            raise _authentication_error(
                self.settings,
                AuthFailureReason.TOKEN_INVALID,
            ) from None

        tenant_id = self.settings.entra_tenant_id
        audience = self.settings.workflow_api_audience
        trusted_client_id = self.settings.trusted_platform_client_id
        assert tenant_id is not None
        assert audience is not None
        assert trusted_client_id is not None

        expected_issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
        v1_issuer = f"https://sts.windows.net/{tenant_id}/"
        token_version = claims.get("ver")
        issuer = claims.get("iss")
        roles = claims.get("roles")
        checks = TokenDiagnostics(
            signature_valid=True,
            lifetime_valid=True,
            token_version_v2=token_version == "2.0",
            issuer_valid=issuer == expected_issuer,
            audience_valid=claims.get("aud") == audience,
            tenant_valid=claims.get("tid") == str(tenant_id),
            idtyp_app=claims.get("idtyp") == "app",
            azp_valid=claims.get("azp") == str(trusted_client_id),
            role_present=(isinstance(roles, list) and SCRIBE_WORKFLOW_ACCESS_ROLE in roles),
        )

        if token_version == "1.0" or issuer == v1_issuer:
            raise _authentication_error(self.settings, AuthFailureReason.TOKEN_VERSION_V1)
        if not checks.token_version_v2:
            raise _authentication_error(self.settings, AuthFailureReason.TOKEN_VERSION_INVALID)
        if not checks.issuer_valid:
            raise _authentication_error(self.settings, AuthFailureReason.ISSUER_MISMATCH)
        if not checks.audience_valid:
            raise _authentication_error(self.settings, AuthFailureReason.AUDIENCE_MISMATCH)
        if not checks.tenant_valid:
            raise _authentication_error(self.settings, AuthFailureReason.TENANT_MISMATCH)
        if not checks.idtyp_app:
            raise _authentication_error(
                self.settings,
                AuthFailureReason.IDTYP_MISSING,
                status.HTTP_403_FORBIDDEN,
            )
        if not checks.azp_valid:
            raise _authentication_error(
                self.settings,
                AuthFailureReason.AZP_MISMATCH,
                status.HTTP_403_FORBIDDEN,
            )
        if not checks.role_present:
            raise _authentication_error(
                self.settings,
                AuthFailureReason.ROLE_MISSING,
                status.HTTP_403_FORBIDDEN,
            )

        return EntraServicePrincipal(client_id=trusted_client_id, diagnostics=checks)


@lru_cache
def get_workflow_authenticator() -> EntraWorkflowAuthenticator:
    return EntraWorkflowAuthenticator(get_settings())


_bearer = HTTPBearer(auto_error=False)


def authenticate_workflow_request(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    authenticator: Annotated[EntraWorkflowAuthenticator, Depends(get_workflow_authenticator)],
) -> EntraServicePrincipal:
    return authenticator(credentials)


def get_verified_tenant_id(
    tenant_id: Annotated[UUID, Header(alias="X-Tenant-ID")],
    _principal: Annotated[EntraServicePrincipal, Depends(authenticate_workflow_request)],
) -> UUID:
    """Accept practice context only after authenticating the source-of-truth platform."""

    return tenant_id
