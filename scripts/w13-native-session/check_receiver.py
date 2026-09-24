"""Exercise only the prepared receiver with offline keys and read-only synthetic catalog."""

import importlib.util
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

root = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("native_receiver", root / "server.py")
assert spec is not None and spec.loader is not None
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class OfflineKeys:
    def get_signing_keys(self, *, refresh):
        return [SimpleNamespace(key_id="offline-only", key=key.public_key())]


def verifier(*, native=False, settings=None):
    return receiver.ClerkTokenVerifier(
        settings or receiver.settings,
        jwks_client=OfflineKeys(),
        start_background_refresh=False,
        allow_native_session_without_origin=native,
    )


receiver.verifier = verifier(native=True)
stages = []
receiver.stage = stages.append
now = datetime.now(UTC)
claims = dict(
    sub=receiver.CONFIG["subject"],
    iss=receiver.CONFIG["issuer"],
    aud=receiver.CONFIG["audience"],
    sid="sess_offline_only",
    org_id=receiver.CONFIG["organization"],
    iat=now,
    nbf=now,
    exp=now + timedelta(minutes=2),
)


def token(changes=None, *, omit=(), signing_key=key, algorithm="RS256", kid="offline-only"):
    payload = {**claims, **(changes or {})}
    for name in omit:
        payload.pop(name, None)
    return jwt.encode(payload, signing_key, algorithm=algorithm, headers={"kid": kid})


try:
    verifier().verify(token())
    raise AssertionError("Default verifier accepted missing azp")
except receiver.AuthenticationFailed:
    pass
try:
    verifier(
        native=True,
        settings=receiver.settings.model_copy(
            update={"clerk_authorized_parties": "capacitor://localhost,https://browser.invalid"}
        ),
    )
    raise AssertionError("Mixed browser configuration accepted native profile")
except RuntimeError:
    pass

with TestClient(receiver.app, base_url=receiver.CONFIG["api_origin"]) as client:
    origin = {"Origin": "capacitor://localhost"}

    def catalog(value, *, headers=None):
        return client.get(
            "/workspaces", headers={**origin, "Authorization": "Bearer " + value, **(headers or {})}
        )

    good = catalog(token())
    assert good.status_code == 200 and good.json()[0]["label"] == "Invented connection visit", (
        good.status_code,
        stages,
    )
    assert catalog(token({"azp": "capacitor://localhost"})).status_code == 200
    assert (
        catalog(token({"o": {"id": receiver.CONFIG["organization"]}}, omit=["org_id"])).status_code
        == 200
    )
    rejected = 0
    for changes, status in [
        ({"azp": None}, 401),
        ({"azp": ""}, 401),
        ({"azp": 42}, 401),
        ({"azp": ["capacitor://localhost"]}, 401),
        ({"azp": "app://cosmas"}, 401),
        ({"azp": "https://unapproved.invalid"}, 401),
        ({"aud": "other-api"}, 401),
        ({"iss": "https://other.clerk.accounts.dev"}, 401),
        ({"sub": "user_unprovisioned"}, 403),
        ({"org_id": "org_other"}, 403),
        ({"o": {"id": "org_other"}}, 403),
        ({"exp": now - timedelta(minutes=1)}, 401),
        ({"iat": now + timedelta(minutes=1)}, 401),
        ({"nbf": now + timedelta(minutes=1)}, 401),
    ]:
        result = catalog(token(changes))
        assert result.status_code == status and "Invented connection visit" not in result.text
        rejected += 1
    for name in ["exp", "iat", "nbf", "iss", "aud", "sub", "sid"]:
        assert catalog(token(omit=[name])).status_code == 401
        rejected += 1
    for value in [
        token(signing_key=wrong_key),
        token(kid="unknown-offline-key"),
        token(signing_key="offline-fixture-key-at-least-32-bytes", algorithm="HS256"),
    ]:
        assert catalog(value).status_code == 401
        rejected += 1
    assert client.get("/workspaces", headers=origin).status_code == 401
    assert catalog(token(), headers={"x-actor-principal-id": "untrusted"}).status_code == 401
    assert catalog(token(), headers={"Origin": "app://cosmas"}).status_code == 404
    assert catalog(token(), headers={"Origin": "https://browser.invalid"}).status_code == 404
    assert catalog(token(), headers={"Host": "unapproved.invalid"}).status_code == 404
    assert client.post("/workspaces", headers=origin).status_code == 404
    assert client.get("/workspaces?actor=other", headers=origin).status_code == 404
    assert good.headers["Cache-Control"] == "no-store"
print(
    json.dumps(
        {
            "native_catalog": "pass",
            "strict_default_preserved": True,
            "invalid_signed_token_cases_rejected": rejected,
            "native_only_origin_boundary": "pass",
            "real_tokens_requested": False,
            "database_writes": False,
            "receiver_activated": False,
        }
    )
)
