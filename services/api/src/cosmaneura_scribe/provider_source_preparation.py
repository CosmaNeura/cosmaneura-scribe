"""One fresh native source decision using a consumed first-window credential."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

import httpx
from pydantic import SecretStr

from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    ProviderCoreUnavailable,
    core_wire_object,
    core_wire_require,
    core_wire_secret,
    core_wire_snapshot,
    core_wire_uuid,
    provider_cookie_jar,
    source_start_reply,
    source_start_sequence,
)
from .provider_encounter_transport import ProviderEncounterAccount
from .provider_native_core_transport import PATH
from .provider_performance import observe_core_response, provider_phase_timing
from .provider_preparation_handoff import PreparationHandoff


async def prepare_source(
    origin: str,
    body: dict[str, object],
    key: str,
    revision: UUID,
    fresh: Callable[[], Awaitable[ProviderEncounterAccount]],
    workload: Callable[[], Awaitable[SecretStr]],
    handoff: PreparationHandoff | None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    connections: ProviderCoreConnections | None = None,
) -> dict[str, object] | None:
    """A pre-I/O miss selects compatibility; every dispatched failure is final."""
    if handoff is None:
        return None
    payload = core_wire_snapshot(body, 8192)
    workspace = core_wire_uuid(payload.get("workspace_id"))
    binding = payload.get("binding_ref")
    core_wire_require(isinstance(binding, str))
    url = httpx.URL(origin)
    core_wire_require(
        url.scheme == "https"
        and bool(url.host)
        and not url.userinfo
        and url.path == "/"
        and not url.query
        and not url.fragment
    )
    async with asyncio.timeout(60):
        before = await fresh()
        retained = handoff.take(
            origin, before, revision, workspace, cast(str, binding), stage="source_start"
        )
        if retained is None or not retained.source_start_supported:
            return None
        sequence, intent, authorize_nonce = source_start_sequence(retained.mount, payload, key)
        if intent.first_sequence_number != 0 or intent.lease_generation != 1:
            return None
        window = retained.source_window
        core_wire_require(
            window is not None
            and intent.first_sequence_number == 0
            and intent.lease_generation == 1
            and intent.lease_id == window.lease_id
            and intent.lease_receipt_id == window.lease_receipt_id
            and intent.capture_authorized_until == window.capture_authorized_until
            and (window.channel == "microphone" or intent.source == "desktop_companion")
        )
        assert window is not None
        with provider_phase_timing("workload_token"):
            credential = await workload()
        # Preserve the original selection boundaries as current local account
        # snapshots. Core performs current visit/binding/consent checks around
        # both source decisions; these are never cached authority decisions.
        for _ in range(3):
            if await fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        request = {
            **sequence,
            "action": "prepared_source",
            "expected_actor_ref": before.actor_ref,
            "expected_tenant_ref": before.tenant_ref,
            "prepared_context": {
                "context_token": core_wire_secret(retained.token),
                "interaction_ref": retained.interaction_ref,
                "client_turn_id": str(retained.turn),
            },
        }
        try:
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
                            "Authorization": "Bearer " + core_wire_secret(before.user_token),
                            "X-Cosmaneura-Workload-Authorization": "Bearer "
                            + core_wire_secret(credential),
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
                        core_wire_require(
                            response.headers.get_list("x-cosmaneura-native-capture-version")
                            == ["1"]
                            and response.headers.get("content-type", "").split(";", 1)[0]
                            == "application/json"
                            and "no-store" in response.headers.get("cache-control", "").lower()
                        )
                        raw = bytearray()
                        async for chunk in response.aiter_bytes():
                            core_wire_require(len(raw) + len(chunk) <= 16_384)
                            raw.extend(chunk)
                value = core_wire_object(
                    json.loads(
                        raw,
                        object_pairs_hook=_unique,
                        parse_constant=lambda _: core_wire_require(False),
                    )
                )
            core_wire_require(
                set(value) == {"version", "action", "actor_ref", "tenant_ref", "result"}
                and value["version"] == "1"
                and value["action"] == "prepared_source"
                and value["actor_ref"] == before.actor_ref
                and value["tenant_ref"] == before.tenant_ref
            )
            if await fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            result = source_start_reply(
                retained.mount,
                sequence,
                core_wire_object(value["result"]),
                intent,
                authorize_nonce,
                datetime.now(UTC),
            )
            prepared = core_wire_object(core_wire_object(result["preparation"])["receipt"])
            core_wire_require(prepared["session_id"] == str(window.session_id))
            await asyncio.sleep(0)
            if await fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            return result
        except ProviderCoreUnavailable:
            raise
        except (httpx.HTTPError, ValueError, TypeError, KeyError, RecursionError):
            raise ProviderCoreUnavailable("core_provider_request_unconfirmed") from None


def _unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        core_wire_require(key not in result)
        result[key] = value
    return result
