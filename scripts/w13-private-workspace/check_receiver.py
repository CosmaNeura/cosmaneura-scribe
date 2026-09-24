"""Offline signed-request checks against the new database and frozen receiver."""

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
spec = importlib.util.spec_from_file_location("owned_receiver", root / "server.py")
assert spec is not None and spec.loader is not None
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class OfflineKeys:
    def get_signing_keys(self, *, refresh):
        return [SimpleNamespace(key_id="offline-only", key=key.public_key())]


receiver.verifier = receiver.ClerkTokenVerifier(
    receiver.settings, jwks_client=OfflineKeys(), start_background_refresh=False
)
receiver.stage = lambda _: None  # Keep offline checks out of the actual-device evidence log.
now = datetime.now(UTC)
claims = dict(
    sub=receiver.CONFIG["subject"],
    iss=receiver.CONFIG["issuer"],
    aud=receiver.CONFIG["audience"],
    sid="sess_offline_only",
    azp="capacitor://localhost",
    org_id=receiver.CONFIG["organization"],
    iat=now,
    nbf=now,
    exp=now + timedelta(minutes=2),
)


def token(**changes):
    return jwt.encode(
        {**claims, **changes}, key, algorithm="RS256", headers={"kid": "offline-only"}
    )


with TestClient(receiver.app, base_url=receiver.CONFIG["api_origin"]) as client:
    headers = {"Origin": "capacitor://localhost"}
    assert client.get("/connection", headers=headers).status_code == 200
    assert client.get("/workspaces", headers=headers).status_code == 401
    good = client.get("/workspaces", headers={**headers, "Authorization": "Bearer " + token()})
    assert good.status_code == 200 and len(good.json()) == 1
    assert good.json()[0]["label"] == "Invented connection visit"
    for changes, status in (
        ({"sub": "user_unprovisioned"}, 403),
        ({"org_id": "org_other"}, 403),
        ({"azp": "https://unapproved.invalid"}, 401),
        ({"exp": now - timedelta(minutes=1)}, 401),
    ):
        result = client.get(
            "/workspaces", headers={**headers, "Authorization": "Bearer " + token(**changes)}
        )
        assert result.status_code == status and "Invented connection visit" not in result.text
    assert client.post("/workspaces", headers=headers).status_code == 404
    assert client.get("/connection").status_code == 404
    assert client.get("/workspaces?actor=other", headers=headers).status_code == 404
    assert good.headers["Cache-Control"] == "no-store"
with receiver.engine.connect() as connection:
    from sqlalchemy import text

    assert connection.scalar(text("SHOW listen_addresses")) == ""
print(
    json.dumps(
        {
            "offline_signed_catalog": "pass",
            "unprovisioned_org_origin_expiry_rejected": True,
            "unknown_routes_and_writes_denied": True,
            "database_tcp_disabled": True,
        }
    )
)
