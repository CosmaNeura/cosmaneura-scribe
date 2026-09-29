"""Offline Core wire fixtures, not native identity or service acceptance."""

import asyncio
import json
import os
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from cosmaneura_scribe.provider_core_connections import ProviderCoreConnections
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


def note_case(wire, template_count=1):
    """Core receipt metadata for transport orchestration; UI parsing is separate."""
    source_id = str(uuid4())
    source = {
        "kind": "reviewed_english",
        "source_version": 1,
        "working_transcript_id": source_id,
        "working_version": 1,
    }
    schema = "doctor_note_schema_" + SUFFIX
    receipts = {
        "review": {
            "schema_version": "1.0",
            "session_id": SESSION,
            "status": "transcript_ready",
            "source": {"source_transcript_version": 1},
            "working": {
                "working_transcript_id": source_id,
                "working_transcript_version": 1,
                "note_ready": True,
            },
        },
        "templates": {
            "session_id": SESSION,
            "templates": [
                {
                    "schema_ref": schema[:-1] + str(index),
                    "note_type": "Synthetic SOAP",
                    "field_names": ["Subjective"],
                }
                for index in range(template_count)
            ],
        },
        "note": {"session_id": SESSION, "schema_ref": schema, "reviewed_source": source},
    }

    def alter(path, value):
        phase = (
            "review"
            if value.get("operation") == "creator_review"
            else "templates"
            if value.get("action") == "templates"
            else "note"
            if value.get("action") == "read"
            else None
        )
        return {**value, "receipt": receipts[phase]} if phase else value

    wire.alter = alter
    return receipts


async def test_note_opening_reuses_only_one_local_negotiation(connection):
    wire, client = connection
    fixtures = note_case(wire)
    mount = await client.open()
    wire.calls.clear()
    nonce = uuid4()
    value = await client.open_note(mount, UUID(SESSION), nonce, "offline-open-note")
    assert len(wire.calls) == 6 and wire.counter == 2
    assert value["request_nonce"] == str(nonce) and value["operation"] == "note_opening"
    assert value["receipt"] == {
        "session_id": SESSION,
        "review": fixtures["review"],
        "templates": fixtures["templates"]["templates"],
        "note": fixtures["note"],
    }
    assert len({key for _, _, key in wire.effects}) == 3
    assert [
        data.get("action", data.get("operation", {}).get("kind")) for _, data, _ in wire.effects
    ] == ["creator_review", "templates", "read"]
    await client.request(
        mount,
        ROOT + "capture-notes",
        body(
            action="read",
            expected_session_id=SESSION,
            schema_ref=fixtures["note"]["schema_ref"],
        ),
        "offline-next-note-read",
    )
    assert wire.counter == 3 and len(wire.calls) == 10
    assert USER_TOKEN not in json.dumps(value) and WORKLOAD_TOKEN not in json.dumps(value)


@pytest.mark.parametrize("count", [0, 2])
async def test_note_opening_never_selects_a_template_for_the_provider(connection, count):
    wire, client = connection
    fixtures = note_case(wire, count)
    value = await client.open_note(await client.open(), UUID(SESSION), uuid4(), "offline-open-note")
    assert value["receipt"]["templates"] == fixtures["templates"]["templates"]
    assert value["receipt"]["note"] is None
    assert len(wire.effects) == 2


async def test_note_opening_stops_at_current_unready_review(connection):
    wire, client = connection
    fixtures = note_case(wire)
    fixtures["review"].update(status="capturing", source=None, working=None)
    value = await client.open_note(await client.open(), UUID(SESSION), uuid4(), "offline-open-note")
    assert value["receipt"] == {
        "session_id": SESSION,
        "review": fixtures["review"],
        "templates": None,
        "note": None,
    }
    assert len(wire.effects) == 1


@pytest.mark.parametrize("phase", ["review", "templates", "note"])
async def test_note_opening_rejects_a_different_session_at_every_read(connection, phase):
    wire, client = connection
    fixtures = note_case(wire)
    fixtures[phase]["session_id"] = str(uuid4())
    with pytest.raises(ProviderCoreUnavailable):
        await client.open_note(await client.open(), UUID(SESSION), uuid4(), "offline-open-note")
    assert len(wire.effects) == ["review", "templates", "note"].index(phase) + 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("working_version", 2),
        ("source_version", 2),
        ("working_transcript_id", str(uuid4())),
        ("capture_continuity", {"synthetic": "changed"}),
    ],
)
async def test_note_opening_rejects_changed_note_lineage(connection, field, value):
    wire, client = connection
    fixtures = note_case(wire)
    fixtures["note"]["reviewed_source"][field] = value
    with pytest.raises(ProviderCoreUnavailable):
        await client.open_note(await client.open(), UUID(SESSION), uuid4(), "offline-open-note")


@pytest.mark.parametrize("boundary", range(1, 7))
@pytest.mark.parametrize("change", ["revoke", "selection"])
async def test_note_opening_rechecks_access_at_each_core_boundary(connection, boundary, change):
    wire, client = connection
    note_case(wire)
    mount = await client.open()
    wire.calls.clear()

    def after(_path):
        if len(wire.calls) == boundary:
            if change == "revoke":
                wire.denied = True
            else:
                wire.selection = replace(SELECTION, authorization_revision=uuid4())

    wire.after = after
    with pytest.raises(ProviderCoreUnavailable) as caught:
        await client.open_note(mount, UUID(SESSION), uuid4(), "offline-open-note")
    assert caught.value.status == 403 and len(wire.calls) == boundary


@pytest.mark.parametrize("action", ["prepare", "save", "resolve", "read-with-edit"])
async def test_note_opening_negotiation_cannot_be_reused_for_writes(connection, action):
    wire, client = connection
    current = await client._negotiate(None)
    with pytest.raises(ProviderCoreUnavailable):
        await client._request(
            current.mount,
            ROOT + "capture-notes",
            body(
                action="read" if action == "read-with-edit" else action,
                expected_session_id=SESSION,
                schema_ref="doctor_note_schema_" + SUFFIX,
                edit={"synthetic": "must not reach Core"},
            ),
            "offline-forbidden-note-reuse",
            _negotiated=current,
        )
    assert wire.effects == []


async def test_note_opening_large_combination_explicitly_uses_separate_reads(
    connection, monkeypatch
):
    wire, client = connection
    fixtures = note_case(wire)
    fixtures["note"]["synthetic_padding"] = "x" * 2000
    monkeypatch.setattr(
        "cosmaneura_scribe.provider_core_transport.MAX_CORE_CAPTURE_RESPONSE_BYTES", 2000
    )
    value = await client.open_note(await client.open(), UUID(SESSION), uuid4(), "offline-open-note")
    assert value["receipt"] == {"session_id": SESSION, "separate_reads_required": True}
    assert len(wire.effects) == 3


async def test_note_opening_cancellation_cannot_continue_to_note_read(connection):
    wire, client = connection
    note_case(wire)
    mount = await client.open()
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold(path):
        if path.endswith("capture-notes"):
            entered.set()
            await release.wait()

    wire.before = hold
    task = asyncio.create_task(client.open_note(mount, UUID(SESSION), uuid4(), "offline-open-note"))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()
    assert len(wire.effects) == 1


async def test_note_opening_total_deadline_does_not_retry_or_continue(connection, monkeypatch):
    wire, client = connection
    note_case(wire)
    mount = await client.open()
    monkeypatch.setattr(
        "cosmaneura_scribe.provider_core_transport.NOTE_OPENING_TOTAL_TIMEOUT_SECONDS", 0.02
    )

    async def hold(path):
        if path.endswith("capture-notes"):
            await asyncio.Event().wait()

    wire.before = hold
    with pytest.raises(ProviderCoreUnavailable, match="^core_provider_request_timeout$"):
        await client.open_note(mount, UUID(SESSION), uuid4(), "offline-open-note")
    assert len(wire.effects) == 1
    assert len([path for path, _ in wire.calls if path.endswith("capture-notes")]) == 1


async def test_concurrent_note_openings_keep_their_negotiations_separate(connection):
    wire, client = connection
    note_case(wire)
    mount = await client.open()
    wire.calls.clear()
    values = await asyncio.gather(
        *(client.open_note(mount, UUID(SESSION), uuid4(), "offline-open-note") for _ in range(2))
    )
    assert len(wire.calls) == 12 and wire.counter == 3
    assert values[0]["request_nonce"] != values[1]["request_nonce"]
    assert len({key for _, _, key in wire.effects}) == 6


async def test_open_with_review_reuses_only_its_own_negotiation(connection):
    wire, client = connection
    nonce = uuid4()
    mount, review = await client.open_with_review(nonce, "offline-opening-read")
    assert mount.binding_ref == BINDING
    assert review["request_nonce"] == str(nonce)
    assert review["operation"] == "provider_encounter"
    assert len(wire.calls) == 4 and wire.counter == 1
    assert wire.effects == [(ROOT + "capture-operations", body(
        request_nonce=str(nonce), operation={"kind": "provider_encounter"},
    ), "offline-opening-read")]
    assert wire.context_calls > len(wire.calls)
    # Neither a subsequent action nor another opening can reuse this authority.
    await client.request(mount, ROOT + "capture-operations", body(
        operation={"kind": "creator_review"},
    ), "offline-next-read")
    assert wire.counter == 2 and len(wire.calls) == 7
    await client.open_with_review(uuid4(), "offline-another-opening")
    assert wire.counter == 3 and len(wire.calls) == 11


@pytest.mark.parametrize("boundary", [
    "/embed/v1/context-tokens/exchange", "/service/v1/agent/mount-context/resolve",
    ROOT + "capture-bindings/resolve", ROOT + "capture-operations",
])
@pytest.mark.parametrize("change", ["revoke", "selection"])
async def test_opening_does_not_publish_access_changed_during_any_core_io(
    connection, boundary, change,
):
    wire, client = connection

    def alter(path):
        if path == boundary:
            if change == "revoke":
                wire.denied = True
            else:
                wire.selection = replace(SELECTION, authorization_revision=uuid4())

    wire.after = alter
    with pytest.raises(ProviderCoreUnavailable) as caught:
        await client.open_with_review(uuid4(), "offline-opening-read")
    assert caught.value.status == 403
    assert wire.calls[-1][0] == boundary


@pytest.mark.parametrize("field,value", [
    ("binding_ref", "scribe_capture_binding_01j00000000000000000000001"),
    ("workspace_id", str(uuid4())), ("request_nonce", str(uuid4())),
    ("operation", "creator_review"), ("checked_at", "2000-01-01T00:00:00Z"),
])
async def test_opening_validates_existing_core_receipt(connection, field, value):
    wire, client = connection
    wire.alter = lambda path, result: (
        {**result, field: value} if path.endswith("capture-operations") else result
    )
    with pytest.raises(ProviderCoreUnavailable):
        await client.open_with_review(uuid4(), "offline-opening-read")


async def test_opening_cannot_reuse_setup_for_a_mutation(connection):
    wire, client = connection
    current = await client._negotiate(None)
    with pytest.raises(ProviderCoreUnavailable):
        await client._request(current.mount, ROOT + "capture-operations", body(
            operation={"kind": "decide_translation", "payload": {"decision": "accepted"}},
        ), "offline-forbidden-reuse", _negotiated=current)
    assert wire.effects == []


async def test_opening_is_cancelled_before_late_core_read(connection):
    wire, client = connection
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold(path):
        if path.endswith("capture-bindings/resolve"):
            entered.set()
            await release.wait()

    wire.before = hold
    task = asyncio.create_task(client.open_with_review(uuid4(), "offline-opening-read"))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()
    assert wire.effects == []


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


def startup_operations(source="ios_microphone"):
    lease_id, receipt_id = str(uuid4()), str(uuid4())
    intent = {
        "schema_version": "1.0", "attempt_id": str(uuid4()), "source": source,
        "owner_proof": "d" * 64, "lease_id": lease_id, "lease_receipt_id": receipt_id,
        "lease_generation": 1,
        "capture_authorized_until": (NOW + timedelta(minutes=15)).isoformat(),
    }
    return [
        {"kind": "issue_lease", "payload": {"protocol_version": "1.0"}},
        {"kind": "reserve_chunks", "payload": {
            "protocol_version": "1.0", "capture_lease_id": lease_id,
            "capture_lease_generation": 1, "channel": "microphone",
            "first_sequence_number": 0, "count": 90,
        }},
        *({"kind": "source_start", "action": action, "payload": intent}
          for action in ("prepare", "authorize", "stop")),
    ]


def source_sequence_case(wire):
    def alter(path, value):
        if value.get("operation") != "source_start_sequence":
            return value
        intent = wire.effects[-1][1]["operation"]["payload"]
        common = {
            **{key: item for key, item in intent.items() if key != "owner_proof"},
            "session_id": SESSION, "source_start_id": intent["attempt_id"],
            "creator_actor_id": SELECTION.actor_ref, "consent_record_id": str(uuid4()),
            "preparation_expires_at": (NOW + timedelta(seconds=30)).isoformat(),
            "capability_id": str(uuid4()),
        }
        prepared = {**common, "state": "prepared", "issued_at": None, "expires_at": None}
        issued = {**common, "state": "issued", "issued_at": NOW.isoformat(),
                  "expires_at": (NOW + timedelta(seconds=15)).isoformat()}
        return {**value, "receipt": {
            "preparation": prepared,
            "authorization": {"receipt": issued, "secret": intent["owner_proof"]},
        }}

    wire.alter = alter
    return body(
        operation=startup_operations()[2],
        authorize_idempotency_key="offline-authorize-" + str(uuid4()),
        authorize_request_nonce=str(uuid4()),
    )


async def test_source_sequence_reuses_one_request_local_setup_and_preserves_intents(connection):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)
    wire.calls.clear()
    wire.context_calls = 0
    result = await client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    assert len(wire.calls) == 3 and wire.context_calls == 6 and wire.counter == 2
    assert len(wire.effects) == 1
    _, sent, prepare_key = wire.effects[0]
    assert prepare_key == "offline-prepare-key"
    assert sent["request_nonce"] == payload["request_nonce"]
    assert sent["operation"] == {
        "kind": "source_start_sequence", "payload": payload["operation"]["payload"],
        "authorize_idempotency_key": payload["authorize_idempotency_key"],
    }
    assert result["preparation"]["receipt"]["state"] == "prepared"
    assert result["authorization"]["receipt"]["receipt"]["state"] == "issued"
    assert result["preparation"]["request_nonce"] == payload["request_nonce"]
    assert result["authorization"]["request_nonce"] == payload["authorize_request_nonce"]
    assert (
        result["authorization"]["receipt"]["secret"]
        == payload["operation"]["payload"]["owner_proof"]
    )
    assert {item["operation"] for item in result.values()} == {"source_start"}
    assert USER_TOKEN not in json.dumps(result) and WORKLOAD_TOKEN not in json.dumps(result)
    await client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    assert wire.counter == 3  # Every subsequent native request negotiates afresh.
    assert wire.effects[0] == wire.effects[1]  # Explicit retry retains both exact intents.


@pytest.mark.parametrize("failure", [
    "action", "kind", "scope", "key", "same-key", "nonce", "same-nonce", "extra",
])
async def test_source_sequence_rejects_invalid_pair_before_core(connection, failure):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)
    wire.calls.clear()
    if failure == "action":
        payload["operation"]["action"] = "authorize"
    elif failure == "kind":
        payload["operation"]["kind"] = "creator_review"
    elif failure == "scope":
        payload["workspace_id"] = str(uuid4())
    elif failure in {"key", "same-key"}:
        payload["authorize_idempotency_key"] = "bad" if failure == "key" else "offline-prepare-key"
    elif failure in {"nonce", "same-nonce"}:
        payload["authorize_request_nonce"] = (
            "bad" if failure == "nonce" else payload["request_nonce"]
        )
    else:
        payload["secret_fallback"] = "forbidden"
    with pytest.raises(ProviderCoreUnavailable):
        await client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    assert wire.calls == [] and wire.effects == []


@pytest.mark.parametrize("boundary", range(1, 7))
@pytest.mark.parametrize("change", ["revoke", "selection"])
async def test_source_sequence_checks_current_access_at_all_six_boundaries(
    connection, boundary, change,
):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)
    wire.calls.clear()
    wire.context_calls = 0

    async def fresh():
        if wire.context_calls + 1 == boundary:
            if change == "revoke":
                wire.denied = True
            else:
                wire.selection = replace(SELECTION, authorization_revision=uuid4())
        return await wire.context()

    client._fresh_context = fresh
    with pytest.raises(ProviderCoreUnavailable) as error:
        await client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    assert error.value.status == 403 and len(wire.calls) == boundary // 2
    assert len(wire.effects) == max(0, boundary // 2 - 2)


@pytest.mark.parametrize("field,value", [
    ("state", "issued"), ("attempt_id", str(uuid4())), ("source", "desktop_companion"),
    ("lease_id", str(uuid4())), ("lease_generation", 2), ("first_sequence_number", 1),
    ("capture_authorized_until", (NOW + timedelta(minutes=14)).isoformat()),
    ("creator_actor_id", "foreign-actor"), ("issued_at", NOW.isoformat()),
    ("preparation_expires_at", (NOW - timedelta(seconds=1)).isoformat()),
    ("preparation_expires_at", (NOW + timedelta(hours=1)).isoformat()),
    ("extra_field", "invalid"),
])
async def test_source_sequence_rejects_invalid_preparation_in_combined_reply(
    connection, field, value,
):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)
    original = wire.alter

    def alter(path, response):
        response = original(path, response)
        if response.get("operation") == "source_start_sequence":
            response["receipt"]["preparation"][field] = value
        return response

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable):
        await client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    assert len(wire.effects) == 1


@pytest.mark.parametrize("target,field,value", [
    ("envelope", "unexpected", "private-sentinel"),
    ("pair", "unexpected", "private-sentinel"),
    ("authorization", "unexpected", "private-sentinel"),
    ("authorization", "secret", "e" * 64),
    ("authorization", "secret", "\u00e9" * 64),
    ("issued", "unexpected", "private-sentinel"),
    ("issued", "session_id", str(uuid4())),
    ("issued", "source_start_id", str(uuid4())),
    ("issued", "consent_record_id", str(uuid4())),
    ("issued", "capability_id", str(uuid4())),
    ("issued", "first_sequence_number", 1),
    ("issued", "state", "stopped"),
    ("issued", "issued_at", None),
    ("issued", "expires_at", None),
    ("issued", "issued_at", (NOW + timedelta(seconds=6)).isoformat()),
    ("issued", "issued_at", (NOW + timedelta(seconds=16)).isoformat()),
    ("issued", "issued_at", (NOW - timedelta(seconds=1)).isoformat()),
    ("issued", "expires_at", NOW.isoformat()),
    ("issued", "expires_at", (NOW + timedelta(seconds=16)).isoformat()),
])
async def test_source_sequence_rejects_invalid_authorization_without_publishing(
    connection, target, field, value,
):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)
    original = wire.alter

    def alter(path, response):
        response = original(path, response)
        if response.get("operation") == "source_start_sequence":
            targets = {
                "envelope": response, "pair": response["receipt"],
                "authorization": response["receipt"]["authorization"],
                "issued": response["receipt"]["authorization"]["receipt"],
            }
            targets[target][field] = value
        return response

    wire.alter = alter
    with pytest.raises(ProviderCoreUnavailable) as error:
        await client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    assert len(wire.effects) == 1
    assert "private-sentinel" not in str(error.value)
    assert payload["operation"]["payload"]["owner_proof"] not in str(error.value)


@pytest.mark.parametrize("native_start", [False, True])
async def test_core_sequence_rejects_generic_transport(connection, native_start):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)
    wire.calls.clear()
    direct = body(operation={
        "kind": "source_start_sequence", "payload": payload["operation"]["payload"],
        "authorize_idempotency_key": payload["authorize_idempotency_key"],
    })
    with pytest.raises(ProviderCoreUnavailable):
        await client.request(
            mount, ROOT + "capture-operations", direct, "offline-prepare-key",
            native_start=native_start,
        )
    assert not wire.calls and not wire.effects


async def test_source_sequence_cancellation_after_core_never_publishes_or_retries(connection):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)

    def cancel(_):
        if len(wire.effects) == 1:
            asyncio.current_task().cancel()

    wire.after = cancel
    task = asyncio.create_task(
        client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    )
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(wire.effects) == 1


@pytest.mark.parametrize("fault", ["lost", "rejected", "conflict", "malformed"])
async def test_source_sequence_uncertain_reply_never_retries_or_falls_back(connection, fault):
    wire, client = connection
    mount = await client.open()
    payload = source_sequence_case(wire)
    original = wire.alter

    def altered(path, value):
        if value.get("operation") != "source_start_sequence":
            return value
        if fault in {"rejected", "conflict"}:
            return httpx.Response(422 if fault == "rejected" else 409)
        if fault == "malformed":
            return {**value, "receipt": {"preparation": {}}}
        return original(path, value)

    wire.alter = altered
    wire.lost = fault == "lost"
    with pytest.raises(ProviderCoreUnavailable):
        await client.prepare_and_authorize_source(mount, payload, "offline-prepare-key")
    assert len(wire.effects) == 1
    assert wire.effects[0][1]["operation"]["kind"] == "source_start_sequence"


async def test_concurrent_source_sequences_keep_their_own_context_and_intents(connection):
    wire, client = connection
    mount = await client.open()
    payloads = [source_sequence_case(wire), source_sequence_case(wire)]
    entered, release = asyncio.Event(), asyncio.Event()
    arrivals = 0

    async def before(path):
        nonlocal arrivals
        if path.endswith("mount-context/resolve"):
            arrivals += 1
            if arrivals == 2:
                entered.set()
            await release.wait()

    wire.before = before
    tasks = [asyncio.create_task(client.prepare_and_authorize_source(
        mount, payload, "offline-prepare-" + str(index),
    )) for index, payload in enumerate(payloads)]
    await asyncio.wait_for(entered.wait(), 2)
    release.set()
    results = await asyncio.gather(*tasks)
    assert wire.counter == 3 and len(wire.effects) == 2
    for payload, result in zip(payloads, results, strict=True):
        assert result["preparation"]["request_nonce"] == payload["request_nonce"]
        assert result["authorization"]["request_nonce"] == payload["authorize_request_nonce"]
        assert (
            result["preparation"]["receipt"]["attempt_id"]
            == payload["operation"]["payload"]["attempt_id"]
        )


@pytest.mark.parametrize("source", ["ios_microphone", "desktop_companion"])
async def test_capture_start_and_stop_keep_fresh_authority_without_duplicate_binding_lookup(
    connection, source,
):
    wire, client = connection
    mount = await client.open()
    wire.calls.clear()
    wire.context_calls = 0
    for index, operation in enumerate(startup_operations(source)):
        payload = body(operation=operation)
        result = await client.request(
            mount, ROOT + "capture-operations", payload, f"offline-start-step-{index}",
            native_start=operation["kind"] == "source_start",
        )
        assert result["operation"] == operation["kind"]
        assert wire.calls[index * 3:] == [
            ("/embed/v1/context-tokens/exchange", {
                "requested_surface": "provider_assistant", "record_ref": SELECTION.appointment_ref,
            }),
            ("/service/v1/agent/mount-context/resolve", None),
            (ROOT + "capture-operations", payload),
        ]
        if index == 3:
            assert len(wire.calls) == 12
    # First four steps start capture; stop uses its original proof and key.
    assert len(wire.calls) == 15 and wire.counter == 6
    assert wire.context_calls == 2 * len(wire.calls)
    assert len(wire.turns) == 6  # Opening and every action have distinct interactions.
    assert [effect[2] for effect in wire.effects] == [f"offline-start-step-{i}" for i in range(5)]


@pytest.mark.parametrize("checkpoint", range(1, 7))
@pytest.mark.parametrize("change", ["revoke", "selection"])
async def test_start_context_checked_before_and_after_each_core_request(
    connection, checkpoint, change,
):
    wire, client = connection
    mount = await client.open()
    wire.calls.clear()
    checks = 0

    async def context():
        nonlocal checks
        checks += 1
        if checks == checkpoint:
            if change == "revoke":
                wire.denied = True
            else:
                wire.selection = replace(SELECTION, authorization_revision=uuid4())
        return await wire.context()

    client._fresh_context = context
    with pytest.raises(ProviderCoreUnavailable) as caught:
        await client.request(
            mount, ROOT + "capture-operations", body(operation=startup_operations()[3]),
            "offline-context-start", native_start=True,
        )
    assert caught.value.status == 403 and checks == checkpoint
    assert len(wire.calls) == checkpoint // 2
    assert len(wire.effects) == (1 if checkpoint == 6 else 0)


async def test_open_exchange_uses_the_immediately_checked_identity(connection):
    wire, client = connection
    trace = []

    async def context():
        trace.append("context")
        return await wire.context()

    async def before(path):
        trace.append(path)

    client._fresh_context = context
    wire.before = before
    await client.open()
    assert trace == [
        "context", "/embed/v1/context-tokens/exchange", "context",
        "context", "/service/v1/agent/mount-context/resolve", "context",
        "context", ROOT + "capture-bindings/resolve", "context",
    ]


@pytest.mark.parametrize("boundary", [1, 2, 3])
@pytest.mark.parametrize("change", ["revoke", "selection"])
async def test_capture_operation_rechecks_access_at_every_remaining_boundary(
    connection, boundary, change,
):
    wire, client = connection
    mount = await client.open()
    wire.calls.clear()

    def change_access(_):
        if len(wire.calls) == boundary:
            if change == "revoke":
                wire.denied = True
            else:
                wire.selection = replace(SELECTION, authorization_revision=uuid4())

    wire.after = change_access
    with pytest.raises(ProviderCoreUnavailable) as caught:
        await client.request(
            mount, ROOT + "capture-operations", body(operation=startup_operations()[3]),
            "offline-one-use-start", native_start=True,
        )
    assert caught.value.status == 403 and len(wire.calls) == boundary
    assert len(wire.effects) == (1 if boundary == 3 else 0)


@pytest.mark.parametrize("status", [401, 403, 404, 410])
async def test_core_binding_denial_never_resolves_a_replacement_or_retries(connection, status):
    wire, client = connection
    mount = await client.open()
    wire.calls.clear()
    wire.alter = lambda path, value: (
        httpx.Response(status) if path.endswith("capture-operations") else value
    )
    with pytest.raises(ProviderCoreUnavailable) as caught:
        await client.request(
            mount, ROOT + "capture-operations", body(operation=startup_operations()[0]),
            "offline-lease-key",
        )
    assert caught.value.status == 403 and len(wire.calls) == 3
    assert len(wire.effects) == 1


async def test_cancelled_fresh_capture_negotiation_never_dispatches_the_operation(connection):
    wire, client = connection
    mount = await client.open()
    arrived = asyncio.Event()

    async def hold(path):
        if path.endswith("mount-context/resolve"):
            arrived.set()
            await asyncio.Event().wait()

    wire.before = hold
    task = asyncio.create_task(client.request(
        mount, ROOT + "capture-operations", body(operation=startup_operations()[2]),
        "offline-cancel-start", native_start=True,
    ))
    await asyncio.wait_for(arrived.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not wire.effects


async def test_uncertain_native_start_preserves_body_proof_and_key_on_explicit_retry(connection):
    wire, client = connection
    mount = await client.open()
    wire.calls.clear()
    payload = body(operation=startup_operations()[3])
    wire.lost = True
    with pytest.raises(ProviderCoreUnavailable):
        await client.request(mount, ROOT + "capture-operations", payload, "offline-original-start",
                             native_start=True)
    assert len(wire.effects) == 1 and len(wire.calls) == 3
    wire.lost = False
    await client.request(mount, ROOT + "capture-operations", payload, "offline-original-start",
                         native_start=True)
    assert len(wire.calls) == 6 and wire.effects[0] == wire.effects[1]
    assert wire.counter == 3  # Explicit retry also exchanges a new context token.


@pytest.mark.parametrize("field,value", [
    ("surface", "patient_assistant"), ("auth_tier", "patient"),
    ("actor_id", "authority_actor_01j00000000000000000000001"),
    ("tenant_id", "authority_tenant_01j00000000000000000000001"),
])
async def test_capture_operation_requires_matching_fresh_mount_identity(connection, field, value):
    wire, client = connection
    mount = await client.open()
    wire.alter = lambda path, result: (
        {**result, field: value} if path.endswith("mount-context/resolve") else result
    )
    with pytest.raises(ProviderCoreUnavailable):
        await client.request(mount, ROOT + "capture-operations",
                             body(operation=startup_operations()[1]), "offline-reserve")
    assert not wire.effects


@pytest.mark.parametrize("field,value", [
    ("binding_ref", "scribe_capture_binding_01j00000000000000000000001"),
    ("workspace_id", str(uuid4())), ("request_nonce", str(uuid4())),
    ("operation", "creator_review"), ("checked_at", "2000-01-01T00:00:00Z"),
])
async def test_capture_operation_with_known_binding_still_validates_reply(connection, field, value):
    wire, client = connection
    mount = await client.open()
    wire.alter = lambda path, result: (
        {**result, field: value} if path.endswith("capture-operations") else result
    )
    with pytest.raises(ProviderCoreUnavailable):
        await client.request(mount, ROOT + "capture-operations",
                             body(operation=startup_operations()[1]), "offline-reserve")
    assert len(wire.effects) == 1


@pytest.mark.parametrize("status", ["created", "capturing"])
async def test_native_recording_context_reuses_fresh_authorized_core_read(connection, status):
    wire, client = connection
    tenant = str(uuid4())
    receipt = {
        "schema_version": "1.0",
        "workspace_id": str(SELECTION.workspace_id),
        "tenant_id": tenant,
        "session_id": SESSION,
        "status": status,
    }
    wire.alter = lambda path, value: (
        {**value, "receipt": receipt} if path.endswith("capture-operations") else value
    )
    mount = await client.open()
    result = await client.request(
        mount,
        ROOT + "capture-operations",
        body(operation={"kind": "native_recording_context"}),
        "offline-native-context",
    )
    assert result["receipt"] == receipt
    assert tenant != SELECTION.tenant_ref
    assert len(wire.effects) == 1 and wire.counter == 2
    assert wire.context_calls > len(wire.calls)


async def test_shared_connections_reauthorize_every_operation_and_keep_clients_separate():
    wire = Wire()
    pool = ProviderCoreConnections(
        "https://core.synthetic.invalid", transport=httpx.MockTransport(wire.handle)
    )

    def fresh_client():
        return ProviderCoreTransport(
            "https://core.synthetic.invalid",
            wire.context,
            wire.workload,
            enabled=True,
            connections=pool,
            clock=lambda: NOW,
        )

    try:
        for _ in range(2):
            client = fresh_client()
            try:
                mount = await client.open()
                await client.request(
                    mount,
                    ROOT + "capture-operations",
                    body(operation={"kind": "creator_review"}),
                    "offline-review-key",
                )
            finally:
                await client.close()
        assert wire.counter == 4 and len(wire.effects) == 2
        assert wire.context_calls > len(wire.calls)
        before = len(wire.calls)
        wire.denied = True
        client = fresh_client()
        try:
            with pytest.raises(ProviderCoreUnavailable):
                await client.open()
            assert len(wire.calls) == before
        finally:
            await client.close()
    finally:
        await pool.close()


@pytest.mark.parametrize("field", ["tenant_id", "session_id", "workspace_id", "payload"])
async def test_native_recording_context_cannot_supply_its_own_key_scope(connection, field):
    wire, client = connection
    mount = await client.open()
    calls = len(wire.calls)
    with pytest.raises(ProviderCoreUnavailable):
        await client.request(
            mount,
            ROOT + "capture-operations",
            body(operation={"kind": "native_recording_context", field: str(uuid4())}),
            "offline-native-context",
        )
    assert len(wire.calls) == calls and wire.effects == []


async def test_native_recording_context_revocation_discards_the_reply(connection):
    wire, client = connection
    mount = await client.open()

    def revoke(path):
        if path.endswith("capture-operations"):
            wire.denied = True

    wire.after = revoke
    with pytest.raises(ProviderCoreUnavailable):
        await client.request(
            mount,
            ROOT + "capture-operations",
            body(operation={"kind": "native_recording_context"}),
            "offline-native-context",
        )
    assert len(wire.effects) == 1


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
        if path.endswith("mount-context/resolve"):
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
