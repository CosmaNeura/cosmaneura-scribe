import json
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_account_setup import ProviderAccountSetupRequired
from cosmaneura_scribe.provider_context_transport import ProviderContextTransport
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from pydantic import SecretStr


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    [
        None,
        "nonce",
        "extra",
        "duplicate",
        "cookie",
        "version",
        "cache",
        "content_type",
        "oversize",
        "stage",
        "status",
        "rebound",
    ],
)
@pytest.mark.parametrize("setup", ["practice", "activation"])
async def test_only_checked_setup_problem_survives_context_transport(fault, setup):
    checks, calls = [], []

    async def verify(_token):
        checks.append(True)
        return {
            "sub": "changed" if fault == "rebound" and len(checks) == 2 else "synthetic-account"
        }

    async def workload():
        return SecretStr("your-synthetic-workload-token")

    def reply(request):
        calls.append(True)
        nonce = json.loads(request.content)["request_nonce"]
        value = {
            "type": "scribe_account_setup_required",
            "status": 409,
            "setup": setup,
            "request_nonce": nonce,
        }
        headers = {
            "Content-Type": "application/problem+json",
            "Cache-Control": "no-store",
            "X-Cosmaneura-Record-Version": "1",
        }
        if fault == "nonce":
            value["request_nonce"] = str(uuid4())
        if fault == "extra":
            value["tenant_ref"] = "forbidden"
        if fault == "stage":
            value["setup"] = "arbitrary"
        if fault == "status":
            value["status"] = "409"
        if fault == "cookie":
            headers["Set-Cookie"] = "forbidden=value"
        if fault == "version":
            headers["X-Cosmaneura-Record-Version"] = "2"
        if fault == "cache":
            headers["Cache-Control"] = "public"
        if fault == "content_type":
            headers["Content-Type"] = "application/json"
        if fault == "duplicate":
            return httpx.Response(
                409, content='{"setup":"practice","setup":"activation"}', headers=headers
            )
        if fault == "oversize":
            return httpx.Response(409, content=b"x" * 1025, headers=headers)
        return httpx.Response(409, json=value, headers=headers)

    client = ProviderContextTransport(
        "https://synthetic.invalid",
        uuid4(),
        "synthetic-box",
        verify,
        workload,
        transport=httpx.MockTransport(reply),
    )
    try:
        with pytest.raises(ProviderCoreUnavailable) as caught:
            await client.request("Bearer synthetic-human-token", "catalog")
        assert isinstance(caught.value, ProviderAccountSetupRequired) == (fault is None)
        assert calls == [True]
        if fault is None:
            assert caught.value.setup == setup and len(checks) == 2
    finally:
        await client.close()
