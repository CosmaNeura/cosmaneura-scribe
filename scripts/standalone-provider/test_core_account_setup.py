"""Receiver-first setup/activation through real frozen offline identity checks."""

import json
from uuid import uuid4

import httpx
import pytest
from receiver import ProviderReceiver
from test_core_context_receiver import receiver
from test_production_native_policy import claims, signed


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["catalog", "activation"])
@pytest.mark.parametrize("malformed", [False, True])
@pytest.mark.parametrize("staging", [False, True])
async def test_closed_account_setup_reaches_native_revision_without_sql(
    action, malformed, staging, monkeypatch
):
    client, token, _calls, verifier = receiver(personal=not staging, staging=staging)
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
        assert str(request.url).startswith(client.profile.core_origin + "/")
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
            transport=httpx.ASGITransport(app=client.app()), base_url=client.profile.origin
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


@pytest.mark.asyncio
@pytest.mark.parametrize("staging", [False, True])
async def test_activation_uses_same_environment_and_never_returns_visit_authority(
    staging, monkeypatch
):
    client, token, _calls, verifier = receiver(personal=not staging, staging=staging)
    revision, nonce, key = (str(uuid4()) for _ in range(3))
    observed = []
    monkeypatch.setattr(
        "receiver.Session", lambda *_args, **_kwargs: pytest.fail("Registry forbidden")
    )

    def core_reply(request):
        observed.append(str(request.url))
        assert (
            str(request.url) == client.profile.core_origin + "/service/v1/agent/scribe/activation"
        )
        assert request.headers["authorization"] == "Bearer " + token
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer synthetic-workload-token"
        )
        assert request.headers["idempotency-key"] == key
        assert json.loads(request.content) == {"action": "activate", "request_nonce": nonce}
        return httpx.Response(
            200,
            json={
                "contract_version": "1",
                "action": "activate",
                "request_nonce": nonce,
                "state": "active",
            },
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Record-Version": "1"},
        )

    client.core_http = httpx.MockTransport(core_reply)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app()), base_url=client.profile.origin
        ) as http:
            response = await http.post(
                "/provider/v1/activation",
                json={"action": "activate", "request_nonce": nonce},
                headers={
                    "Origin": "app://cosmas",
                    "Authorization": "Bearer " + token,
                    "X-Scribe-Native-Revision": revision,
                    "Idempotency-Key": key,
                },
            )
        assert response.status_code == 200
        assert response.json() == {
            "revision": revision,
            "contract_version": "1",
            "action": "activate",
            "request_nonce": nonce,
            "state": "active",
        }
        assert len(observed) == 1 and response.headers["cache-control"] == "no-store"
    finally:
        verifier.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"iss": "https://clerk.cosmaneura.com"},
        {"org_id": "org_fixture"},
        {"o": {"id": "org_fixture"}},
        {"sid": "untrusted-session"},
    ],
)
async def test_staging_rejects_mixed_identity_before_any_core_or_registry_call(
    changes, monkeypatch
):
    client, _token, calls, verifier = receiver(staging=True)
    value = claims(azp="app://cosmas", iss="https://resolved-emu-53.clerk.accounts.dev")
    value.pop("org_id")
    value.pop("aud")
    token = signed(value | changes)
    monkeypatch.setattr(
        "receiver.Session", lambda *_args, **_kwargs: pytest.fail("Registry forbidden")
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app()), base_url=client.profile.origin
        ) as http:
            response = await http.post(
                "/provider/v1/activation",
                json={"action": "activate", "request_nonce": str(uuid4())},
                headers={
                    "Origin": "app://cosmas",
                    "Authorization": "Bearer " + token,
                    "X-Scribe-Native-Revision": str(uuid4()),
                    "Idempotency-Key": str(uuid4()),
                },
            )
        assert response.status_code == 401 and not calls
    finally:
        verifier.close()
