"""Receiver-first setup/activation through real frozen offline identity checks."""

import json
from uuid import uuid4

import httpx
import pytest
from receiver import ProviderReceiver
from test_core_context_receiver import ORIGIN, receiver


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["catalog", "activation"])
@pytest.mark.parametrize("malformed", [False, True])
async def test_closed_account_setup_reaches_native_revision_without_sql(
    action, malformed, monkeypatch
):
    client, token, _calls, verifier = receiver(personal=True)
    revision, nonce = str(uuid4()), str(uuid4())

    def no_sql(*_args, **_kwargs):
        raise AssertionError("Account setup must never use a registry fallback")

    monkeypatch.setattr("receiver.Session", no_sql)

    def core_reply(request):
        body = json.loads(request.content)
        expected = "/service/v1/agent/scribe/" + (
            "provider-context" if action == "catalog" else "activation"
        )
        assert request.url.path == expected
        value = {
            "type": "scribe_account_setup_required",
            "status": 409,
            "setup": "practice",
            "request_nonce": body["request_nonce"],
        }
        if malformed:
            value["tenant_ref"] = "forbidden"
        return httpx.Response(
            409,
            json=value,
            headers={
                "Content-Type": "application/problem+json",
                "Cache-Control": "no-store",
                "X-Cosmaneura-Record-Version": "1",
            },
        )

    client.core_http = httpx.MockTransport(core_reply)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app()), base_url=ORIGIN
        ) as http:
            response = await http.post(
                "/provider/v1/" + action,
                json={} if action == "catalog" else {"action": "activate", "request_nonce": nonce},
                headers={
                    "Origin": "app://cosmas",
                    "Authorization": "Bearer " + token,
                    "X-Scribe-Native-Revision": revision,
                    "Idempotency-Key": str(uuid4()),
                },
            )
        assert response.status_code == (503 if malformed else 409)
        if not malformed:
            value = response.json()
            assert set(value) == {"type", "status", "setup", "request_nonce", "revision"}
            assert value["revision"] == revision and value["setup"] == "practice"
            if action == "activation":
                assert value["request_nonce"] == nonce
        assert response.headers["cache-control"] == "no-store"
    finally:
        verifier.close()


@pytest.mark.asyncio
async def test_legacy_registry_does_not_gain_automatic_activation():
    assert not hasattr(ProviderReceiver, "activation")
