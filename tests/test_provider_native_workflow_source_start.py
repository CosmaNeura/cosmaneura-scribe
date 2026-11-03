"""Existing native prepare/authorize contracts, fixed Core wire and fresh fences."""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import (
    CoreProviderMount,
    CoreProviderSelection,
    ProviderCoreUnavailable,
)
from cosmaneura_scribe.provider_native_workflow_transport import (
    SCOPE,
    ProviderNativeWorkflowTransport,
)
from pydantic import SecretStr
from test_provider_native_core_transport import ACCOUNT, BINDING
from test_provider_source_preparation import SourceWire

pytestmark = pytest.mark.asyncio


def source_fixture(action, *, source="desktop_companion", fault=None, revoked_boundary=None):
    wire = SourceWire()
    workspace = uuid4()
    mount = CoreProviderMount(
        CoreProviderSelection(
            ACCOUNT.recovery_scope,
            uuid4(),
            workspace,
            "appointment_00000000000000000000000004",
            ACCOUNT.actor_ref,
            ACCOUNT.tenant_ref,
        ),
        BINDING,
    )
    payload = wire.payload(str(workspace), source)
    payload.pop("authorize_idempotency_key")
    payload.pop("authorize_request_nonce")
    payload["operation"]["action"] = action
    calls, fences = [], []

    async def fresh():
        fences.append(None)
        return replace(ACCOUNT, actor_ref="revoked") if len(fences) == revoked_boundary else ACCOUNT

    async def workload():
        return SecretStr("invented-workload-token")

    def handle(request):
        calls.append(request)
        data = json.loads(request.content)
        assert data["action"] == "workflow_operation"
        assert data["operation"] == payload["operation"]
        assert "prepared_context" not in data
        assert request.headers["authorization"] == "Bearer invented-user-session-token"
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer invented-workload-token"
        )
        assert "cookie" not in request.headers
        now = datetime.now(UTC)
        receipt = {
            **{k: v for k, v in payload["operation"]["payload"].items() if k != "owner_proof"},
            "session_id": str(uuid4()),
            "source_start_id": str(uuid4()),
            "creator_actor_id": ACCOUNT.actor_ref,
            "consent_record_id": str(uuid4()),
            "capability_id": str(uuid4()),
            "preparation_expires_at": (now + timedelta(seconds=30)).isoformat(),
            "state": "prepared" if action == "prepare" else "issued",
            "issued_at": None if action == "prepare" else now.isoformat(),
            "expires_at": None
            if action == "prepare"
            else (now + timedelta(seconds=15)).isoformat(),
        }
        secret = "a" * 64
        if fault == "actor":
            receipt["creator_actor_id"] = "other-actor"
        elif fault == "lease":
            receipt["lease_id"] = str(uuid4())
        elif fault == "position":
            receipt["first_sequence_number"] = 1
        elif fault == "source":
            receipt["source"] = "ios_microphone"
        elif fault == "preparation_expired":
            receipt["preparation_expires_at"] = (now - timedelta(seconds=1)).isoformat()
        elif fault == "preparation_after_authority":
            receipt["preparation_expires_at"] = (wire.deadline + timedelta(seconds=1)).isoformat()
        elif fault == "prepared_with_authority":
            receipt["issued_at"] = now.isoformat()
            receipt["expires_at"] = (now + timedelta(seconds=15)).isoformat()
        elif fault == "decision_expired":
            receipt["issued_at"] = (now - timedelta(seconds=20)).isoformat()
            receipt["expires_at"] = (now - timedelta(seconds=5)).isoformat()
        elif fault == "decision_too_long":
            receipt["expires_at"] = (now + timedelta(seconds=16)).isoformat()
        elif fault == "decision_future":
            receipt["issued_at"] = (now + timedelta(seconds=10)).isoformat()
        elif fault == "proof":
            secret = "b" * 64
        headers = {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private",
            "X-Cosmaneura-Native-Capture-Version": "1",
        }
        if fault == "cookie":
            headers["Set-Cookie"] = "synthetic=forbidden"
        result = {
            **{k: payload[k] for k in SCOPE},
            "contract_version": "1",
            "checked_at": now.isoformat(),
            "operation": "source_start",
            "receipt": receipt if action == "prepare" else {"receipt": receipt, "secret": secret},
        }
        return httpx.Response(
            200,
            json={
                "version": "1",
                "action": "workflow_operation",
                "actor_ref": ACCOUNT.actor_ref,
                "tenant_ref": ACCOUNT.tenant_ref,
                "result": result,
            },
            headers=headers,
        )

    transport = ProviderNativeWorkflowTransport(
        "https://core.synthetic.invalid", fresh, workload, transport=httpx.MockTransport(handle)
    )
    return transport, mount, payload, calls, fences


@pytest.mark.parametrize("action", ["prepare", "authorize"])
@pytest.mark.parametrize("source", ["desktop_companion", "ios_microphone"])
async def test_ready_native_source_uses_existing_workflow_and_all_four_fresh_fences(action, source):
    transport, mount, payload, calls, fences = source_fixture(action, source=source)
    try:
        result = await transport.workflow(
            "source-start", payload, "native-ready-source-key", mount=mount
        )
        assert len(calls) == 1 and len(fences) == 4
        assert result["operation"] == "source_start"
        if action == "prepare":
            assert result["receipt"]["state"] == "prepared"
            assert (
                result["receipt"]["issued_at"] is None and result["receipt"]["expires_at"] is None
            )
        else:
            assert result["receipt"]["receipt"]["state"] == "issued"
            assert result["receipt"]["secret"] == "a" * 64
    finally:
        await transport.close()


@pytest.mark.parametrize("action", ["prepare", "authorize"])
@pytest.mark.parametrize("boundary", [1, 2, 3, 4])
async def test_ready_native_source_revocation_at_each_fence_never_retries(action, boundary):
    transport, mount, payload, calls, _ = source_fixture(action, revoked_boundary=boundary)
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.workflow(
                "source-start", payload, "native-ready-source-key", mount=mount
            )
        assert len(calls) == (0 if boundary <= 2 else 1)
    finally:
        await transport.close()


@pytest.mark.parametrize(
    "action,fault",
    [
        ("prepare", "actor"),
        ("authorize", "actor"),
        ("prepare", "lease"),
        ("authorize", "lease"),
        ("prepare", "position"),
        ("authorize", "position"),
        ("prepare", "source"),
        ("authorize", "source"),
        ("prepare", "preparation_expired"),
        ("prepare", "preparation_after_authority"),
        ("prepare", "prepared_with_authority"),
        ("authorize", "decision_expired"),
        ("authorize", "decision_too_long"),
        ("authorize", "decision_future"),
        ("authorize", "proof"),
        ("prepare", "cookie"),
        ("authorize", "cookie"),
    ],
)
async def test_ready_native_source_rejects_invalid_scope_authority_or_proof(action, fault):
    transport, mount, payload, calls, _ = source_fixture(action, fault=fault)
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.workflow(
                "source-start", payload, "native-ready-source-key", mount=mount
            )
        assert len(calls) == 1
    finally:
        await transport.close()


@pytest.mark.parametrize("action", ["prepare", "authorize"])
async def test_ready_native_source_still_rejects_generic_renderer_and_changed_mount(action):
    transport, mount, payload, calls, fences = source_fixture(action)
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.workflow(
                "capture-operations", payload, "native-ready-source-key", mount=mount
            )
        payload["workspace_id"] = str(uuid4())
        with pytest.raises(ProviderCoreUnavailable):
            await transport.workflow(
                "source-start", payload, "native-ready-source-key", mount=mount
            )
        assert not calls and not fences
    finally:
        await transport.close()
