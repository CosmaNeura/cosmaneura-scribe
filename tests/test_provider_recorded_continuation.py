"""Recorded Resume reuses negotiation once; source authority remains fresh."""

import asyncio
import copy
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_recorded_continuation import (
    is_recorded_continuation,
    prepare_recorded_source,
)
from test_provider_native_core_transport import ACCOUNT
from test_provider_preparation_core_transport import PATH
from test_provider_unused_continuation import Wire as UnusedWire

pytestmark = pytest.mark.asyncio


class Wire(UnusedWire):
    def __init__(self, first=2, previous_generation=1):
        super().__init__()
        self.supported = True
        payload = self.body["operation"]["payload"]
        payload["first_sequence_number"] = first
        payload["previous_lease_generation"] = previous_generation
        self.answer["receipt"]["lease"]["generation"] = previous_generation + 1
        for index, row in enumerate(self.answer["receipt"]["reservations"]["reservations"]):
            row["sequence_number"] = first + index
        self.source_body["operation"]["payload"].update(
            first_sequence_number=first, lease_generation=previous_generation + 1,
        )

    async def handle(self, request):
        response = await super().handle(request)
        if request.url.path == PATH and self.supported:
            response.headers["x-cosmaneura-prepared-source-start-version"] = "1"
        return response

    async def start(self):
        return await prepare_recorded_source(
            "https://core.synthetic.invalid", self.source_body, "original-prepare-key",
            self.revision, self.fresh, self.workload, self.handoff,
            transport=httpx.MockTransport(self.handle),
        )


@pytest.mark.parametrize("first,generation", [(2, 1), (50, 3)])
async def test_recorded_resume_keeps_original_intents_and_uses_one_fresh_source_request(
    first, generation,
):
    wire = Wire(first, generation)
    result = await wire.continuation()
    assert result["receipt"] == wire.answer["receipt"] and len(wire.calls) == 2
    retained = next(iter(wire.handoff._pending.values()))
    assert retained.issued_at == 100 and retained.stage == "recorded_continuation_source"
    source = await wire.start()
    assert source["preparation"]["receipt"]["first_sequence_number"] == first
    assert source["preparation"]["receipt"]["lease_generation"] == generation + 1
    assert len(wire.calls) == 3 and wire.calls[1][1] == wire.body
    assert wire.calls[2][1]["operation"]["payload"] == wire.source_body["operation"]["payload"]
    assert not wire.handoff._pending and await wire.start() is None
    assert len(wire.calls) == 3


async def test_missing_advertisement_preserves_continuation_without_transferring_context():
    wire = Wire()
    wire.supported = False
    reply = await wire.continuation()
    assert reply["receipt"] == wire.answer["receipt"]
    assert not wire.handoff._pending and await wire.start() is None
    assert len(wire.calls) == 2


@pytest.mark.parametrize("fault", ["generation", "position", "duplicate", "deadline"])
async def test_bad_recorded_window_never_transfers_negotiation(fault):
    wire = Wire()
    receipt = wire.answer["receipt"]
    if fault == "generation":
        receipt["lease"]["generation"] += 1
    elif fault == "position":
        receipt["reservations"]["reservations"][0]["sequence_number"] = 0
    elif fault == "duplicate":
        receipt["reservations"]["reservations"][1] = receipt["reservations"]["reservations"][0]
    else:
        receipt["reservations"]["capture_authorized_until"] = "2099-01-01T00:00:00Z"
    with pytest.raises((ValueError, ProviderCoreUnavailable)):
        await wire.continuation()
    assert not wire.handoff._pending and len(wire.calls) == 2


@pytest.mark.parametrize(
    "fault", ["lease", "receipt", "generation", "position", "account", "expired"],
)
async def test_mismatched_or_expired_recorded_source_never_dispatches(fault):
    wire = Wire()
    await wire.continuation()
    payload = wire.source_body["operation"]["payload"]
    if fault in {"lease", "receipt"}:
        payload["lease_id" if fault == "lease" else "lease_receipt_id"] = str(uuid4())
    elif fault == "generation":
        payload["lease_generation"] += 1
    elif fault == "position":
        payload["first_sequence_number"] += 1
    elif fault == "account":
        wire.account = replace(ACCOUNT, actor_ref="different-current-actor")
    else:
        wire.now += 25
    try:
        assert await wire.start() is None
    except ProviderCoreUnavailable:
        pass
    assert len(wire.calls) == 2


async def test_recorded_profile_requires_positive_strict_position_and_supported_channel():
    wire = Wire()
    assert is_recorded_continuation(wire.body)
    for field, value in [("first_sequence_number", 0), ("first_sequence_number", True),
                         ("previous_lease_generation", True), ("channel", "system_audio")]:
        changed = copy.deepcopy(wire.body)
        changed["operation"]["payload"][field] = value
        assert not is_recorded_continuation(changed)


@pytest.mark.parametrize("cancel", [False, True])
async def test_recorded_source_reply_loss_or_cancellation_never_refills_or_falls_back(cancel):
    wire = Wire()
    await wire.continuation()
    original = wire.handle
    entered = asyncio.Event()

    async def fail(request):
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
    assert not wire.handoff._pending and await wire.start() is None
    assert len(wire.calls) == 3
