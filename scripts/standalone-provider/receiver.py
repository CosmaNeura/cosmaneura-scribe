"""Standalone provider receiver composition; no import-time runtime or activation.

The host supplies the retained, hash-verified OS identity/account models and an
owned database. This reuses their verifier and creator access checks, with an
explicitly separate Core personal-session profile in the proposed identity copy.
Only the existing Core transport can perform clinical operations. There is no
synthetic identity mode, credential fallback, seeding, schema change or listener.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlsplit
from uuid import UUID, uuid4, uuid5

import httpx
from cosmaneura_scribe.provider_core_connections import ProviderCoreConnections
from cosmaneura_scribe.provider_core_timing import PROVIDER_CORE_HEADER
from cosmaneura_scribe.provider_core_transport import (
    AuthorizedCoreProvider,
    CoreProviderMount,
    CoreProviderSelection,
    ProviderCoreTransport,
    ProviderCoreUnavailable,
)
from cosmaneura_scribe.provider_encounter_transport import (
    ProviderEncounterAccount,
    ProviderEncounterTransport,
)
from cosmaneura_scribe.provider_native_core_transport import (
    NATIVE_READ_OPERATIONS,
    ProviderNativeCoreTransport,
)
from cosmaneura_scribe.provider_performance import (
    provider_diagnostic_timing,
    provider_phase_timing,
    provider_request_timing,
)
from cosmaneura_scribe.provider_preparation_core_transport import prepare_then_dispatch
from cosmaneura_scribe.provider_preparation_handoff import PreparationHandoff
from cosmaneura_scribe.provider_source_preparation import prepare_source
from cosmas_os.api.auth import (
    CORE_STAGING_PERSONAL,
    AccessDenied,
    AuthenticationFailed,
    ClerkTokenVerifier,
    CoreProviderIdentity,
    RequestIdentity,
    TokenVerifier,
    authenticate_core_provider,
    authenticate_request,
    core_provider_configuration_valid,
)
from cosmas_os.application import workspace as ws
from cosmas_os.config import Settings
from cosmas_os.models import (
    AppointmentObservation,
    CoreCaptureAccount,
    CoreProviderAccount,
    EncounterWorkspace,
    PatientLink,
    Principal,
)
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import SecretStr
from sqlalchemy import Connection, Engine, or_, select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

_PREFIX = "/provider/v1/"
_CORE = "/service/v1/agent/scribe/"
_LIMITS = {
    "catalog": 2,
    "encounters": 16384,
    "mount": 256,
    "recorder": 1024,
    "note-opening": 1024,
    "source-start": 4096,
    "source-start-ready": 8192,
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
    identity_profile: str = "clerk-organization-v1"

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

        if self.identity_profile not in {"clerk-organization-v1", CORE_STAGING_PERSONAL}:
            raise ValueError("provider_profile_invalid")
        if self.identity_profile == CORE_STAGING_PERSONAL and (
            self.core_origin != "https://staging-app.cosmaneura.com"
            or not self.native_origins <= frozenset({"capacitor://localhost", "app://cosmas"})
            or self.origin
            != (
                "https://cosmaneura-staging-scribe-native."
                "politesmoke-7989878f.northcentralus.azurecontainerapps.io"
            )
        ):
            raise ValueError("provider_profile_invalid")

    def allows_provider_trace(self) -> bool:
        return (
            self.identity_profile == CORE_STAGING_PERSONAL
            and self.core_origin == "https://staging-app.cosmaneura.com"
            and self.origin
            == (
                "https://cosmaneura-staging-scribe-native."
                "politesmoke-7989878f.northcentralus.azurecontainerapps.io"
            )
        )


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
        engine: Engine | AsyncEngine,
        settings: Settings,
        verifier: TokenVerifier,
        workload_token: Callable[[], Awaitable[SecretStr]],
        *,
        enabled: bool = False,
        core_http: httpx.AsyncBaseTransport | None = None,
        core_connections: ProviderCoreConnections | None = None,
        encounter_creation_enabled: bool = False,
        provider_trace_enabled: bool = False,
    ) -> None:
        authentication_valid = not settings.workspace_authentication_errors()
        if profile.identity_profile == CORE_STAGING_PERSONAL:
            authentication_valid = (
                core_provider_configuration_valid(settings)
                and isinstance(verifier, ClerkTokenVerifier)
                and verifier.core_provider_session
                and verifier._settings == settings
            )
        elif isinstance(verifier, ClerkTokenVerifier) and verifier.core_provider_session:
            authentication_valid = False
        if (
            settings.auth_mode != "clerk_jwt"
            or not settings.beta_box_id
            or not authentication_valid
            or not profile.native_origins <= set(settings.allowed_origins)
            or not profile.native_origins <= set(settings.authorized_parties)
        ):
            raise ValueError("provider_authentication_required")
        self.profile, self.engine, self.settings = profile, engine, settings
        self.verifier, self.workload_token = verifier, workload_token
        self.enabled, self.core_http = enabled is True, core_http
        self.core_connections = core_connections
        self.encounter_creation_enabled = encounter_creation_enabled is True
        # Existing personal staging receiver only; no renderer flag or token.
        self._preparation_handoff = (
            PreparationHandoff() if profile.allows_provider_trace() else None
        )
        # This host-only switch is off for general receivers. The personal
        # staging profile above already pins both exact HTTPS origins; caller
        # headers/body can neither enable this trace nor select another host.
        self._provider_trace_enabled = (
            provider_trace_enabled is True and profile.allows_provider_trace()
        )

    async def registry_read[T](self, operation: Callable[[Engine | Connection], T]) -> T:
        with provider_phase_timing("registry"):
            if isinstance(self.engine, AsyncEngine):
                # Each call starts a new, consistent, read-only registry snapshot.
                # Remote operations recheck authority through another fresh call.
                async with self.engine.connect() as connection:
                    connection = await connection.execution_options(
                        isolation_level="REPEATABLE READ",
                        postgresql_readonly=True,
                    )
                    return await connection.run_sync(operation)
            return await run_in_threadpool(operation, self.engine)

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
                with provider_request_timing(
                    action,
                    trace_enabled=self._provider_trace_enabled,
                ) as timing:
                    response = await call_next(request)
                # Same completed handler snapshot as safe logging. Never forward
                # another layer's arbitrary Server-Timing value or add DB work.
                if "server-timing" in response.headers:
                    del response.headers["server-timing"]
                if header := timing.server_timing():
                    response.headers["Server-Timing"] = header
                if "x-scribe-provider-trace" in response.headers:
                    del response.headers["x-scribe-provider-trace"]
                if trace := timing.trace_header():
                    response.headers["X-Scribe-Provider-Trace"] = trace
                # Never forward arbitrary diagnostics from another layer. Old
                # Server-Timing remains byte-compatible; this is optional v1.
                if PROVIDER_CORE_HEADER in response.headers:
                    del response.headers[PROVIDER_CORE_HEADER]
                if core := timing.core_header():
                    response.headers[PROVIDER_CORE_HEADER] = core
                return response
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
                body = await _read(request, _LIMITS[action], private_note=action == "encounters")
                if action == "encounters":
                    _require(self.encounter_creation_enabled)
                    key = request.headers.get("idempotency-key", "")
                    result = await self.encounters(authorization, body, key)
                    return _reply(200, {"revision": str(revision), **result})
                if action == "catalog":
                    _require(not body)
                    rows = await self.registry_read(
                        lambda bind: self.catalog(authorization, bind=bind)
                    )
                    account = None
                    recovery_scope = None
                    if self.encounter_creation_enabled:
                        result = await self.encounters(
                            authorization,
                            {"action": "list", "request_nonce": str(uuid4())},
                            str(uuid4()),
                        )
                        account = result["account"]
                        recovery_scope = str(_uuid(result.get("recoveryScope")))
                        current_rows = result.get("encounters")
                        _require(isinstance(current_rows, list) and len(current_rows) <= 1000)
                        by_appointment = {r["appointmentRef"]: r for r in rows}
                        for raw in current_rows:
                            entry = self.core_entry(raw)
                            existing = by_appointment.get(entry["appointmentRef"])
                            _require(
                                existing is None or existing["workspaceId"] == entry["workspaceId"]
                            )
                            by_appointment[entry["appointmentRef"]] = entry
                        rows = list(by_appointment.values())
                    if not self.enabled:
                        raise AccessDenied()
                    return _reply(
                        200,
                        {
                            "revision": str(revision),
                            "encounters": rows,
                            "opening_review_v1": True,
                            "note_opening_v1": True,
                            **(
                                {
                                    "encounter_creation_v1": True,
                                    "account": account,
                                    "recoveryScope": recovery_scope,
                                    "environment": "Staging",
                                }
                                if self.encounter_creation_enabled
                                else {}
                            ),
                        },
                    )

                workspace_id = _uuid(body.get("workspace_id"))
                key = request.headers.get("idempotency-key", "")
                # Even mount/recorder authorization uses a caller-retained key;
                # capture operations pass that exact key through to existing Core.
                _require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))

                # Read-only compositions can check this receiver's registry on
                # both sides of one Core call. Mutations retain every existing
                # intermediate registry check; a final denial cannot undo them.
                operation = body.get("operation")
                composed_read = action in {"mount", "recorder"} or (
                    action == "capture-operations"
                    and isinstance(operation, dict)
                    and isinstance(operation.get("kind"), str)
                    and operation["kind"] in NATIVE_READ_OPERATIONS
                )
                if (
                    self.encounter_creation_enabled
                    and composed_read
                    and not await self.registry_read(
                        lambda bind: self.legacy_workspace_exists(workspace_id, bind)
                    )
                ):
                    return _reply(
                        200, await self.native_core_read(authorization, revision, action, body, key)
                    )

                preparation = (
                    action == "capture-admissions"
                    and set(body)
                    in (
                        {
                            "workspace_id",
                            "binding_ref",
                            "request_nonce",
                            "attestation",
                            "configured_capture",
                        },
                        {
                            "workspace_id",
                            "binding_ref",
                            "request_nonce",
                            "attestation",
                            "configured_capture",
                            "preparation_metadata",
                        },
                        {
                            "workspace_id",
                            "binding_ref",
                            "request_nonce",
                            "attestation",
                            "configured_capture",
                            "native_recording_preparation",
                        },
                    )
                ) or (
                    action == "capture-operations"
                    and isinstance(operation, dict)
                    and operation.get("kind") == "prepare_recording_window"
                )
                if (
                    self.encounter_creation_enabled
                    and preparation
                    and not await self.registry_read(
                        lambda bind: self.legacy_workspace_exists(workspace_id, bind)
                    )
                ):

                    async def preparation_account():
                        try:
                            if not self.enabled or not self.encounter_creation_enabled:
                                raise AccessDenied()
                            return await self.registry_read(
                                lambda bind: self.encounter_account(authorization, bind=bind)
                            )
                        except AuthenticationFailed:
                            raise ProviderCoreUnavailable(
                                "core_provider_access_unavailable", 401
                            ) from None
                        except (AccessDenied, ws.WorkspaceError):
                            raise ProviderCoreUnavailable(
                                "core_provider_access_unavailable", 403
                            ) from None

                    result = await prepare_then_dispatch(
                        self.profile.core_origin,
                        action,
                        body,
                        key,
                        revision,
                        preparation_account,
                        self.workload_token,
                        transport=self.core_http,
                        connections=self.core_connections,
                        handoff=self._preparation_handoff,
                    )
                    if not self.enabled:
                        raise AccessDenied()
                    return _reply(200, result)

                if (
                    self.encounter_creation_enabled
                    and action == "source-start-ready"
                    and not await self.registry_read(
                        lambda bind: self.legacy_workspace_exists(workspace_id, bind)
                    )
                ):

                    async def source_account():
                        if not self.enabled or not self.encounter_creation_enabled:
                            raise AccessDenied()
                        return await self.registry_read(
                            lambda bind: self.encounter_account(authorization, bind=bind)
                        )

                    prepared_source = await prepare_source(
                        self.profile.core_origin,
                        body,
                        key,
                        revision,
                        source_account,
                        self.workload_token,
                        self._preparation_handoff,
                        transport=self.core_http,
                        connections=self.core_connections,
                    )
                    if prepared_source is not None:
                        if not self.enabled:
                            raise AccessDenied()
                        return _reply(200, prepared_source)

                checked_selection = None

                async def fresh() -> AuthorizedCoreProvider:
                    nonlocal checked_selection
                    if not self.enabled:
                        raise AccessDenied()
                    selected = await self.selected_current(authorization, revision, workspace_id)
                    checked_selection = selected
                    return selected[0]

                transport = ProviderCoreTransport(
                    self.profile.core_origin,
                    fresh,
                    self.workload_token,
                    enabled=True,
                    transport=self.core_http,
                    connections=self.core_connections,
                )
                try:
                    if action == "mount":
                        opening_review = None
                        if "opening_nonce" in body:
                            _require(set(body) == {"workspace_id", "opening_nonce"})
                            mount, opening_review = await transport.open_with_review(
                                _uuid(body["opening_nonce"]),
                                key,
                            )
                        else:
                            _require(set(body) == {"workspace_id"})
                            mount = await transport.open()
                        # The transport's final post-I/O check just supplied
                        # this exact display. No await may intervene before it
                        # is published; do not cache it for another request.
                        _require(checked_selection is not None and self.enabled)
                        context, encounter = checked_selection
                        _require(context.selection == mount.selection)
                        result = {
                            **mount.client_scope(),
                            "encounter": encounter,
                            "revision": str(revision),
                        }
                        if opening_review is not None:
                            result["openingReview"] = opening_review
                    else:
                        context = await fresh()
                        binding = body.get("binding_ref")
                        if not isinstance(binding, str) or not re.fullmatch(
                            r"scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}", binding
                        ):
                            raise InvalidRequest()
                        mount = CoreProviderMount(context.selection, binding)
                        if action == "note-opening":
                            _require(
                                set(body)
                                == {
                                    "workspace_id",
                                    "binding_ref",
                                    "request_nonce",
                                    "expected_session_id",
                                }
                            )
                            result = await transport.open_note(
                                mount,
                                _uuid(body["expected_session_id"]),
                                _uuid(body["request_nonce"]),
                                key,
                            )
                        elif action == "source-start-ready":
                            # Native-only prepare/authorize pair; generic renderer
                            # operations cannot submit either start action.
                            result = await transport.prepare_and_authorize_source(mount, body, key)
                        elif action == "source-start":
                            # Only the native owner uses this endpoint. Generic
                            # renderer capture-operations still rejects its kind.
                            result = await transport.request(
                                mount,
                                _CORE + "capture-operations",
                                body,
                                key,
                                native_start=True,
                            )
                        elif action == "recorder":
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
                                    # This existing read rechecks the configured
                                    # creator/consent and identifies the session,
                                    # including before any transcript exists.
                                    # Capabilities have no session_id.
                                    "operation": {"kind": "creator_review"},
                                },
                                key,
                            )
                            receipt = result.get("receipt")
                            _require(
                                isinstance(receipt, dict)
                                and receipt.get("schema_version") == "1.0"
                                and receipt.get("session_id") == session_id
                            )
                            result = {"revision": str(revision), "session_id": session_id}
                        else:
                            result = await transport.request(mount, _CORE + action, body, key)
                    # Mount assembly has not yielded since its final checked
                    # display. Other operations keep their publication recheck.
                    if action != "mount" and (await fresh()).selection != mount.selection:
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

    def encounter_account(self, authorization, *, bind):
        with Session(bind) as session:
            identity = self.identity(session, authorization)
            account = self.account(session, identity)
            recovery = uuid5(
                self.profile.environment_id,
                f"{identity.box_id}:{identity.principal_id}:{account.id}",
            )
            session_fingerprint = None
            if self.profile.allows_provider_trace():
                # A fresh JWT changes its iat/signature without changing the
                # authenticated Clerk session. Derive this scope only from the
                # existing actual verifier, after current account checks; never
                # use unverified JWT decoding or a renderer-supplied session.
                if not isinstance(self.verifier, ClerkTokenVerifier):
                    raise AuthenticationFailed()
                claims = self.verifier.verify(authorization[7:])
                session_id = claims.get("sid")
                if not isinstance(session_id, str) or not re.fullmatch(
                    r"sess_[A-Za-z0-9_]{1,250}", session_id
                ):
                    raise AuthenticationFailed()
                session_fingerprint = hashlib.sha256(
                    json.dumps(
                        [claims["iss"], claims["sub"], session_id],
                        separators=(",", ":"),
                    ).encode()
                ).digest()
            return ProviderEncounterAccount(
                str(account.id),
                recovery,
                account.core_actor_ref,
                account.core_tenant_ref,
                SecretStr(authorization[7:]),
                session_fingerprint,
            )

    async def encounters(self, authorization, body, key):
        if not self.enabled or not self.encounter_creation_enabled:
            raise AccessDenied()

        async def fresh_account():
            if not self.enabled or not self.encounter_creation_enabled:
                raise AccessDenied()
            return await self.registry_read(
                lambda bind: self.encounter_account(authorization, bind=bind)
            )

        transport = ProviderEncounterTransport(
            self.profile.core_origin,
            fresh_account,
            transport=self.core_http,
            connections=self.core_connections,
        )
        try:
            return await transport.request(body, key)
        finally:
            await transport.close()

    @staticmethod
    def legacy_workspace_exists(workspace_id, bind):
        with Session(bind) as session:
            return (
                session.scalar(
                    select(EncounterWorkspace.id).where(EncounterWorkspace.id == str(workspace_id))
                )
                is not None
            )

    async def native_core_read(self, authorization, revision, action, body, key):
        async def fresh_account():
            try:
                if not self.enabled or not self.encounter_creation_enabled:
                    raise AccessDenied()
                return await self.registry_read(
                    lambda bind: self.encounter_account(authorization, bind=bind)
                )
            except AuthenticationFailed:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 401) from None
            except (AccessDenied, ws.WorkspaceError):
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403) from None

        transport = ProviderNativeCoreTransport(
            self.profile.core_origin,
            fresh_account,
            self.workload_token,
            transport=self.core_http,
            connections=self.core_connections,
        )
        try:
            account, value = await transport.request(
                action,
                body,
                key,
                handoff=self._preparation_handoff,
                revision=revision,
            )
            if not self.enabled:
                raise AccessDenied()
            if action == "recorder":
                return {"revision": str(revision), "session_id": body["session_id"]}
            if action != "mount":
                return value
            row = self.core_entry(value["encounter"])
            _require(
                row["workspaceId"] == str(_uuid(body["workspace_id"]))
                and row["appointmentRef"] == value["appointment_ref"]
            )
            result = {
                "revision": str(revision),
                "recoveryScope": str(account.recovery_scope),
                "workspaceId": row["workspaceId"],
                "appointmentRef": row["appointmentRef"],
                "bindingRef": value["binding_ref"],
                "encounter": {
                    "admission_metadata_v1": True,
                    "native_recording_preparation_v1": True,
                    "admission_native_preparation_v1": True,
                    "appointmentRef": row["appointmentRef"],
                    "title": row["title"],
                    "detail": row["detail"],
                    "patientName": row["patientName"],
                },
            }
            if "opening_review" in value:
                result["openingReview"] = value["opening_review"]
            return result
        finally:
            await transport.close()

    @staticmethod
    def core_entry(value):
        _require(isinstance(value, dict))
        workspace = str(_uuid(value.get("workspace_id")))
        appointment = value.get("appointment_ref")
        _require(
            isinstance(appointment, str)
            and re.fullmatch(r"appointment_[0-7][0-9a-hjkmnp-tv-z]{25}", appointment)
        )
        for name in ("patient_name", "title", "appointment_at"):
            _require(
                isinstance(value.get(name), str)
                and 0 < len(value[name]) <= 200
                and "\x00" not in value[name]
            )
        return {
            "workspaceId": workspace,
            "appointmentRef": appointment,
            "title": value["patient_name"],
            "patientName": value["patient_name"],
            "detail": value["title"] + " · " + value["appointment_at"],
            **({"patientRef": value["patient_ref"]} if "patient_ref" in value else {}),
            **({"dateOfBirth": value["date_of_birth"]} if "date_of_birth" in value else {}),
            **({"status": value["status"]} if "status" in value else {}),
            **({"identity": value["identity"]} if "identity" in value else {}),
        }

    async def selected_current(self, authorization, revision, workspace_id):
        with provider_diagnostic_timing("selection_check"):
            return await self._selected_current(authorization, revision, workspace_id)

    async def _selected_current(self, authorization, revision, workspace_id):
        # Keep the legacy path and its exact recovery IDs. A revoked/tampered
        # legacy workspace must never fall through to another source.
        def legacy_exists(bind):
            with Session(bind) as session:
                return (
                    session.scalar(
                        select(EncounterWorkspace.id).where(
                            EncounterWorkspace.id == str(workspace_id)
                        )
                    )
                    is not None
                )

        if not self.encounter_creation_enabled or await self.registry_read(legacy_exists):
            return await self.registry_read(
                lambda bind: self.selected(authorization, revision, workspace_id, bind=bind)
            )
        account = await self.registry_read(
            lambda bind: self.encounter_account(authorization, bind=bind)
        )
        value = await self.encounters(
            authorization,
            {"action": "lookup", "workspace_id": str(workspace_id), "request_nonce": str(uuid4())},
            str(uuid4()),
        )
        row = self.core_entry(value.get("encounter"))
        _require(row["workspaceId"] == str(workspace_id))
        current = await self.registry_read(
            lambda bind: self.encounter_account(authorization, bind=bind)
        )
        if current != account:
            raise AccessDenied()
        selection = CoreProviderSelection(
            recovery_scope=account.recovery_scope,
            authorization_revision=uuid5(account.recovery_scope, str(revision)),
            workspace_id=workspace_id,
            appointment_ref=row["appointmentRef"],
            actor_ref=account.actor_ref,
            tenant_ref=account.tenant_ref,
        )
        return AuthorizedCoreProvider(selection, account.user_token), {
            "appointmentRef": row["appointmentRef"],
            "title": row["title"],
            "patientName": row["patientName"],
            "detail": row["detail"],
        }

    def identity(
        self, session: Session, authorization: str
    ) -> RequestIdentity | CoreProviderIdentity:
        with provider_diagnostic_timing("identity_check"):
            return self._identity(session, authorization)

    def _identity(
        self, session: Session, authorization: str
    ) -> RequestIdentity | CoreProviderIdentity:
        if self.profile.identity_profile == CORE_STAGING_PERSONAL:
            if not isinstance(self.verifier, ClerkTokenVerifier):
                raise AuthenticationFailed("authentication configuration is unavailable")
            return authenticate_core_provider(
                session,
                self.settings,
                authorization=authorization,
                verifier=self.verifier,
            )
        return authenticate_request(
            session,
            self.settings,
            authorization=authorization,
            box_header=None,
            actor_header=None,
            verifier=self.verifier,
        )

    @staticmethod
    def account(
        session: Session, identity: RequestIdentity | CoreProviderIdentity
    ) -> CoreCaptureAccount | CoreProviderAccount:
        if isinstance(identity, CoreProviderIdentity):
            account = session.scalar(
                select(CoreProviderAccount).where(
                    CoreProviderAccount.id == identity.core_account_id,
                    CoreProviderAccount.box_id == identity.box_id,
                    CoreProviderAccount.principal_id == identity.principal_id,
                    CoreProviderAccount.revoked_at.is_(None),
                )
            )
            if not account or not account.reviewed_by.strip() or not account.evidence_ref.strip():
                raise AccessDenied()
            return account
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

    def selected(
        self,
        authorization: str,
        revision: UUID,
        workspace_id: UUID,
        *,
        bind: Engine | Connection | None = None,
    ):
        selected_bind = bind if bind is not None else self.engine
        if isinstance(selected_bind, AsyncEngine):
            raise InvalidRequest()
        row_locks = not isinstance(self.engine, AsyncEngine)
        with Session(selected_bind) as session:
            identity = self.identity(session, authorization)
            account = self.account(session, identity)
            if row_locks:
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
            else:
                appointment = self.read_only_appointment(session, identity, workspace_id)
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

    @staticmethod
    def read_only_appointment(
        session: Session,
        identity: RequestIdentity | CoreProviderIdentity,
        workspace_id: UUID,
    ) -> AppointmentObservation:
        # Same current-row predicates as _workspace/_encounter, in one query.
        # This path only serves one fresh read-only registry snapshot. Legacy
        # callers retain the original row-locking helpers; no access is cached.
        bind = session.get_bind()
        if not isinstance(bind, Connection):
            raise InvalidRequest()
        options = bind.get_execution_options()
        if (
            options.get("isolation_level") != "REPEATABLE READ"
            or options.get("postgresql_readonly") is not True
        ):
            raise InvalidRequest()
        appointment = session.scalar(
            select(AppointmentObservation)
            .select_from(EncounterWorkspace)
            .join(Principal, Principal.id == EncounterWorkspace.owner_id)
            .join(
                AppointmentObservation,
                AppointmentObservation.id == EncounterWorkspace.appointment_id,
            )
            .join(PatientLink, PatientLink.id == AppointmentObservation.patient_link_id)
            .where(
                EncounterWorkspace.id == str(workspace_id),
                EncounterWorkspace.box_id == identity.box_id,
                EncounterWorkspace.owner_id == identity.principal_id,
                Principal.box_id == identity.box_id,
                Principal.principal_type == "human",
                Principal.state == "active",
                Principal.tombstoned_at.is_(None),
                AppointmentObservation.box_id == identity.box_id,
                PatientLink.box_id == identity.box_id,
                PatientLink.state == "confirmed",
                PatientLink.revoked_at.is_(None),
                or_(
                    EncounterWorkspace.patient_link_id.is_(None),
                    EncounterWorkspace.patient_link_id == AppointmentObservation.patient_link_id,
                ),
            )
            .execution_options(populate_existing=True)
        )
        if appointment is None:
            raise AccessDenied()
        return appointment

    def context(
        self,
        authorization: str,
        revision: UUID,
        workspace_id: UUID,
        *,
        bind: Engine | Connection | None = None,
    ):
        return self.selected(authorization, revision, workspace_id, bind=bind)[0]

    def catalog(self, authorization: str, *, bind: Engine | Connection | None = None):
        selected_bind = bind if bind is not None else self.engine
        if isinstance(selected_bind, AsyncEngine):
            raise InvalidRequest()
        with Session(selected_bind) as session:
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
                        row_locks=not isinstance(self.engine, AsyncEngine),
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
        with Session(selected_bind) as session:
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


async def _read(request: Request, limit: int, *, private_note: bool = False) -> dict:
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
        if private_note and len(data) > 4096:
            _require(
                result.get("action") == "private_note_save"
                and set(result) == {
                    "action", "appointment_ref", "text", "expected_version",
                    "change_key", "request_nonce",
                }
            )
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
