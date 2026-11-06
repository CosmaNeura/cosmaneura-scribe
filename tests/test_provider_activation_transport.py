import json
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_account_setup import ProviderAccountSetupRequired
from cosmaneura_scribe.provider_activation_transport import PATH, ProviderActivationTransport
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from pydantic import SecretStr


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    [
        None,
        "practice",
        "denied",
        "extra",
        "nonce",
        "cookie",
        "cache",
        "redirect",
        "duplicate",
        "oversize",
        "rebound",
    ],
)
async def test_explicit_activation_checked_contract_and_current_identity(fault):
    nonce, key = str(uuid4()), str(uuid4())
    body = {"action": "activate", "request_nonce": nonce}
    calls, checks = [], []

    async def verify(_token):
        checks.append(True)
        return {
            "iss": "https://synthetic.invalid",
            "sub": "synthetic-account",
            "sid": "other" if fault == "rebound" and len(checks) > 1 else "sess_synthetic",
        }

    async def workload():
        return SecretStr("your-synthetic-workload-token")

    def reply(request):
        calls.append(request.url.path)
        assert request.url.path == PATH and json.loads(request.content) == body
        assert request.headers["idempotency-key"] == key
        assert request.headers["authorization"] == "Bearer synthetic-human-token"
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer your-synthetic-workload-token"
        )
        value = {"contract_version": "1", **body, "state": "active"}
        headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Cosmaneura-Record-Version": "1",
        }
        if fault == "practice":
            return httpx.Response(
                409,
                json={
                    "type": "scribe_account_setup_required",
                    "status": 409,
                    "setup": "practice",
                    "request_nonce": nonce,
                },
                headers={**headers, "Content-Type": "application/problem+json"},
            )
        if fault == "denied":
            return httpx.Response(403)
        if fault == "extra":
            value["tenant_ref"] = "forbidden"
        if fault == "nonce":
            value["request_nonce"] = str(uuid4())
        if fault == "cookie":
            headers["Set-Cookie"] = "forbidden=value"
        if fault == "cache":
            headers["Cache-Control"] = "public"
        if fault == "redirect":
            return httpx.Response(302, headers={"Location": "https://other.invalid"})
        if fault == "duplicate":
            return httpx.Response(
                200, content='{"state":"active","state":"active"}', headers=headers
            )
        if fault == "oversize":
            return httpx.Response(200, content=b"x" * 1025, headers=headers)
        return httpx.Response(200, json=value, headers=headers)

    client = ProviderActivationTransport(
        "https://synthetic.invalid", verify, workload, transport=httpx.MockTransport(reply)
    )
    try:
        if fault is None:
            assert (await client.request("Bearer synthetic-human-token", body, key))[
                "state"
            ] == "active"
        elif fault == "practice":
            with pytest.raises(ProviderAccountSetupRequired) as caught:
                await client.request("Bearer synthetic-human-token", body, key)
            assert caught.value.setup == "practice" and len(checks) == 2
        else:
            with pytest.raises(ProviderCoreUnavailable):
                await client.request("Bearer synthetic-human-token", body, key)
        assert calls == [PATH]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [{"doctor_ref": "forbidden"}, {"practice_ref": "forbidden"}])
async def test_renderer_cannot_supply_activation_identity(extra):
    async def unexpected(*_args):
        raise AssertionError("Invalid request must not reach verification or Core")

    client = ProviderActivationTransport("https://synthetic.invalid", unexpected, unexpected)
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await client.request(
                "Bearer synthetic-human-token",
                {"action": "activate", "request_nonce": str(uuid4()), **extra},
                str(uuid4()),
            )
    finally:
        await client.close()
