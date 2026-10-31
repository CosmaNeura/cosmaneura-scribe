"""Offline native capture/save fixed wire and no-redispatch authority fences."""

import json
from dataclasses import replace
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_encounter_transport import ProviderEncounterAccount
from cosmaneura_scribe.provider_native_workflow_transport import (
    OPERATIONS,
    PATH,
    SCOPE,
    ProviderNativeWorkflowTransport,
)
from pydantic import SecretStr

pytestmark = pytest.mark.asyncio

BINDING = "scribe_capture_binding_00000000000000000000000003"


def body(action="capture-operations", key=None):
    value = dict(workspace_id=str(uuid4()), binding_ref=BINDING, request_nonce=str(uuid4()))
    if action == "capture-operations":
        value["operation"] = {"kind": "chunk_receipt", "object_id": str(uuid4())}
    elif action == "capture-admissions":
        value.update(
            attestation=None, configured_capture={"schema_version": "1.0", "language_mode": "en-US"}
        )
    else:
        value.update(
            expected_session_id=str(uuid4()),
            action="save",
            schema_ref="doctor_note_schema_00000000000000000000000004",
            edit={
                "client_key": key,
                "expected_note_ref": "visit_note_00000000000000000000000005",
                "expected_note_sha256": "1" * 64,
                "expected_source_sha256": "2" * 64,
                "fields": {"test": "synthetic"},
            },
        )
    return value


def fixture(fault=None):
    account = ProviderEncounterAccount(
        "synthetic", uuid4(), "actor", "tenant", SecretStr("synthetic-human-token")
    )
    calls, fences = [], []

    async def fresh():
        fences.append(None)
        return (
            replace(account, actor_ref="revoked")
            if (fault == "before" and len(fences) > 1) or (fault == "after" and calls)
            else account
        )

    async def workload():
        return SecretStr("synthetic-workload-token")

    def handle(request):
        calls.append(request)
        assert str(request.url) == "https://core.synthetic.invalid" + PATH
        assert request.headers["authorization"] == "Bearer synthetic-human-token"
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer synthetic-workload-token"
        )
        assert "cookie" not in request.headers
        wire = json.loads(request.content)
        result = {k: wire[k] for k in ("workspace_id", "binding_ref", "request_nonce")}
        result.update(contract_version="1", checked_at=datetime.now(UTC).isoformat())
        if wire["action"] == "workflow_notes":
            note = wire["note_request"]
            result.update(
                action=note["action"], receipt={"session_id": note["expected_session_id"]}
            )
        elif wire["action"] == "workflow_admission":
            result.update(
                appointment_ref="appointment_00000000000000000000000004",
                operation_ref="scribe_admission_00000000000000000000000005",
                session_id=str(uuid4()),
                consent_record_id=str(uuid4()),
                status="admitted",
                configured_capture=wire["configured_capture"],
            )
        else:
            result.update(operation=wire["operation"]["kind"], receipt={"test": "synthetic"})
        value = dict(
            version="1",
            action=wire["action"],
            actor_ref="actor",
            tenant_ref="tenant",
            result=result,
        )
        headers = {"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"}
        if fault in {"deny", "conflict"}:
            return httpx.Response(403 if fault == "deny" else 409)
        if fault == "lost":
            raise httpx.ReadError("synthetic loss")
        if fault == "redirect":
            return httpx.Response(302, headers={"Location": "https://foreign.synthetic.invalid"})
        if fault == "cookie":
            headers["Set-Cookie"] = "synthetic=1"
        if fault == "cache":
            headers["Cache-Control"] = "public"
        if fault == "actor":
            value["actor_ref"] = "foreign"
        if fault == "nonce":
            result["request_nonce"] = str(uuid4())
        if fault == "binding":
            result["binding_ref"] = "foreign"
        if fault == "expired":
            result["checked_at"] = "2000-01-01T00:00:00+00:00"
        if fault == "session":
            result["receipt"]["session_id"] = str(uuid4())
        return httpx.Response(200, json=value, headers=headers)

    return (
        ProviderNativeWorkflowTransport(
            "https://core.synthetic.invalid", fresh, workload, transport=httpx.MockTransport(handle)
        ),
        calls,
        fences,
    )


@pytest.mark.parametrize("action", ["capture-operations", "capture-admissions", "capture-notes"])
async def test_closed_native_workflow_preserves_original_retained_key_and_wire(action):
    transport, calls, fences = fixture()
    key = str(uuid4())
    value = body(action, key)
    try:
        result = await transport.workflow(action, value, key)
        assert result["request_nonce"] == value["request_nonce"]
        assert calls[0].headers["idempotency-key"] == key and len(fences) == 4
        retry = value | {"request_nonce": str(uuid4())}
        await transport.workflow(action, retry, key)
        assert len(calls) == 2 and calls[1].headers["idempotency-key"] == key
        if action == "capture-notes":
            assert json.loads(calls[1].content)["note_request"]["edit"] == value["edit"]
    finally:
        await transport.close()


@pytest.mark.parametrize(
    "fault",
    [
        "deny",
        "conflict",
        "lost",
        "redirect",
        "cookie",
        "cache",
        "actor",
        "nonce",
        "binding",
        "expired",
        "before",
        "after",
        "session",
    ],
)
async def test_failure_or_current_authority_loss_has_no_retry_or_generic_fallback(fault):
    transport, calls, _ = fixture(fault)
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.workflow(
                "capture-notes", body("capture-notes", "retained-key"), "retained-key"
            )
        assert len(calls) == (0 if fault == "before" else 1)
        assert all(request.url.path == PATH for request in calls)
    finally:
        await transport.close()


@pytest.mark.parametrize(
    "kind",
    [
        "source_start",
        "source_start_sequence",
        "source_extension",
        "correct_transcript",
        "recover_capture",
        "transcript",
    ],
)
async def test_renderer_cannot_submit_native_owner_actions_or_expand_scope(kind):
    transport, calls, _ = fixture()
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.workflow(
                "capture-operations", body() | {"operation": {"kind": kind}}, "retained-key"
            )
        assert not calls and kind not in OPERATIONS
    finally:
        await transport.close()


async def test_note_changed_header_key_denied_without_io():
    transport, calls, _ = fixture()
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.workflow(
                "capture-notes", body("capture-notes", "original-key"), "different-key"
            )
        assert not calls
    finally:
        await transport.close()


@pytest.mark.parametrize("fault", [None, "foreign-actor", "wrong-lease", "revoked"])
async def test_initial_source_pair_without_retained_context_reuses_exact_original_proofs(fault):
    from cosmaneura_scribe.provider_core_transport import CoreProviderMount, CoreProviderSelection
    from test_provider_native_core_transport import ACCOUNT
    from test_provider_native_core_transport import BINDING as SOURCE_BINDING
    from test_provider_source_preparation import SourceWire

    wire = SourceWire()
    workspace = str(uuid4())
    mount = CoreProviderMount(
        CoreProviderSelection(
            ACCOUNT.recovery_scope,
            uuid4(),
            uuid4(),
            "appointment_00000000000000000000000004",
            ACCOUNT.actor_ref,
            ACCOUNT.tenant_ref,
        ),
        SOURCE_BINDING,
    )
    workspace = str(mount.selection.workspace_id)
    payload = wire.payload(workspace)
    original = wire.handle

    async def handler(request):
        data = json.loads(request.content)
        assert data["action"] == "workflow_operation" and "prepared_context" not in data
        # Reuse the established exact source-pair fixture; only the newly selected
        # native action differs. Both original retained keys/proofs are unchanged.
        data["action"] = "prepared_source"
        response = await original(
            httpx.Request(
                "POST", request.url, headers=request.headers, content=json.dumps(data).encode()
            )
        )
        value = response.json()
        value["action"] = "workflow_operation"
        if fault == "foreign-actor":
            value["result"]["receipt"]["authorization"]["receipt"]["creator_actor_id"] = "foreign"
        if fault == "wrong-lease":
            value["result"]["receipt"]["preparation"]["lease_id"] = str(uuid4())
        if fault == "revoked":
            wire.revoked = True
        return httpx.Response(
            200,
            json=value,
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
        )

    transport = ProviderNativeWorkflowTransport(
        "https://core.synthetic.invalid",
        wire.fresh,
        wire.workload,
        transport=httpx.MockTransport(handler),
    )
    try:
        if fault:
            with pytest.raises(ProviderCoreUnavailable):
                await transport.workflow(
                    "source-start-ready", payload, "retained-source-key", mount=mount
                )
        else:
            result = await transport.workflow(
                "source-start-ready", payload, "retained-source-key", mount=mount
            )
            assert result["preparation"]["request_nonce"] == payload["request_nonce"]
            assert result["authorization"]["request_nonce"] == payload["authorize_request_nonce"]
        assert len(wire.calls) == 1
        assert wire.calls[0]["operation"]["payload"] == payload["operation"]["payload"]
        assert wire.calls[0]["operation"]["authorize_idempotency_key"] == wire.authorize_key
    finally:
        await transport.close()


@pytest.mark.parametrize("deny", [False, True])
async def test_qualified_core_context_receiver_mutation_never_uses_registry_or_generic_api(
    monkeypatch, deny
):
    from test_core_context_receiver import ACTOR, ORIGIN, TENANT, WORKSPACE, receiver

    client, token, paths, verifier = receiver()
    current = client.core_http.handler
    calls = []

    def no_sql(*args, **kwargs):
        raise AssertionError("No registry SQL")

    monkeypatch.setattr("receiver.Session", no_sql)

    def handle(request):
        if request.url.path != PATH:
            return current(request)
        calls.append(request)
        assert request.headers["authorization"] == "Bearer " + token
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer synthetic-workload-token"
        )
        if deny:
            return httpx.Response(403)
        wire = json.loads(request.content)
        assert wire["action"] == "workflow_operation"
        return httpx.Response(
            200,
            json={
                "version": "1",
                "action": wire["action"],
                "actor_ref": ACTOR,
                "tenant_ref": TENANT,
                "result": {
                    **{k: wire[k] for k in SCOPE},
                    "contract_version": "1",
                    "checked_at": datetime.now(UTC).isoformat(),
                    "operation": wire["operation"]["kind"],
                    "receipt": {"test": "synthetic"},
                },
            },
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
        )

    client.core_http = httpx.MockTransport(handle)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app()), base_url=ORIGIN
        ) as http:
            key = str(uuid4())
            response = await http.post(
                "/provider/v1/capture-operations",
                json=body() | {"workspace_id": WORKSPACE},
                headers={
                    "Origin": "app://cosmas",
                    "Authorization": "Bearer " + token,
                    "X-Scribe-Native-Revision": str(uuid4()),
                    "Idempotency-Key": key,
                },
            )
            assert response.status_code == (403 if deny else 200)
            assert len(calls) == 1 and calls[0].headers["idempotency-key"] == key
            assert all(path.endswith("/provider-context") for path in paths)
    finally:
        if client.core_connections is not None:
            await client.core_connections.close()
        verifier.close()
