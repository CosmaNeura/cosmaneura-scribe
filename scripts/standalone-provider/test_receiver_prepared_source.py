"""Real frozen identity/registry checks, fictional Core wire, no audio or services."""

import json
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_preparation_handoff import PreparationHandoff
from test_receiver import (
    BINDING,
    SESSION_ID,
    CoreCaptureAccount,
    client,
    core_created_opening,
    source_sequence_payload,
)
from test_receiver import engine as engine
from test_receiver import harness as harness
from test_receiver_context_reads import async_receiver as async_receiver

pytestmark = pytest.mark.asyncio
PATH = "/service/v1/agent/scribe/native-capture"


def prepared_source_fixture(h):
    workspace, lookups = core_created_opening(h, native_admission=True)
    payload = {**source_sequence_payload(h), "workspace_id": str(workspace)}
    intent = payload["operation"]["payload"]
    transport = h.receiver.core_http
    actions = []
    h.receiver._preparation_handoff = PreparationHandoff()

    async def handle(request):
        data = json.loads(request.content)
        if request.url.path != PATH:
            return await transport.handle_async_request(request)
        action = data["action"]
        actions.append(action)
        if action not in {"prepared_window", "prepared_source"}:
            response = await transport.handle_async_request(request)
            if action == "mount":
                return httpx.Response(
                    response.status_code,
                    json=response.json(),
                    headers=list(response.headers.multi_items())
                    + [
                        ("X-Cosmaneura-Prepared-Source-Start-Version", "1"),
                        ("X-Cosmaneura-Prepared-Native-Read-Version", "1"),
                    ],
                )
            return response
        h.wire.calls.append(PATH)
        now = datetime.now(UTC).isoformat()
        result = {
            "contract_version": "1",
            "workspace_id": str(workspace),
            "binding_ref": BINDING,
            "request_nonce": data["request_nonce"],
            "checked_at": now,
            "operation": "prepare_recording_window"
            if action == "prepared_window"
            else "source_start_sequence",
        }
        if action == "prepared_source":
            assert data["prepared_context"]["context_token"] == "offline-core-mount-token"
            result = h.wire.alter(PATH, data, result)
        else:
            result["receipt"] = {
                "schema_version": "1.0",
                "binding": {
                    "session_id": SESSION_ID,
                    "key_version": "synthetic-key",
                    "created_at": now,
                },
                "lease": {
                    "protocol_version": "1.0",
                    "receipt_id": intent["lease_receipt_id"],
                    "lease_id": intent["lease_id"],
                    "session_id": SESSION_ID,
                    "generation": 1,
                    "issued_at": now,
                    "expires_at": intent["capture_authorized_until"],
                },
                "reservations": {
                    "protocol_version": "1.0",
                    "batch_id": str(uuid4()),
                    "session_id": SESSION_ID,
                    "capture_authorized_until": intent["capture_authorized_until"],
                    "reservations": [
                        {
                            "protocol_version": "1.0",
                            "object_id": str(uuid4()),
                            "session_id": SESSION_ID,
                            "channel": "microphone",
                            "sequence_number": index,
                            "additional_authenticated_data": "offline-aad",
                            "created_at": now,
                        }
                        for index in range(30)
                    ],
                },
            }
        return httpx.Response(
            200,
            json={
                "version": "1",
                "action": action,
                "actor_ref": h.wire.selection.actor_ref,
                "tenant_ref": h.wire.selection.tenant_ref,
                "result": result,
            },
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
        )

    h.receiver.core_http = httpx.MockTransport(handle)
    return workspace, payload, lookups, actions


async def prepare(h, *, mobile=True):
    workspace, payload, lookups, actions = prepared_source_fixture(h)
    scope = {"workspace_id": str(workspace), "binding_ref": BINDING}
    async with client(h) as connection:
        response = await connection.post(
            "/provider/v1/mount", json={"workspace_id": str(workspace)}
        )
        assert response.status_code == 200 and "prepared_context" not in response.text
        admission = {
            **scope,
            "request_nonce": str(uuid4()),
            "attestation": {"all_parties_consented": True},
            "configured_capture": {"schema_version": "1.0", "language_mode": "en-US"},
        }
        if mobile:
            admission["native_recording_preparation"] = True
        response = await connection.post("/provider/v1/capture-admissions", json=admission)
        assert response.status_code == 200
        if not mobile:
            response = await connection.post(
                "/provider/v1/capture-operations",
                json={
                    **scope,
                    "request_nonce": str(uuid4()),
                    "operation": {"kind": "native_recording_preparation"},
                },
            )
            assert response.status_code == 200
        response = await connection.post(
            "/provider/v1/capture-operations",
            json={
                **scope,
                "request_nonce": str(uuid4()),
                "operation": {
                    "kind": "prepare_recording_window",
                    "payload": {
                        "schema_version": "1.0",
                        "binding": {"key_version": "synthetic-key", "wrapped_dek": "a" * 512},
                        "bind_idempotency_key": "offline-bind-key",
                        "lease_idempotency_key": "offline-lease-key",
                        "reserve_idempotency_key": "offline-reserve-key",
                        "channel": "microphone",
                        "reservation_count": 30,
                    },
                },
            },
        )
        assert response.status_code == 200
    return payload, lookups, actions


@pytest.mark.parametrize("mobile", [True, False])
async def test_fresh_source_endpoint_one_core_call_no_encounter_lookup_six_real_snapshots(
    async_receiver, mobile
):
    h = async_receiver
    payload, lookups, actions = await prepare(h, mobile=mobile)
    before = len(h.wire.calls)
    checks, original = [], h.receiver.encounter_account

    def current(*args, **kwargs):
        checks.append(1)
        return original(*args, **kwargs)

    h.receiver.encounter_account = current
    async with client(h) as connection:
        response = await connection.post("/provider/v1/source-start-ready", json=payload)
    assert response.status_code == 200
    assert response.json()["preparation"]["receipt"]["session_id"] == SESSION_ID
    assert len(h.wire.calls) - before == 1 and h.wire.calls[-1] == PATH
    assert not lookups and len(checks) == 6
    assert actions == [
        "mount",
        "prepared_admission",
        *([] if mobile else ["prepared_native_read"]),
        "prepared_window",
        "prepared_source",
    ]
    assert not h.receiver._preparation_handoff._pending
    assert "context_token" not in response.text and "interaction_ref" not in response.text


@pytest.mark.parametrize("boundary", range(1, 7))
async def test_source_endpoint_committed_account_revocation_at_each_real_snapshot(
    async_receiver, boundary
):
    h = async_receiver
    payload, lookups, _ = await prepare(h)
    checks, original = [], h.receiver.encounter_account
    before = len(h.wire.calls)

    def current(*args, **kwargs):
        checks.append(1)
        if len(checks) == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))
        return original(*args, **kwargs)

    h.receiver.encounter_account = current
    async with client(h) as connection:
        response = await connection.post("/provider/v1/source-start-ready", json=payload)
    assert response.status_code == 403 and "preparation" not in response.json()
    assert len(h.wire.calls) - before == (0 if boundary <= 4 else 1)
    assert not lookups


async def test_default_receiver_without_handoff_preserves_existing_source_route(async_receiver):
    h = async_receiver
    workspace, lookups = core_created_opening(h)
    payload = {**source_sequence_payload(h), "workspace_id": str(workspace)}
    assert h.receiver._preparation_handoff is None
    async with client(h) as connection:
        response = await connection.post("/provider/v1/source-start-ready", json=payload)
    assert response.status_code == 200 and len(lookups) == 6 and len(h.wire.calls) == 3
