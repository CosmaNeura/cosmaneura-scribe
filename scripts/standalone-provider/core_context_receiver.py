"""Explicit production Core-authority backend; the legacy registry stays intact."""

import inspect
import re
from typing import cast
from uuid import uuid4, uuid5

from cosmaneura_scribe.provider_context_transport import ProviderContextTransport
from cosmaneura_scribe.provider_core_transport import (
    AuthorizedCoreProvider,
    CoreProviderSelection,
    ProviderCoreUnavailable,
)
from cosmaneura_scribe.provider_native_encounter_transport import ProviderNativeEncounterTransport
from fastapi import Request
from fastapi.routing import APIRoute
from receiver import (
    _PREFIX,
    AuthenticationFailed,
    ClerkTokenVerifier,
    ProviderReceiver,
    _read,
    _reply,
    _require,
    _uuid,
)
from sqlalchemy import Engine
from starlette.concurrency import run_in_threadpool


class CoreContextReceiver(ProviderReceiver):
    def __init__(self, profile, engine, settings, verifier, workload_token, **kwargs):
        if (
            engine is not None
            or profile.identity_profile != "clerk-organization-v1"
            or not isinstance(verifier, ClerkTokenVerifier)
            or verifier.core_provider_session
            or verifier._settings != settings
        ):
            raise ValueError("core_context_requires_production_organization")
        # None is never a database fallback: every registry entry point below
        # is replaced or denied, and this mode never creates a SQL engine.
        super().__init__(profile, cast(Engine, None), settings, verifier, workload_token, **kwargs)

    async def registry_read(self, operation):
        value = operation(None)
        if inspect.isawaitable(value):
            return await value
        if value is False:
            return False
        raise ProviderCoreUnavailable("core_registry_backend_unavailable", 403)

    async def _verify(self, token):
        if not self.enabled:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        try:
            claims = await run_in_threadpool(self.verifier.verify, token)
        except AuthenticationFailed:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 401) from None
        if (
            claims.get("iss") != self.settings.clerk_issuer
            or not isinstance(claims.get("sub"), str)
            or not claims["sub"]
            or not isinstance(claims.get("sid"), str)
            or re.fullmatch(r"sess_[A-Za-z0-9_]{1,250}", claims["sid"]) is None
        ):
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 401)
        return {name: claims[name] for name in ("iss", "sub", "sid")}

    async def _context(self, authorization, action):
        transport = ProviderContextTransport(
            self.profile.core_origin,
            self.profile.environment_id,
            str(self.settings.beta_box_id),
            self._verify,
            self.workload_token,
            transport=self.core_http,
            connections=self.core_connections,
        )
        try:
            return await transport.request(authorization, action)
        finally:
            await transport.close()

    async def encounter_account(self, authorization, *, bind):
        return (await self._context(authorization, "connection"))[0]

    @staticmethod
    def legacy_workspace_exists(workspace_id, bind):
        return False

    async def catalog(self, authorization, *, bind=None):
        value = await self.encounters(
            authorization, {"action": "list", "request_nonce": str(uuid4())}, str(uuid4())
        )
        return [self.core_entry(row) for row in value["encounters"]]

    async def encounters(self, authorization, body, key):
        if body.get("action") in {"patients", "create"}:
            if not self.encounter_creation_enabled:
                raise ProviderCoreUnavailable("core_provider_operation_unavailable", 409)

            async def fresh():
                if not self.enabled or not self.encounter_creation_enabled:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                return await self.encounter_account(authorization, bind=None)

            transport = ProviderNativeEncounterTransport(
                self.profile.core_origin,
                fresh,
                self.workload_token,
                transport=self.core_http,
                connections=self.core_connections,
            )
            try:
                return await transport.request(body, key)
            finally:
                await transport.close()
        if body.get("action") not in {
            "list",
            "lookup",
        }:
            raise ProviderCoreUnavailable("core_provider_operation_unavailable", 409)
        expected = {"action", "request_nonce"}
        if body["action"] == "lookup":
            expected.add("workspace_id")
        _require(set(body) == expected and re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))
        nonce = str(_uuid(body.get("request_nonce")))
        if body["action"] == "lookup":
            _uuid(body.get("workspace_id"))
        account, value = await self._context(authorization, "catalog")
        rows = [self.core_entry(row) for row in value["encounters"]]
        if len({row["workspaceId"] for row in rows}) != len(rows) or len(
            {row["appointmentRef"] for row in rows}
        ) != len(rows):
            raise ProviderCoreUnavailable("core_provider_context_unconfirmed")
        current = await self.encounter_account(authorization, bind=None)
        if account != current:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        result = {
            **value,
            "action": body["action"],
            "request_nonce": nonce,
            "recoveryScope": str(account.recovery_scope),
        }
        if body["action"] == "lookup":
            wanted = str(_uuid(body.get("workspace_id")))
            matches = [
                raw
                for raw, row in zip(value["encounters"], rows, strict=True)
                if row["workspaceId"] == wanted
            ]
            if len(matches) != 1:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            result.pop("encounters")
            result["encounter"] = matches[0]
        return result

    async def _selected_current(self, authorization, revision, workspace_id):
        account = await self.encounter_account(authorization, bind=None)
        value = await self.encounters(
            authorization,
            {"action": "lookup", "workspace_id": str(workspace_id), "request_nonce": str(uuid4())},
            str(uuid4()),
        )
        row = self.core_entry(value["encounter"])
        if await self.encounter_account(authorization, bind=None) != account:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        selection = CoreProviderSelection(
            recovery_scope=account.recovery_scope,
            authorization_revision=uuid5(account.recovery_scope, str(revision)),
            workspace_id=workspace_id,
            appointment_ref=row["appointmentRef"],
            actor_ref=account.actor_ref,
            tenant_ref=account.tenant_ref,
        )
        return AuthorizedCoreProvider(selection, account.user_token), self.core_display(row)

    def identity(self, *args, **kwargs):
        raise ProviderCoreUnavailable("core_registry_backend_unavailable", 403)

    account = selected = read_only_appointment = context = identity

    def app(self):
        app = super().app()

        async def catalog(request: Request):
            try:
                revision = _uuid(request.headers.get("x-scribe-native-revision"))
                _require(not await _read(request, 2))
                value = await self.encounters(
                    request.headers.get("authorization", ""),
                    {"action": "list", "request_nonce": str(uuid4())},
                    str(uuid4()),
                )
                rows = [self.core_entry(row) for row in value["encounters"]]
                _require(self.enabled)
                return _reply(
                    200,
                    {
                        "revision": str(revision),
                        "encounters": rows,
                        "opening_review_v1": True,
                        "note_opening_v1": True,
                        "encounter_creation_v1": self.encounter_creation_enabled,
                        **(
                            {"existing_patient_visits_v1": True}
                            if self.encounter_creation_enabled
                            else {}
                        ),
                        "account": value["account"],
                        "recoveryScope": value["recoveryScope"],
                        "environment": "Production",
                    },
                )
            except ProviderCoreUnavailable as error:
                return _reply(error.status, {"code": error.code})
            except Exception:
                return _reply(403, {"code": "provider_request_denied"})

        # Keep the legacy shared boundary middleware; only this explicit mode's
        # catalog route precedes its generic provider-action route.
        app.router.routes.insert(
            0, APIRoute(_PREFIX + "catalog", catalog, methods=["POST"], include_in_schema=False)
        )
        return app
