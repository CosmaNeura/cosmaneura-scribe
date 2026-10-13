"""Receiver keeps consent fences while eliminating the device's next request."""

from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_preparation_core_transport import prepare_then_dispatch
from test_provider_native_core_transport import ACCOUNT, BINDING, SESSION, retained_preparation
from test_provider_native_core_transport import Wire as NativeWire

pytestmark = pytest.mark.asyncio


async def invoke(wire, *, supported=True):
    payload = {
        "workspace_id": str(uuid4()),
        "binding_ref": BINDING,
        "request_nonce": str(uuid4()),
        "attestation": {"all_parties_consented": True},
        "configured_capture": {"schema_version": "1.0", "language_mode": "en-US"},
        "native_recording_preparation": True,
    }
    client, handoff, revision = retained_preparation(
        wire,
        payload["workspace_id"],
        stage="admission",
        admission_native_preparation_supported=supported,
    )
    await client.close()
    return payload, handoff, revision


async def dispatch(wire, payload, handoff, revision):
    return await prepare_then_dispatch(
        "https://core.synthetic.invalid",
        "capture-admissions",
        payload,
        "original-retained-key",
        revision,
        wire.fresh,
        wire.workload,
        handoff=handoff,
        transport=httpx.MockTransport(wire.handle),
    )


async def test_supported_admission_returns_context_once_with_original_age():
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)
    result = await dispatch(wire, payload, handoff, revision)
    assert [call["action"] for call in wire.calls] == ["prepared_admission"]
    assert wire.calls[0]["include_native_preparation"] is True
    assert result["native_recording_preparation"]["context"]["session_id"] == SESSION
    saved = handoff.take(
        "https://core.synthetic.invalid", ACCOUNT, revision, payload["workspace_id"], BINDING
    )
    assert saved is not None and saved.issued_at == 100.0 and saved.native_read_done
    assert "invented-context-token" not in str(result)


@pytest.mark.parametrize(
    "fault",
    ["foreign_session", "foreign_workspace", "private_key", "extra", "absent", "reply_loss"],
)
async def test_invalid_or_lost_combined_reply_never_retries_or_publishes_partial_admission(fault):
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)

    def alter(value):
        metadata = value["result"]["native_recording_preparation"]
        if fault == "foreign_session":
            metadata["context"]["session_id"] = str(uuid4())
        elif fault == "foreign_workspace":
            metadata["context"]["workspace_id"] = str(uuid4())
        elif fault == "private_key":
            metadata["encryption_key"]["public_jwk"]["d"] = "invented"
        elif fault == "extra":
            metadata["permission"] = True
        elif fault == "absent":
            value["result"].pop("native_recording_preparation")
        else:
            raise httpx.ReadError("invented reply loss")
        return value

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await dispatch(wire, payload, handoff, revision)
    assert len(wire.calls) == 1
    assert (
        handoff.take(
            "https://core.synthetic.invalid", ACCOUNT, revision, payload["workspace_id"], BINDING
        )
        is None
    )


@pytest.mark.parametrize("boundary", range(1, 8))
async def test_revocation_at_each_combined_registry_boundary_blocks_publication(boundary):
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


async def test_older_core_uses_original_read_without_retrying_admission():
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire, supported=False)
    result = await dispatch(wire, payload, handoff, revision)
    assert [call["action"] for call in wire.calls] == ["prepared_admission", "operation"]
    assert all("include_native_preparation" not in call for call in wire.calls)
    assert result["native_recording_preparation"]["context"]["session_id"] == SESSION


@pytest.mark.parametrize(
    "change",
    [
        {"attestation": None},
        {"native_recording_preparation": False},
        {"preparation_metadata": True},
    ],
)
async def test_opt_in_cannot_change_recovery_or_mix_metadata_contracts(change):
    wire = NativeWire()
    payload, handoff, revision = await invoke(wire)
    with pytest.raises((ValueError, ProviderCoreUnavailable)):
        await dispatch(wire, payload | change, handoff, revision)
    assert not wire.calls
