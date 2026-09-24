"""Standalone provider receiver composition; no import-time runtime or activation.

The host supplies the retained, hash-verified OS identity/account models and an
owned database. This reuses their verifier and creator access checks unchanged.
Only the existing Core transport can perform clinical operations. There is no
synthetic identity mode, credential fallback, seeding, schema change or listener.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlsplit
from uuid import UUID, uuid5

import httpx
from cosmaneura_scribe.provider_core_transport import (
    AuthorizedCoreProvider,
    CoreProviderMount,
    CoreProviderSelection,
    ProviderCoreTransport,
    ProviderCoreUnavailable,
)
from cosmas_os.api.auth import (
    AccessDenied,
    AuthenticationFailed,
    RequestIdentity,
    TokenVerifier,
    authenticate_request,
)
from cosmas_os.application import workspace as ws
from cosmas_os.config import Settings
from cosmas_os.models import CoreCaptureAccount, EncounterWorkspace
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import SecretStr
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

_PREFIX = "/provider/v1/"
_CORE = "/service/v1/agent/scribe/"
_LIMITS = {
    "catalog": 2,
    "mount": 256,
    "recorder": 1024,
    "capture-admissions": 2048,
    "capture-operations": 4_194_304,
    "capture-notes": 262_144 + 8192,
}


@dataclass(frozen=True)
class ReceiverProfile:
    """Explicit host configuration; none of these values come from the renderer."""

    origin: str
    core_origin: str
    environment_id: UUID
    native_origins: frozenset[str]

    def __post_init__(self) -> None:
        for value in (self.origin, self.core_origin):
            parsed = urlsplit(value)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.port == 0
                or parsed.username
                or parsed.password
                or parsed.path
                or parsed.query
                or parsed.fragment
                or any(c.isspace() or ord(c) < 33 for c in value)
            ):
                raise ValueError("provider_profile_invalid")
        if (
            not isinstance(self.environment_id, UUID)
            or not isinstance(self.native_origins, frozenset)
            or not self.native_origins
            or not self.native_origins <= {"capacitor://localhost", "app://cosmas"}
        ):
            raise ValueError("provider_profile_invalid")


class ProviderReceiver:
    """Bind real normalized identity and reviewed Core correspondence per request.

    A new SQL session is used for every authorization, including after Core I/O;
    an ORM cache or an open transaction cannot conceal a committed revocation.
    A native revision is only a cancellation epoch, never identity or authority.
    Core revalidates the bearer, mount, creator, encounter and binding on every
    operation. No mount token, workload credential or user token is returned.
    """

    def __init__(
        self,
        profile: ReceiverProfile,
        engine: Engine,
        settings: Settings,
        verifier: TokenVerifier,
        workload_token: Callable[[], Awaitable[SecretStr]],
        *,
        enabled: bool = False,
        core_http: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if (
            settings.auth_mode != "clerk_jwt"
            or not settings.beta_box_id
            or settings.workspace_authentication_errors()
            or not profile.native_origins <= set(settings.allowed_origins)
            or not profile.native_origins <= set(settings.authorized_parties)
        ):
            raise ValueError("provider_authentication_required")
        self.profile, self.engine, self.settings = profile, engine, settings
        self.verifier, self.workload_token = verifier, workload_token
        self.enabled, self.core_http = enabled is True, core_http

    def app(self) -> FastAPI:
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

        @app.middleware("http")
        async def boundary(request: Request, call_next):
            # No CORS preflight, cookies, forwarding headers, user-selected URLs,
            # caller authority or compatibility routes on this native receiver.
            action = request.url.path.removeprefix(_PREFIX)
            header_names = [name.decode("latin1").lower() for name, _ in request.scope["headers"]]
            duplicate = any(
                header_names.count(name) > 1
                for name in (
                    "host",
                    "origin",
                    "authorization",
                    "x-scribe-native-revision",
                    "idempotency-key",
                )
            )
            if (
                not self.enabled
                or request.method != "POST"
                or request.url.scheme != "https"
                or request.url.path != _PREFIX + action
                or action not in _LIMITS
                or request.url.query
                or request.headers.get("host") != urlsplit(self.profile.origin).netloc
                or request.headers.get("origin") not in self.profile.native_origins
                or duplicate
                or any(
                    name in {"cookie", "x-box-id", "x-actor-principal-id"}
                    or name.startswith(("x-cosmaneura-", "x-forwarded-"))
                    or name.startswith("x-scribe-")
                    and name != "x-scribe-native-revision"
                    for name in header_names
                )
            ):
                return _reply(404, {"detail": "provider_unavailable"})
            try:
                return await call_next(request)
            except Exception:
                # Framework/SQL/credential exceptions must not echo request data.
                return _reply(503, {"detail": "provider_unavailable"})

        @app.post(_PREFIX + "{action}")
        async def handle(action: str, request: Request):
            try:
                authorization = request.headers.get("authorization", "")
                if len(authorization) > 8200 or not authorization.startswith("Bearer "):
                    raise AuthenticationFailed()
                revision = _uuid(request.headers.get("x-scribe-native-revision"))
                body = await _read(request, _LIMITS[action])
                if action == "catalog":
                    _require(not body)
                    rows = await run_in_threadpool(self.catalog, authorization)
                    if not self.enabled:
                        raise AccessDenied()
                    return _reply(200, {"revision": str(revision), "encounters": rows})

                workspace_id = _uuid(body.get("workspace_id"))
                key = request.headers.get("idempotency-key", "")
                # Even mount/recorder authorization uses a caller-retained key;
                # capture operations pass that exact key through to existing Core.
                _require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))

                async def fresh() -> AuthorizedCoreProvider:
                    if not self.enabled:
                        raise AccessDenied()
                    return await run_in_threadpool(
                        self.context,
                        authorization,
                        revision,
                        workspace_id,
                    )

                transport = ProviderCoreTransport(
                    self.profile.core_origin,
                    fresh,
                    self.workload_token,
                    enabled=True,
                    transport=self.core_http,
                )
                try:
                    if action == "mount":
                        _require(set(body) == {"workspace_id"})
                        mount = await transport.open()
                        # Use a fresh authorized observation for the display row.
                        context, encounter = await run_in_threadpool(
                            self.selected,
                            authorization,
                            revision,
                            workspace_id,
                        )
                        _require(context.selection == mount.selection)
                        result = {
                            **mount.client_scope(),
                            "encounter": encounter,
                            "revision": str(revision),
                        }
                    else:
                        context = await fresh()
                        binding = body.get("binding_ref")
                        if not isinstance(binding, str) or not re.fullmatch(
                            r"scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}", binding
                        ):
                            raise InvalidRequest()
                        mount = CoreProviderMount(context.selection, binding)
                        if action == "recorder":
                            _require(
                                set(body)
                                == {
                                    "workspace_id",
                                    "binding_ref",
                                    "session_id",
                                    "request_nonce",
                                }
                            )
                            session_id = str(_uuid(body["session_id"]))
                            result = await transport.request(
                                mount,
                                _CORE + "capture-operations",
                                {
                                    "workspace_id": str(workspace_id),
                                    "binding_ref": binding,
                                    "request_nonce": str(_uuid(body["request_nonce"])),
                                    "operation": {"kind": "capabilities"},
                                },
                                key,
                            )
                            receipt = result.get("receipt")
                            _require(
                                isinstance(receipt, dict)
                                and receipt.get("session_id") == session_id
                            )
                            result = {"revision": str(revision), "session_id": session_id}
                        else:
                            result = await transport.request(mount, _CORE + action, body, key)
                    if (await fresh()).selection != mount.selection:
                        raise AccessDenied()
                    return _reply(200, result)
                finally:
                    await transport.close()
            except AuthenticationFailed:
                return _reply(401, {"detail": "provider_authentication_required"})
            except (AccessDenied, ws.WorkspaceError):
                return _reply(403, {"detail": "provider_access_unavailable"})
            except ProviderCoreUnavailable as error:
                return _reply(error.status, {"detail": error.code})
            except InvalidRequest:
                return _reply(422, {"detail": "provider_request_invalid"})

        return app

    def identity(self, session: Session, authorization: str) -> RequestIdentity:
        return authenticate_request(
            session,
            self.settings,
            authorization=authorization,
            box_header=None,
            actor_header=None,
            verifier=self.verifier,
        )

    @staticmethod
    def account(session: Session, identity: RequestIdentity) -> CoreCaptureAccount:
        accounts = list(
            session.scalars(
                select(CoreCaptureAccount).where(
                    CoreCaptureAccount.external_identity_id == identity.external_identity_id,
                    CoreCaptureAccount.revoked_at.is_(None),
                )
            )
        )
        if (
            len(accounts) != 1
            or not accounts[0].reviewed_by.strip()
            or not accounts[0].evidence_ref.strip()
        ):
            raise AccessDenied()
        return accounts[0]

    def selected(self, authorization: str, revision: UUID, workspace_id: UUID):
        with Session(self.engine) as session:
            identity = self.identity(session, authorization)
            account = self.account(session, identity)
            workspace = ws._workspace(
                session,
                identity.box_id,
                identity.principal_id,
                str(workspace_id),
            )
            appointment = ws._encounter(
                session,
                identity.box_id,
                workspace.appointment_id,
                workspace.patient_link_id,
            )
            if appointment.source != "cosmaneura_core":
                raise AccessDenied()
            # A changed environment, reviewed account or creator cannot reopen a
            # prior creator's local recovery store. Tokens are never hashed here.
            recovery = uuid5(
                self.profile.environment_id,
                f"{identity.box_id}:{identity.principal_id}:{account.id}",
            )
            selection = CoreProviderSelection(
                recovery_scope=recovery,
                authorization_revision=uuid5(recovery, str(revision)),
                workspace_id=workspace_id,
                appointment_ref=appointment.external_id,
                actor_ref=account.core_actor_ref,
                tenant_ref=account.core_tenant_ref,
            )
            return AuthorizedCoreProvider(selection, SecretStr(authorization[7:])), {
                "appointmentRef": selection.appointment_ref,
                "title": appointment.patient_label,
                "detail": "",
            }

    def context(self, authorization: str, revision: UUID, workspace_id: UUID):
        return self.selected(authorization, revision, workspace_id)[0]

    def catalog(self, authorization: str):
        with Session(self.engine) as session:
            identity = self.identity(session, authorization)
            account_id = self.account(session, identity).id
            workspaces = session.scalars(
                select(EncounterWorkspace)
                .where(
                    EncounterWorkspace.box_id == identity.box_id,
                    EncounterWorkspace.owner_id == identity.principal_id,
                )
                .order_by(EncounterWorkspace.id)
                .limit(101)
            ).all()
            if len(workspaces) > 100:
                raise AccessDenied()
            rows = []
            for workspace in workspaces:
                try:
                    appointment = ws._encounter(
                        session,
                        identity.box_id,
                        workspace.appointment_id,
                        workspace.patient_link_id,
                    )
                except ws.WorkspaceError:
                    continue
                if appointment.source != "cosmaneura_core":
                    continue
                # Validate the reference before it can become a client selection.
                if not re.fullmatch(
                    r"appointment_[0-7][0-9a-hjkmnp-tv-z]{25}", appointment.external_id
                ):
                    raise AccessDenied()
                rows.append(
                    {
                        "workspaceId": workspace.id,
                        "appointmentRef": appointment.external_id,
                        "title": appointment.patient_label,
                        "detail": "",
                    }
                )
            # Re-read identity/account after the catalog queries as well.
        with Session(self.engine) as session:
            if self.identity(session, authorization) != identity:
                raise AccessDenied()
            if self.account(session, identity).id != account_id:
                raise AccessDenied()
        return rows


class InvalidRequest(Exception):
    pass


def _require(condition: object) -> None:
    if not condition:
        raise InvalidRequest()


def _uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise InvalidRequest()
    try:
        _require(str(UUID(value)) == value)
        return UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise InvalidRequest() from None


def _unique(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result)
        result[key] = value
    return result


async def _read(request: Request, limit: int) -> dict:
    _require(
        request.headers.get("content-type", "").split(";", 1)[0] == "application/json"
        and "content-encoding" not in request.headers
    )
    data = bytearray()
    try:
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                _require(len(data) + len(chunk) <= limit)
                data.extend(chunk)
        result = json.loads(
            data, object_pairs_hook=_unique, parse_constant=lambda _: _require(False)
        )
        _require(isinstance(result, dict))
        return result
    except (ValueError, UnicodeError, TimeoutError, RecursionError):
        raise InvalidRequest() from None


def _reply(status: int, body: object) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=body,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
