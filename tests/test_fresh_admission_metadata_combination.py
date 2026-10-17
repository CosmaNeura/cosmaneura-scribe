"""Synthetic consented source-only fixtures; no actual receiver or audio."""

import asyncio
import copy
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_native_core_transport import ProviderNativeCoreTransport
from cosmaneura_scribe.provider_preparation_core_transport import prepare_then_dispatch
from test_fresh_preparation_source_capability import HEADER as SOURCE_HEADER
from test_fresh_preparation_source_capability import SourceWire, source, window
from test_provider_native_core_transport import ACCOUNT, SESSION
from test_provider_native_core_transport import Wire as NativeWire
from test_provider_preparation_handoff import Sequence

pytestmark = pytest.mark.asyncio
HEADERS = {
    "desktop": "X-Cosmaneura-Admission-Preparation-Metadata-Version",
    "ios": "X-Cosmaneura-Admission-Native-Preparation-Version",
}
FIELDS = {"desktop": "preparation_metadata", "ios": "native_recording_preparation"}


class CombinationWire(SourceWire):
    def __init__(self, mode="desktop", headers=None):
        if headers is None:
            headers = [(HEADERS[mode], "1"), (SOURCE_HEADER, "1")]
        super().__init__(headers)
        self.mode = mode
        self.context_alter = lambda value: value
        self.prepared_alter = lambda value: value
        self.context_after = lambda: None
        self.prepared_after = lambda: None
        self.context_status = 200
        self.prepared_status = 200
        self.lose_prepared = False
        self.duplicate_context = False
        self.duplicate_prepared = False
        self.context_entered = asyncio.Event()
        self.prepared_entered = asyncio.Event()
        self.wait_context = False
        self.wait_prepared = False
        self.swallow_cancel = False
        self.release = asyncio.Event()

    async def fresh(self):
        await super().fresh()
        return getattr(self, "account", ACCOUNT)

    async def handle(self, request):
        data = json.loads(request.content)
        if data.get("action") == "prepared_admission":
            self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
            self.prepared_entered.set()
            if self.wait_prepared:
                try:
                    await self.release.wait()
                except asyncio.CancelledError:
                    if not self.swallow_cancel:
                        raise
            if self.lose_prepared:
                raise httpx.ReadError("synthetic lost combined response")
            reply = await NativeWire().handle(request)
            value = self.prepared_alter(reply.json())
            self.prepared_after()
            content = json.dumps(value)
            if self.duplicate_prepared:
                content = content.replace('"version": "1"', '"version": "1", "version": "1"', 1)
            return httpx.Response(self.prepared_status, content=content, headers=reply.headers)
        if (
            data.get("action") == "operation"
            and data.get("operation", {}).get("kind") == "native_recording_preparation"
        ):
            self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
            return await NativeWire().handle(request)
        reply = await super().handle(request)
        if data.get("action") == "preparation_context":
            self.context_entered.set()
            if self.wait_context:
                try:
                    await self.release.wait()
                except asyncio.CancelledError:
                    if not self.swallow_cancel:
                        raise
            value = self.context_alter(reply.json())
            self.context_after()
            content = json.dumps(value)
            if self.duplicate_context:
                content = content.replace('"version": "1"', '"version": "1", "version": "1"', 1)
            return httpx.Response(self.context_status, content=content, headers=reply.headers)
        if data.get("action") == "mount":
            return httpx.Response(
                reply.status_code,
                content=reply.content,
                headers=list(reply.headers.multi_items()) + list(self.capability_headers),
            )
        return reply


def scenario(mode="desktop", headers=None):
    s = Sequence()
    s.wire = CombinationWire(mode, headers)
    s.body = {
        "workspace_id": s.workspace,
        "binding_ref": s.binding,
        "request_nonce": str(uuid4()),
        "attestation": {"all_parties_consented": True},
        "configured_capture": {"schema_version": "1.0", "language_mode": "en-US"},
        FIELDS[mode]: True,
    }
    s.key = "synthetic-combined-admission-key"
    return s


async def admit(s, *, handoff=True):
    return await prepare_then_dispatch(
        s.origin,
        "capture-admissions",
        s.body,
        s.key,
        s.revision,
        s.wire.fresh,
        s.wire.workload,
        transport=httpx.MockTransport(s.wire.handle),
        handoff=s.pending if handoff else None,
    )


def actions(s):
    return [
        data.get("action", data.get("operation", {}).get("kind")) for _, data, _ in s.wire.calls
    ]


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("lowercase", [False, True])
async def test_fresh_singleton_combines_exact_consent_and_metadata_in_two_calls(mode, lowercase):
    header = HEADERS[mode].lower() if lowercase else HEADERS[mode]
    s = scenario(mode, [(header, "1"), (SOURCE_HEADER, "1")])
    answer = await admit(s)
    assert actions(s) == ["preparation_context", "prepared_admission"]
    assert s.wire.checks == 9
    sent = s.wire.calls[1][1]
    assert s.wire.calls[1][2] == s.key
    assert {name: sent[name] for name in s.body if name != FIELDS[mode]} == {
        name: value for name, value in s.body.items() if name != FIELDS[mode]
    }
    assert (
        sent["include_preparation_metadata" if mode == "desktop" else "include_native_preparation"]
        is True
    )
    assert (
        "include_native_preparation" if mode == "desktop" else "include_preparation_metadata"
    ) not in sent
    assert answer["session_id"] == SESSION
    assert (
        answer[FIELDS[mode]]["review" if mode == "desktop" else "context"]["session_id"] == SESSION
    )
    assert "invented-server-context-token" not in str(answer)
    context = next(iter(s.pending._pending.values()))
    assert context.issued_at == 100.0 and context.source_start_supported
    assert context.stage == "recording_window" and context.native_read_done == (mode == "ios")


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize(
    "values", [[], ["0"], ["true"], ["1,1"], [" 1"], ["1 "], ["1", "1"], ["1", "0"]]
)
async def test_absent_non_singleton_metadata_header_keeps_original_compatibility(mode, values):
    s = scenario(mode, [(HEADERS[mode], value) for value in values])
    answer = await admit(s)
    assert actions(s) == [
        "preparation_context",
        None,
        "preparation_metadata" if mode == "desktop" else "operation",
    ]
    assert answer["session_id"] == SESSION and "prepared_admission" not in actions(s)


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_other_metadata_capability_does_not_authorize_requested_shape(mode):
    other = "ios" if mode == "desktop" else "desktop"
    s = scenario(mode, [(HEADERS[other], "1")])
    await admit(s)
    assert "prepared_admission" not in actions(s) and len(s.wire.calls) == 3


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_no_handoff_still_requires_fresh_validated_context(mode):
    s = scenario(mode)
    answer = await admit(s, handoff=False)
    assert answer["session_id"] == SESSION and actions(s) == [
        "preparation_context",
        "prepared_admission",
    ]
    assert not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_combination_preserves_first_window_and_single_source_handoff(mode):
    s = scenario(mode)
    await admit(s)
    s.wire.calls.clear()
    s.wire.checks = 0
    await window(s)
    assert actions(s) == ["prepared_window"] and s.wire.checks == 6
    s.wire.calls.clear()
    await source(s)
    assert actions(s) == ["prepared_source"]
    assert await source(s) is None and not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("boundary", range(1, 10))
async def test_each_original_account_snapshot_can_deny_before_or_after_dispatch(mode, boundary):
    s = scenario(mode)
    s.wire.revoke_at = boundary
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == (
        []
        if boundary <= 2
        else ["preparation_context"]
        if boundary <= 5
        else ["preparation_context", "prepared_admission"]
    )
    assert not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("status", [401, 403, 409, 503])
async def test_denied_prepared_admission_never_dispatches_ordinary_fallback(mode, status):
    s = scenario(mode)
    s.wire.prepared_status = status
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == ["preparation_context", "prepared_admission"]
    assert not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_uncertain_dispatched_reply_never_retries_or_publishes_partial_admission(mode):
    s = scenario(mode)
    s.wire.lose_prepared = True
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == ["preparation_context", "prepared_admission"]
    assert not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize(
    "fault", ["actor", "tenant", "workspace", "binding", "nonce", "stale", "unknown", "missing"]
)
async def test_malformed_fresh_context_never_reaches_admission(mode, fault):
    s = scenario(mode)

    def alter(value):
        result = value["result"]
        if fault in {"actor", "tenant"}:
            value[fault + "_ref"] = "synthetic-other-scope"
        elif fault in {"workspace", "nonce"}:
            result["workspace_id" if fault == "workspace" else "request_nonce"] = str(uuid4())
        elif fault == "binding":
            result["binding_ref"] = "scribe_capture_binding_01j00000000000000000000001"
        elif fault == "stale":
            result["checked_at"] = (datetime.now(UTC) - timedelta(seconds=31)).isoformat()
        elif fault == "unknown":
            result["not_allowed"] = True
        else:
            del result["context_token"]
        return value

    s.wire.context_alter = alter
    with pytest.raises((ProviderCoreUnavailable, ValueError)):
        await admit(s)
    assert actions(s) == ["preparation_context"] and not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("fault", ["metadata_session", "extra", "missing", "stale", "wrong_action"])
async def test_malformed_combined_reply_is_not_partial_success(mode, fault):
    s = scenario(mode)

    def alter(value):
        result = value["result"]
        if fault == "metadata_session":
            result[FIELDS[mode]]["review" if mode == "desktop" else "context"]["session_id"] = str(
                uuid4()
            )
        elif fault == "extra":
            result["not_allowed"] = True
        elif fault == "missing":
            del result[FIELDS[mode]]
        elif fault == "wrong_action":
            value["action"] = "prepared_window"
        else:
            result["checked_at"] = (datetime.now(UTC) - timedelta(seconds=31)).isoformat()
        return value

    s.wire.prepared_alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == ["preparation_context", "prepared_admission"] and not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize(
    "when,age", [("context", 15), ("context", -1), ("reply", 30), ("reply", -1)]
)
async def test_original_fresh_context_epoch_never_extends_at_dispatch_or_publication(
    mode, when, age
):
    s = scenario(mode)

    def callback():
        s.now = 100.0 + age

    if when == "context":
        s.wire.context_after = callback
    else:
        s.wire.prepared_after = callback
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == ["preparation_context"] + (
        ["prepared_admission"] if when == "reply" else []
    )
    assert not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("phase", ["context", "prepared"])
@pytest.mark.parametrize("swallow", [False, True])
async def test_cancelled_or_swallowed_late_response_cannot_dispatch_or_publish(
    mode, phase, swallow
):
    s = scenario(mode)
    s.wire.swallow_cancel = swallow
    setattr(s.wire, "wait_" + phase, True)
    task = asyncio.create_task(admit(s))
    await asyncio.wait_for(getattr(s.wire, phase + "_entered").wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert actions(s) == ["preparation_context"] + (
        ["prepared_admission"] if phase == "prepared" else []
    )
    assert not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("change", ["account", "actor", "tenant", "recovery"])
async def test_scope_change_in_late_combined_reply_blocks_publication(mode, change):
    s = scenario(mode)
    changes = {
        "account": {"account_id": "synthetic-other-account"},
        "actor": {"actor_ref": "synthetic-other-actor"},
        "tenant": {"tenant_ref": "synthetic-other-tenant"},
        "recovery": {"recovery_scope": uuid4()},
    }
    s.wire.prepared_after = lambda: setattr(s.wire, "account", replace(ACCOUNT, **changes[change]))
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == ["preparation_context", "prepared_admission"] and not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_same_admission_request_never_reuses_a_consumed_context(mode):
    s = scenario(mode)
    original = copy.deepcopy(s.body)
    await admit(s)
    await admit(s)
    assert actions(s) == [
        "preparation_context",
        "prepared_admission",
        "preparation_context",
        "prepared_admission",
    ]
    assert s.body == original and all(key == s.key for _, _, key in s.wire.calls)


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_retained_mount_keeps_existing_combined_path_and_original_epoch(mode):
    s = scenario(mode)
    native = ProviderNativeCoreTransport(
        s.origin, s.wire.fresh, s.wire.workload, transport=httpx.MockTransport(s.wire.handle)
    )
    try:
        await native.request(
            "mount",
            {"workspace_id": s.workspace},
            "synthetic-mount-key",
            handoff=s.pending,
            revision=s.revision,
        )
    finally:
        await native.close()
    assert next(iter(s.pending._pending.values())).issued_at == 100.0
    s.wire.calls.clear()
    s.wire.checks = 0
    s.now = 110.0
    await admit(s)
    assert actions(s) == ["prepared_admission"] and s.wire.checks == 7
    assert next(iter(s.pending._pending.values())).issued_at == 100.0


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_no_explicit_consent_never_dispatches_preparation_or_admission(mode):
    s = scenario(mode)
    s.body["attestation"] = None
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert not s.wire.calls and not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("status", [401, 403, 409, 503])
async def test_denied_context_cannot_dispatch_admission(mode, status):
    s = scenario(mode)
    s.wire.context_status = status
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == ["preparation_context"] and not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
@pytest.mark.parametrize("phase", ["context", "prepared"])
async def test_repeated_closed_json_keys_are_rejected_without_fallback(mode, phase):
    s = scenario(mode)
    setattr(s.wire, "duplicate_" + phase, True)
    with pytest.raises(ProviderCoreUnavailable):
        await admit(s)
    assert actions(s) == ["preparation_context"] + (
        ["prepared_admission"] if phase == "prepared" else []
    )
    assert not s.pending._pending


@pytest.mark.parametrize("mode", ["desktop", "ios"])
async def test_expired_retained_mount_is_consumed_then_fresh_context_is_used(mode):
    s = scenario(mode)
    native = ProviderNativeCoreTransport(
        s.origin, s.wire.fresh, s.wire.workload, transport=httpx.MockTransport(s.wire.handle)
    )
    try:
        await native.request(
            "mount",
            {"workspace_id": s.workspace},
            "synthetic-mount-key",
            handoff=s.pending,
            revision=s.revision,
        )
    finally:
        await native.close()
    old = next(iter(s.pending._pending.values()))
    s.now = 115.0
    s.wire.calls.clear()
    await admit(s)
    assert actions(s) == ["preparation_context", "prepared_admission"]
    new = next(iter(s.pending._pending.values()))
    assert old.issued_at == 100.0 and new.issued_at == 115.0
    s.now = 140.0
    s.wire.calls.clear()
    await window(s)
    assert actions(s)[0] == "preparation_context"
