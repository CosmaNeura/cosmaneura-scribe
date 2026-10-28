"""Offline tests against the exact qualified verifier after the reviewed patch.

Set SCRIBE_QUALIFIED_IDENTITY_SOURCE to the retained directory containing
cosmas_os/. The test refuses any auth.py other than the qualified input digest.
No Clerk, JWKS, Azure, database, or network service is used.
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from prepare_sources import (
    FILES,
    PINNED_AUTH_SHA256,
    PRODUCTION_AUTH_SHA256,
    PRODUCTION_PATCH_SHA256,
    patched_production_auth,
    prepare,
)

ISSUER = "https://clerk.cosmaneura.com"
AUDIENCE = "fixture-audience"
ORGANIZATION = "org_fixture"
POLICY_RECEIPT = "4" * 64
KID = "offline-production-policy"
PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class OfflineKeys:
    def get_signing_keys(self, refresh=False):
        return [SimpleNamespace(key_id=KID, key=PRIVATE_KEY.public_key())]


def retained_identity_source():
    configured = os.environ.get("SCRIBE_QUALIFIED_IDENTITY_SOURCE")
    if not configured:
        pytest.skip("retained qualified identity source not supplied")
    return Path(configured)


@pytest.fixture(scope="module")
def patched_identity(tmp_path_factory):
    source = retained_identity_source()
    auth = source / "cosmas_os/api/auth.py"
    if not auth.is_file():
        pytest.fail("qualified identity source is unavailable")
    root = tmp_path_factory.mktemp("production-identity")
    shutil.copytree(source / "cosmas_os", root / "cosmas_os")
    original = auth.read_bytes()
    assert __import__("hashlib").sha256(original).hexdigest() == PINNED_AUTH_SHA256
    (root / "cosmas_os/api/auth.py").write_bytes(patched_production_auth(original))
    for name in tuple(sys.modules):
        if name == "cosmas_os" or name.startswith("cosmas_os."):
            del sys.modules[name]
    sys.path.insert(0, str(root))
    module = importlib.import_module("cosmas_os.api.auth")
    config = importlib.import_module("cosmas_os.config")
    yield module, config.Settings
    sys.path.remove(str(root))


def test_source_preparation_applies_exact_patch_and_records_all_hashes(tmp_path):
    source = retained_identity_source()
    qualified = tmp_path / "qualified"
    frozen = qualified / "server-source/cosmas_os"
    frozen.parent.mkdir(parents=True)
    shutil.copytree(source / "cosmas_os", frozen)
    expected = {
        relative: __import__("hashlib").sha256((frozen / relative).read_bytes()).hexdigest()
        for relative in FILES
    }
    (qualified / "runtime.json").write_text(
        json.dumps(
            {
                "native_token_profile": "w13-ios-native-session-v1",
                "source_sha256": expected,
            }
        )
    )
    output = tmp_path / "output"
    output.mkdir()
    prepare(output, qualified, production_native_policy=True)
    manifest = json.loads((output / "identity-source-manifest.json").read_text())
    assert manifest["production_native_policy"] == {
        "selected": True,
        "input_sha256": PINNED_AUTH_SHA256,
        "patch_sha256": PRODUCTION_PATCH_SHA256,
        "output_sha256": PRODUCTION_AUTH_SHA256,
    }
    revised = output / "identity-source/cosmas_os/api/auth.py"
    assert __import__("hashlib").sha256(revised.read_bytes()).hexdigest() == PRODUCTION_AUTH_SHA256
    unchanged = tmp_path / "unchanged"
    unchanged.mkdir()
    prepare(unchanged, qualified)
    copied = unchanged / "identity-source/cosmas_os/api/auth.py"
    assert __import__("hashlib").sha256(copied.read_bytes()).hexdigest() == PINNED_AUTH_SHA256
    default_manifest = json.loads((unchanged / "identity-source-manifest.json").read_text())
    assert default_manifest["production_native_policy"] is None
    with pytest.raises(ValueError, match="Qualified production identity source changed"):
        patched_production_auth((source / "cosmas_os/api/auth.py").read_bytes() + b"\n")


def settings(Settings, origin, *, production=True):
    issuer = ISSUER if production else "https://resolved-emu-53.clerk.accounts.dev"
    return Settings(
        _env_file=None,
        auth_mode="clerk_jwt",
        cosmas_env="synth_os",
        data_mode="authorized_beta" if production else "synthetic",
        synth_seed=False,
        beta_box_id=str(uuid4()),
        clerk_issuer=issuer,
        clerk_jwks_url=issuer + "/.well-known/jwks.json",
        clerk_audience=AUDIENCE if production else None,
        clerk_organization_id=ORGANIZATION if production else None,
        workspace_native_synthetic_enabled=False,
        clerk_authorized_parties=origin,
        cors_allowed_origins=origin,
        workspace_apple_local_transport_enabled=production and origin == "capacitor://localhost",
        workspace_desktop_local_transport_enabled=production and origin == "app://cosmas",
    )


def claims(**changes):
    now = datetime.now(UTC)
    value = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "org_id": ORGANIZATION,
        "sub": "user_fixture",
        "sid": "sess_fixture",
        "iat": now - timedelta(seconds=2),
        "nbf": now - timedelta(seconds=2),
        "exp": now + timedelta(minutes=3),
    }
    for key, item in changes.items():
        if item is _MISSING:
            value.pop(key, None)
        else:
            value[key] = item
    return value


_MISSING = object()


def signed(value):
    return jwt.encode(value, PRIVATE_KEY, algorithm="RS256", headers={"kid": KID})


def verifier(auth, Settings, origin, **changes):
    arguments = {
        "jwks_client": OfflineKeys(),
        "start_background_refresh": False,
        "production_native_origin": origin,
        "production_native_policy_receipt_sha256": POLICY_RECEIPT,
        **changes,
    }
    return auth.ClerkTokenVerifier(settings(Settings, origin), **arguments)


@pytest.mark.parametrize("origin", ["capacitor://localhost", "app://cosmas"])
def test_production_native_missing_azp_retains_all_signed_identity_bindings(
    patched_identity, origin
):
    auth, Settings = patched_identity
    instance = verifier(auth, Settings, origin)
    assert instance.verify(signed(claims()))["sid"] == "sess_fixture"
    # A present, exactly matching native party remains accepted.
    assert instance.verify(signed(claims(azp=origin)))["sub"] == "user_fixture"
    instance.close()


@pytest.mark.parametrize(
    "change",
    [
        {"azp": None},
        {"azp": "https://app.cosmaneura.com"},
        {"iss": "https://untrusted.example"},
        {"aud": "wrong-audience"},
        {"org_id": "org_other"},
        {"sid": _MISSING},
        {"sid": ""},
        {"sub": _MISSING},
        {"sub": ""},
        {"exp": datetime.now(UTC) - timedelta(minutes=1)},
    ],
)
def test_production_native_rejects_wrong_null_web_and_replayed_claims(
    patched_identity, change
):
    auth, Settings = patched_identity
    instance = verifier(auth, Settings, "capacitor://localhost")
    with pytest.raises((auth.AuthenticationFailed, auth.AccessDenied)):
        instance.verify(signed(claims(**change)))
    instance.close()


@pytest.mark.parametrize("receipt", [None, "", "4" * 63, "G" * 64])
def test_missing_or_malformed_policy_receipt_cannot_select_exception(
    patched_identity, receipt
):
    auth, Settings = patched_identity
    with pytest.raises(RuntimeError, match="Production native organization policy is incomplete"):
        auth.ClerkTokenVerifier(
            settings(Settings, "capacitor://localhost"),
            jwks_client=OfflineKeys(),
            start_background_refresh=False,
            production_native_origin="capacitor://localhost",
            production_native_policy_receipt_sha256=receipt,
        )


def test_policy_receipt_cannot_be_replayed_into_staging_or_another_origin(patched_identity):
    auth, Settings = patched_identity
    staging = settings(Settings, "capacitor://localhost", production=False)
    with pytest.raises(RuntimeError, match="Production native organization policy is incomplete"):
        auth.ClerkTokenVerifier(
            staging,
            jwks_client=OfflineKeys(),
            start_background_refresh=False,
            production_native_origin="capacitor://localhost",
            production_native_policy_receipt_sha256=POLICY_RECEIPT,
        )
    wrong_environment = settings(Settings, "capacitor://localhost")
    wrong_environment.cosmas_env = "early_adopter_beta"
    with pytest.raises(RuntimeError, match="Production native organization policy is incomplete"):
        auth.ClerkTokenVerifier(
            wrong_environment,
            jwks_client=OfflineKeys(),
            start_background_refresh=False,
            production_native_origin="capacitor://localhost",
            production_native_policy_receipt_sha256=POLICY_RECEIPT,
        )
    production = settings(Settings, "capacitor://localhost")
    with pytest.raises(RuntimeError, match="Production native organization policy is incomplete"):
        auth.ClerkTokenVerifier(
            production,
            jwks_client=OfflineKeys(),
            start_background_refresh=False,
            production_native_origin="app://cosmas",
            production_native_policy_receipt_sha256=POLICY_RECEIPT,
        )


def test_existing_staging_native_exception_is_preserved(patched_identity):
    auth, Settings = patched_identity
    staging = settings(Settings, "capacitor://localhost", production=False)
    instance = auth.ClerkTokenVerifier(
        staging,
        jwks_client=OfflineKeys(),
        start_background_refresh=False,
        core_provider_session=True,
        allow_native_session_without_origin=True,
    )
    now = datetime.now(UTC)
    token = signed(
        {
            "iss": "https://resolved-emu-53.clerk.accounts.dev",
            "sub": "user_fixture",
            "sid": "sess_fixture",
            "iat": now - timedelta(seconds=2),
            "nbf": now - timedelta(seconds=2),
            "exp": now + timedelta(minutes=3),
        }
    )
    assert instance.verify(token)["sid"] == "sess_fixture"
    instance.close()
