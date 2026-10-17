"""Fixed server-only setup, followed by the ordinary fenced capture mutation."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import UUID, uuid5

import httpx
from pydantic import SecretStr

from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    ADMISSION_TOTAL_TIMEOUT_SECONDS,
    AuthorizedCoreProvider,
    CoreProviderMount,
    CoreProviderSelection,
    ProviderCoreTransport,
    ProviderCoreUnavailable,
    provider_cookie_jar,
)
from .provider_core_transport import (
    core_wire_object as obj,
)
from .provider_core_transport import (
    core_wire_require as need,
)
from .provider_core_transport import (
    core_wire_secret as secret,
)
from .provider_core_transport import (
    core_wire_snapshot as snapshot,
)
from .provider_core_transport import (
    core_wire_uuid as uid,
)
from .provider_encounter_transport import ProviderEncounterAccount
from .provider_native_core_transport import PreparationMetadata, ProviderNativeCoreTransport
from .provider_performance import observe_core_response, provider_phase_timing
from .provider_preparation_handoff import (
    PreparationHandoff,
    PreparedContext,
    retain_source_window,
)

PATH = "/service/v1/agent/scribe/native-capture"


async def prepare_then_dispatch(
    origin: str,
    action: str,
    body: dict[str, object],
    key: str,
    revision: UUID,
    fresh: Callable[[], Awaitable[ProviderEncounterAccount]],
    workload: Callable[[], Awaitable[SecretStr]],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    connections: ProviderCoreConnections | None = None,
    handoff: PreparationHandoff | None = None,
) -> dict[str, object]:
    """No credential/context is returned to the receiver caller or device."""
    need(action in {"capture-admissions", "capture-operations"})
    payload = snapshot(body, 2048 if action == "capture-admissions" else 4_194_304)
    metadata_requested = "preparation_metadata" in payload
    if metadata_requested:
        need(
            action == "capture-admissions"
            and payload.pop("preparation_metadata") is True
            and payload.get("attestation") is not None
        )
    native_metadata_requested = "native_recording_preparation" in payload
    if native_metadata_requested:
        need(
            action == "capture-admissions"
            and payload.pop("native_recording_preparation") is True
            and payload.get("attestation") is not None
            and not metadata_requested
        )
    workspace = uid(payload.get("workspace_id"))
    nonce = uid(payload.get("request_nonce"))
    binding = payload.get("binding_ref")
    need(
        isinstance(binding, str)
        and re.fullmatch(r"scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}", binding)
    )
    need(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))
    preparation = "admission" if action == "capture-admissions" else "recording_window"
    need(
        (
            action == "capture-admissions"
            and set(payload)
            == {"workspace_id", "binding_ref", "request_nonce", "attestation", "configured_capture"}
        )
        or (
            action == "capture-operations"
            and set(payload) == {"workspace_id", "binding_ref", "request_nonce", "operation"}
            and obj(payload["operation"]).get("kind") == "prepare_recording_window"
        )
    )
    url = httpx.URL(origin)
    need(
        url.scheme == "https"
        and bool(url.host)
        and not url.userinfo
        and url.path == "/"
        and not url.query
        and not url.fragment
    )
    # Both remote calls own one whole timeout. This is transport waiting only;
    # it does not extend Core's admission, lease or source authorization budget.
    async with asyncio.timeout(
        ADMISSION_TOTAL_TIMEOUT_SECONDS if preparation == "admission" else 60
    ):
        before = await fresh()
        with provider_phase_timing("workload_token"):
            credential = await workload()
        token = secret(credential)
        user = secret(before.user_token)
        if await fresh() != before:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        retained = (
            handoff.take(origin, before, revision, workspace, cast(str, binding), stage=preparation)
            if handoff is not None
            else None
        )
        prepared_answer = None
        native_read_supported = retained.native_read_supported if retained is not None else False
        source_start_supported = retained.source_start_supported if retained is not None else False
        combined_native_metadata = (
            native_metadata_requested
            and retained is not None
            and retained.admission_native_preparation_supported
        )
        combined_metadata = (
            metadata_requested
            and retained is not None
            and retained.admission_preparation_metadata_supported
        )
        if retained is not None:
            # Core receiver-first: retain the native route's current Clerk,
            # agent-workload, capture-workload and visit-policy boundaries.
            # This is one fixed first-window action, never a generic mutation.
            native = ProviderNativeCoreTransport(
                origin, fresh, workload, transport=transport, connections=connections
            )
            try:
                prepared_answer = await native.prepared_operation(
                    payload,
                    key,
                    before,
                    retained,
                    credential,
                    admission=preparation == "admission",
                    admission_native_preparation=combined_native_metadata,
                    admission_preparation_metadata=combined_metadata,
                )
            finally:
                await native.close()
            if preparation != "admission":
                retain_source_window(
                    handoff,
                    origin,
                    before,
                    revision,
                    workspace,
                    cast(str, binding),
                    retained,
                    payload,
                    prepared_answer,
                )
                return prepared_answer
        if retained is not None:
            issued_at = retained.issued_at
            mount = retained.mount
            selection = mount.selection
            context = retained.token
            interaction = retained.interaction_ref
            turn = retained.turn
        else:
            issued_at = handoff.now() if handoff is not None else 0.0
            request = {
                "action": "preparation_context",
                "preparation": preparation,
                "workspace_id": workspace,
                "binding_ref": binding,
                "request_nonce": nonce,
                "expected_actor_ref": before.actor_ref,
                "expected_tenant_ref": before.tenant_ref,
            }
            async with httpx.AsyncClient(
                transport=connections.borrow(origin) if connections else transport,
                trust_env=False,
                follow_redirects=False,
                cookies=provider_cookie_jar(),
                timeout=httpx.Timeout(40, connect=5),
            ) as client:
                with provider_phase_timing("core_operation"):
                    async with client.stream(
                        "POST",
                        origin.rstrip("/") + PATH,
                        content=json.dumps(request, allow_nan=False).encode(),
                        headers={
                            "Authorization": "Bearer " + user,
                            "X-Cosmaneura-Workload-Authorization": "Bearer " + token,
                            "X-Cosmaneura-Native-Capture-Version": "1",
                            "Idempotency-Key": key,
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "Cache-Control": "no-store",
                        },
                    ) as response:
                        observe_core_response(response.headers)
                        if response.status_code != 200:
                            raise ProviderCoreUnavailable(
                                "core_provider_request_unconfirmed",
                                response.status_code
                                if response.status_code in {401, 403, 409, 422}
                                else 503,
                            )
                        need(
                            response.headers.get("x-cosmaneura-native-capture-version") == "1"
                            and response.headers.get("content-type", "").split(";", 1)[0]
                            == "application/json"
                            and "no-store" in response.headers.get("cache-control", "").lower()
                        )
                        native_read_supported = response.headers.get_list(
                            "x-cosmaneura-prepared-native-read-version"
                        ) == ["1"]
                        source_start_supported = response.headers.get_list(
                            "x-cosmaneura-prepared-source-start-version"
                        ) == ["1"]
                        combined_native_metadata = native_metadata_requested and (
                            response.headers.get_list(
                                "x-cosmaneura-admission-native-preparation-version"
                            )
                            == ["1"]
                        )
                        combined_metadata = metadata_requested and (
                            response.headers.get_list(
                                "x-cosmaneura-admission-preparation-metadata-version"
                            )
                            == ["1"]
                        )
                        raw = bytearray()
                        async for chunk in response.aiter_bytes():
                            need(len(raw) + len(chunk) <= 16384)
                            raw.extend(chunk)
                value = obj(
                    json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: need(False))
                )
                need(
                    set(value) == {"version", "action", "actor_ref", "tenant_ref", "result"}
                    and value["version"] == "1"
                    and value["action"] == "preparation_context"
                    and value["actor_ref"] == before.actor_ref
                    and value["tenant_ref"] == before.tenant_ref
                )
                result = obj(value["result"])
                need(
                    set(result)
                    == {
                        "contract_version",
                        "workspace_id",
                        "binding_ref",
                        "request_nonce",
                        "checked_at",
                        "appointment_ref",
                        "preparation",
                        "context_token",
                        "interaction_ref",
                        "client_turn_id",
                    }
                )
                need(
                    result["contract_version"] == "1"
                    and result["workspace_id"] == workspace
                    and result["binding_ref"] == binding
                    and result["request_nonce"] == nonce
                    and result["preparation"] == preparation
                )
                stamp = datetime.fromisoformat(str(result["checked_at"]))
                need(
                    stamp.tzinfo is not None
                    and datetime.now(UTC) - timedelta(seconds=30)
                    <= stamp
                    <= datetime.now(UTC) + timedelta(seconds=5)
                )
                appointment = result["appointment_ref"]
                interaction = result["interaction_ref"]
                need(
                    isinstance(appointment, str)
                    and re.fullmatch(r"appointment_[0-7][0-9a-hjkmnp-tv-z]{25}", appointment)
                    and isinstance(interaction, str)
                    and re.fullmatch(r"[A-Za-z0-9._~-]{16,160}", interaction)
                )
                need(isinstance(result["context_token"], str))
                context = SecretStr(cast(str, result["context_token"]))
                secret(context)
                turn = UUID(uid(result["client_turn_id"]))
            selection = CoreProviderSelection(
                before.recovery_scope,
                uuid5(before.recovery_scope, str(revision)),
                UUID(workspace),
                cast(str, appointment),
                before.actor_ref,
                before.tenant_ref,
            )
            mount = CoreProviderMount(selection, cast(str, binding))

        if await fresh() != before:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)

        if retained is None and (combined_native_metadata or combined_metadata):
            # Use only this invocation's freshly validated, advertised context.
            # A missing capability selects compatibility before admission I/O;
            # a dispatched failure never retries or returns partial admission.
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise asyncio.CancelledError
            if handoff is not None:
                need(0 <= handoff.now() - issued_at < 15)
            native = ProviderNativeCoreTransport(
                origin, fresh, workload, transport=transport, connections=connections
            )
            try:
                prepared_answer = await native.prepared_operation(
                    payload,
                    key,
                    before,
                    PreparedContext(mount, context, cast(str, interaction), turn, issued_at),
                    credential,
                    admission=True,
                    admission_native_preparation=combined_native_metadata,
                    admission_preparation_metadata=combined_metadata,
                )
            finally:
                await native.close()
            if task is not None and task.cancelling():
                raise asyncio.CancelledError
            if handoff is not None:
                need(0 <= handoff.now() - issued_at < 30)
            # Core retains the combined operation's intermediate admission and
            # metadata authority checks. Keep both receiver metadata-publication
            # snapshots as well as the existing final snapshot below (nine total).
            for _ in range(2):
                if await fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)

        async def current():
            if await fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            return AuthorizedCoreProvider(selection, before.user_token)

        async def retained_workload():
            return credential

        ordinary = ProviderCoreTransport(
            origin,
            current,
            retained_workload,
            enabled=True,
            transport=transport,
            connections=connections,
        )
        try:
            # The ordinary dispatcher still checks directly before mutation and
            # after response; final publication is an additional local fence.
            answer = (
                prepared_answer
                if prepared_answer is not None
                else await ordinary.request_prepared(
                    mount,
                    "/service/v1/agent/scribe/" + action,
                    payload,
                    key,
                    token=context,
                    interaction_ref=cast(str, interaction),
                    turn=turn,
                    workload=credential,
                )
            )
            if await fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            if native_metadata_requested and not combined_native_metadata:
                # Old Core takes the original read path. This is a supported
                # compatibility choice made before I/O, never failure fallback.
                native = ProviderNativeCoreTransport(
                    origin, fresh, workload, transport=transport, connections=connections
                )
                try:
                    _, metadata = await native.request(
                        "capture-operations",
                        {
                            "workspace_id": workspace,
                            "binding_ref": binding,
                            "request_nonce": nonce,
                            "operation": {"kind": "native_recording_preparation"},
                        },
                        str(uuid5(revision, "admission-native-metadata:" + key)),
                    )
                finally:
                    await native.close()
                need(obj(obj(metadata["receipt"])["context"])["session_id"] == answer["session_id"])
                if await fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                answer = {
                    **answer,
                    "native_recording_preparation": metadata["receipt"],
                    "checked_at": metadata["checked_at"],
                }
            if metadata_requested and not combined_metadata:
                # Read after the ordinary admission and its publication fence.
                # Reuse only this invocation's negotiation; the ordinary read
                # rechecks local access around I/O and Core authorizes afresh.
                metadata = await ordinary.request_prepared(
                    mount,
                    "/service/v1/agent/scribe/capture-operations",
                    {
                        "workspace_id": workspace,
                        "binding_ref": binding,
                        "request_nonce": nonce,
                        "operation": {"kind": "preparation_metadata"},
                    },
                    str(uuid5(revision, "admission-metadata:" + key)),
                    token=context,
                    interaction_ref=cast(str, interaction),
                    turn=turn,
                    workload=credential,
                )
                try:
                    receipt = PreparationMetadata.model_validate(metadata.get("receipt"))
                except ValueError:
                    raise ProviderCoreUnavailable() from None
                need(receipt.review.session_id == UUID(uid(answer.get("session_id"))))
                public = obj(obj(metadata["receipt"])["encryption_key"])
                wrapping = obj(public.get("public_jwk"))
                need(
                    set(public) == {"key_version", "algorithm", "public_jwk"}
                    and set(wrapping) == {"kty", "n", "e", "alg", "ext", "key_ops"}
                    and wrapping.get("key_ops") == ["wrapKey"]
                )
                if await fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                answer = {
                    **answer,
                    "checked_at": metadata["checked_at"],
                    "preparation_metadata": receipt.model_dump(mode="json"),
                }
            if action == "capture-admissions" and handoff is not None:
                # Publish only after every requested admission/metadata fence.
                # Store the credential, never the fresh account/access result.
                handoff.retain(
                    origin,
                    before,
                    revision,
                    workspace,
                    cast(str, binding),
                    PreparedContext(
                        mount,
                        context,
                        cast(str, interaction),
                        turn,
                        issued_at,
                        native_read_supported=native_read_supported,
                        native_read_done=native_metadata_requested,
                        source_start_supported=source_start_supported,
                    ),
                )
            return answer
        finally:
            await ordinary.close()


def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ProviderCoreUnavailable()
        value[key] = item
    return value
