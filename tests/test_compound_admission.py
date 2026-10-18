"""Actual receiver transport, synthetic HTTP only; no token SDK/SQL/audio."""

import asyncio
import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_native_core_transport import ProviderNativeCoreTransport
from cosmaneura_scribe.provider_preparation_core_transport import prepare_then_dispatch
from cosmaneura_scribe.provider_preparation_handoff import PreparationHandoff
from pydantic import SecretStr
from test_provider_native_core_transport import ACCOUNT, BINDING, SESSION
from test_provider_native_core_transport import Wire as NativeWire
from test_provider_preparation_core_transport import Wire as LegacyWire

pytestmark = pytest.mark.asyncio


class Sequence:
    def __init__(self, advertisement=("1",)):
        self.now = 100.0
        self.account = replace(ACCOUNT, session_fingerprint=b"s" * 32)
        self.workspace, self.revision = str(uuid4()), uuid4()
        self.origin = "https://core.synthetic.invalid"
        self.handoff = PreparationHandoff(clock=lambda: self.now)
        self.sent, self.checks = [], 0
        self.advertisement = advertisement
        self.revoke_at = None
        self.failure = None
        self.alter = lambda value: value
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        self.hold = False

    async def fresh(self):
        self.checks += 1
        if self.checks == self.revoke_at:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        return self.account

    async def workload(self):
        return SecretStr("invented-workload-token")

    async def handle(self, request):
        data = json.loads(request.content)
        self.sent.append((request.url.path, data, request.headers["idempotency-key"]))
        assert "cookie" not in request.headers
        if data.get("action") == "fresh_admission":
            assert (
                request.headers["authorization"]
                == "Bearer " + self.account.user_token.get_secret_value()
            )
            assert (
                request.headers["x-cosmaneura-workload-authorization"]
                == "Bearer invented-workload-token"
            )
            assert "prepared_context" not in data
            assert data["retain_preparation_context"] is True
            self.entered.set()
            if self.hold:
                await self.release.wait()
            if self.failure == "loss":
                raise httpx.ReadError("synthetic response lost")
            projected = {**data, "action": "prepared_admission"}
            response = await NativeWire().handle(
                httpx.Request("POST", request.url, headers=request.headers, json=projected)
            )
            value = response.json()
            value["action"] = "fresh_admission"
            value["result"]["prepared_context"] = self.private()
            return httpx.Response(
                503 if self.failure == "status" else 200,
                json=self.alter(value),
                headers=self.headers(),
            )
        if data.get("action") == "mount":
            response = await NativeWire().handle(request)
            value = response.json()
            value["result"]["prepared_context"] = self.private()
            headers = self.headers()
            headers += [
                ("x-cosmaneura-compound-admission-version", value) for value in self.advertisement
            ]
            return httpx.Response(200, json=self.alter(value), headers=headers)
        return await LegacyWire().handle(request)

    @staticmethod
    def private():
        return {
            "context_token": "invented-server-context-token",
            "interaction_ref": "invented-interaction-0123456789",
            "client_turn_id": str(uuid4()),
        }

    @staticmethod
    def headers():
        return [
            ("Cache-Control", "no-store"),
            ("X-Cosmaneura-Native-Capture-Version", "1"),
            ("X-Cosmaneura-Admission-Native-Preparation-Version", "1"),
            ("X-Cosmaneura-Admission-Preparation-Metadata-Version", "1"),
            ("X-Cosmaneura-Prepared-Native-Read-Version", "1"),
            ("X-Cosmaneura-Prepared-Source-Start-Version", "1"),
        ]

    async def mount(self):
        transport = ProviderNativeCoreTransport(
            self.origin, self.fresh, self.workload, transport=httpx.MockTransport(self.handle)
        )
        try:
            _, answer = await transport.request(
                "mount",
                {"workspace_id": self.workspace},
                "synthetic-mount-key",
                handoff=self.handoff,
                revision=self.revision,
            )
            assert "invented-server-context-token" not in str(answer)
        finally:
            await transport.close()
        self.sent.clear()
        self.checks = 0

    async def admit(self, metadata=None, extra=None):
        body = {
            "workspace_id": self.workspace,
            "binding_ref": BINDING,
            "request_nonce": str(uuid4()),
            "attestation": {"all_parties_consented": True},
            "configured_capture": {"schema_version": "1.0", "language_mode": "en-US"},
            **(extra or {}),
        }
        if metadata is not None:
            body[metadata] = True
        return await prepare_then_dispatch(
            self.origin,
            "capture-admissions",
            body,
            "original-retained-key",
            self.revision,
            self.fresh,
            self.workload,
            transport=httpx.MockTransport(self.handle),
            handoff=self.handoff,
        )


@pytest.mark.parametrize("idle", [30, 60])
@pytest.mark.parametrize("metadata", [None, "native_recording_preparation", "preparation_metadata"])
async def test_long_idle_uses_one_post_and_keeps_context_private_and_original_epoch(idle, metadata):
    s = Sequence()
    await s.mount()
    s.now += idle
    answer = await s.admit(metadata)
    assert len(s.sent) == 1 and s.sent[0][1]["action"] == "fresh_admission"
    assert s.sent[0][2] == "original-retained-key" and s.checks == 9
    assert answer["status"] == "admitted" and answer["session_id"] == SESSION
    assert not any(
        k in answer
        for k in ("prepared_context", "context_token", "interaction_ref", "client_turn_id")
    )
    assert "invented-server-context-token" not in str(answer)
    context = s.handoff.take(s.origin, s.account, s.revision, s.workspace, BINDING)
    assert context is not None and context.issued_at == 100 + idle
    assert context.native_read_done == (metadata == "native_recording_preparation")
    assert context.native_read_supported and context.source_start_supported
    assert s.handoff.take(s.origin, s.account, s.revision, s.workspace, BINDING) is None
    s.handoff.close()


@pytest.mark.parametrize("advertisement", [(), ("0",), ("true",), ("1", "1"), ("1", "0")])
async def test_missing_or_non_singleton_capability_selects_legacy_before_dispatch(advertisement):
    s = Sequence(advertisement)
    await s.mount()
    s.now += 60
    answer = await s.admit()
    assert len(s.sent) == 2 and s.sent[0][1]["action"] == "preparation_context"
    assert s.sent[1][0].endswith("capture-admissions") and answer["status"] == "admitted"
    assert all(row[1].get("action") != "fresh_admission" for row in s.sent)
    s.handoff.close()


@pytest.mark.parametrize("boundary", range(1, 10))
async def test_current_caller_fences_stop_dispatch_or_publication(boundary):
    s = Sequence()
    await s.mount()
    s.now += 60
    s.revoke_at = boundary
    with pytest.raises(ProviderCoreUnavailable):
        await s.admit("native_recording_preparation")
    assert len(s.sent) == (0 if boundary <= 5 else 1)
    assert (
        s.handoff.take(s.origin, s.account, s.revision, s.workspace, BINDING, stage="admission")
        is None
    )
    s.handoff.close()


@pytest.mark.parametrize("failure", ["loss", "status"])
async def test_uncertain_mutation_never_falls_back_and_requires_fresh_mount(failure):
    s = Sequence()
    await s.mount()
    s.now += 60
    s.failure = failure
    with pytest.raises(ProviderCoreUnavailable):
        await s.admit()
    assert len(s.sent) == 1
    with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
        await s.admit()
    assert len(s.sent) == 1
    s.failure = None
    await s.mount()
    s.now += 60
    assert (await s.admit())["status"] == "admitted"
    s.handoff.close()


async def test_cancel_during_dispatched_compound_preserves_no_fallback_or_handoff():
    s = Sequence()
    await s.mount()
    s.now += 60
    s.hold = True
    task = asyncio.create_task(s.admit())
    await s.entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(s.sent) == 1 and not s.handoff._pending
    with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
        await s.admit()
    s.handoff.close()


@pytest.mark.parametrize(
    "fault", ["missing", "extra", "token_type", "interaction", "turn", "session"]
)
async def test_private_or_metadata_invalidity_refuses_whole_reply(fault):
    s = Sequence()
    await s.mount()
    s.now += 60

    def alter(value):
        result = value["result"]
        if fault == "missing":
            result.pop("prepared_context")
        elif fault == "extra":
            result["prepared_context"]["private_key"] = "not-allowed"
        elif fault == "token_type":
            result["prepared_context"]["context_token"] = 1
        elif fault == "interaction":
            result["prepared_context"]["interaction_ref"] = "bad"
        elif fault == "turn":
            result["prepared_context"]["client_turn_id"] = "bad"
        else:
            result["native_recording_preparation"]["context"]["session_id"] = str(uuid4())
        return value

    s.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await s.admit("native_recording_preparation")
    assert len(s.sent) == 1 and not s.handoff._pending
    s.handoff.close()


async def test_wrong_scope_and_programmatic_body_cannot_enable_capability():
    s = Sequence()
    await s.mount()
    s.now += 60
    original = s.revision
    s.revision = uuid4()
    assert (
        s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING) is None
    )
    s.revision = original
    with pytest.raises(ProviderCoreUnavailable):
        await s.admit(extra={"compound_admission": True})
    assert not s.sent
    s.handoff.close()


async def test_fresh_mount_generation_survives_older_failure_and_close_clears_all():
    s = Sequence()
    await s.mount()
    generation = s.handoff.compound_capability(
        s.origin, s.account, s.revision, s.workspace, BINDING
    )
    await s.mount()
    s.handoff.invalidate_compound(s.origin, s.account, s.revision, s.workspace, BINDING, generation)
    assert (
        s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING)
        is not None
    )
    s.handoff.close()
    assert not s.handoff._compound and not s.handoff._pending


@pytest.mark.parametrize("changed", ["account", "tenant", "session"])
async def test_held_remote_reply_cannot_publish_after_actual_account_transition(changed):
    s = Sequence()
    await s.mount()
    s.now += 60
    s.hold = True
    original = s.account
    task = asyncio.create_task(s.admit("native_recording_preparation"))
    try:
        await asyncio.wait_for(s.entered.wait(), 1)
        if changed == "account":
            s.account = replace(original, account_id=uuid4())
        elif changed == "tenant":
            s.account = replace(original, tenant_ref="authority_tenant_00000000000000000000000000")
        else:
            s.account = replace(original, session_fingerprint=b"n" * 32)
        s.release.set()
        with pytest.raises(ProviderCoreUnavailable):
            await task
        assert len(s.sent) == 1
        assert s.handoff.take(s.origin, original, s.revision, s.workspace, BINDING) is None
        s.account = original
        with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
            await s.admit()
        assert len(s.sent) == 1
    finally:
        s.release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        s.handoff.close()


async def test_bounded_capability_cache_never_evicts_failed_dispatch_into_legacy_miss():
    s = Sequence()
    revisions = [uuid4() for _ in range(64)]
    for revision in revisions:
        s.handoff.advertise_compound(
            s.origin, s.account, revision, s.workspace, BINDING, supported=True
        )
        generation = s.handoff.compound_capability(
            s.origin, s.account, revision, s.workspace, BINDING
        )
        s.handoff.invalidate_compound(
            s.origin, s.account, revision, s.workspace, BINDING, generation
        )
    with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
        s.handoff.advertise_compound(
            s.origin, s.account, uuid4(), s.workspace, BINDING, supported=True
        )
    assert len(s.handoff._compound) == 64
    for revision in revisions:
        with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
            s.handoff.compound_capability(s.origin, s.account, revision, s.workspace, BINDING)
    s.handoff.advertise_compound(
        s.origin, s.account, revisions[0], s.workspace, BINDING, supported=True
    )
    assert (
        s.handoff.compound_capability(s.origin, s.account, revisions[0], s.workspace, BINDING)
        is not None
    )
    s.handoff.close()


@pytest.mark.parametrize("outcome", ["account_changed", "expired", "failed", "resistant_cancel"])
async def test_owning_close_settles_before_handoff_and_uncertainty_quarantines(
    outcome, monkeypatch
):
    s = Sequence()
    await s.mount()
    s.now += 60
    original_account = s.account
    entered, release = asyncio.Event(), asyncio.Event()
    original_close = ProviderNativeCoreTransport.close
    clients = []

    async def close(client):
        clients.append(client)
        entered.set()
        if outcome == "failed":
            raise RuntimeError("synthetic_close_failed")
        try:
            await release.wait()
        except asyncio.CancelledError:
            assert outcome == "resistant_cancel"
            await release.wait()
        await original_close(client)

    monkeypatch.setattr(ProviderNativeCoreTransport, "close", close)
    task = asyncio.create_task(s.admit("native_recording_preparation"))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert not s.handoff._pending and s.handoff._compound_active
        if outcome == "account_changed":
            s.account = replace(original_account, session_fingerprint=b"c" * 32)
        elif outcome == "expired":
            s.now += 30
        elif outcome == "resistant_cancel":
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done() and not s.handoff._pending
        release.set()
        expected = (
            RuntimeError
            if outcome == "failed"
            else asyncio.CancelledError
            if outcome == "resistant_cancel"
            else ProviderCoreUnavailable
        )
        with pytest.raises(expected):
            await task
        assert len(clients) == 1 and len(s.sent) == 1 and not s.handoff._pending
        assert bool(s.handoff._compound_active) == (outcome == "failed")
        s.account = original_account
        with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
            await s.admit()
        assert len(s.sent) == 1
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for client in clients:
            await original_close(client)
        s.handoff.close()


@pytest.mark.parametrize("outcome", ["expired", "cancel_resisted"])
async def test_last_awaited_account_snapshot_cannot_hide_expiry_or_cancellation(outcome):
    s = Sequence()
    await s.mount()
    s.now += 60
    entered, release = asyncio.Event(), asyncio.Event()
    original_fresh = s.fresh

    async def held_final_snapshot():
        account = await original_fresh()
        if s.checks == 9:
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                assert outcome == "cancel_resisted"
                await release.wait()
        return account

    s.fresh = held_final_snapshot
    task = asyncio.create_task(s.admit())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert not s.handoff._pending and s.handoff._compound_active
        if outcome == "expired":
            s.now += 30
        else:
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        release.set()
        with pytest.raises(
            ProviderCoreUnavailable if outcome == "expired" else asyncio.CancelledError
        ):
            await task
        assert len(s.sent) == 1 and not s.handoff._pending
        s.fresh = original_fresh
        with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
            await s.admit()
        assert len(s.sent) == 1
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        s.handoff.close()


@pytest.mark.parametrize("outcome", ["loss", "cancel"])
async def test_held_dispatch_survives_unrelated_capacity_churn_without_legacy_retry(outcome):
    s = Sequence()
    await s.mount()
    s.now += 60
    s.hold = True
    task = asyncio.create_task(s.admit())
    try:
        await asyncio.wait_for(s.entered.wait(), 1)
        for _ in range(130):
            s.handoff.advertise_compound(
                s.origin, s.account, uuid4(), s.workspace, BINDING, supported=True
            )
        assert len(s.handoff._compound) == 64
        assert (
            s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING)
            is not None
        )
        if outcome == "loss":
            s.failure = "loss"
            s.release.set()
            with pytest.raises(ProviderCoreUnavailable):
                await task
        else:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert len(s.sent) == 1 and not s.handoff._pending
        with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
            await s.admit()
        assert len(s.sent) == 1
    finally:
        s.release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        s.handoff.close()


async def test_completed_compound_calls_allow_more_than_two_cache_capacities():
    s = Sequence()
    try:
        for _ in range(130):
            s.revision = uuid4()
            await s.mount()
            s.now += 60
            assert (await s.admit())["status"] == "admitted"
            assert len(s.sent) == 1 and s.sent[0][1]["action"] == "fresh_admission"
            assert not s.handoff._compound_active
        assert len(s.handoff._compound) == 64
    finally:
        s.handoff.close()


def fill_failed_scopes(s, count=63):
    for _ in range(count):
        revision = uuid4()
        s.handoff.advertise_compound(
            s.origin, s.account, revision, s.workspace, BINDING, supported=True
        )
        generation = s.handoff.compound_capability(
            s.origin, s.account, revision, s.workspace, BINDING
        )
        assert generation is not None
        s.handoff.invalidate_compound(
            s.origin, s.account, revision, s.workspace, BINDING, generation
        )


def require_protected_capacity(s):
    with pytest.raises(ProviderCoreUnavailable, match="core_provider_mount_required"):
        s.handoff.advertise_compound(
            s.origin, s.account, uuid4(), s.workspace, BINDING, supported=True
        )


async def test_one_of_two_held_calls_finishing_does_not_make_scope_evictable():
    s = Sequence()
    await s.mount()
    s.now += 60
    entered = [asyncio.Event(), asyncio.Event()]
    release = [asyncio.Event(), asyncio.Event()]
    original_handle, started = s.handle, 0

    async def held(request):
        nonlocal started
        index = started
        started += 1
        entered[index].set()
        await release[index].wait()
        return await original_handle(request)

    s.handle = held
    tasks = [asyncio.create_task(s.admit()) for _ in range(2)]
    try:
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in entered)), 1)
        assert list(s.handoff._compound_active.values()) == [2]
        fill_failed_scopes(s)
        require_protected_capacity(s)
        release[0].set()
        assert (await tasks[0])["status"] == "admitted"
        assert list(s.handoff._compound_active.values()) == [1]
        require_protected_capacity(s)
        release[1].set()
        assert (await tasks[1])["status"] == "admitted"
        assert not s.handoff._compound_active
        s.handoff.advertise_compound(
            s.origin, s.account, uuid4(), s.workspace, BINDING, supported=True
        )
        assert (
            s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING)
            is None
        )
    finally:
        for event in release:
            event.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        s.handoff.close()


@pytest.mark.parametrize("supported", [False, True])
async def test_remount_keeps_held_old_generation_until_exact_transport_settles(supported):
    s = Sequence()
    await s.mount()
    s.now += 60
    original = s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING)
    s.hold = True
    task = asyncio.create_task(s.admit())
    try:
        await asyncio.wait_for(s.entered.wait(), 1)
        s.handoff.advertise_compound(
            s.origin, s.account, s.revision, s.workspace, BINDING, supported=supported
        )
        current = s.handoff.compound_capability(
            s.origin, s.account, s.revision, s.workspace, BINDING
        )
        assert current != original and (current is not None) == supported
        if current is not None:
            acquired = s.handoff.acquire_compound(
                s.origin, s.account, s.revision, s.workspace, BINDING
            )
            assert acquired == current
            s.handoff.release_compound(s.origin, s.account, s.revision, s.workspace, BINDING)
        assert list(s.handoff._compound_active.values()) == [1]
        fill_failed_scopes(s)
        require_protected_capacity(s)
        s.failure = "loss"
        s.release.set()
        with pytest.raises(ProviderCoreUnavailable):
            await task
        assert not s.handoff._compound_active
        assert (
            s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING)
            == current
        )
        s.handoff.advertise_compound(
            s.origin, s.account, uuid4(), s.workspace, BINDING, supported=True
        )
    finally:
        s.release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        s.handoff.close()


async def test_unconfirmed_close_protects_old_scope_even_after_fresh_remount(monkeypatch):
    s = Sequence()
    await s.mount()
    s.now += 60
    original_close = ProviderNativeCoreTransport.close
    clients = []

    async def failed_close(client):
        clients.append(client)
        raise RuntimeError("synthetic_close_failed")

    monkeypatch.setattr(ProviderNativeCoreTransport, "close", failed_close)
    try:
        with pytest.raises(RuntimeError, match="synthetic_close_failed"):
            await s.admit()
        assert s.handoff._compound_active
        s.handoff.advertise_compound(
            s.origin, s.account, s.revision, s.workspace, BINDING, supported=True
        )
        assert (
            s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING)
            is not None
        )
        fill_failed_scopes(s)
        s.now += 60
        s.handoff._expire()
        assert not s.handoff._pending and s.handoff._compound_active
        require_protected_capacity(s)
    finally:
        for client in clients:
            await original_close(client)
        s.handoff.close()


async def test_readonly_capability_and_retained_admission_do_not_acquire_unused_calls():
    s = Sequence()
    try:
        await s.mount()
        original_handle = s.handle

        async def retained(request):
            if json.loads(request.content).get("action") == "prepared_admission":
                s.sent.append(
                    (
                        request.url.path,
                        json.loads(request.content),
                        request.headers["idempotency-key"],
                    )
                )
                return await NativeWire().handle(request)
            return await original_handle(request)

        s.handle = retained
        assert (
            s.handoff.compound_capability(s.origin, s.account, s.revision, s.workspace, BINDING)
            is not None
        )
        assert not s.handoff._compound_active
        assert (await s.admit())["status"] == "admitted"
        assert all(row[1].get("action") != "fresh_admission" for row in s.sent)
        assert not s.handoff._compound_active
    finally:
        s.handoff.close()


async def test_repeated_same_scope_remount_and_unconfirmed_close_keep_bounded_storage():
    s = Sequence()
    try:
        for _ in range(130):
            s.handoff.advertise_compound(
                s.origin, s.account, s.revision, s.workspace, BINDING, supported=True
            )
            generation = s.handoff.acquire_compound(
                s.origin, s.account, s.revision, s.workspace, BINDING
            )
            assert generation is not None
            s.handoff.invalidate_compound(
                s.origin, s.account, s.revision, s.workspace, BINDING, generation
            )
            # An unconfirmed close deliberately does not release this call.
        assert len(s.handoff._compound) == len(s.handoff._compound_active) == 1
        assert list(s.handoff._compound_active.values()) == [130]
        fill_failed_scopes(s)
        require_protected_capacity(s)
        s.handoff.advertise_compound(
            s.origin, s.account, s.revision, s.workspace, BINDING, supported=True
        )
        for _ in range(129):
            s.handoff.release_compound(s.origin, s.account, s.revision, s.workspace, BINDING)
        assert list(s.handoff._compound_active.values()) == [1]
        require_protected_capacity(s)
        s.handoff.release_compound(s.origin, s.account, s.revision, s.workspace, BINDING)
        assert not s.handoff._compound_active
        s.handoff.advertise_compound(
            s.origin, s.account, uuid4(), s.workspace, BINDING, supported=True
        )
    finally:
        s.handoff.close()
