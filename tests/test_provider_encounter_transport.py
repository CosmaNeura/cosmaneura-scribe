"""Offline Core workflow boundary: no accounts, patient records or network writes."""

import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_encounter_transport import (
    ProviderEncounterAccount,
    ProviderEncounterTransport,
)
from pydantic import SecretStr

pytestmark = pytest.mark.asyncio


@pytest.mark.parametrize("date_of_birth", [None, "1980-01-02"])
async def test_fixed_human_boundary_rechecks_account_and_keeps_key(date_of_birth):
    account = ProviderEncounterAccount(
        "account", uuid4(), "actor", "tenant", SecretStr("synthetic-user-token")
    )
    seen = []

    async def fresh():
        seen.append("fresh")
        return account

    async def handle(request):
        seen.append("request")
        assert str(request.url) == "https://core.synthetic.invalid/embed/v1/scribe/encounters"
        assert request.headers["authorization"] == "Bearer synthetic-user-token"
        assert request.headers["idempotency-key"] == key
        body = json.loads(request.content)
        assert body["expected_actor_ref"] == account.actor_ref
        assert body["expected_tenant_ref"] == account.tenant_ref
        assert body["patient"] == {
            "kind": "new",
            "name": "Synthetic walk-in",
            "date_of_birth": date_of_birth,
        }
        return httpx.Response(
            200,
            json={
                **body,
                "version": "1",
                "account": {"actor_ref": "actor", "tenant_ref": "tenant"},
            },
            headers={
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "X-Cosmaneura-Scribe-Encounter-Version": "1",
            },
        )

    client = ProviderEncounterTransport(
        "https://core.synthetic.invalid", fresh, transport=httpx.MockTransport(handle)
    )
    key = str(uuid4())
    try:
        reply = await client.request(
            {
                "action": "create",
                "creation_key": key,
                "request_nonce": str(uuid4()),
                "patient": {
                    "kind": "new",
                    "name": "Synthetic walk-in",
                    "date_of_birth": date_of_birth,
                },
            },
            key,
        )
        assert reply["recoveryScope"] == str(account.recovery_scope)
        assert seen == ["fresh", "request", "fresh"]
    finally:
        await client.close()


@pytest.mark.parametrize(
    "fault",
    [
        "account_changed",
        "wrong_actor",
        "wrong_nonce",
        "redirect",
        "oversize",
        "duplicate",
        "cacheable",
        "lost_reply",
    ],
)
async def test_refuses_untrusted_or_uncertain_reply_without_retry(fault):
    account = ProviderEncounterAccount(
        "account", uuid4(), "actor", "tenant", SecretStr("synthetic-user-token")
    )
    calls = []

    async def fresh():
        return (
            replace(account, account_id="changed")
            if calls and fault == "account_changed"
            else account
        )

    async def handle(request):
        calls.append(request)
        value = {
            **json.loads(request.content),
            "version": "1",
            "account": {"actor_ref": "actor", "tenant_ref": "tenant"},
        }
        headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Cosmaneura-Scribe-Encounter-Version": "1",
        }
        if fault == "lost_reply":
            raise httpx.ReadError("synthetic disconnected response")
        if fault == "redirect":
            return httpx.Response(302, headers={"Location": "https://foreign.synthetic.invalid"})
        if fault == "wrong_actor":
            value["account"]["actor_ref"] = "foreign"
        if fault == "wrong_nonce":
            value["request_nonce"] = str(uuid4())
        if fault == "cacheable":
            headers["Cache-Control"] = "public"
        raw = json.dumps(value)
        if fault == "duplicate":
            raw = raw[:-1] + ',"version":"1"}'
        if fault == "oversize":
            raw = " " * 1_048_577
        return httpx.Response(200, content=raw, headers=headers)

    client = ProviderEncounterTransport(
        "https://core.synthetic.invalid", fresh, transport=httpx.MockTransport(handle)
    )
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await client.request({"action": "list", "request_nonce": str(uuid4())}, str(uuid4()))
        assert len(calls) == 1
    finally:
        await client.close()


@pytest.mark.parametrize(
    "extra",
    [{"expected_actor_ref": "foreign"}, {"expected_tenant_ref": "foreign"}, {"action": "record"}],
)
async def test_renderer_cannot_supply_account_authority(extra):
    account = ProviderEncounterAccount(
        "account", uuid4(), "actor", "tenant", SecretStr("synthetic-user-token")
    )

    async def fresh():
        return account

    async def handle(_request):
        pytest.fail("Rejected input must not reach Core")

    client = ProviderEncounterTransport(
        "https://core.synthetic.invalid", fresh, transport=httpx.MockTransport(handle)
    )
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await client.request(
                {"action": "list", "request_nonce": str(uuid4()), **extra}, str(uuid4())
            )
    finally:
        await client.close()
