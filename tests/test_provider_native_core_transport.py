"""Single-request wire boundary; no native, device, or service acceptance claim."""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_encounter_transport import ProviderEncounterAccount
from cosmaneura_scribe.provider_native_core_transport import PATH, ProviderNativeCoreTransport
from pydantic import SecretStr

pytestmark = pytest.mark.asyncio
SUFFIX = "01j00000000000000000000000"
BINDING = "scribe_capture_binding_" + SUFFIX
ACCOUNT = ProviderEncounterAccount(
    "synthetic-account",
    uuid4(),
    "authority_actor_" + SUFFIX,
    "authority_tenant_" + SUFFIX,
    SecretStr("invented-user-session-token"),
)


class Wire:
    def __init__(self):
        self.account = ACCOUNT
        self.calls = []
        self.checks = 0
        self.revoked = False
        self.status = 200
        self.after = lambda: None
        self.alter = lambda value: value

    async def fresh(self):
        self.checks += 1
        if self.revoked:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        return self.account

    async def workload(self):
        return SecretStr("invented-workload-token")

    async def handle(self, request):
        assert request.url == "https://core.synthetic.invalid" + PATH
        assert request.headers["authorization"] == "Bearer invented-user-session-token"
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer invented-workload-token"
        )
        assert (
            "cookie" not in request.headers and "x-cosmaneura-mount-context" not in request.headers
        )
        data = json.loads(request.content)
        self.calls.append(data)
        assert (
            data["expected_actor_ref"] == ACCOUNT.actor_ref
            and data["expected_tenant_ref"] == ACCOUNT.tenant_ref
        )
        result = {
            "contract_version": "1",
            "workspace_id": data["workspace_id"],
            "binding_ref": BINDING,
            "request_nonce": data["request_nonce"],
            "checked_at": datetime.now(UTC).isoformat(),
        }
        review = {"schema_version": "1.0", "session_id": SESSION}
        if data.get("operation", {}).get("kind") == "encryption_key":
            review = {
                "key_version": "synthetic-key",
                "algorithm": "RSA-OAEP-256",
                "public_jwk": {
                    "kty": "RSA",
                    "n": "a" * 512,
                    "e": "AQAB",
                    "alg": "RSA-OAEP-256",
                    "ext": True,
                    "key_ops": ["wrapKey"],
                },
            }
        if data.get("operation", {}).get("kind") in {
            "preparation_metadata",
            "native_recording_preparation",
        }:
            review = {
                "schema_version": "1.0",
                "review": {"schema_version": "1.0", "session_id": SESSION, "status": "created"},
                "encryption_key": {
                    "key_version": "synthetic-key",
                    "algorithm": "RSA-OAEP-256",
                    "public_jwk": {
                        "kty": "RSA",
                        "n": "a" * 512,
                        "e": "AQAB",
                        "alg": "RSA-OAEP-256",
                        "ext": True,
                        "key_ops": ["wrapKey"],
                    },
                },
                "capabilities": {
                    "protocol_version": "1.0",
                    "media": {
                        "media_type": "audio/wav",
                        "encoding": "pcm_s16le",
                        "channels": 1,
                        "sample_rate_hz": 16000,
                    },
                    "target_chunk_duration_ms": 10000,
                    "max_envelope_bytes": 327680,
                    "max_chunks": 1000,
                    "remaining_aggregate_plaintext_bytes": 67108864,
                    "capture_lease_ttl_seconds": 900,
                    "reservation_window_seconds": 900,
                    "max_reservations_per_batch": 90,
                    "upload_concurrency": 2,
                },
            }
            if data["operation"]["kind"] == "native_recording_preparation":
                review = {
                    "schema_version": "1.0",
                    "context": {
                        "schema_version": "1.0",
                        "workspace_id": data["workspace_id"],
                        "tenant_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                        "session_id": SESSION,
                        "status": "created",
                    },
                    "encryption_key": review["encryption_key"],
                }
        if data["action"] == "operation":
            result.update(operation=data["operation"]["kind"], receipt=review)
        else:
            result.update(appointment_ref="appointment_" + SUFFIX, encounter={})
            if "opening_nonce" in data:
                result["opening_review"] = {
                    **result,
                    "request_nonce": data["opening_nonce"],
                    "operation": "provider_encounter",
                    "receipt": review,
                }
        value = {
            "version": "1",
            "action": data["action"],
            "actor_ref": ACCOUNT.actor_ref,
            "tenant_ref": ACCOUNT.tenant_ref,
            "result": result,
        }
        self.after()
        return httpx.Response(
            self.status,
            json=self.alter(value),
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
        )

    async def call(self, action, body):
        client = ProviderNativeCoreTransport(
            "https://core.synthetic.invalid",
            self.fresh,
            self.workload,
            transport=httpx.MockTransport(self.handle),
        )
        try:
            return await client.request(action, body, "original-retained-key")
        finally:
            await client.close()


SESSION = str(uuid4())


async def test_native_recording_preparation_is_one_fresh_core_request():
    wire = Wire()
    account, value = await wire.call(
        "capture-operations", body("capture-operations", "native_recording_preparation")
    )
    assert account == ACCOUNT and len(wire.calls) == 1 and wire.checks == 3
    assert value["receipt"]["context"]["session_id"] == SESSION
    assert value["receipt"]["encryption_key"]["public_jwk"]["key_ops"] == ["wrapKey"]


@pytest.mark.parametrize(
    "fault",
    ["missing", "extra", "private_key", "key_ops", "workspace", "tenant", "status", "session"],
)
async def test_native_recording_preparation_rejects_malformed_receipts(fault):
    wire = Wire()

    def alter(value):
        receipt = value["result"]["receipt"]
        if fault == "missing":
            receipt.pop("encryption_key")
        elif fault == "extra":
            receipt["capture_permission"] = True
        elif fault in {"private_key", "key_ops"}:
            receipt["encryption_key"]["public_jwk"][
                "d" if fault == "private_key" else "key_ops"
            ] = "invented" if fault == "private_key" else ["unwrapKey"]
        elif fault == "workspace":
            receipt["context"]["workspace_id"] = str(uuid4())
        elif fault == "status":
            receipt["context"]["status"] = "uploaded"
        elif fault == "tenant":
            receipt["context"]["tenant_id"] = "authority_tenant_" + SUFFIX
        else:
            receipt["context"]["session_id"] = "uncertain"
        return value

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call(
            "capture-operations", body("capture-operations", "native_recording_preparation")
        )


@pytest.mark.parametrize("phase", ["workload", "response"])
async def test_native_recording_preparation_discards_changed_account(phase):
    wire = Wire()
    if phase == "workload":

        async def workload():
            wire.revoked = True
            return SecretStr("invented-workload-token")

        wire.workload = workload
    else:
        wire.after = lambda: setattr(wire, "revoked", True)
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call(
            "capture-operations", body("capture-operations", "native_recording_preparation")
        )
    assert len(wire.calls) == (0 if phase == "workload" else 1)


@pytest.mark.parametrize("field", ["tenant_id", "session_id", "payload"])
async def test_native_recording_preparation_cannot_choose_scope(field):
    wire = Wire()
    request = body("capture-operations", "native_recording_preparation")
    request["operation"][field] = "invented"
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("capture-operations", request)
    assert not wire.calls and wire.checks == 0


async def test_combined_preparation_is_one_fresh_core_request_with_closed_metadata():
    wire = Wire()
    account, value = await wire.call(
        "capture-operations", body("capture-operations", "preparation_metadata")
    )
    assert account == ACCOUNT and len(wire.calls) == 1 and wire.checks == 3
    result = value["receipt"]
    assert (
        result["review"]["session_id"] == SESSION
        and result["capabilities"]["protocol_version"] == "1.0"
    )
    assert result["encryption_key"]["public_jwk"]["key_ops"] == ["wrapKey"]


@pytest.mark.parametrize(
    "fault", ["missing", "extra", "private_key", "key_ops", "budget", "review"]
)
async def test_malformed_combined_preparation_is_never_published(fault):
    wire = Wire()

    def alter(value):
        receipt = value["result"]["receipt"]
        if fault == "missing":
            receipt.pop("encryption_key")
        elif fault == "extra":
            receipt["capture_permission"] = True
        elif fault in {"private_key", "key_ops"}:
            receipt["encryption_key"]["public_jwk"][
                ("d" if fault == "private_key" else "key_ops")
            ] = "invented" if fault == "private_key" else ["unwrapKey"]
        elif fault == "budget":
            receipt["capabilities"]["remaining_aggregate_plaintext_bytes"] = -1
        else:
            receipt["review"]["schema_version"] = "unknown"
        return value

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("capture-operations", body("capture-operations", "preparation_metadata"))


@pytest.mark.parametrize("phase", ["workload", "response"])
async def test_combined_preparation_rechecks_account_around_io(phase):
    wire = Wire()
    if phase == "workload":

        async def workload():
            wire.revoked = True
            return SecretStr("invented-workload-token")

        wire.workload = workload
    else:
        wire.after = lambda: setattr(wire, "revoked", True)
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("capture-operations", body("capture-operations", "preparation_metadata"))
    assert len(wire.calls) == (0 if phase == "workload" else 1)


def body(action, kind="creator_review"):
    value = {"workspace_id": str(uuid4())}
    if action == "mount":
        return value | {"opening_nonce": str(uuid4())}
    value.update(binding_ref=BINDING, request_nonce=str(uuid4()))
    return value | (
        {"session_id": SESSION} if action == "recorder" else {"operation": {"kind": kind}}
    )


@pytest.mark.parametrize("action", ["mount", "capture-operations", "recorder"])
async def test_each_client_phase_uses_one_fresh_core_request(action):
    wire = Wire()
    account, result = await wire.call(action, body(action))
    assert account == ACCOUNT and len(wire.calls) == 1 and wire.checks == 3
    assert result["binding_ref"] == BINDING
    assert "token" not in str(result)


@pytest.mark.parametrize("status", [401, 403, 409, 422, 404, 503])
async def test_failed_facade_never_falls_back_to_older_authority(status):
    wire = Wire()
    wire.status = status
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("mount", body("mount"))
    assert len(wire.calls) == 1


@pytest.mark.parametrize("phase", ["workload", "response"])
async def test_revocation_prevents_send_or_read_publication(phase):
    wire = Wire()
    if phase == "workload":

        async def workload():
            wire.revoked = True
            return SecretStr("invented-workload-token")

        wire.workload = workload
    else:
        wire.after = lambda: setattr(wire, "revoked", True)
    with pytest.raises(ProviderCoreUnavailable) as error:
        await wire.call("mount", body("mount"))
    assert error.value.status == 403
    assert len(wire.calls) == (0 if phase == "workload" else 1)


@pytest.mark.parametrize(
    "field",
    [
        "actor_ref",
        "tenant_ref",
        "action",
        "workspace_id",
        "binding_ref",
        "request_nonce",
        "checked_at",
        "session_id",
    ],
)
async def test_wrong_scope_replayed_or_stale_reply_is_rejected(field):
    wire = Wire()

    def alter(value):
        if field in {"actor_ref", "tenant_ref", "action"}:
            value[field] = "wrong"
        elif field == "session_id":
            value["result"]["receipt"][field] = str(uuid4())
        else:
            value["result"][field] = (
                (datetime.now(UTC) - timedelta(minutes=2)).isoformat()
                if field == "checked_at"
                else str(uuid4())
            )
        return value

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("recorder", body("recorder"))


@pytest.mark.parametrize(
    "operation",
    [
        {"kind": "issue_lease", "payload": {}},
        {"kind": "source_start"},
        {"kind": "bind_key", "payload": {}},
        {"kind": []},
    ],
)
async def test_mutation_and_key_binding_operations_cannot_enter_facade(operation):
    wire = Wire()
    data = body("capture-operations") | {"operation": operation}
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("capture-operations", data)
    assert wire.calls == []


async def test_public_key_read_uses_one_core_call_and_three_fresh_account_checks():
    wire = Wire()
    account, result = await wire.call(
        "capture-operations", body("capture-operations", "encryption_key")
    )
    assert account == ACCOUNT and len(wire.calls) == 1 and wire.checks == 3
    assert wire.calls[0]["operation"] == {"kind": "encryption_key"}
    assert result["operation"] == "encryption_key"


@pytest.mark.parametrize("extra", ["payload", "profile_receipt_id", "private_key"])
async def test_public_key_request_cannot_add_key_material_or_profile(extra):
    wire = Wire()
    data = body("capture-operations", "encryption_key")
    data["operation"][extra] = "invented-private-sentinel"
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("capture-operations", data)
    assert wire.calls == [] and wire.checks == 0


@pytest.mark.parametrize("extra", ["d", "p", "q", "secret", "wrapped_key"])
async def test_public_key_response_rejects_private_or_extra_fields(extra):
    wire = Wire()

    def alter(value):
        value["result"]["receipt"]["public_jwk"][extra] = "invented-private-sentinel"
        return value

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("capture-operations", body("capture-operations", "encryption_key"))
    assert len(wire.calls) == 1


@pytest.mark.parametrize("phase", ["workload", "response"])
async def test_public_key_read_keeps_account_revocation_fences(phase):
    wire = Wire()
    if phase == "workload":

        async def workload():
            wire.revoked = True
            return SecretStr("invented-workload-token")

        wire.workload = workload
    else:
        wire.after = lambda: setattr(wire, "revoked", True)
    with pytest.raises(ProviderCoreUnavailable) as error:
        await wire.call("capture-operations", body("capture-operations", "encryption_key"))
    assert error.value.status == 403
    assert len(wire.calls) == (0 if phase == "workload" else 1)


async def test_cancellation_during_wire_read_does_not_publish():
    wire = Wire()
    entered = asyncio.Event()

    async def held(request):
        entered.set()
        await asyncio.sleep(30)

    wire.handle = held
    task = asyncio.create_task(wire.call("mount", body("mount")))
    try:
        await asyncio.wait_for(entered.wait(), 2)
    finally:
        task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert wire.checks == 2


async def test_account_retarget_after_core_read_is_not_published():
    wire = Wire()
    wire.after = lambda: setattr(
        wire, "account", replace(ACCOUNT, tenant_ref="authority_tenant_00000000000000000000000002")
    )
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("mount", body("mount"))


async def test_roundtrip_model_does_not_claim_four_second_device_acceptance():
    # Three separate native phases retain their awaits. Only repeated receiver
    # negotiation is removed; processing and Clerk token latency are unchanged.
    old, composed = 3 * 9, 3
    assert old - composed == 24
    assert [(old - composed) * rtt for rtt in (0.1, 0.2, 0.3)] == pytest.approx([2.4, 4.8, 7.2])


@pytest.mark.parametrize("change", ["oversize", "extra", "invalid_nonce", "invalid_binding"])
async def test_invalid_native_body_never_reaches_core(change):
    wire = Wire()
    data = body("capture-operations")
    if change == "oversize":
        data["operation"] = {"kind": "creator_review", "extra": "x" * 4_194_304}
    elif change == "extra":
        data["appointment_ref"] = "appointment_" + SUFFIX
    else:
        data["request_nonce" if change == "invalid_nonce" else "binding_ref"] = "wrong"
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call("capture-operations", data)
    assert wire.calls == []
