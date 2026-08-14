from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any
from uuid import UUID

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient, PyJWTError

from .settings import Settings, get_settings

SCRIBE_WORKFLOW_ACCESS_ROLE = "Scribe.Workflow.Access"


@dataclass(frozen=True)
class EntraServicePrincipal:
    client_id: UUID


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
            audience=self.settings.workflow_api_audience,
            issuer=self.issuer,
            options={"require": ["aud", "exp", "iat", "iss", "sub", "tid"]},
        )


def _authentication_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Service authentication failed.",
        headers={"WWW-Authenticate": "Bearer"},
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
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Service authentication is not configured.",
            )

        if credentials is None or credentials.scheme.lower() != "bearer":
            raise _authentication_error()

        decoder = self.decoder
        if decoder is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Service authentication is not configured.",
            )
        try:
            claims = decoder(credentials.credentials)
        except (PyJWTError, ValueError, TypeError):
            raise _authentication_error() from None

        if claims.get("tid") != str(self.settings.entra_tenant_id):
            raise _authentication_error()

        client_id = claims.get("azp")
        roles = claims.get("roles")
        if (
            claims.get("idtyp") != "app"
            or client_id != str(self.settings.trusted_platform_client_id)
            or not isinstance(roles, list)
            or SCRIBE_WORKFLOW_ACCESS_ROLE not in roles
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Service caller is not authorized.",
            )

        return EntraServicePrincipal(client_id=self.settings.trusted_platform_client_id)


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
