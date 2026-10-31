"""Synthetic full visit transport contract; no database, audio or network."""

import json
from dataclasses import replace
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_encounter_transport import ProviderEncounterAccount
from cosmaneura_scribe.provider_native_encounter_transport import (
    PATH,
    ProviderNativeEncounterTransport,
)
from pydantic import SecretStr

pytestmark = pytest.mark.asyncio
PATIENT = "patient_00000000000000000000000003"
CANONICAL = "patient_00000000000000000000000004"
APPOINTMENT = "appointment_00000000000000000000000005"
NAME = "Invented person"


def identity(state="provisional", version=0, patient=PATIENT, birthday=None):
    return dict(
        state=state,
        version=version,
        canonical_patient_ref=patient,
        name=NAME,
        date_of_birth=birthday,
    )


def encounter(current=None):
    return dict(
        workspace_id=str(uuid4()),
        appointment_ref=APPOINTMENT,
        patient_ref=PATIENT,
        patient_name=NAME,
        date_of_birth=None,
        title="Visit",
        appointment_at="2026-10-31T00:00:00Z",
        identity=current or identity(),
    )


def body(action, key, **fields):
    value = dict(action=action, request_nonce=str(uuid4()), **fields)
    if action == "create":
        value.update(
            creation_key=key,
            patient=dict(kind="new", name=NAME, date_of_birth=None, provisional=True),
            appointment_at="2026-10-31T00:00:00Z",
            title="Visit",
        )
    elif action != "patients":
        value["appointment_ref"] = APPOINTMENT
    return value


def fixture(*, capability=True, fault=None, creation_identity=None):
    account = ProviderEncounterAccount(
        "invented",
        uuid4(),
        "actor",
        "tenant",
        SecretStr("synthetic-human-token"),
        native_visit_actions_v2=capability,
    )
    calls, reads = [], []

    async def fresh():
        reads.append(None)
        return (
            replace(account, native_visit_actions_v2=False)
            if (fault == "revoked" and calls or fault == "before_dispatch" and len(reads) > 1)
            else account
        )

    async def workload():
        return SecretStr("synthetic-workload")

    def reply(request):
        calls.append(request)
        assert str(request.url) == "https://core.synthetic.invalid" + PATH
        assert request.headers["x-cosmaneura-scribe-encounter-version"] == "2"
        assert request.headers["authorization"] == "Bearer synthetic-human-token"
        assert request.headers["x-cosmaneura-workload-authorization"] == "Bearer synthetic-workload"
        payload = json.loads(request.content)
        assert (
            payload["expected_actor_ref"] == "actor" and payload["expected_tenant_ref"] == "tenant"
        )
        action = payload["action"]
        value = dict(
            version="2",
            action=action,
            request_nonce=payload["request_nonce"],
            account=dict(actor_ref="actor", tenant_ref="tenant"),
        )
        if action == "create":
            value.update(
                creation_key=payload["creation_key"], encounter=encounter(creation_identity)
            )
        elif action in {"patients", "patient_match_candidates"}:
            value.update(
                patients=[dict(patient_ref=CANONICAL, name=NAME, date_of_birth=None)],
                more_results=False,
            )
            if action == "patient_match_candidates":
                value["identity"] = identity()
        elif action == "patient_match_save":
            chosen = payload["selection"]
            current = identity(
                "matched" if chosen["kind"] == "existing" else "confirmed",
                payload["expected_version"] + 1,
                chosen.get("patient_ref", PATIENT),
                chosen.get("date_of_birth"),
            )
            value.update(
                change_key=payload["change_key"], identity=current, encounter=encounter(current)
            )
        else:
            value["private_note"] = dict(
                text=payload.get("text", ""),
                version=payload.get("expected_version", -1) + 1,
                updated_at=datetime.now(UTC).isoformat(),
            )
            if action == "private_note_save":
                value["change_key"] = payload["change_key"]
        headers = {"Cache-Control": "no-store", "X-Cosmaneura-Scribe-Encounter-Version": "2"}
        if fault == "deny":
            return httpx.Response(403)
        if fault == "version":
            headers["X-Cosmaneura-Scribe-Encounter-Version"] = "1"
        if fault == "extra":
            value["authority_hint"] = "forbidden"
        if fault == "key":
            value["change_key"] = str(uuid4())
        if fault == "canonical":
            value["identity"]["canonical_patient_ref"] = PATIENT
        if fault == "private_text":
            value["private_note"]["text"] = "Other invented text"
        return httpx.Response(200, json=value, headers=headers)

    return ProviderNativeEncounterTransport(
        "https://core.synthetic.invalid",
        fresh,
        workload,
        version="2",
        transport=httpx.MockTransport(reply),
    ), calls


async def test_ordinary_provisional_match_and_private_flow_retains_each_mutation_key():
    transport, calls = fixture()
    try:
        key = str(uuid4())
        created = await transport.request(body("create", key), key)
        assert created["encounter"]["identity"]["state"] == "provisional"
        await transport.request(body("create", key), key)
        assert calls[0].headers["idempotency-key"] == calls[1].headers["idempotency-key"] == key
        candidates = await transport.request(
            body("patient_match_candidates", key, query=NAME, date_of_birth=None), key
        )
        assert candidates["patients"][0]["patient_ref"] == CANONICAL
        for selection in [
            dict(kind="existing", patient_ref=CANONICAL),
            dict(kind="confirm_new", date_of_birth="1980-01-02"),
        ]:
            key = str(uuid4())
            matched = await transport.request(
                body(
                    "patient_match_save",
                    key,
                    selection=selection,
                    expected_version=0,
                    change_key=key,
                ),
                key,
            )
            assert matched["encounter"]["patient_ref"] == PATIENT
            assert matched["identity"]["canonical_patient_ref"] == selection.get(
                "patient_ref", PATIENT
            )
        await transport.request(body("private_note_read", key), key)
        key = str(uuid4())
        note = await transport.request(
            body("private_note_save", key, text="📝" * 2000, expected_version=0, change_key=key),
            key,
        )
        assert note["private_note"]["version"] == 1 and calls[-1].headers["idempotency-key"] == key
        assert len(calls[-1].content) < 16384
    finally:
        await transport.close()


@pytest.mark.parametrize("current", [identity("matched", 1, CANONICAL), identity("confirmed", 2)])
async def test_creation_replay_retains_source_patient_after_explicit_identity_change(current):
    transport, calls = fixture(creation_identity=current)
    key = str(uuid4())
    try:
        result = await transport.request(body("create", key), key)
        assert result["creation_key"] == key
        assert result["encounter"]["patient_ref"] == PATIENT
        assert result["encounter"]["identity"] == current
        assert calls[0].headers["idempotency-key"] == key
    finally:
        await transport.close()


@pytest.mark.parametrize("fault", ["deny", "version", "extra", "key", "private_text", "revoked"])
async def test_unconfirmed_private_save_never_replays_or_falls_back(fault):
    transport, calls = fixture(fault=fault)
    key = str(uuid4())
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.request(
                body(
                    "private_note_save",
                    key,
                    text="Invented reminder",
                    expected_version=0,
                    change_key=key,
                ),
                key,
            )
        assert len(calls) == 1
    finally:
        await transport.close()


@pytest.mark.parametrize("fault", ["before_dispatch", "capability"])
async def test_full_capability_must_remain_current_before_dispatch(fault):
    transport, calls = fixture(capability=fault != "capability", fault=fault)
    key = str(uuid4())
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.request(body("create", key), key)
        assert not calls
    finally:
        await transport.close()


@pytest.mark.parametrize(
    "bad", ["actor", "key", "version", "text", "date", "legacy", "provisional"]
)
async def test_unknown_or_malformed_full_mutations_do_not_dispatch(bad):
    transport, calls = fixture()
    key = str(uuid4())
    payload = body("private_note_save", key, text="Invented", expected_version=0, change_key=key)
    if bad == "actor":
        payload["expected_actor_ref"] = "foreign"
    if bad == "key":
        payload["change_key"] = str(uuid4())
    if bad == "version":
        payload["expected_version"] = True
    if bad == "text":
        payload["text"] = "x" * 2001
    if bad == "date":
        payload = body("patient_match_candidates", key, query="", date_of_birth="1980-02-31")
    if bad == "legacy":
        payload["action"] = "add_birth_date"
    if bad == "provisional":
        payload = body("create", key)
        payload["patient"]["provisional"] = "true"
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.request(payload, key)
        assert not calls
    finally:
        await transport.close()


async def test_match_receipt_cannot_confirm_a_different_canonical_patient():
    transport, calls = fixture(fault="canonical")
    key = str(uuid4())
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.request(
                body(
                    "patient_match_save",
                    key,
                    selection=dict(kind="existing", patient_ref=CANONICAL),
                    expected_version=0,
                    change_key=key,
                ),
                key,
            )
        assert len(calls) == 1
    finally:
        await transport.close()
