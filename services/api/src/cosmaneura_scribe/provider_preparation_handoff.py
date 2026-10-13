"""Single-use server credential handoff; never an authorization result."""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import SecretStr

from .provider_core_transport import CoreProviderMount
from .provider_encounter_transport import ProviderEncounterAccount


@dataclass(frozen=True, repr=False)
class PreparedContext:
    mount: CoreProviderMount
    token: SecretStr
    interaction_ref: str
    turn: UUID
    issued_at: float
    stage: Literal["admission", "recording_window"] = "recording_window"
    native_read_done: bool = False
    native_read_supported: bool = False
    admission_native_preparation_supported: bool = False
    admission_preparation_metadata_supported: bool = False


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
        stage: Literal["admission", "recording_window"] = "recording_window",
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
