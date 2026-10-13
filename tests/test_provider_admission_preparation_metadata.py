"""Full desktop metadata combined with admission; no dropped capability checks."""

import asyncio
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from test_provider_admission_native_preparation import dispatch
from test_provider_native_core_transport import ACCOUNT, BINDING, SESSION, retained_preparation
from test_provider_native_core_transport import Wire as NativeWire

pytestmark = pytest.mark.asyncio


async def invoke(wire, *, supported=True, issued_at=100.0):
    payload = {
        "workspace_id": str(uuid4()),
        "binding_ref": BINDING,
        "request_nonce": str(uuid4()),
        "attestation": {"all_parties_consented": True},
        "configured_capture": {"schema_version": "1.0", "language_mode": "en-US"},
        "preparation_metadata": True,
    }
    client, handoff, revision = retained_preparation(
        wire,
        payload["workspace_id"],
        stage="admission",
        issued_at=issued_at,
        admission_preparation_metadata_supported=supported,
    )
    await client.close()
    return payload, handoff, revision


async def test_supported_desktop_admission_preserves_full_receipt_and_one_core_call():
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)
    result = await dispatch(wire, payload, handoff, revision)
    assert [call["action"] for call in wire.calls] == ["prepared_admission"]
    assert wire.calls[0]["include_preparation_metadata"] is True
    assert "include_native_preparation" not in wire.calls[0]
    receipt = result["preparation_metadata"]
    assert set(receipt) == {"schema_version", "review", "encryption_key", "capabilities"}
    assert receipt["review"]["session_id"] == SESSION
    assert receipt["capabilities"]["remaining_aggregate_plaintext_bytes"] == 67108864
    saved = handoff.take(
        "https://core.synthetic.invalid", ACCOUNT, revision, payload["workspace_id"], BINDING
    )
    assert saved is not None and saved.issued_at == 100.0
    assert not saved.native_read_done
    assert "invented-context-token" not in str(result)


async def test_unsupported_core_keeps_existing_separate_metadata_read():
    from test_provider_preparation_handoff import Sequence, mount

    sequence = Sequence()
    await mount(sequence)
    retained = next(iter(sequence.pending._pending.values()))
    assert not retained.admission_preparation_metadata_supported
    result = await sequence.call(admission=True, metadata=True)
    assert [
        call[1].get("action", call[1].get("operation", {}).get("kind"))
        for call in sequence.wire.calls
    ] == ["prepared_admission", "preparation_metadata"]
    assert all("include_preparation_metadata" not in call[1] for call in sequence.wire.calls)
    assert result["preparation_metadata"]["review"]["session_id"] == SESSION


@pytest.mark.parametrize(
    "fault",
    [
        "foreign_session", "private_key", "wrong_operations", "extra", "absent", "budget",
        "reply_loss",
    ],
)
async def test_invalid_combined_receipt_never_retries_or_retains_partial_result(fault):
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)

    def alter(value):
        metadata = value["result"]["preparation_metadata"]
        if fault == "foreign_session":
            metadata["review"]["session_id"] = str(uuid4())
        elif fault == "private_key":
            metadata["encryption_key"]["public_jwk"]["d"] = "invented"
        elif fault == "wrong_operations":
            metadata["encryption_key"]["public_jwk"]["key_ops"] = ["unwrapKey"]
        elif fault == "extra":
            metadata["permission"] = True
        elif fault == "absent":
            value["result"].pop("preparation_metadata")
        elif fault == "budget":
            metadata["capabilities"]["remaining_aggregate_plaintext_bytes"] = -1
        else:
            raise httpx.ReadError("invented reply loss")
        return value

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await dispatch(wire, payload, handoff, revision)
    assert len(wire.calls) == 1
    assert handoff.take(
        "https://core.synthetic.invalid", ACCOUNT, revision, payload["workspace_id"], BINDING
    ) is None


@pytest.mark.parametrize("boundary", range(1, 8))
async def test_revocation_at_each_combined_boundary_blocks_publication(boundary):
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)

    async def fresh():
        wire.checks += 1
        if wire.checks == boundary:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        return ACCOUNT

    wire.fresh = fresh
    with pytest.raises(ProviderCoreUnavailable):
        await dispatch(wire, payload, handoff, revision)
    assert len(wire.calls) == (0 if boundary <= 4 else 1)


async def test_cancellation_does_not_retain_or_retry_admission():
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)
    original, entered = wire.handle, asyncio.Event()

    async def blocked(request):
        await original(request)
        entered.set()
        await asyncio.Event().wait()

    wire.handle = blocked
    task = asyncio.create_task(dispatch(wire, payload, handoff, revision))
    await asyncio.wait_for(entered.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(wire.calls) == 1 and not handoff._pending


async def test_unrequested_metadata_is_not_added_even_when_supported():
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)
    payload.pop("preparation_metadata")
    result = await dispatch(wire, payload, handoff, revision)
    assert len(wire.calls) == 1
    assert "include_preparation_metadata" not in wire.calls[0]
    assert "preparation_metadata" not in result


@pytest.mark.parametrize("change", [{"attestation": None}, {"native_recording_preparation": True}])
async def test_full_metadata_opt_in_cannot_change_recovery_or_mix_native_contract(change):
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)
    with pytest.raises((ValueError, ProviderCoreUnavailable)):
        await dispatch(wire, payload | change, handoff, revision)
    assert not wire.calls


async def test_mount_capability_header_enables_only_explicit_supported_version():
    from cosmaneura_scribe.provider_native_core_transport import ProviderNativeCoreTransport
    from cosmaneura_scribe.provider_preparation_handoff import PreparationHandoff

    for header in (None, "0", "1", "1, 1"):
        wire, handoff, revision = NativeWire(), PreparationHandoff(), uuid4()
        original = wire.handle

        async def mount(request, original=original, header=header):
            response = await original(request)
            value = response.json()
            value["result"]["prepared_context"] = {
                "context_token": "invented-server-context-token",
                "interaction_ref": "invented-interaction-0123456789",
                "client_turn_id": str(uuid4()),
            }
            headers = dict(response.headers)
            if header is not None:
                headers["x-cosmaneura-admission-preparation-metadata-version"] = header
            return httpx.Response(200, json=value, headers=headers)

        client = ProviderNativeCoreTransport(
            "https://core.synthetic.invalid", wire.fresh, wire.workload,
            transport=httpx.MockTransport(mount),
        )
        try:
            await client.request("mount", {"workspace_id": str(uuid4())}, str(uuid4()),
                                 handoff=handoff, revision=revision)
        finally:
            await client.close()
        retained = next(iter(handoff._pending.values()))
        assert retained.admission_preparation_metadata_supported is (header == "1")
