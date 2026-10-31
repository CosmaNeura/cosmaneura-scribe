"""Offline fixed native mutation path; no real people, services or database."""

import json
from dataclasses import replace
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


def body(key):
    return dict(
        action="create",
        creation_key=key,
        request_nonce=str(uuid4()),
        patient=dict(kind="existing", patient_ref=PATIENT),
        appointment_at="2026-10-31T00:00:00Z",
        title="Visit",
    )


async def fixture(fault=None):
    account = ProviderEncounterAccount(
        "synthetic-account", uuid4(), "actor", "tenant", SecretStr("synthetic-human-token")
    )
    calls = []

    async def fresh():
        return replace(account, account_id="changed") if calls and fault == "revoked" else account

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
        request_body = json.loads(request.content)
        assert (
            request_body["expected_actor_ref"] == account.actor_ref
            and request_body["expected_tenant_ref"] == account.tenant_ref
        )
        value = dict(
            version="1",
            action=request_body["action"],
            request_nonce=request_body["request_nonce"],
            account=dict(actor_ref="actor", tenant_ref="tenant"),
        )
        if request_body["action"] == "create":
            value.update(
                creation_key=request_body["creation_key"], encounter=dict(patient_ref=PATIENT)
            )
        else:
            value.update(patients=[], more_results=False)
        headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Cosmaneura-Scribe-Encounter-Version": "1",
        }
        if fault == "deny":
            return httpx.Response(403)
        if fault == "conflict":
            return httpx.Response(409)
        if fault == "redirect":
            return httpx.Response(302, headers={"Location": "https://foreign.synthetic.invalid"})
        if fault == "lost":
            raise httpx.ReadError("synthetic lost response")
        if fault == "cookie":
            headers["Set-Cookie"] = "synthetic=1"
        if fault == "cache":
            headers["Cache-Control"] = "public"
        if fault == "actor":
            value["account"]["actor_ref"] = "other"
        if fault == "nonce":
            value["request_nonce"] = str(uuid4())
        if fault == "key":
            value["creation_key"] = str(uuid4())
        if fault == "patient":
            value["encounter"]["patient_ref"] = "patient_00000000000000000000000009"
        return httpx.Response(200, json=value, headers=headers)

    return (
        ProviderNativeEncounterTransport(
            "https://core.synthetic.invalid", fresh, workload, transport=httpx.MockTransport(handle)
        ),
        calls,
        account,
    )


async def test_existing_patient_visit_uses_dual_auth_fixed_path_and_retained_key():
    transport, calls, account = await fixture()
    key = str(uuid4())
    try:
        result = await transport.request(body(key), key)
        assert result["creation_key"] == key and result["recoveryScope"] == str(
            account.recovery_scope
        )
        assert calls[0].headers["idempotency-key"] == key
        retry = body(key)
        await transport.request(retry, key)
        assert len(calls) == 2 and calls[1].headers["idempotency-key"] == key
    finally:
        await transport.close()


@pytest.mark.parametrize(
    "fault",
    [
        "deny",
        "conflict",
        "redirect",
        "lost",
        "cookie",
        "cache",
        "actor",
        "nonce",
        "key",
        "patient",
        "revoked",
    ],
)
async def test_denied_ambiguous_or_uncertain_reply_never_retries_or_falls_back(fault):
    transport, calls, _ = await fixture(fault)
    key = str(uuid4())
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.request(body(key), key)
        assert len(calls) == 1
    finally:
        await transport.close()


@pytest.mark.parametrize("bad", ["new_patient", "actor_hint", "wrong_key", "private_note"])
async def test_closed_existing_patient_subset_never_dispatches_other_mutations(bad):
    transport, calls, _ = await fixture()
    key = str(uuid4())
    request = body(key)
    if bad == "new_patient":
        request["patient"] = {"kind": "new", "name": "Synthetic"}
    if bad == "actor_hint":
        request["expected_actor_ref"] = "other"
    if bad == "wrong_key":
        request["creation_key"] = str(uuid4())
    if bad == "private_note":
        request["action"] = "private_note_save"
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.request(request, key)
        assert calls == []
    finally:
        await transport.close()


async def test_provider_owned_patient_search_uses_same_native_boundary():
    transport, calls, _ = await fixture()
    try:
        result = await transport.request(
            dict(action="patients", query="Invented", request_nonce=str(uuid4())), str(uuid4())
        )
        assert result["patients"] == [] and len(calls) == 1
    finally:
        await transport.close()
