"""Actual provider transports, synthetic Core wire; no audio or account access."""

import asyncio
import copy
import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreTransport, ProviderCoreUnavailable
from cosmaneura_scribe.provider_preparation_core_transport import PATH, prepare_then_dispatch
from cosmaneura_scribe.provider_preparation_handoff import PreparationHandoff
from cosmaneura_scribe.provider_unused_continuation import (
    is_unused_continuation,
    prepare_unused_source,
)
from test_provider_native_core_transport import ACCOUNT
from test_provider_preparation_core_transport import Wire as PreparationWire
from test_provider_source_preparation import ORIGIN, SESSION, SourceWire, window_fixture

pytestmark = pytest.mark.asyncio


class Wire(PreparationWire):
    def __init__(self):
        super().__init__()
        self.source = SourceWire()
        self.workspace = str(uuid4())
        self.revision = uuid4()
        self.now = 100.0
        self.handoff = PreparationHandoff(clock=lambda: self.now)
        self.body, self.answer = window_fixture(self.source, self.workspace)
        self.body["operation"] = {
            "kind": "prepare_continuation_window",
            "payload": {
                "schema_version": "1.0", "channel": "microphone",
                "first_sequence_number": 0,
                "previous_lease_id": str(self.source.lease_id), "previous_lease_generation": 1,
                "renew_idempotency_key": "original-renew-key",
                "reservation_idempotency_key": "original-reserve-key",
            },
        }
        receipt = self.answer["receipt"]
        del receipt["binding"]
        receipt["lease"]["generation"] = 2
        rows = receipt["reservations"]["reservations"]
        receipt["reservations"]["reservations"] = [
            {**rows[0], "object_id": str(uuid4()), "sequence_number": index}
            for index in range(90)
        ]
        self.source_body = self.source.payload(self.workspace, "desktop_companion")
        self.source_body["operation"]["payload"]["lease_generation"] = 2
        self.after = lambda: None
        self.account = ACCOUNT

    async def fresh(self):
        await super().fresh()
        return self.account

    async def handle(self, request):
        data = json.loads(request.content)
        if request.url.path == PATH:
            return await super().handle(request)
        assert request.url.path == "/service/v1/agent/scribe/capture-operations"
        assert request.headers["authorization"] == "Bearer invented-workload-token"
        assert request.headers["x-cosmaneura-mount-context"] == "invented-server-context-token"
        self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
        if self.lose == request.url.path:
            raise httpx.ReadError("synthetic loss")
        if data["operation"]["kind"] == "prepare_continuation_window":
            response = await super().handle(request)
            self.calls.pop()  # Super's one synthetic response, not another I/O.
            value = response.json()
            value["operation"] = "prepare_continuation_window"
            value["receipt"] = self.answer["receipt"]
        else:
            assert data["operation"]["kind"] == "source_start_sequence"
            source_reply = await self.source.handle(httpx.Request(
                "POST", ORIGIN + PATH,
                headers={"authorization": "Bearer invented-user-session-token",
                         "x-cosmaneura-workload-authorization": "Bearer invented-workload-token"},
                json={**data, "action": "prepared_source"},
            ))
            value = source_reply.json()["result"]
        self.after()
        return httpx.Response(
            self.status, json=value,
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Capture-Version": "1"},
        )

    async def continuation(self):
        return await prepare_then_dispatch(
            ORIGIN, "capture-operations", self.body, "original-window-key", self.revision,
            self.fresh, self.workload, handoff=self.handoff,
            transport=httpx.MockTransport(self.handle),
        )

    async def start(self):
        return await prepare_unused_source(
            ORIGIN, self.source_body, "original-prepare-key", self.revision,
            self.fresh, self.workload, self.handoff, transport=httpx.MockTransport(self.handle),
        )


async def test_real_transports_use_three_calls_original_intents_and_destructive_handoff():
    wire = Wire()
    result = await wire.continuation()
    assert result["receipt"] == wire.answer["receipt"]
    assert wire.checks == 7 and len(wire.calls) == 2
    retained = next(iter(wire.handoff._pending.values()))
    assert retained.issued_at == 100 and retained.stage == "unused_continuation_source"
    result = await wire.start()
    assert result["preparation"]["receipt"]["session_id"] == SESSION
    assert len(wire.calls) == 3
    assert wire.calls[1][1] == wire.body
    assert wire.calls[2][1]["operation"]["payload"] == wire.source_body["operation"]["payload"]
    assert wire.calls[2][1]["operation"]["authorize_idempotency_key"] == wire.source.authorize_key
    assert not wire.handoff._pending and await wire.start() is None
    assert len(wire.calls) == 3
    assert "invented-server-context-token" not in str(result)


@pytest.mark.parametrize("boundary", range(1, 8))
async def test_each_continuation_account_fence_refuses_no_retained_context(boundary):
    wire = Wire()
    wire.revoke_at = boundary
    with pytest.raises(ProviderCoreUnavailable):
        await wire.continuation()
    assert not wire.handoff._pending
    assert len(wire.calls) <= 2


@pytest.mark.parametrize(
    "fault", ["session", "lease", "generation", "position", "duplicate", "deadline"]
)
async def test_bad_window_cannot_transfer_credential(fault):
    wire = Wire()
    row = wire.answer["receipt"]
    if fault == "count":
        row["reservations"]["reservations"].pop()
    elif fault == "session":
        row["lease"]["session_id"] = str(uuid4())
    elif fault == "lease":
        row["lease"]["lease_id"] = str(uuid4())
    elif fault == "generation":
        row["lease"]["generation"] = 3
    elif fault == "position":
        row["reservations"]["reservations"][0]["sequence_number"] = 1
    elif fault == "duplicate":
        row["reservations"]["reservations"][1] = row["reservations"]["reservations"][0]
    else:
        row["reservations"]["capture_authorized_until"] = "2099-01-01T00:00:00Z"
    with pytest.raises((ValueError, ProviderCoreUnavailable)):
        await wire.continuation()
    assert not wire.handoff._pending and len(wire.calls) == 2


@pytest.mark.parametrize("boundary", range(1, 6))
async def test_source_account_revocation_keeps_consumed_context(boundary):
    wire = Wire()
    await wire.continuation()
    wire.revoke_at = wire.checks + boundary
    with pytest.raises(ProviderCoreUnavailable):
        await wire.start()
    # A failed first account read has not claimed anything; a later request
    # still has to authenticate afresh before it can claim that exact context.
    if boundary > 1:
        assert not wire.handoff._pending
    assert len(wire.calls) <= 3


@pytest.mark.parametrize(
    "fault",
    ["lease", "receipt", "generation", "source", "position", "account", "revision", "expired"],
)
async def test_foreign_or_expired_source_never_dispatches(fault):
    wire = Wire()
    await wire.continuation()
    payload = wire.source_body["operation"]["payload"]
    if fault in {"lease", "receipt"}:
        payload["lease_id" if fault == "lease" else "lease_receipt_id"] = str(uuid4())
    elif fault == "generation":
        payload["lease_generation"] = 3
    elif fault == "source":
        payload["source"] = "ios_microphone"
    elif fault == "position":
        payload["first_sequence_number"] = 1
    elif fault == "account":
        wire.account = replace(ACCOUNT, actor_ref="different-current-actor")
    elif fault == "revision":
        wire.revision = uuid4()
    else:
        wire.now += 25
    try:
        assert await wire.start() is None
    except ProviderCoreUnavailable:
        pass
    assert len(wire.calls) == 2


async def test_source_cancellation_and_reply_loss_never_fallback_or_refill():
    for cancel in (False, True):
        wire = Wire()
        await wire.continuation()
        original = wire.handle
        entered = asyncio.Event()

        async def fail(request, original=original, entered=entered, cancel=cancel):
            await original(request)
            entered.set()
            if cancel:
                await asyncio.Event().wait()
            raise httpx.ReadError("synthetic response lost")

        wire.handle = fail
        task = asyncio.create_task(wire.start())
        await asyncio.wait_for(entered.wait(), 5)
        if cancel:
            task.cancel()
        with pytest.raises((asyncio.CancelledError, ProviderCoreUnavailable)):
            await task
        assert await wire.start() is None and len(wire.calls) == 3


async def test_other_continuations_cannot_select_this_profile():
    wire = Wire()
    assert is_unused_continuation(wire.body)
    for field, value in [("first_sequence_number", 1), ("previous_lease_generation", 2),
                         ("previous_lease_generation", True), ("channel", "system_audio")]:
        changed = copy.deepcopy(wire.body)
        changed["operation"]["payload"][field] = value
        assert not is_unused_continuation(changed)


async def test_smaller_valid_reservation_budget_keeps_success_without_handoff():
    wire = Wire()
    wire.answer["receipt"]["reservations"]["reservations"].pop()
    reply = await wire.continuation()
    assert len(reply["receipt"]["reservations"]["reservations"]) == 89
    assert not wire.handoff._pending and await wire.start() is None
    assert len(wire.calls) == 2


@pytest.mark.parametrize("cancel", [False, True])
async def test_failed_or_cancelled_owned_close_never_publishes_handoff(monkeypatch, cancel):
    wire = Wire()
    entered = asyncio.Event()
    original = ProviderCoreTransport.close

    async def close(client):
        await original(client)
        entered.set()
        if cancel:
            await asyncio.Event().wait()
        raise RuntimeError("synthetic close failure")

    monkeypatch.setattr(ProviderCoreTransport, "close", close)
    task = asyncio.create_task(wire.continuation())
    await asyncio.wait_for(entered.wait(), 5)
    if cancel:
        task.cancel()
    with pytest.raises((RuntimeError, asyncio.CancelledError)):
        await task
    assert not wire.handoff._pending and len(wire.calls) == 2
