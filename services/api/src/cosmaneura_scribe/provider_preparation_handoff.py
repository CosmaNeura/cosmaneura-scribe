"""Single-use server credential handoff; never an authorization result."""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Literal, cast
from uuid import UUID, uuid4

from pydantic import SecretStr

from .provider_core_transport import CoreProviderMount, ProviderCoreUnavailable
from .provider_encounter_transport import ProviderEncounterAccount


@dataclass(frozen=True, repr=False)
class PreparedSourceWindow:
    session_id: UUID
    lease_id: UUID
    lease_receipt_id: UUID
    capture_authorized_until: datetime
    channel: Literal["microphone", "mixed"]


@dataclass(frozen=True, repr=False)
class PreparedContext:
    mount: CoreProviderMount
    token: SecretStr
    interaction_ref: str
    turn: UUID
    issued_at: float
    stage: Literal[
        "admission", "recording_window", "source_start", "unused_continuation_source"
    ] = "recording_window"
    native_read_done: bool = False
    native_read_supported: bool = False
    admission_native_preparation_supported: bool = False
    admission_preparation_metadata_supported: bool = False
    source_start_supported: bool = False
    source_window: PreparedSourceWindow | None = None


class PreparationHandoff:
    """Keep at most 64 opaque contexts for thirty seconds in this receiver only.

    No user/workload credential or access decision is retained. The
    caller supplies a freshly authenticated account when taking a context, and
    Core must reauthorize the existing token, binding and consent normally.
    Taking is synchronous and destructive, including on a subsequent failure.
    One successful native preparation read may hand the same credential onward
    to the first window, with its original issue time and a consumed-read marker.
    A miss uses the original negotiation before any mutation; failed mutations
    never retry or fall back. Process restart needs no recovery state.
    """

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._pending: OrderedDict[tuple[object, ...], PreparedContext] = OrderedDict()
        self._expiry_handle: asyncio.TimerHandle | None = None
        # Protocol metadata only: no token, consent or authorization snapshot.
        # It can outlive context TTL under the exact current mounted scope.
        self._compound: OrderedDict[tuple[object, ...], UUID | None] = OrderedDict()
        # Counts belong to the scope, including older remount generations.
        # Only confirmed owning-transport cleanup releases an active call.
        self._compound_active: dict[tuple[object, ...], int] = {}

    def _scope(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
    ) -> tuple[object, ...]:
        return (
            origin.rstrip("/"),
            account.account_id,
            account.recovery_scope,
            account.actor_ref,
            account.tenant_ref,
            ("session", account.session_fingerprint)
            if account.session_fingerprint is not None
            else (
                "token",
                hashlib.sha256(account.user_token.get_secret_value().encode()).digest(),
            ),
            revision,
            workspace,
            binding,
        )

    def advertise_compound(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
        *,
        supported: bool,
    ) -> None:
        """Only a completely validated current mount response calls this seam."""
        if type(supported) is not bool:
            raise ValueError("invalid_compound_advertisement")
        scope = self._scope(origin, account, revision, workspace, binding)
        if supported:
            scopes = self._compound.keys() | self._compound_active.keys()
            if scope not in scopes and len(scopes) >= 64:
                idle = next(
                    (
                        key
                        for key, generation in self._compound.items()
                        if generation is not None and key not in self._compound_active
                    ),
                    None,
                )
                if idle is None:
                    raise ProviderCoreUnavailable("core_provider_mount_required", 409)
                del self._compound[idle]
            self._compound.pop(scope, None)
            self._compound[scope] = uuid4()
        else:
            self._compound.pop(scope, None)

    def compound_capability(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
    ) -> UUID | None:
        # Caller must supply its just-authenticated account, not a saved claim.
        scope = self._scope(origin, account, revision, workspace, binding)
        if scope in self._compound and self._compound[scope] is None:
            raise ProviderCoreUnavailable("core_provider_mount_required", 409)
        return self._compound.get(scope)

    def acquire_compound(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
    ) -> UUID | None:
        """Atomically count only a call that will dispatch this capability."""
        generation = self.compound_capability(origin, account, revision, workspace, binding)
        if generation is not None:
            scope = self._scope(origin, account, revision, workspace, binding)
            self._compound_active[scope] = self._compound_active.get(scope, 0) + 1
            self._compound.move_to_end(scope)
        return generation

    def release_compound(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
    ) -> None:
        """Release an exact settled call even if a remount replaced metadata."""
        scope = self._scope(origin, account, revision, workspace, binding)
        active = self._compound_active.get(scope)
        if active is None:
            return
        if active == 1:
            del self._compound_active[scope]
        else:
            self._compound_active[scope] = active - 1
        if self._compound.get(scope) is not None:
            self._compound.move_to_end(scope)

    def invalidate_compound(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
        generation: UUID,
    ) -> None:
        scope = self._scope(origin, account, revision, workspace, binding)
        if self._compound.get(scope) == generation:
            self._compound[scope] = None

    def close(self) -> None:
        """Discard process-local state when its owning receiver is disposed."""
        if self._expiry_handle is not None:
            self._expiry_handle.cancel()
            self._expiry_handle = None
        self._pending.clear()
        self._compound.clear()
        self._compound_active.clear()

    def _expire(self) -> None:
        now = self._clock()
        for key, value in list(self._pending.items()):
            if not 0 <= now - value.issued_at < 30:
                del self._pending[key]

    def take(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
        stage: Literal[
            "admission", "recording_window", "source_start", "unused_continuation_source"
        ] = "recording_window",
    ) -> PreparedContext | None:
        self._expire()
        value = self._pending.pop(self._scope(origin, account, revision, workspace, binding), None)
        # Leave room for real service work; a user who pauses at consent gets
        # fresh negotiation before any mutation, rather than mid-step expiry.
        max_age = 15 if stage == "admission" else 25
        return (
            value
            if value is not None
            and value.stage == stage
            and 0 <= self._clock() - value.issued_at < max_age
            else None
        )

    def retain(
        self,
        origin: str,
        account: ProviderEncounterAccount,
        revision: UUID,
        workspace: str,
        binding: str,
        context: PreparedContext,
    ) -> None:
        self._expire()
        if not 0 <= self._clock() - context.issued_at < 30:
            return
        key = self._scope(origin, account, revision, workspace, binding)
        self._pending.pop(key, None)
        while len(self._pending) >= 64:
            self._pending.popitem(last=False)
        self._pending[key] = context
        if self._expiry_handle is None:
            self._expiry_handle = asyncio.get_running_loop().call_later(
                min(30 - (self._clock() - row.issued_at) for row in self._pending.values()),
                self._discard_expired,
            )

    def _discard_expired(self) -> None:
        self._expiry_handle = None
        self._expire()
        if self._pending:
            remaining = min(30 - (self._clock() - row.issued_at) for row in self._pending.values())
            self._expiry_handle = asyncio.get_running_loop().call_later(
                remaining, self._discard_expired
            )

    def now(self) -> float:
        return self._clock()


def retain_source_window(
    handoff: PreparationHandoff | None,
    origin: str,
    account: ProviderEncounterAccount,
    revision: UUID,
    workspace: str,
    binding: str,
    context: PreparedContext | None,
    request: dict[str, object],
    answer: dict[str, object],
) -> None:
    """Carry one fresh window's credential, never its authority or a new epoch."""
    if handoff is None or context is None or not context.source_start_supported:
        return
    from .creator_window_routes import CreatorWindowReceipt, CreatorWindowRequest
    from .provider_core_transport import ProviderCoreUnavailable

    try:
        operation = request["operation"]
        if not isinstance(operation, dict):
            raise ValueError
        operation = cast(dict[str, object], operation)
        if operation.get("kind") != "prepare_recording_window":
            raise ValueError
        payload = CreatorWindowRequest.model_validate(operation["payload"])
        receipt = CreatorWindowReceipt.model_validate(answer["receipt"])
        lease, batch = receipt.lease, receipt.reservations
        if (
            payload.channel not in {"microphone", "mixed"}
            or lease.generation != 1
            or payload.reservation_count != 30
        ):
            return
        if (
            receipt.binding.key_version != payload.binding.key_version
            or receipt.binding.session_id != lease.session_id
            or batch.session_id != lease.session_id
            or batch.capture_authorized_until != lease.expires_at
            or lease.expires_at.tzinfo is None
            or len(batch.reservations) != 30
            or len({row.object_id for row in batch.reservations}) != 30
            or any(
                row.session_id != lease.session_id
                or row.channel != payload.channel
                or row.sequence_number != index
                for index, row in enumerate(batch.reservations)
            )
        ):
            raise ValueError
        window = PreparedSourceWindow(
            lease.session_id,
            lease.lease_id,
            lease.receipt_id,
            lease.expires_at,
            cast(Literal["microphone", "mixed"], payload.channel.value),
        )
    except (ValueError, TypeError, KeyError):
        raise ProviderCoreUnavailable() from None
    handoff.retain(
        origin,
        account,
        revision,
        workspace,
        binding,
        replace(context, stage="source_start", source_window=window),
    )
