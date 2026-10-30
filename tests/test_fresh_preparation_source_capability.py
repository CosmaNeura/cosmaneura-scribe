"""Synthetic consented metadata-only regressions; no device/audio/network."""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_preparation_core_transport import PATH, prepare_then_dispatch
from cosmaneura_scribe.provider_source_preparation import prepare_source
from test_provider_native_core_transport import ACCOUNT, SESSION
from test_provider_preparation_handoff import MountHandoffWire, Sequence, mount

pytestmark = pytest.mark.asyncio
HEADER = "X-Cosmaneura-Prepared-Source-Start-Version"


class SourceWire(MountHandoffWire):
    def __init__(self, headers=()):
        super().__init__()
        self.capability_headers = headers
        self.stamp = datetime.now(UTC)
        self.lease_id = str(uuid4())
        self.receipt_id = str(uuid4())
        self.until = (self.stamp + timedelta(minutes=15)).isoformat()

    async def handle(self, request):
        data = json.loads(request.content)
        if data.get("action") == "prepared_source":
            self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
            assert request.url.path == PATH
            assert data["prepared_context"]["context_token"] == "invented-server-context-token"
            assert data["expected_actor_ref"] == ACCOUNT.actor_ref
            assert data["expected_tenant_ref"] == ACCOUNT.tenant_ref
            if self.lose == PATH:
                raise httpx.ReadError("synthetic response loss")
            intent = data["operation"]["payload"]
            now = datetime.now(UTC)
            common = {
                **{key: value for key, value in intent.items() if key != "owner_proof"},
                "session_id": SESSION,
                "source_start_id": intent["attempt_id"],
                "creator_actor_id": ACCOUNT.actor_ref,
                "consent_record_id": str(uuid4()),
                "preparation_expires_at": (now + timedelta(seconds=30)).isoformat(),
                "capability_id": str(uuid4()),
            }
            result = {
                **{key: data[key] for key in ("workspace_id", "binding_ref", "request_nonce")},
                "contract_version": "1",
                "checked_at": now.isoformat(),
                "operation": "source_start_sequence",
                "receipt": {
                    "preparation": {
                        **common,
                        "state": "prepared",
                        "issued_at": None,
                        "expires_at": None,
                    },
                    "authorization": {
                        "receipt": {
                            **common,
                            "state": "issued",
                            "issued_at": now.isoformat(),
                            "expires_at": (now + timedelta(seconds=15)).isoformat(),
                        },
                        "secret": intent["owner_proof"],
                    },
                },
            }
            return httpx.Response(
                200,
                json={
                    "version": "1",
                    "action": "prepared_source",
                    "actor_ref": ACCOUNT.actor_ref,
                    "tenant_ref": ACCOUNT.tenant_ref,
                    "result": result,
                },
                headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
            )
        response = await super().handle(request)
        if data.get("action") == "preparation_context":
            return httpx.Response(
                response.status_code,
                content=response.content,
                headers=list(response.headers.multi_items()) + list(self.capability_headers),
            )
        if data.get("action") == "prepared_window":
            value = response.json()
            value["result"]["receipt"] = self.window_receipt()
            return httpx.Response(response.status_code, json=value, headers=response.headers)
        if (
            request.url.path.endswith("/capture-operations")
            and data.get("operation", {}).get("kind") == "prepare_recording_window"
        ):
            value = response.json()
            value["receipt"] = self.window_receipt()
            return httpx.Response(response.status_code, json=value, headers=response.headers)
        return response

    def window_receipt(self):
        now = self.stamp.isoformat()
        return {
            "schema_version": "1.0",
            "binding": {
                "session_id": SESSION,
                "key_version": "synthetic-key",
                "created_at": now,
            },
            "lease": {
                "protocol_version": "1.0",
                "receipt_id": self.receipt_id,
                "lease_id": self.lease_id,
                "session_id": SESSION,
                "generation": 1,
                "issued_at": now,
                "expires_at": self.until,
            },
            "reservations": {
                "protocol_version": "1.0",
                "batch_id": str(uuid4()),
                "session_id": SESSION,
                "capture_authorized_until": self.until,
                "reservations": [
                    {
                        "protocol_version": "1.0",
                        "object_id": str(uuid4()),
                        "session_id": SESSION,
                        "channel": "microphone",
                        "sequence_number": index,
                        "additional_authenticated_data": "synthetic-aad",
                        "created_at": now,
                    }
                    for index in range(30)
                ],
            },
        }


def sequence(headers=((HEADER, "1"),)):
    s = Sequence()
    s.wire = SourceWire(headers)
    return s


async def window(s):
    return await prepare_then_dispatch(
        s.origin,
        "capture-operations",
        {
            "workspace_id": s.workspace,
            "binding_ref": s.binding,
            "request_nonce": str(uuid4()),
            "operation": {
                "kind": "prepare_recording_window",
                "payload": {
                    "schema_version": "1.0",
                    "binding": {
                        "key_version": "synthetic-key",
                        "wrapped_dek": "a" * 512,
                    },
                    "bind_idempotency_key": "synthetic-bind-key",
                    "lease_idempotency_key": "synthetic-lease-key",
                    "reserve_idempotency_key": "synthetic-reserve-key",
                    "channel": "microphone",
                    "reservation_count": 30,
                },
            },
        },
        "synthetic-window-key",
        s.revision,
        s.wire.fresh,
        s.wire.workload,
        transport=httpx.MockTransport(s.wire.handle),
        handoff=s.pending,
    )


async def source(s):
    return await prepare_source(
        s.origin,
        {
            "workspace_id": s.workspace,
            "binding_ref": s.binding,
            "request_nonce": str(uuid4()),
            "authorize_idempotency_key": "synthetic-authorize-key",
            "authorize_request_nonce": str(uuid4()),
            "operation": {
                "kind": "source_start",
                "action": "prepare",
                "payload": {
                    "schema_version": "1.0",
                    "attempt_id": str(uuid4()),
                    "source": "ios_microphone",
                    "owner_proof": "d" * 64,
                    "lease_id": s.wire.lease_id,
                    "lease_receipt_id": s.wire.receipt_id,
                    "lease_generation": 1,
                    "capture_authorized_until": s.wire.until,
                },
            },
        },
        "synthetic-source-key",
        s.revision,
        s.wire.fresh,
        s.wire.workload,
        s.pending,
        transport=httpx.MockTransport(s.wire.handle),
    )


@pytest.mark.parametrize(
    "headers,supported",
    [
        ((), False),
        (((HEADER, "1"),), True),
        (((HEADER.lower(), "1"),), True),
        (((HEADER, "1"), (HEADER, "1")), False),
        (((HEADER, "1"), (HEADER, "2")), False),
        (((HEADER, "1, 1"),), False),
        (((HEADER, "01"),), False),
        (((HEADER, "2"),), False),
        (((HEADER, "true"),), False),
        (((HEADER, " 1 "),), False),
        (((HEADER, ""),), False),
    ],
)
@pytest.mark.parametrize("native_read", [False, True])
async def test_fresh_exact_singleton_capability_is_private_and_independent(
    headers, supported, native_read
):
    s = sequence(headers)
    s.wire.native_read_supported = native_read
    answer = await s.call(admission=True)
    retained = next(iter(s.pending._pending.values()))
    assert retained.source_start_supported is supported
    assert retained.native_read_supported is native_read
    assert retained.issued_at == 100 and retained.stage == "recording_window"
    assert s.wire.checks == 9 and len(s.wire.calls) == 3
    assert "source_start_supported" not in answer and "context_token" not in answer


async def test_fresh_capability_reaches_one_source_operation_without_reissuing_context():
    s = sequence()
    await s.call(admission=True)
    s.now += 5
    await window(s)
    retained = next(iter(s.pending._pending.values()))
    assert retained.stage == "source_start" and retained.issued_at == 100
    s.wire.calls.clear()
    s.wire.checks = 0
    answer = await source(s)
    assert answer["authorization"]["receipt"]["receipt"]["state"] == "issued"
    assert [call[1]["action"] for call in s.wire.calls] == ["prepared_source"]
    assert s.wire.calls[0][2] == "synthetic-source-key" and s.wire.checks == 6
    assert not s.pending._pending
    assert await source(s) is None and len(s.wire.calls) == 1


@pytest.mark.parametrize("previous_setup", [False, True])
async def test_new_window_after_setup_miss_carries_its_fresh_context_to_one_source_call(
    previous_setup,
):
    s = sequence()
    if previous_setup:
        await s.call(admission=True)
        s.now += 30
    s.wire.calls.clear()
    await window(s)
    assert [call[1].get("action") for call in s.wire.calls] == ["preparation_context", None]
    retained = next(iter(s.pending._pending.values()))
    assert retained.stage == "source_start" and retained.issued_at == s.now
    s.wire.calls.clear()
    s.wire.checks = 0
    answer = await source(s)
    assert answer["authorization"]["receipt"]["receipt"]["state"] == "issued"
    assert [call[1]["action"] for call in s.wire.calls] == ["prepared_source"]
    assert s.wire.checks == 6 and not s.pending._pending


async def test_new_window_transport_close_failure_does_not_publish_source_handoff(monkeypatch):
    from cosmaneura_scribe.provider_core_transport import ProviderCoreTransport

    close = ProviderCoreTransport.close

    async def failed_close(self):
        await close(self)
        raise RuntimeError("synthetic transport close failure")

    monkeypatch.setattr(ProviderCoreTransport, "close", failed_close)
    s = sequence()
    with pytest.raises(RuntimeError, match="synthetic transport close failure"):
        await window(s)
    assert not s.pending._pending


@pytest.mark.parametrize("supported", [False, True])
async def test_retained_mount_capability_and_original_age_are_unchanged(supported):
    s = sequence()
    await mount(s)
    retained = next(iter(s.pending._pending.values()))
    s.pending._pending[next(iter(s.pending._pending))] = replace(
        retained,
        source_start_supported=supported,
    )
    s.wire = SourceWire(((HEADER, "1" if not supported else "2"),))
    s.now += 4
    await s.call(admission=True)
    retained = next(iter(s.pending._pending.values()))
    assert retained.source_start_supported is supported and retained.issued_at == 100
    assert all(call[1].get("action") != "preparation_context" for call in s.wire.calls)


@pytest.mark.parametrize("age", [25, 30, -1])
async def test_fresh_capability_cannot_extend_original_expiry_or_rewind_clock(age):
    s = sequence()
    await s.call(admission=True)
    await window(s)
    s.now = 100 + age
    s.wire.calls.clear()
    assert await source(s) is None and not s.wire.calls
    assert not s.pending._pending


@pytest.mark.parametrize(
    "field,value",
    [
        ("account_id", "different-synthetic-account"),
        ("recovery_scope", uuid4()),
        ("actor_ref", "different-synthetic-actor"),
        ("tenant_ref", "different-synthetic-tenant"),
    ],
)
async def test_fresh_capability_is_not_reused_across_current_account_scope(field, value):
    s = sequence()
    await s.call(admission=True)
    await window(s)
    s.wire.calls.clear()

    async def changed():
        return replace(ACCOUNT, **{field: value})

    s.wire.fresh = changed
    assert await source(s) is None and not s.wire.calls
    s.wire.fresh = MountHandoffWire().fresh
    assert (await source(s))["preparation"]["receipt"]["state"] == "prepared"


@pytest.mark.parametrize("boundary", range(1, 7))
async def test_capability_source_rechecks_each_current_access_fence_and_does_not_retry(boundary):
    s = sequence()
    await s.call(admission=True)
    await window(s)
    s.wire.calls.clear()
    s.wire.checks = 0
    s.wire.revoke_at = boundary
    with pytest.raises(ProviderCoreUnavailable):
        await source(s)
    assert len(s.wire.calls) == (0 if boundary <= 4 else 1)
    if boundary != 1:
        assert not s.pending._pending


async def test_uncertain_source_reply_is_consumed_without_retry_or_compatibility_fallback():
    s = sequence()
    await s.call(admission=True)
    await window(s)
    s.wire.calls.clear()
    s.wire.lose = PATH
    with pytest.raises(ProviderCoreUnavailable):
        await source(s)
    assert len(s.wire.calls) == 1 and not s.pending._pending


@pytest.mark.parametrize(
    "headers",
    [
        (),
        ((HEADER, "1"), (HEADER, "1")),
        ((HEADER, "1, 1"),),
        ((HEADER, "01"),),
        ((HEADER, "2"),),
        ((HEADER, "true"),),
    ],
)
async def test_absent_or_unsupported_fresh_capability_chooses_compatibility_before_source_io(
    headers,
):
    s = sequence(headers)
    await s.call(admission=True)
    await window(s)
    s.wire.calls.clear()
    assert not s.pending._pending
    assert await source(s) is None and not s.wire.calls
