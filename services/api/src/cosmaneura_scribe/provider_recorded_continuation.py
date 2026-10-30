"""One-use negotiation transfer from deliberate Resume to its fresh source.

Only a validated recorded-prefix continuation can enter this path. The
receiver retains no user/workload credential or authorization result. Core
still makes both source decisions against current creator, consent and lease.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

import httpx
from pydantic import SecretStr

from .capture_protocol_v1 import MAX_CHUNKS, MAX_RESERVATIONS_PER_BATCH
from .creator_continuation_routes import CreatorContinuationReceiptV1, CreatorContinuationRequestV1
from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    AuthorizedCoreProvider,
    ProviderCoreTransport,
    ProviderCoreUnavailable,
    core_wire_object,
    core_wire_require,
    source_start_sequence,
)
from .provider_encounter_transport import ProviderEncounterAccount
from .provider_preparation_handoff import (
    PreparationHandoff,
    PreparedContext,
    PreparedContinuationWindow,
)


def is_recorded_continuation(body: dict[str, object]) -> bool:
    try:
        operation = core_wire_object(body.get("operation"))
        if set(operation) != {"kind", "payload"}:
            return False
        if operation["kind"] != "prepare_continuation_window":
            return False
        payload = CreatorContinuationRequestV1.model_validate(operation["payload"])
        return payload.first_sequence_number > 0
    except (ValueError, ProviderCoreUnavailable):
        return False


def retain_recorded_continuation(
    handoff: PreparationHandoff | None,
    origin: str,
    account: ProviderEncounterAccount,
    revision: UUID,
    workspace: str,
    binding: str,
    context: PreparedContext,
    request: dict[str, object],
    answer: dict[str, object],
) -> None:
    if handoff is None or not context.source_start_supported:
        return
    core_wire_require(is_recorded_continuation(request))
    payload = CreatorContinuationRequestV1.model_validate(
        core_wire_object(request["operation"])["payload"]
    )
    receipt = CreatorContinuationReceiptV1.model_validate(answer.get("receipt"))
    lease, batch = receipt.lease, receipt.reservations
    count = len(batch.reservations)
    core_wire_require(
        lease.lease_id == payload.previous_lease_id
        and lease.generation == payload.previous_lease_generation + 1
        and lease.expires_at.tzinfo is not None
        and lease.expires_at > datetime.now(UTC)
        and batch.session_id == lease.session_id
        and batch.capture_authorized_until == lease.expires_at
        and 0 < count <= MAX_RESERVATIONS_PER_BATCH
        and payload.first_sequence_number + count <= MAX_CHUNKS
        and len({row.object_id for row in batch.reservations}) == count
        and all(
            row.session_id == lease.session_id
            and row.channel == payload.channel
            and row.sequence_number == payload.first_sequence_number + index
            for index, row in enumerate(batch.reservations)
        )
    )
    handoff.retain(
        origin, account, revision, workspace, binding,
        replace(
            context, stage="recorded_continuation_source",
            continuation_window=PreparedContinuationWindow(
                lease.session_id, lease.lease_id, lease.receipt_id,
                lease.expires_at, payload.channel, lease.generation,
                payload.first_sequence_number,
            ),
        ),
    )


async def prepare_recorded_source(
    origin: str,
    body: dict[str, object],
    key: str,
    revision: UUID,
    fresh: Callable[[], Awaitable[ProviderEncounterAccount]],
    workload: Callable[[], Awaitable[SecretStr]],
    handoff: PreparationHandoff,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    connections: ProviderCoreConnections | None = None,
) -> dict[str, object] | None:
    """An absent pre-I/O context uses compatibility; any dispatched failure is final."""
    workspace, binding = body.get("workspace_id"), body.get("binding_ref")
    core_wire_require(isinstance(workspace, str) and isinstance(binding, str))
    async with asyncio.timeout(60):
        before = await fresh()
        retained = handoff.take(
            origin, before, revision, cast(str, workspace), cast(str, binding),
            stage="recorded_continuation_source",
        )
        if retained is None:
            return None
        _, intent, _ = source_start_sequence(retained.mount, body, key)
        window = retained.continuation_window
        core_wire_require(
            retained.source_start_supported
            and window is not None
            and intent.source == "desktop_companion"
            and intent.first_sequence_number == window.first_sequence_number
            and intent.lease_generation == window.lease_generation
            and intent.lease_id == window.lease_id
            and intent.lease_receipt_id == window.lease_receipt_id
            and intent.capture_authorized_until == window.capture_authorized_until
            and intent.capture_authorized_until > datetime.now(UTC)
        )
        assert window is not None
        credential = await workload()

        async def current():
            if await fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            core_wire_require(0 <= handoff.now() - retained.issued_at < 30)
            return AuthorizedCoreProvider(retained.mount.selection, before.user_token)

        async def retained_workload():
            return credential

        ordinary = ProviderCoreTransport(
            origin, current, retained_workload, enabled=True,
            transport=transport, connections=connections,
        )
        try:
            await current()
            core_wire_require(0 <= handoff.now() - retained.issued_at < 25)
            result = await ordinary.prepare_and_authorize_source_prepared(
                retained.mount, body, key, token=retained.token,
                interaction_ref=retained.interaction_ref, turn=retained.turn,
                workload=credential,
                expected_first_sequence_number=window.first_sequence_number,
                expected_lease_generation=window.lease_generation,
            )
            prepared = core_wire_object(core_wire_object(result["preparation"])["receipt"])
            core_wire_require(prepared.get("session_id") == str(window.session_id))
        finally:
            await ordinary.close()
        await current()
        task = asyncio.current_task()
        if task is not None and task.cancelling():
            raise asyncio.CancelledError
        return result
