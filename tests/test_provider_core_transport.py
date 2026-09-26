"""Offline Core wire fixtures, not native identity or service acceptance."""

import asyncio
import json
import os
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from cosmaneura_scribe.provider_core_transport import (
    MAX_CORE_CAPTURE_RESPONSE_BYTES,
    AuthorizedCoreProvider,
    CoreProviderSelection,
    ProviderCoreTransport,
    ProviderCoreUnavailable,
)
from pydantic import SecretStr

ROOT = "/service/v1/agent/scribe/"
REPO = Path(__file__).resolve().parents[1]
SUFFIX = "01j00000000000000000000000"
BINDING = "scribe_capture_binding_" + SUFFIX
USER_TOKEN = "offline-user-session-token"
WORKLOAD_TOKEN = "your-offline-entra-workload-token"
SESSION = str(uuid4())
NOW = datetime.now(UTC)
SELECTION = CoreProviderSelection(
    recovery_scope=uuid4(),
    authorization_revision=uuid4(),
    workspace_id=uuid4(),
    appointment_ref="appointment_" + SUFFIX,
    actor_ref="authority_actor_" + SUFFIX,
    tenant_ref="authority_tenant_" + SUFFIX,
)
pytestmark = pytest.mark.asyncio


class Wire:
    def __init__(self):
        self.selection = SELECTION
        self.calls = []
        self.timeouts = []
        self.effects = []
        self.turns = {}
        self.counter = 0
        self.denied = False
        self.alter = lambda path, value: value
        self.after = lambda path: None
        self.before = None
        self.lost = False
        self.context_calls = 0

    async def context(self):
        self.context_calls += 1
        if self.denied:
            raise ValueError("private-context-sentinel")
        return AuthorizedCoreProvider(self.selection, SecretStr(USER_TOKEN))

    async def workload(self):
        return SecretStr(WORKLOAD_TOKEN)

    async def handle(self, request):
        path = request.url.path
        assert request.url.host == "core.synthetic.invalid" and request.url.scheme == "https"
        assert request.method == "POST" and request.headers["cache-control"] == "no-store"
        assert "cookie" not in request.headers
        data = json.loads(request.content) if request.content else None
        self.calls.append((path, data))
        self.timeouts.append((path, request.extensions["timeout"]))
        if self.before:
            await self.before(path)
        headers = {"Cache-Control": "no-store", "Set-Cookie": "foreign_browser_session=x; Path=/"}
        if path == "/embed/v1/context-tokens/exchange":
            assert request.headers["authorization"] == "Bearer " + USER_TOKEN
            assert "x-cosmaneura-mount-context" not in request.headers
            assert data == {
                "requested_surface": "provider_assistant",
                "record_ref": SELECTION.appointment_ref,
            }
            self.counter += 1
            token = "offline-core-mount-" + str(self.counter)
            result = {
                "context_token": token,
                "token_type": "Bearer",
                "issued_at": NOW.isoformat(),
                "refresh_after": (NOW + timedelta(minutes=2)).isoformat(),
                "expires_at": (NOW + timedelta(minutes=5)).isoformat(),
            }
            headers["X-Cosmaneura-Embed-Version"] = "1.0"
        else:
            assert request.headers["authorization"] == "Bearer " + WORKLOAD_TOKEN
            assert "x-scribe-creator-actor-id" not in request.headers
            token = request.headers["x-cosmaneura-mount-context"]
            turn = request.headers["x-cosmaneura-client-turn-id"]
            assert token.startswith("offline-core-mount-")
            if path == "/service/v1/agent/mount-context/resolve":
                assert data is None
                self.turns[turn] = (token, "offline-interaction-" + turn)
                headers.update(
                    {
                        "X-Cosmaneura-Client-Turn-ID": turn,
                        "X-Cosmaneura-Interaction-Ref": self.turns[turn][1],
                    }
                )
                result = {
                    "surface": "provider_assistant",
                    "auth_tier": "provider",
                    "actor_id": SELECTION.actor_ref,
                    "tenant_id": SELECTION.tenant_ref,
                    "capabilities": ["record.read", "record.write"],
                }
            else:
                assert (token, request.headers["x-cosmaneura-interaction-ref"]) == self.turns[turn]
                headers["X-Cosmaneura-Capture-Version"] = "1"
                result = {
                    "contract_version": "1",
                    "binding_ref": BINDING,
                    "workspace_id": str(SELECTION.workspace_id),
                    "request_nonce": data["request_nonce"],
                    "checked_at": NOW.isoformat(),
                }
                if path.endswith("capture-bindings/resolve"):
                    result.update(
                        appointment_ref=SELECTION.appointment_ref,
                        actor_ref=SELECTION.actor_ref,
                        tenant_ref=SELECTION.tenant_ref,
                    )
                else:
                    self.effects.append((path, data, request.headers["idempotency-key"]))
                    if self.lost:
                        raise httpx.ReadError("offline lost reply with private sentinel")
                    if path.endswith("capture-admissions"):
                        result.update(
                            appointment_ref=SELECTION.appointment_ref,
                            operation_ref="scribe_admission_" + SUFFIX,
                            consent_record_id=str(uuid4()),
                            session_id=SESSION,
                        )
                    elif path.endswith("capture-operations"):
                        result.update(
                            operation=data["operation"]["kind"], receipt={"session_id": SESSION}
                        )
                    elif path.endswith("capture-notes"):
                        result.update(action=data["action"], receipt={"session_id": SESSION})
                    else:
                        pytest.fail("unlisted route reached")
        self.after(path)
        changed = self.alter(path, result)
        if isinstance(changed, httpx.Response):
            return changed
        return httpx.Response(
            201 if path.endswith("/exchange") else 200, json=changed, headers=headers
        )


@pytest_asyncio.fixture
async def connection():
    wire = Wire()
    client = ProviderCoreTransport(
        "https://core.synthetic.invalid",
        wire.context,
        wire.workload,
        enabled=True,
        transport=httpx.MockTransport(wire.handle),
        clock=lambda: NOW,
    )
    try:
        yield wire, client
    finally:
        await client.close()


def body(**values):
    return {
        "binding_ref": BINDING,
        "workspace_id": str(SELECTION.workspace_id),
        "request_nonce": str(uuid4()),
        **values,
    }


async def test_configured_admission_review_and_existing_note_routes(connection):
    wire, client = connection
    mount = await client.open()
    assert mount.client_scope() == {
        "bindingRef": BINDING,
        "workspaceId": str(SELECTION.workspace_id),
        "appointmentRef": SELECTION.appointment_ref,
        "recoveryScope": str(SELECTION.recovery_scope),
    }
    admission = body(
        attestation={
            "modality": "in_person",
            "participant_regions": ["US-NY"],
            "method": "verbal_attestation",
            "all_parties_consented": True,
            "granted_at": NOW.isoformat(),
        },
        configured_capture={"schema_version": "1.0", "language_mode": "en-US+es-US"},
    )
    assert (
        await client.request(mount, ROOT + "capture-admissions", admission, "offline-admission")
    )["session_id"] == SESSION
    for kind in ["creator_review", "decide_translation", "provider_encounter"]:
        payload = body(
            operation={
                "kind": kind,
                **({"payload": {"decision": "accepted"}} if kind == "decide_translation" else {}),
            }
        )
        assert (
            await client.request(mount, ROOT + "capture-operations", payload, "offline-review")
        )["operation"] == kind
    for action in ["templates", "read", "prepare", "save", "resolve"]:
        payload = body(action=action, expected_session_id=SESSION)
        assert (await client.request(mount, ROOT + "capture-notes", payload, "offline-note"))[
            "action"
        ] == action
    assert len(wire.effects) == 9
    assert wire.counter == 10  # Fresh exchange for every action, not a cached mount token.
    assert wire.context_calls > len(wire.calls)
    assert USER_TOKEN not in repr(mount) and WORKLOAD_TOKEN not in repr(client)


async def test_admission_waits_for_both_core_phases_without_extending_other_requests(connection):
    wire, client = connection
    mount = await client.open()
    await client.request(
        mount,
        ROOT + "capture-admissions",
        body(
            attestation=None, configured_capture={"schema_version": "1.0", "language_mode": "en-US"}
        ),
        "same-admission-key",
    )
    for path, timeout in wire.timeouts:
        assert timeout["connect"] == 5
        if path.endswith("capture-admissions"):
            assert timeout["read"] > 2 * 65  # Current shared Core's two phase bounds.
        else:
            assert timeout["read"] == 20
    assert [key for _, _, key in wire.effects] == ["same-admission-key"]


async def test_admission_deadline_is_bounded_and_does_not_retry_or_replace_intent(
    connection, monkeypatch
):
    import cosmaneura_scribe.provider_core_transport as module

    wire, client = connection
    mount = await client.open()
    monkeypatch.setattr(module, "ADMISSION_TOTAL_TIMEOUT_SECONDS", 0.02)

    async def wait_for_response(path):
        if path.endswith("capture-admissions"):
            await asyncio.Event().wait()

    wire.before = wait_for_response
    payload = body(
        attestation=None, configured_capture={"schema_version": "1.0", "language_mode": "en-US"}
    )
    original = json.dumps(payload, sort_keys=True)
    with pytest.raises(ProviderCoreUnavailable, match="^core_provider_request_timeout$"):
        await client.request(mount, ROOT + "capture-admissions", payload, "retained-admission-key")
    assert len([path for path, _ in wire.calls if path.endswith("capture-admissions")]) == 1
    assert json.dumps(payload, sort_keys=True) == original
    wire.before = None
    monkeypatch.setattr(module, "ADMISSION_TOTAL_TIMEOUT_SECONDS", 180)
    await client.request(mount, ROOT + "capture-admissions", payload, "retained-admission-key")
    assert wire.effects[-1] == (ROOT + "capture-admissions", payload, "retained-admission-key")


@pytest.mark.parametrize(
    "variant", ["exact", "other_code", "missing_version", "oversize", "revoked"]
)
async def test_consent_renewal_requires_exact_current_core_refusal(connection, variant):
    wire, client = connection
    mount = await client.open()

    def refusal(path, value):
        if not path.endswith("capture-admissions"):
            return value
        if variant == "revoked":
            wire.denied = True
        headers = {
            "Cache-Control": "no-store",
            "Content-Type": "application/problem+json",
            "X-Cosmaneura-Capture-Version": "1",
        }
        if variant == "missing_version":
            headers.pop("X-Cosmaneura-Capture-Version")
        return httpx.Response(
            409,
            headers=headers,
            json={
                "code": "CAPTURE_REQUEST_CONFLICT"
                if variant == "other_code"
                else "CAPTURE_CONSENT_REQUIRED",
                "status": 409,
                "retryable": False,
                "detail": "private-sentinel" * (200 if variant == "oversize" else 1),
            },
        )

    wire.alter = refusal
    with pytest.raises(ProviderCoreUnavailable) as caught:
        await client.request(
            mount,
            ROOT + "capture-admissions",
            body(
                attestation=None,
                configured_capture={"schema_version": "1.0", "language_mode": "en-US"},
            ),
            "retained-preparation-key",
        )
    if variant == "exact":
        assert caught.value.code == "core_provider_consent_required"
        assert caught.value.status == 409
    else:
        assert caught.value.code != "core_provider_consent_required"
    assert "private-sentinel" not in str(caught.value)


async def test_default_off_and_invalid_intents_never_acquire_credentials(connection):
    wire, client = connection
    dark = ProviderCoreTransport(
        "https://core.synthetic.invalid",
        wire.context,
        wire.workload,
        transport=httpx.MockTransport(wire.handle),
    )
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await dark.open()
        assert not wire.calls and wire.context_calls == 0
    finally:
        await dark.close()
    mount = await client.open()
    count = wire.context_calls
    for path, payload in [
        ("https://other.invalid/steal", body()),
        (ROOT + "capture-admissions", body(attestation={})),
        (
            ROOT + "capture-operations",
            body(operation={"kind": "creator_review"}, actor_id="forged"),
        ),
        (ROOT + "capture-operations", body(operation={"kind": []})),
        (
            ROOT + "capture-operations",
            {**body(operation={"kind": "creator_review"}), "workspace_id": str(uuid4())},
        ),
    ]:
        with pytest.raises(ProviderCoreUnavailable):
            await client.request(mount, path, payload, "offline-invalid")
    assert wire.context_calls == count and not wire.effects


@pytest.mark.parametrize("change", ["revision", "creator", "grant"])
async def test_identity_change_during_exchange_prevents_facade_request(connection, change):
    wire, client = connection
    mount = await client.open()

    def revoke(path):
        if not path.endswith("/exchange"):
            return
        if change == "revision":
            wire.selection = replace(SELECTION, authorization_revision=uuid4())
        elif change == "creator":
            wire.selection = replace(
                SELECTION, actor_ref="authority_actor_01j00000000000000000000001"
            )
        else:
            wire.denied = True

    wire.after = revoke
    with pytest.raises(ProviderCoreUnavailable, match="core_provider_access_unavailable"):
        await client.request(
            mount,
            ROOT + "capture-operations",
            body(operation={"kind": "creator_review"}),
            "offline-read",
        )
    assert not wire.effects


async def test_revocation_during_mutation_hides_reply_without_replaying_effect(connection):
    wire, client = connection
    mount = await client.open()
    wire.after = lambda path: setattr(wire, "denied", path.endswith("capture-notes"))
    with pytest.raises(ProviderCoreUnavailable) as error:
        await client.request(
            mount,
            ROOT + "capture-notes",
            body(action="save", expected_session_id=SESSION),
            "offline-save",
        )
    assert error.value.status == 403 and len(wire.effects) == 1
    assert "private" not in str(error.value)


async def test_lost_reply_requires_explicit_retry_preserving_key_and_body(connection):
    wire, client = connection
    mount = await client.open()
    payload = body(
        action="save", expected_session_id=SESSION, edit={"fields": {"Plan": "Invented plan"}}
    )
    wire.lost = True
    with pytest.raises(ProviderCoreUnavailable, match="core_provider_request_unconfirmed"):
        await client.request(mount, ROOT + "capture-notes", payload, "offline-save-key")
    assert len(wire.effects) == 1
    wire.lost = False
    await client.request(mount, ROOT + "capture-notes", payload, "offline-save-key")
    assert len(wire.effects) == 2 and wire.effects[0] == wire.effects[1]


async def test_concurrent_requests_keep_their_own_interaction_and_snapshot(connection):
    wire, client = connection
    mount = await client.open()
    arrived = asyncio.Event()
    both_arrived = asyncio.Event()
    arrivals = 0
    release = asyncio.Event()
    original = body(operation={"kind": "creator_review"})

    async def before(path):
        nonlocal arrivals
        if path.endswith("capture-bindings/resolve"):
            arrivals += 1
            arrived.set()
            if arrivals == 2:
                both_arrived.set()
            await release.wait()

    wire.before = before
    first = asyncio.create_task(
        client.request(mount, ROOT + "capture-operations", original, "offline-first")
    )
    await arrived.wait()
    original["operation"]["kind"] = "unlisted-operation"
    second = asyncio.create_task(
        client.request(
            mount,
            ROOT + "capture-notes",
            body(action="templates", expected_session_id=SESSION),
            "offline-second",
        )
    )
    await both_arrived.wait()
    release.set()
    await asyncio.gather(first, second)
    assert len(wire.effects) == 2
    first_effect = next(effect for effect in wire.effects if effect[2] == "offline-first")
    assert first_effect[1]["operation"]["kind"] == "creator_review"


@pytest.mark.parametrize("change", ["actor", "nonce", "stale", "oversize", "duplicate", "redirect"])
async def test_bad_core_reply_never_opens_a_mount(connection, change):
    wire, client = connection

    def alter(path, value):
        if not path.endswith("capture-bindings/resolve"):
            return value
        if change == "actor":
            return {**value, "actor_ref": "authority_actor_01j00000000000000000000001"}
        if change == "nonce":
            return {**value, "request_nonce": str(uuid4())}
        if change == "stale":
            return {**value, "checked_at": (NOW - timedelta(minutes=1)).isoformat()}
        if change == "oversize":
            return {**value, "extra": "x" * 16384}
        if change == "duplicate":
            return httpx.Response(
                200,
                content=b'{"binding_ref":"first","binding_ref":"second"}',
                headers={
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                    "X-Cosmaneura-Capture-Version": "1",
                },
            )
        return httpx.Response(307, headers={"Location": "https://other.invalid/steal"})

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await client.open()
    assert len(wire.calls) == 3 and not wire.effects


@pytest.mark.parametrize(
    "action,size,accepted",
    [
        ("capture-operations", 9 * 1024 * 1024, True),
        ("capture-operations", MAX_CORE_CAPTURE_RESPONSE_BYTES, False),
        ("capture-notes", 9 * 1024 * 1024, False),
    ],
)
async def test_long_review_receiver_keeps_operation_specific_bounds(
    connection, action, size, accepted
):
    wire, client = connection
    mount = await client.open()
    wire.alter = lambda path, value: (
        {**value, "receipt": {"session_id": SESSION, "synthetic_padding": "x" * size}}
        if path == ROOT + action
        else value
    )
    payload = (
        body(operation={"kind": "creator_review"})
        if action == "capture-operations"
        else body(action="read", expected_session_id=SESSION)
    )
    if accepted:
        result = await client.request(mount, ROOT + action, payload, "long-review-offline")
        assert len(result["receipt"]["synthetic_padding"]) == size
    else:
        with pytest.raises(ProviderCoreUnavailable):
            await client.request(mount, ROOT + action, payload, "long-review-offline")


async def test_cancellation_during_binding_does_not_dispatch_mutation(connection):
    wire, client = connection
    mount = await client.open()
    arrived = asyncio.Event()

    async def block(path):
        if path.endswith("capture-bindings/resolve"):
            arrived.set()
            await asyncio.Event().wait()

    wire.before = block
    task = asyncio.create_task(
        client.request(
            mount,
            ROOT + "capture-notes",
            body(action="prepare", expected_session_id=SESSION),
            "offline-prepare",
        )
    )
    await arrived.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not wire.effects


async def test_actual_typescript_provider_client_uses_server_transport(connection):
    wire, client = connection
    mount = await client.open()
    public = mount.client_scope()
    scope = {
        "bindingRef": public["bindingRef"],
        "workspaceId": public["workspaceId"],
        "appointmentRef": public["appointmentRef"],
    }
    node = os.environ.get("SCRIBE_TEST_NODE")
    if not node:
        pytest.skip(
            "Set SCRIBE_TEST_NODE to the installed Node 24 binary for client/server wire check"
        )
    process = await asyncio.create_subprocess_exec(
        node,
        "--import",
        "tsx",
        "tests/browser/provider-core-client.mjs",
        json.dumps({"scope": scope, "session": SESSION}),
        cwd=REPO,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(30):
            while True:
                line = await process.stdout.readline()
                assert line, "Provider client exited before completing its request sequence"
                message = json.loads(line)
                if message.get("done"):
                    break
                value = await client.request(
                    mount, message["path"], message["body"], message["key"]
                )
                process.stdin.write(json.dumps(value).encode() + b"\n")
                await process.stdin.drain()
            await process.wait()
            assert process.returncode == 0
        assert len(wire.effects) == 8
        assert wire.effects[0][1]["configured_capture"]["language_mode"] == "en-US+es-US"
        assert wire.effects[-2][1]["edit"] == wire.effects[-1][1]["edit"]
        assert wire.effects[-2][2] == wire.effects[-1][2]
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_closing_connection_during_final_authorization_withholds_reply():
    wire = Wire()
    arrived, release = asyncio.Event(), asyncio.Event()

    async def context():
        if wire.effects:
            arrived.set()
            await release.wait()
        return await wire.context()

    client = ProviderCoreTransport(
        "https://core.synthetic.invalid",
        context,
        wire.workload,
        enabled=True,
        transport=httpx.MockTransport(wire.handle),
        clock=lambda: NOW,
    )
    try:
        mount = await client.open()
        task = asyncio.create_task(
            client.request(
                mount,
                ROOT + "capture-notes",
                body(action="templates", expected_session_id=SESSION),
                "offline-close",
            )
        )
        await arrived.wait()
        await client.close()
        release.set()
        with pytest.raises(ProviderCoreUnavailable):
            await task
        assert len(wire.effects) == 1
    finally:
        release.set()
        await client.close()
