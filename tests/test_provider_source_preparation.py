"""A fresh source uses one Core call; authority and stop custody stay current."""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_native_core_transport import ProviderNativeCoreTransport
from cosmaneura_scribe.provider_preparation_core_transport import prepare_then_dispatch
from cosmaneura_scribe.provider_preparation_handoff import (
    PreparationHandoff,
    PreparedSourceWindow,
    retain_source_window,
)
from cosmaneura_scribe.provider_source_preparation import prepare_source
from pydantic import SecretStr
from test_provider_native_core_transport import ACCOUNT, BINDING, SESSION, retained_preparation
from test_provider_native_core_transport import Wire as NativeWire

pytestmark = pytest.mark.asyncio
ORIGIN = "https://core.synthetic.invalid"


class SourceWire(NativeWire):
    def __init__(self):
        super().__init__()
        self.after = lambda: None
        self.deadline = datetime.now(UTC) + timedelta(minutes=10)
        self.lease_id, self.receipt_id = uuid4(), uuid4()
        self.authorize_key = str(uuid4())

    def payload(self, workspace, source="ios_microphone"):
        return {
            "workspace_id": workspace,
            "binding_ref": BINDING,
            "request_nonce": str(uuid4()),
            "authorize_idempotency_key": self.authorize_key,
            "authorize_request_nonce": str(uuid4()),
            "operation": {
                "kind": "source_start",
                "action": "prepare",
                "payload": {
                    "schema_version": "1.0",
                    "attempt_id": str(uuid4()),
                    "source": source,
                    "owner_proof": "a" * 64,
                    "lease_id": str(self.lease_id),
                    "lease_receipt_id": str(self.receipt_id),
                    "lease_generation": 1,
                    "capture_authorized_until": self.deadline.isoformat(),
                },
            },
        }

    async def handle(self, request):
        data = json.loads(request.content)
        if data["action"] != "prepared_source":
            return await super().handle(request)
        assert request.url.path == "/service/v1/agent/scribe/native-capture"
        assert request.headers["authorization"] == "Bearer invented-user-session-token"
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer invented-workload-token"
        )
        assert (
            "cookie" not in request.headers and "x-cosmaneura-mount-context" not in request.headers
        )
        self.calls.append(data)
        now = datetime.now(UTC)
        common = {
            **{k: v for k, v in data["operation"]["payload"].items() if k != "owner_proof"},
            "session_id": SESSION,
            "source_start_id": str(uuid4()),
            "creator_actor_id": ACCOUNT.actor_ref,
            "consent_record_id": str(uuid4()),
            "capability_id": str(uuid4()),
            "preparation_expires_at": (now + timedelta(seconds=30)).isoformat(),
        }
        prepared = {**common, "state": "prepared", "issued_at": None, "expires_at": None}
        issued = {
            **common,
            "state": "issued",
            "issued_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=15)).isoformat(),
        }
        value = {
            "version": "1",
            "action": "prepared_source",
            "actor_ref": ACCOUNT.actor_ref,
            "tenant_ref": ACCOUNT.tenant_ref,
            "result": {
                "contract_version": "1",
                "workspace_id": data["workspace_id"],
                "binding_ref": BINDING,
                "request_nonce": data["request_nonce"],
                "checked_at": now.isoformat(),
                "operation": "source_start_sequence",
                "receipt": {
                    "preparation": prepared,
                    "authorization": {"receipt": issued, "secret": "a" * 64},
                },
            },
        }
        self.after()
        return httpx.Response(
            self.status,
            json=self.alter(value),
            headers={
                "Cache-Control": "no-store",
                "X-Cosmaneura-Native-Capture-Version": "1",
            },
        )


async def setup(wire, *, supported=True, native_read_done=False, age=0, channel="microphone"):
    workspace = str(uuid4())
    context = PreparedSourceWindow(
        UUID(SESSION), wire.lease_id, wire.receipt_id, wire.deadline, channel
    )
    client, handoff, revision = retained_preparation(
        wire,
        workspace,
        stage="source_start",
        issued_at=100.0 - age,
        source_start_supported=supported,
        source_window=context,
        native_read_done=native_read_done,
    )
    await client.close()
    return workspace, handoff, revision


async def invoke(wire, workspace, handoff, revision, payload=None):
    return await prepare_source(
        ORIGIN,
        payload or wire.payload(workspace),
        "original-prepare-key",
        revision,
        wire.fresh,
        wire.workload,
        handoff,
        transport=httpx.MockTransport(wire.handle),
    )


@pytest.mark.parametrize(
    "source,channel",
    [
        ("ios_microphone", "microphone"),
        ("desktop_companion", "mixed"),
        ("desktop_companion", "microphone"),
    ],
)
@pytest.mark.parametrize("native_read_done", [True, False])
async def test_fresh_source_one_core_call_six_current_fences_original_intents(
    source, channel, native_read_done
):
    wire = SourceWire()
    workspace, handoff, revision = await setup(
        wire, native_read_done=native_read_done, channel=channel
    )
    payload = wire.payload(workspace, source)
    result = await invoke(wire, workspace, handoff, revision, payload)
    assert len(wire.calls) == 1 and wire.checks == 6
    request = wire.calls[0]
    assert request["action"] == "prepared_source"
    assert request["operation"]["payload"] == payload["operation"]["payload"]
    assert request["operation"]["authorize_idempotency_key"] == wire.authorize_key
    assert result["preparation"]["request_nonce"] == payload["request_nonce"]
    assert result["authorization"]["request_nonce"] == payload["authorize_request_nonce"]
    assert result["preparation"]["receipt"]["session_id"] == SESSION
    assert not handoff._pending
    assert await invoke(wire, workspace, handoff, revision) is None
    assert len(wire.calls) == 1


@pytest.mark.parametrize("boundary", range(1, 7))
async def test_revocation_at_every_source_fence_blocks_dispatch_or_publication(boundary):
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire)

    async def fresh():
        wire.checks += 1
        if wire.checks == boundary:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        return ACCOUNT

    wire.fresh = fresh
    with pytest.raises(ProviderCoreUnavailable):
        await invoke(wire, workspace, handoff, revision)
    assert len(wire.calls) == (0 if boundary <= 4 else 1)


@pytest.mark.parametrize(
    "fault",
    [
        "session",
        "lease",
        "receipt",
        "position",
        "source",
        "proof",
        "nonce",
        "state",
        "extra",
        "expired",
        "reply_loss",
        "403",
        "503",
        "bad_timestamp",
        "old_timestamp",
        "future_timestamp",
        "outer_scope",
        "outer_extra",
    ],
)
async def test_bad_or_lost_source_reply_is_destructive_and_never_falls_back(fault):
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire)

    def alter(value):
        pair = value["result"]["receipt"]
        common = pair["preparation"]
        if fault in {"403", "503"}:
            return value
        if fault == "reply_loss":
            raise httpx.ReadError("synthetic lost reply")
        if fault in {"session", "lease", "receipt"}:
            common[
                {"session": "session_id", "lease": "lease_id", "receipt": "lease_receipt_id"}[fault]
            ] = str(uuid4())
        elif fault == "position":
            common["first_sequence_number"] = 1
        elif fault == "source":
            common["source"] = "desktop_companion"
        elif fault == "proof":
            pair["authorization"]["secret"] = "b" * 64
        elif fault == "nonce":
            value["result"]["request_nonce"] = str(uuid4())
        elif fault == "state":
            common["state"] = "issued"
        elif fault == "extra":
            common["permission"] = True
        elif fault == "bad_timestamp":
            value["result"]["checked_at"] = "not-a-time"
        elif fault == "old_timestamp":
            value["result"]["checked_at"] = (datetime.now(UTC) - timedelta(seconds=31)).isoformat()
        elif fault == "future_timestamp":
            value["result"]["checked_at"] = (datetime.now(UTC) + timedelta(seconds=6)).isoformat()
        elif fault == "outer_scope":
            value["actor_ref"] = "unrelated-actor"
        elif fault == "outer_extra":
            value["extra"] = True
        else:
            pair["authorization"]["receipt"]["expires_at"] = datetime.now(UTC).isoformat()
        return value

    wire.alter = alter
    if fault in {"403", "503"}:
        wire.status = int(fault)
    with pytest.raises(ProviderCoreUnavailable):
        await invoke(wire, workspace, handoff, revision)
    assert len(wire.calls) == 1 and not handoff._pending
    assert await invoke(wire, workspace, handoff, revision) is None
    assert len(wire.calls) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("lease_id", str(uuid4())),
        ("lease_receipt_id", str(uuid4())),
        ("capture_authorized_until", datetime.now(UTC).isoformat()),
    ],
)
async def test_retained_foreign_window_never_dispatches_replacement(field, value):
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire)
    payload = wire.payload(workspace)
    payload["operation"]["payload"][field] = value
    with pytest.raises(ProviderCoreUnavailable):
        await invoke(wire, workspace, handoff, revision, payload)
    assert not wire.calls and not handoff._pending


@pytest.mark.parametrize("field,value", [("lease_generation", 2), ("first_sequence_number", 1)])
async def test_resume_selects_existing_transport_before_any_source_io(field, value):
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire)
    payload = wire.payload(workspace)
    payload["operation"]["payload"][field] = value
    assert await invoke(wire, workspace, handoff, revision, payload) is None
    assert not wire.calls and not handoff._pending


@pytest.mark.parametrize("age", [25, 29, 30, 31])
async def test_expired_original_epoch_is_pre_dispatch_compatibility(age):
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire, age=age)
    assert await invoke(wire, workspace, handoff, revision) is None
    assert not wire.calls


async def test_unsupported_core_uses_pre_dispatch_compatibility():
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire, supported=False)
    assert await invoke(wire, workspace, handoff, revision) is None
    assert not wire.calls


async def test_cancelled_concurrent_source_consumes_handoff_only_once():
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire)
    entered, original = asyncio.Event(), wire.handle

    async def blocked(request):
        await original(request)
        entered.set()
        await asyncio.Event().wait()

    wire.handle = blocked
    task = asyncio.create_task(invoke(wire, workspace, handoff, revision))
    await asyncio.wait_for(entered.wait(), 5)
    assert await invoke(wire, workspace, handoff, revision) is None
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(wire.calls) == 1 and not handoff._pending


def window_fixture(wire, workspace):
    request = {
        "operation": {
            "kind": "prepare_recording_window",
            "payload": {
                "schema_version": "1.0",
                "binding": {"key_version": "synthetic-key", "wrapped_dek": "a" * 512},
                "bind_idempotency_key": "synthetic-bind-key",
                "lease_idempotency_key": "synthetic-lease-key",
                "reserve_idempotency_key": "synthetic-reserve-key",
                "channel": "microphone",
                "reservation_count": 30,
            },
        }
    }
    now = datetime.now(UTC).isoformat()
    answer = {
        "receipt": {
            "schema_version": "1.0",
            "binding": {"session_id": SESSION, "key_version": "synthetic-key", "created_at": now},
            "lease": {
                "protocol_version": "1.0",
                "receipt_id": str(wire.receipt_id),
                "lease_id": str(wire.lease_id),
                "session_id": SESSION,
                "generation": 1,
                "issued_at": now,
                "expires_at": wire.deadline.isoformat(),
            },
            "reservations": {
                "protocol_version": "1.0",
                "batch_id": str(uuid4()),
                "session_id": SESSION,
                "capture_authorized_until": wire.deadline.isoformat(),
                "reservations": [
                    {
                        "protocol_version": "1.0",
                        "object_id": str(uuid4()),
                        "session_id": SESSION,
                        "channel": "microphone",
                        "sequence_number": i,
                        "additional_authenticated_data": "invented-aad",
                        "created_at": now,
                    }
                    for i in range(30)
                ],
            },
        }
    }
    return request | {
        "workspace_id": workspace,
        "binding_ref": BINDING,
        "request_nonce": str(uuid4()),
    }, answer


async def test_first_window_carries_original_age_and_marker_only_after_all_window_checks():
    wire = SourceWire()
    workspace = str(uuid4())
    client, handoff, revision = retained_preparation(
        wire, workspace, issued_at=90, native_read_done=True, source_start_supported=True
    )
    await client.close()
    retained = handoff.take(ORIGIN, ACCOUNT, revision, workspace, BINDING)
    request, answer = window_fixture(wire, workspace)
    retain_source_window(
        handoff, ORIGIN, ACCOUNT, revision, workspace, BINDING, retained, request, answer
    )
    saved = handoff.take(ORIGIN, ACCOUNT, revision, workspace, BINDING, stage="source_start")
    assert saved is not None and saved.issued_at == 90 and saved.native_read_done
    assert saved.source_window.session_id == UUID(SESSION)
    assert saved.stage == "source_start"


async def test_admission_propagates_source_capability_without_changing_mobile_contract():
    wire = NativeWire()
    workspace = str(uuid4())
    client, handoff, revision = retained_preparation(
        wire,
        workspace,
        stage="admission",
        source_start_supported=True,
        admission_native_preparation_supported=True,
    )
    await client.close()
    result = await prepare_then_dispatch(
        ORIGIN,
        "capture-admissions",
        {
            "workspace_id": workspace,
            "binding_ref": BINDING,
            "request_nonce": str(uuid4()),
            "attestation": {"all_parties_consented": True},
            "configured_capture": {"schema_version": "1.0", "language_mode": "en-US"},
            "native_recording_preparation": True,
        },
        "original-admission-key",
        revision,
        wire.fresh,
        wire.workload,
        handoff=handoff,
        transport=httpx.MockTransport(wire.handle),
    )
    saved = handoff.take(ORIGIN, ACCOUNT, revision, workspace, BINDING)
    assert saved.source_start_supported and saved.native_read_done
    assert saved.source_window is None and saved.issued_at == 100
    assert "source_start" not in str(result)


class PipelineWire(SourceWire):
    def __init__(self, versions=("1",)):
        super().__init__()
        self.versions = versions

    async def handle(self, request):
        data = json.loads(request.content)
        if data["action"] == "prepared_window":
            self.calls.append(data)
            _, answer = window_fixture(self, data["workspace_id"])
            self.after()
            return httpx.Response(
                200,
                json={
                    "version": "1",
                    "action": "prepared_window",
                    "actor_ref": ACCOUNT.actor_ref,
                    "tenant_ref": ACCOUNT.tenant_ref,
                    "result": {
                        "contract_version": "1",
                        "workspace_id": data["workspace_id"],
                        "binding_ref": BINDING,
                        "request_nonce": data["request_nonce"],
                        "checked_at": datetime.now(UTC).isoformat(),
                        "operation": "prepare_recording_window",
                        **answer,
                    },
                },
                headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
            )
        answer = await super().handle(request)
        if data["action"] != "mount":
            return answer
        value = answer.json()
        value["result"]["prepared_context"] = {
            "context_token": "invented-context-token",
            "interaction_ref": "invented-interaction-0123456789",
            "client_turn_id": str(uuid4()),
        }
        headers = (
            list(answer.headers.multi_items())
            + [
                ("X-Cosmaneura-Prepared-Native-Read-Version", "1"),
                ("X-Cosmaneura-Admission-Native-Preparation-Version", "1"),
            ]
            + [("X-Cosmaneura-Prepared-Source-Start-Version", v) for v in self.versions]
        )
        return httpx.Response(200, json=value, headers=headers)


async def mount(wire):
    workspace, revision = str(uuid4()), uuid4()
    clock = [100.0]
    handoff = PreparationHandoff(clock=lambda: clock[0])
    client = ProviderNativeCoreTransport(
        ORIGIN, wire.fresh, wire.workload, transport=httpx.MockTransport(wire.handle)
    )
    try:
        _, value = await client.request(
            "mount",
            {"workspace_id": workspace},
            "original-mount-key",
            handoff=handoff,
            revision=revision,
        )
    finally:
        await client.close()
    assert "prepared_context" not in value and "invented-context-token" not in str(value)
    return workspace, handoff, revision, clock


@pytest.mark.parametrize(
    "versions,supported",
    [((), False), (("1",), True), (("2",), False), (("1", "1"), False), (("1, 1",), False)],
)
async def test_source_capability_requires_one_exact_supported_mount_header(versions, supported):
    wire = PipelineWire(versions)
    workspace, handoff, revision, _ = await mount(wire)
    context = handoff.take(ORIGIN, ACCOUNT, revision, workspace, BINDING, stage="admission")
    assert context.source_start_supported is supported


@pytest.mark.parametrize("mobile", [True, False])
async def test_real_transports_mount_admission_window_source_share_one_original_epoch(mobile):
    wire = PipelineWire()
    workspace, handoff, revision, clock = await mount(wire)
    original = next(iter(handoff._pending.values()))
    clock[0] += 2
    admission = {
        "workspace_id": workspace,
        "binding_ref": BINDING,
        "request_nonce": str(uuid4()),
        "attestation": {"all_parties_consented": True},
        "configured_capture": {"schema_version": "1.0", "language_mode": "en-US"},
    }
    if mobile:
        admission["native_recording_preparation"] = True
    await prepare_then_dispatch(
        ORIGIN,
        "capture-admissions",
        admission,
        "original-admission-key",
        revision,
        wire.fresh,
        wire.workload,
        handoff=handoff,
        transport=httpx.MockTransport(wire.handle),
    )
    if not mobile:
        client = ProviderNativeCoreTransport(
            ORIGIN, wire.fresh, wire.workload, transport=httpx.MockTransport(wire.handle)
        )
        try:
            await client.request(
                "capture-operations",
                {
                    "workspace_id": workspace,
                    "binding_ref": BINDING,
                    "request_nonce": str(uuid4()),
                    "operation": {"kind": "native_recording_preparation"},
                },
                "original-native-read-key",
                handoff=handoff,
                revision=revision,
            )
        finally:
            await client.close()
    clock[0] += 2
    request, _ = window_fixture(wire, workspace)
    before = wire.checks
    await prepare_then_dispatch(
        ORIGIN,
        "capture-operations",
        request,
        "original-window-key",
        revision,
        wire.fresh,
        wire.workload,
        handoff=handoff,
        transport=httpx.MockTransport(wire.handle),
    )
    assert wire.checks - before == 6
    retained = next(iter(handoff._pending.values()))
    assert retained.stage == "source_start" and retained.native_read_done
    assert retained.issued_at == original.issued_at == 100.0 and retained.token == original.token
    clock[0] += 2
    before = wire.checks
    result = await invoke(wire, workspace, handoff, revision)
    assert result["preparation"]["receipt"]["session_id"] == SESSION
    assert wire.checks - before == 6
    assert [data["action"] for data in wire.calls] == [
        "mount",
        "prepared_admission",
        *([] if mobile else ["prepared_native_read"]),
        "prepared_window",
        "prepared_source",
    ]
    assert wire.calls[-1]["prepared_context"] == wire.calls[-2]["prepared_context"]
    assert not handoff._pending


@pytest.mark.parametrize(
    "fault", ["key", "session", "deadline", "index", "object", "channel", "extra"]
)
async def test_malformed_first_window_cannot_publish_a_source_credential(fault):
    wire = SourceWire()
    workspace = str(uuid4())
    client, handoff, revision = retained_preparation(wire, workspace, source_start_supported=True)
    await client.close()
    context = handoff.take(ORIGIN, ACCOUNT, revision, workspace, BINDING)
    request, answer = window_fixture(wire, workspace)
    receipt = answer["receipt"]
    if fault == "key":
        receipt["binding"]["key_version"] = "foreign-key"
    elif fault == "session":
        receipt["binding"]["session_id"] = str(uuid4())
    elif fault == "deadline":
        receipt["reservations"]["capture_authorized_until"] = datetime.now(UTC).isoformat()
    elif fault == "index":
        receipt["reservations"]["reservations"][0]["sequence_number"] = 1
    elif fault == "object":
        receipt["reservations"]["reservations"][0]["object_id"] = receipt["reservations"][
            "reservations"
        ][1]["object_id"]
    elif fault == "channel":
        receipt["reservations"]["reservations"][0]["channel"] = "mixed"
    else:
        receipt["lease"]["permission"] = True
    with pytest.raises(ProviderCoreUnavailable):
        retain_source_window(
            handoff, ORIGIN, ACCOUNT, revision, workspace, BINDING, context, request, answer
        )
    assert not handoff._pending


@pytest.mark.parametrize(
    "change",
    [
        "origin",
        "revision",
        "workspace",
        "binding",
        "actor",
        "tenant",
        "recovery",
        "account",
        "session",
    ],
)
async def test_foreign_handoff_scope_does_not_dispatch_a_source_request(change):
    wire = SourceWire()
    workspace, handoff, revision = await setup(wire)
    origin, binding = ORIGIN, BINDING
    if change == "origin":
        origin = "https://other.synthetic.invalid"
    elif change == "revision":
        revision = uuid4()
    elif change == "workspace":
        workspace = str(uuid4())
    elif change == "binding":
        binding = "scribe_capture_binding_01j11111111111111111111111"
    else:
        fields = {
            "actor": ("actor_ref", "other-actor"),
            "tenant": ("tenant_ref", "other-tenant"),
            "recovery": ("recovery_scope", uuid4()),
            "account": ("account_id", "other-account"),
            "session": (
                "user_token",
                SecretStr("invented-other-session-token"),
            ),
        }
        field, value = fields[change]
        wire.account = replace(ACCOUNT, **{field: value})
    payload = wire.payload(workspace)
    payload["binding_ref"] = binding
    assert (
        await prepare_source(
            origin,
            payload,
            "original-prepare-key",
            revision,
            wire.fresh,
            wire.workload,
            handoff,
            transport=httpx.MockTransport(wire.handle),
        )
        is None
    )
    assert not wire.calls
