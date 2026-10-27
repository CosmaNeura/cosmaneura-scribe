"""One-use credential transfer for the first expired, never-recorded window.

This is not retained authority. The existing Core continuation and source
sequence routes still check the current creator, consent, binding and lease.
Other generations and any previously recorded prefix use normal negotiation.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import cast
from uuid import UUID

import httpx
from pydantic import SecretStr

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
from .provider_preparation_handoff import PreparationHandoff, PreparedContext, PreparedSourceWindow


def is_unused_continuation(body: dict[str, object]) -> bool:
    try:
        operation = core_wire_object(body.get("operation"))
        if set(operation) != {"kind", "payload"}:
            return False
        if operation["kind"] != "prepare_continuation_window":
            return False
        payload = CreatorContinuationRequestV1.model_validate(operation["payload"])
        return payload.first_sequence_number == 0 and payload.previous_lease_generation == 1
    except (ValueError, ProviderCoreUnavailable):
        return False


def retain_unused_continuation(
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
    if handoff is None:
        return
    core_wire_require(is_unused_continuation(request))
    payload = CreatorContinuationRequestV1.model_validate(
        core_wire_object(request["operation"])["payload"]
    )
    receipt = CreatorContinuationReceiptV1.model_validate(answer.get("receipt"))
    lease, batch = receipt.lease, receipt.reservations
    # The ordinary server may legitimately reserve a smaller budget. Preserve
    # its successful reply; only the demonstrated ninety-slot shape can transfer.
    if len(batch.reservations) != 90:
        return
    core_wire_require(
        lease.lease_id == payload.previous_lease_id
        and lease.generation == 2
        and batch.session_id == lease.session_id
        and batch.capture_authorized_until == lease.expires_at
        and len({row.object_id for row in batch.reservations}) == 90
        and all(
            row.session_id == lease.session_id
            and row.channel == payload.channel
            and row.sequence_number == index
            for index, row in enumerate(batch.reservations)
        )
    )
    handoff.retain(
        origin, account, revision, workspace, binding,
        replace(
            context, stage="unused_continuation_source",
            source_window=PreparedSourceWindow(
                lease.session_id, lease.lease_id, lease.receipt_id,
                lease.expires_at, payload.channel,
            ),
        ),
    )


async def prepare_unused_source(
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
    """Only a pre-I/O cache miss may use compatibility. Never retry a decision."""
    workspace, binding = body.get("workspace_id"), body.get("binding_ref")
    core_wire_require(isinstance(workspace, str) and isinstance(binding, str))
    async with asyncio.timeout(60):
        before = await fresh()
        retained = handoff.take(
            origin, before, revision, cast(str, workspace), cast(str, binding),
            stage="unused_continuation_source",
        )
        if retained is None:
            return None
        _, intent, _ = source_start_sequence(retained.mount, body, key)
        window = retained.source_window
        core_wire_require(
            window is not None
            and intent.source == "desktop_companion"
            and intent.first_sequence_number == 0
            and intent.lease_generation == 2
            and intent.lease_id == window.lease_id
            and intent.lease_receipt_id == window.lease_receipt_id
            and intent.capture_authorized_until == window.capture_authorized_until
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
            # Recheck original age after any awaited credential/current work.
            await current()
            core_wire_require(0 <= handoff.now() - retained.issued_at < 25)
            result = await ordinary.prepare_and_authorize_source_prepared(
                retained.mount, body, key, token=retained.token,
                interaction_ref=retained.interaction_ref, turn=retained.turn,
                workload=credential,
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
