"""A pending credential removes setup, never the mutation's current fences."""

from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_preparation_core_transport import PATH, prepare_then_dispatch
from cosmaneura_scribe.provider_preparation_handoff import PreparationHandoff
from pydantic import SecretStr
from test_provider_native_core_transport import ACCOUNT, BINDING
from test_provider_preparation_core_transport import Wire

pytestmark = pytest.mark.asyncio


class HandoffWire(Wire):
    async def handle(self, request):
        import json
        from datetime import UTC, datetime

        data = json.loads(request.content)
        if request.url.path == PATH and data["action"] == "prepared_native_read":
            from test_provider_native_core_transport import Wire as NativeWire

            self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
            assert data["prepared_context"]["context_token"] == "invented-server-context-token"
            return await NativeWire().handle(request)
        if request.url.path != PATH or data["action"] != "prepared_window":
            return await super().handle(request)
        self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
        assert request.headers["authorization"] == "Bearer " + getattr(
            self, "expected_user_token", "invented-user-session-token"
        )
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer invented-workload-token"
        )
        if self.lose == PATH:
            raise httpx.ReadError("invented window reply loss")
        assert data["prepared_context"]["context_token"] == "invented-server-context-token"
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
                    "binding_ref": data["binding_ref"],
                    "request_nonce": data["request_nonce"],
                    "checked_at": datetime.now(UTC).isoformat(),
                    "operation": "prepare_recording_window",
                    "receipt": {"schema_version": "1.0"},
                },
            },
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
        )


class Sequence:
    def __init__(self):
        self.wire = HandoffWire()
        self.now = 100.0
        self.pending = PreparationHandoff(clock=lambda: self.now)
        self.origin = "https://core.synthetic.invalid"
        self.workspace = str(uuid4())
        self.revision = uuid4()
        self.binding = BINDING

    async def call(self, admission=False, metadata=True):
        payload = {
            "workspace_id": self.workspace,
            "binding_ref": self.binding,
            "request_nonce": str(uuid4()),
        }
        if admission:
            payload.update(
                attestation={"all_parties_consented": True},
                configured_capture={"schema_version": "1.0", "language_mode": "en-US"},
            )
            if metadata:
                payload["preparation_metadata"] = True
        else:
            payload["operation"] = {"kind": "prepare_recording_window", "payload": {}}
        return await prepare_then_dispatch(
            self.origin,
            "capture-admissions" if admission else "capture-operations",
            payload,
            str(uuid4()),
            self.revision,
            self.wire.fresh,
            self.wire.workload,
            transport=httpx.MockTransport(self.wire.handle),
            handoff=self.pending,
        )


async def test_verified_session_survives_token_refresh_without_reusing_access():
    s = Sequence()
    s.wire.account = replace(ACCOUNT, session_fingerprint=b"s" * 32)
    # This wire's fresh() method uses its configured account. Every original
    # current-account check still executes around each native mutation.
    original = s.wire.fresh

    async def current():
        await original()
        return s.wire.account

    s.wire.fresh = current
    await s.call(admission=True)
    s.wire.account = replace(s.wire.account, user_token=SecretStr("refreshed-user-session-token"))
    s.wire.expected_user_token = "refreshed-user-session-token"
    s.wire.calls.clear()
    s.wire.checks = 0
    answer = await s.call()
    assert answer["operation"] == "prepare_recording_window"
    assert s.wire.checks == 6
    assert len(s.wire.calls) == 1 and s.wire.calls[0][1]["action"] == "prepared_window"
    assert not s.pending._pending


@pytest.mark.parametrize(
    "fault", ["session", "account", "actor", "tenant", "recovery", "missing_session"]
)
async def test_verified_session_keeps_all_other_handoff_boundaries(fault):
    s = Sequence()
    initial = replace(ACCOUNT, session_fingerprint=b"s" * 32)
    from uuid import UUID

    from cosmaneura_scribe.provider_core_transport import CoreProviderMount, CoreProviderSelection
    from cosmaneura_scribe.provider_preparation_handoff import PreparedContext

    selection = CoreProviderSelection(
        initial.recovery_scope,
        uuid4(),
        UUID(s.workspace),
        "appointment_01j00000000000000000000000",
        initial.actor_ref,
        initial.tenant_ref,
    )
    context = PreparedContext(
        CoreProviderMount(selection, s.binding),
        SecretStr("invented-context-token"),
        "invented-interaction-123",
        uuid4(),
        s.now,
        "admission",
    )
    s.pending.retain(s.origin, initial, s.revision, s.workspace, s.binding, context)
    changes = {
        "session": {"session_fingerprint": b"t" * 32},
        "account": {"account_id": "another-account"},
        "actor": {"actor_ref": "another-actor"},
        "tenant": {"tenant_ref": "another-tenant"},
        "recovery": {"recovery_scope": uuid4()},
        "missing_session": {"session_fingerprint": None},
    }
    assert (
        s.pending.take(
            s.origin,
            replace(initial, **changes[fault]),
            s.revision,
            s.workspace,
            s.binding,
            "admission",
        )
        is None
    )
    assert (
        s.pending.take(s.origin, initial, s.revision, s.workspace, s.binding, "admission")
        == context
    )


@pytest.mark.parametrize("value", [b"", b"x" * 31, b"x" * 33, "x" * 32, bytearray(b"x" * 32)])
async def test_session_fingerprint_requires_fixed_digest_bytes(value):
    with pytest.raises(ValueError, match="provider_session_fingerprint_invalid"):
        replace(ACCOUNT, session_fingerprint=value)


async def test_one_window_omits_setup_but_keeps_all_six_fresh_registry_checks():
    s = Sequence()
    admission = await s.call(admission=True)
    assert s.wire.checks == 9 and len(s.wire.calls) == 3
    assert admission["preparation_metadata"]["review"]["session_id"] == admission["session_id"]
    s.wire.calls.clear()
    s.wire.checks = 0
    answer = await s.call()
    assert s.wire.checks == 6
    assert len(s.wire.calls) == 1 and s.wire.calls[0][1]["action"] == "prepared_window"
    assert "invented-server-context-token" not in str(answer)
    assert not s.pending._pending
    s.wire.calls.clear()
    await s.call()
    assert len(s.wire.calls) == 2 and s.wire.calls[0][0] == PATH


@pytest.mark.parametrize("boundary", range(1, 7))
async def test_revocation_still_blocks_each_window_fence_without_fallback(boundary):
    s = Sequence()
    await s.call(admission=True)
    s.wire.calls.clear()
    s.wire.checks = 0
    s.wire.revoke_at = boundary
    with pytest.raises(ProviderCoreUnavailable):
        await s.call()
    assert len(s.wire.calls) == (0 if boundary <= 4 else 1)
    assert all(row[1]["action"] == "prepared_window" for row in s.wire.calls)


@pytest.mark.parametrize(
    "fault",
    [
        "expiry",
        "backward_clock",
        "revision",
        "workspace",
        "origin",
        "account",
        "actor",
        "tenant",
        "recovery",
        "user_token",
    ],
)
async def test_unmatched_or_expired_scope_uses_original_negotiation(fault):
    s = Sequence()
    await s.call(admission=True)
    s.wire.calls.clear()
    if fault == "expiry":
        s.now += 30
    elif fault == "backward_clock":
        s.now -= 1
    elif fault == "revision":
        s.revision = uuid4()
    elif fault == "workspace":
        s.workspace = str(uuid4())
    elif fault == "origin":
        s.origin = "https://another.synthetic.invalid"
    else:
        changes = {
            "account": {"account_id": str(uuid4())},
            "actor": {"actor_ref": "authority_actor_" + "0" * 26},
            "tenant": {"tenant_ref": "authority_tenant_" + "0" * 26},
            "recovery": {"recovery_scope": uuid4()},
            "user_token": {"user_token": SecretStr("another-invented-user-session-token")},
        }
        account = replace(ACCOUNT, **changes[fault])

        async def fresh():
            return account

        s.wire.fresh = fresh
        # The first setup request proves that no old credential was consumed.
        s.wire.lose = PATH
    if fault in {"account", "actor", "tenant", "recovery", "user_token"}:
        with pytest.raises(httpx.ReadError):
            await s.call()
    else:
        await s.call()
    assert s.wire.calls[0][0] == PATH


async def test_lost_window_reply_consumes_handoff_and_never_retries():
    s = Sequence()
    await s.call(admission=True)
    s.wire.calls.clear()
    s.wire.lose = PATH
    with pytest.raises(ProviderCoreUnavailable):
        await s.call()
    assert len(s.wire.calls) == 1 and not s.pending._pending


async def test_partial_failure_never_retains_and_mobile_admission_can_handoff():
    s = Sequence()
    s.wire.lose = "/service/v1/agent/scribe/capture-operations"
    with pytest.raises(ProviderCoreUnavailable):
        await s.call(admission=True)
    assert not s.pending._pending
    s.wire.lose = None
    await s.call(admission=True, metadata=False)
    assert s.pending._pending
    s.wire.calls.clear()
    await s.call()
    assert len(s.wire.calls) == 1 and s.wire.calls[0][1]["action"] == "prepared_window"


async def test_mobile_admission_native_read_window_preserves_the_handoff_and_original_keys():
    from cosmaneura_scribe.provider_native_core_transport import ProviderNativeCoreTransport

    s = Sequence()
    s.wire.native_read_supported = True
    await s.call(admission=True, metadata=False)
    s.wire.calls.clear()
    s.wire.checks = 0
    client = ProviderNativeCoreTransport(
        s.origin, s.wire.fresh, s.wire.workload, transport=httpx.MockTransport(s.wire.handle)
    )
    try:
        _, result = await client.request(
            "capture-operations",
            {
                "workspace_id": s.workspace,
                "binding_ref": s.binding,
                "request_nonce": str(uuid4()),
                "operation": {"kind": "native_recording_preparation"},
            },
            "original-mobile-read-key",
            handoff=s.pending,
            revision=s.revision,
        )
    finally:
        await client.close()
    assert result["receipt"]["context"]["workspace_id"] == s.workspace
    assert s.wire.checks == 3 and s.pending._pending
    assert s.wire.calls[0][2] == "original-mobile-read-key"
    await s.call()
    assert [row[1]["action"] for row in s.wire.calls] == ["prepared_native_read", "prepared_window"]
    assert s.wire.checks == 9 and not s.pending._pending


async def test_new_admission_invalidates_pending_context_and_renegotiates():
    s = Sequence()
    await s.call(admission=True)
    s.wire.calls.clear()
    await s.call(admission=True)
    assert len(s.wire.calls) == 3 and s.wire.calls[0][0] == PATH


async def test_handoff_bounds_memory_and_expiry_and_repr_contains_no_credential():
    s = Sequence()
    await s.call(admission=True)
    context = next(iter(s.pending._pending.values()))
    assert "invented-server-context-token" not in repr(context)
    for _ in range(100):
        s.pending.retain(s.origin, ACCOUNT, uuid4(), s.workspace, BINDING, context)
    assert len(s.pending._pending) == 64
    s.now += 30
    assert s.pending.take(s.origin, ACCOUNT, s.revision, s.workspace, BINDING) is None
    assert not s.pending._pending


class MountHandoffWire(HandoffWire):
    async def handle(self, request):
        import json
        from datetime import UTC, datetime

        from test_provider_native_core_transport import SESSION, SUFFIX
        from test_provider_native_core_transport import Wire as NativeWire

        data = json.loads(request.content)
        if data.get("action") == "mount":
            native = NativeWire()

            def add(value):
                value["result"]["prepared_context"] = {
                    "context_token": "invented-server-context-token",
                    "interaction_ref": "invented-interaction-0123456789",
                    "client_turn_id": str(uuid4()),
                }
                return value

            native.alter = add
            answer = await native.handle(request)
            self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
            return answer
        if data.get("action") != "prepared_admission":
            return await super().handle(request)
        self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
        assert request.headers["authorization"] == "Bearer invented-user-session-token"
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer invented-workload-token"
        )
        assert data["prepared_context"]["context_token"] == "invented-server-context-token"
        if self.lose == PATH:
            raise httpx.ReadError("invented admission reply loss")
        return httpx.Response(
            200,
            json={
                "version": "1",
                "action": "prepared_admission",
                "actor_ref": ACCOUNT.actor_ref,
                "tenant_ref": ACCOUNT.tenant_ref,
                "result": {
                    "contract_version": "1",
                    "workspace_id": data["workspace_id"],
                    "binding_ref": data["binding_ref"],
                    "request_nonce": data["request_nonce"],
                    "checked_at": datetime.now(UTC).isoformat(),
                    "appointment_ref": "appointment_" + SUFFIX,
                    "operation_ref": "scribe_admission_" + SUFFIX,
                    "session_id": SESSION,
                    "consent_record_id": str(uuid4()),
                    "status": "admitted",
                    "configured_capture": data["configured_capture"],
                },
            },
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
        )


async def mount(sequence):
    from cosmaneura_scribe.provider_native_core_transport import ProviderNativeCoreTransport

    sequence.wire = MountHandoffWire()
    native = ProviderNativeCoreTransport(
        sequence.origin,
        sequence.wire.fresh,
        sequence.wire.workload,
        transport=httpx.MockTransport(sequence.wire.handle),
    )
    try:
        _, result = await native.request(
            "mount",
            {"workspace_id": sequence.workspace},
            str(uuid4()),
            handoff=sequence.pending,
            revision=sequence.revision,
        )
        assert "prepared_context" not in result and "invented-server-context-token" not in str(
            result
        )
        assert next(iter(sequence.pending._pending.values())).stage == "admission"
    finally:
        await native.close()
    sequence.wire.calls.clear()
    sequence.wire.checks = 0


@pytest.mark.parametrize("metadata", [True, False])
async def test_mount_to_admission_to_window_never_reissues_a_context(metadata):
    s = Sequence()
    await mount(s)
    answer = await s.call(admission=True, metadata=metadata)
    assert answer["status"] == "admitted"
    assert [
        row[1].get("action", row[1].get("operation", {}).get("kind")) for row in s.wire.calls
    ] == (["prepared_admission", "preparation_metadata"] if metadata else ["prepared_admission"])
    assert next(iter(s.pending._pending.values())).stage == "recording_window"
    s.wire.calls.clear()
    s.wire.checks = 0
    await s.call()
    assert len(s.wire.calls) == 1 and s.wire.calls[0][1]["action"] == "prepared_window"
    assert s.wire.checks == 6 and not s.pending._pending


@pytest.mark.parametrize("boundary", range(1, 7))
async def test_mount_context_does_not_bypass_each_admission_registry_boundary(boundary):
    s = Sequence()
    await mount(s)
    s.wire.revoke_at = boundary
    with pytest.raises(ProviderCoreUnavailable):
        await s.call(admission=True, metadata=False)
    assert len(s.wire.calls) == (0 if boundary <= 4 else 1)
    assert not any(row[1].get("action") == "preparation_context" for row in s.wire.calls)


async def test_lost_admission_reply_is_not_retried_and_discards_context():
    s = Sequence()
    await mount(s)
    s.wire.lose = PATH
    with pytest.raises(ProviderCoreUnavailable):
        await s.call(admission=True)
    assert len(s.wire.calls) == 1 and not s.pending._pending


async def test_mount_context_is_not_reused_for_wrong_step_or_after_user_wait():
    s = Sequence()
    await mount(s)
    s.wire = HandoffWire()
    await s.call()  # Wrong stage: negotiate before mutation.
    assert len(s.wire.calls) == 2 and not s.pending._pending
    await mount(s)
    s.now += 30
    s.wire = HandoffWire()
    await s.call(admission=True)
    assert len(s.wire.calls) == 3 and s.wire.calls[0][1]["action"] == "preparation_context"


@pytest.mark.parametrize("stage,age", [("admission", 15), ("recording_window", 25)])
async def test_old_context_negotiates_early_enough_to_finish_next_step(stage, age):
    s = Sequence()
    if stage == "admission":
        await mount(s)
    else:
        await s.call(admission=True)
    s.now += age
    s.wire = HandoffWire()
    await s.call(admission=stage == "admission")
    assert s.wire.calls[0][1]["action"] == "preparation_context"
