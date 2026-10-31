"""Offline signed human/workload tokens and the exact Core context contract."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import jwt
import pytest
from cosmaneura_scribe.provider_context_transport import PATH, ProviderContextTransport
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import SecretStr

pytestmark = pytest.mark.asyncio
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ISSUER = "https://synthetic.clerk.invalid"
ORIGIN = "https://core.synthetic.invalid"
AUDIENCE = "10000000-0000-4000-8000-000000000001"
CALLER = "10000000-0000-4000-8000-000000000002"
ACTOR = "authority_actor_00000000000000000000000001"
TENANT = "authority_tenant_00000000000000000000000002"


def signed(**claims):
    return jwt.encode(
        {"exp": datetime.now(UTC) + timedelta(minutes=5), **claims}, KEY, algorithm="RS256"
    )


def connection():
    value = {
        "actor_ref": ACTOR,
        "tenant_ref": TENANT,
        "provider_link_ref": "scribe_provider_link_00000000000000000000000003",
        "practice_ref": "practice_00000000000000000000000004",
        "practice_label": "Invented practice",
        "review_sha256": "a" * 64,
    }
    value["connection_sha256"] = hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return value


def fixture(*, fault=None, action="connection"):
    user = signed(
        iss=ISSUER,
        sub="user_synthetic",
        sid="sess_synthetic",
        aud="native-synthetic",
        org_id="org_synthetic",
        azp="app://cosmas",
    )
    workload = signed(
        iss="https://login.microsoftonline.com/synthetic/v2.0",
        aud=AUDIENCE,
        azp=CALLER,
        roles=["AgentApi.Access"],
        idtyp="app",
    )
    seen = []

    async def verify(token):
        claims = jwt.decode(
            token,
            KEY.public_key(),
            algorithms=["RS256"],
            issuer=ISSUER,
            audience="native-synthetic",
            options={"require": ["iss", "sub", "sid", "exp", "aud"]},
        )
        assert claims["org_id"] == "org_synthetic" and claims["azp"] == "app://cosmas"
        seen.append("verify")
        return {name: claims[name] for name in ("iss", "sub", "sid")}

    async def bearer():
        seen.append("workload")
        return SecretStr(workload)

    def reply(request):
        seen.append("request")
        assert str(request.url) == ORIGIN + PATH
        assert request.headers["authorization"] == "Bearer " + user
        assert request.headers["x-cosmaneura-workload-authorization"] == "Bearer " + workload
        claims = jwt.decode(workload, KEY.public_key(), algorithms=["RS256"], audience=AUDIENCE)
        assert (
            claims["azp"] == CALLER
            and claims["roles"] == ["AgentApi.Access"]
            and claims["idtyp"] == "app"
        )
        body = json.loads(request.content)
        assert set(body) == {"action", "request_nonce"} and body["action"] == action
        value = {
            "contract_version": "1",
            **body,
            "checked_at": datetime.now(UTC).isoformat(),
            "connection": connection(),
            "catalog": None,
        }
        if action == "catalog":
            value["catalog"] = {
                "version": "1",
                "action": "list",
                "request_nonce": body["request_nonce"],
                "account": {"actor_ref": ACTOR, "tenant_ref": TENANT},
                "encounters": [],
            }
        headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Cosmaneura-Record-Version": "1",
        }
        if fault == "denied":
            return httpx.Response(403)
        if fault == "redirect":
            return httpx.Response(302, headers={"Location": "https://other.invalid"})
        if fault == "wrong_nonce":
            value["request_nonce"] = str(uuid4())
        if fault == "expired":
            value["checked_at"] = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
        if fault == "future":
            value["checked_at"] = (datetime.now(UTC) + timedelta(minutes=1)).isoformat()
        if fault == "digest":
            value["connection"]["connection_sha256"] = "b" * 64
        if fault == "extra":
            value["receiver_authority"] = "forbidden"
        if fault == "cookie":
            headers["Set-Cookie"] = "forbidden=value"
        if fault == "cache":
            headers["Cache-Control"] = "public"
        if fault == "wrong_catalog_owner":
            value["catalog"]["account"]["actor_ref"] = "other"
        if fault == "duplicate":
            return httpx.Response(
                200, content='{"action":"connection","action":"catalog"}', headers=headers
            )
        if fault == "oversize":
            return httpx.Response(200, content=b"x" * 1_048_577, headers=headers)
        return httpx.Response(200, json=value, headers=headers)

    client = ProviderContextTransport(
        ORIGIN, uuid4(), "synthetic-box", verify, bearer, transport=httpx.MockTransport(reply)
    )
    return client, "Bearer " + user, seen


@pytest.mark.parametrize("action", ["connection", "catalog"])
async def test_exact_separate_signed_tokens_and_current_core_account(action):
    client, authorization, seen = fixture(action=action)
    try:
        before, catalog = await client.request(authorization, action)
        after, _ = await client.request(authorization, action)
        assert before == after and before.actor_ref == ACTOR and before.tenant_ref == TENANT
        assert before.user_token.get_secret_value() == authorization[7:]
        assert (catalog is None) == (action == "connection")
        assert seen == ["verify", "workload", "request", "verify"] * 2
    finally:
        await client.close()


@pytest.mark.parametrize(
    "fault",
    [
        "denied",
        "redirect",
        "wrong_nonce",
        "expired",
        "future",
        "digest",
        "extra",
        "cookie",
        "cache",
        "duplicate",
        "oversize",
    ],
)
async def test_uncertain_context_denies_without_fallback_or_retry(fault):
    client, authorization, seen = fixture(fault=fault)
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await client.request(authorization, "connection")
        assert seen.count("request") == 1
    finally:
        await client.close()


async def test_catalog_cannot_select_another_actor():
    client, authorization, _ = fixture(action="catalog", fault="wrong_catalog_owner")
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await client.request(authorization, "catalog")
    finally:
        await client.close()


async def test_mutation_and_missing_human_bearer_never_reach_core():
    client, authorization, seen = fixture()
    try:
        for token, action in [(authorization, "create"), ("", "connection")]:
            with pytest.raises(ProviderCoreUnavailable):
                await client.request(token, action)
        assert seen == []
    finally:
        await client.close()
