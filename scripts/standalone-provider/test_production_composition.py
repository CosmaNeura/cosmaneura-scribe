"""Offline configuration and ASGI boundary checks; no service or credentials."""

import asyncio
import base64
import json
import plistlib

import pytest
from azure_ingress import ACA_PROFILE, PRODUCTION_ACA_PROFILE, STAGING_HOST, AzureIngress
from prepare_production_profiles import prepare, project
from receiver_runtime import ReceiverConfiguration, identity_arguments, load_configuration


def configured(**changes):
    return {
        "schema": 1,
        "enabled": True,
        "platforms": ["ios", "desktop"],
        "environment_id": "10000000-0000-4000-8000-000000000001",
        "beta_box_id": "10000000-0000-4000-8000-000000000002",
        "managed_identity_client_id": "10000000-0000-4000-8000-000000000003",
        "database_host": "syntheticfixture.postgres.database.azure.com",
        "database_name": "syntheticfixture",
        "database_reader_role": "fixture_reader",
        "core_scope": "api://10000000-0000-4000-8000-000000000004/.default",
        "ingress_isolation_receipt": "synthetic-fixture-receipt",
        **changes,
    }


def production():
    return {
        "core_origin": "https://app.cosmaneura.com",
        "issuer": "https://clerk.cosmaneura.com",
        "receiver_origin": "https://synthetic-fixture-production.example.azurecontainerapps.io",
        "audience": "fixture-audience",
        "organization_id": "org_fixture",
        "deployment_receipt_sha256": "1" * 64,
        "session_claims_receipt_sha256": "2" * 64,
        "native_policy_receipt_sha256": "4" * 64,
        "protected_data_receipt_sha256": "3" * 64,
    }


def validate(value):
    return ReceiverConfiguration.model_validate_json(json.dumps(value))


def test_staging_composition_preserved():
    config = validate(configured(desktop_native_session_without_origin=True))
    for platform in config.platforms:
        settings, verifier = identity_arguments(config, platform)
        assert settings["clerk_issuer"] == "https://resolved-emu-53.clerk.accounts.dev"
        assert settings["clerk_audience"] is None and settings["clerk_organization_id"] is None
        assert settings["data_mode"] == "synthetic"
        assert verifier["core_provider_session"] is True
        assert verifier["allow_native_session_without_origin"] is (platform == "ios")
        assert verifier["allow_staging_desktop_session_without_origin"] is (platform == "desktop")
        assert set(verifier) == {
            "core_provider_session",
            "allow_native_session_without_origin",
            "allow_staging_desktop_session_without_origin",
        }


def test_production_composition_selects_receipt_gated_native_organization_verifier():
    config = validate(
        configured(profile="core-production-organization-v1", production=production())
    )
    for platform in config.platforms:
        settings, verifier = identity_arguments(config, platform)
        assert settings["clerk_issuer"] == "https://clerk.cosmaneura.com"
        assert settings["clerk_audience"] == "fixture-audience"
        assert settings["clerk_organization_id"] == "org_fixture"
        assert settings["data_mode"] == "authorized_beta"
        assert settings["workspace_apple_local_transport_enabled"] is (platform == "ios")
        assert settings["workspace_desktop_local_transport_enabled"] is (platform == "desktop")
        assert verifier == {
            "core_provider_session": False,
            "allow_native_session_without_origin": False,
            "allow_staging_desktop_session_without_origin": False,
            "production_native_origin": "capacitor://localhost"
            if platform == "ios"
            else "app://cosmas",
            "production_native_policy_receipt_sha256": "4" * 64,
        }


def test_missing_or_mixed_production_binding_refused(tmp_path):
    for value in [
        configured(profile="core-production-organization-v1"),
        configured(production=production()),
        configured(
            profile="core-production-organization-v1",
            production=production(),
            desktop_native_session_without_origin=True,
        ),
        configured(
            profile="core-production-organization-v1",
            production={**production(), "issuer": "https://resolved-emu-53.clerk.accounts.dev"},
        ),
        configured(
            profile="core-production-organization-v1",
            production={**production(), "receiver_origin": "https://" + STAGING_HOST},
        ),
        configured(
            profile="core-production-organization-v1",
            production={**production(), "organization_id": ""},
        ),
        configured(
            profile="core-production-organization-v1",
            production={**production(), "native_policy_receipt_sha256": ""},
        ),
    ]:
        with pytest.raises(ValueError):
            validate(value)
    path = tmp_path / "duplicate.json"
    path.write_text('{"schema":1,"enabled":false,"enabled":true}')
    with pytest.raises(RuntimeError, match="receiver_configuration_unavailable"):
        load_configuration(path)


def test_production_ingress_pins_supplied_authority_and_rejects_stage_host():
    reached = []

    async def app(scope, _receive, send):
        reached.append(scope)
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    edge = AzureIngress(
        app, profile=PRODUCTION_ACA_PROFILE, production_origin=production()["receiver_origin"]
    )

    async def invoke(host):
        sent = []

        async def send(message):
            sent.append(message)

        async def receive():
            return {"type": "http.request", "body": b""}

        await edge(
            {
                "type": "http",
                "scheme": "http",
                "root_path": "",
                "path": "/native/provider",
                "headers": [(b"host", host.encode()), (b"x-forwarded-proto", b"https")],
            },
            receive,
            send,
        )
        return sent[0]["status"]

    assert asyncio.run(invoke(STAGING_HOST)) == 404 and not reached
    assert asyncio.run(invoke(production()["receiver_origin"][8:])) == 204
    assert reached[0]["server"] == (production()["receiver_origin"][8:], 443)
    assert reached[0]["client"] is None
    with pytest.raises(ValueError):
        AzureIngress(app, profile=ACA_PROFILE, production_origin=production()["receiver_origin"])


def profile_input():
    receiver = configured(
        profile="core-production-organization-v1", production=production(), enabled=False
    )
    return {
        "schema": 1,
        "receiver": receiver,
        "client": {
            "publishable_key": "pk_live_" + base64.b64encode(b"clerk.cosmaneura.com$").decode(),
            "upload_origin": "https://syntheticfixture.blob.core.windows.net",
            "workspace_id": receiver["beta_box_id"],
        },
        "desktop_helpers": {
            role: {"path": "native/" + role, "sha256": "3" * 64}
            for role in ["auth", "audio", "presentation"]
        },
    }


def test_owner_input_projection_stays_disabled_and_preserves_source(tmp_path):
    source = tmp_path / "owner.json"
    raw = json.dumps(profile_input()).encode()
    source.write_bytes(raw)
    output = tmp_path / "new-output"
    prepare(source, output)
    assert source.read_bytes() == raw
    projected = project(profile_input())
    assert projected["receiver"]["enabled"] is False and projected["desktop"]["enabled"] is False
    assert projected["ios"]["CosmasNativeAuth"]["enabled"] is False
    assert projected["ios"]["CosmasNativeAuth"]["nativePolicyReceiptSha256"] == "4" * 64
    assert projected["desktop_auth"]["CosmasNativeAuth"]["nativePolicyReceiptSha256"] == "4" * 64
    assert projected["receiver"]["production"]["native_policy_receipt_sha256"] == "4" * 64
    assert projected["ios"]["CFBundleIdentifier"] == "com.cosmaneura.scribe.beta"
    assert projected["desktop"]["workspaceId"] == projected["receiver"]["beta_box_id"]
    assert json.loads((output / "status.json").read_text())["production_qualified"] is False
    with pytest.raises(FileExistsError):
        prepare(source, output)


def test_owner_projection_rejects_staging_key_and_active_input():
    value = profile_input()
    value["client"]["publishable_key"] = value["client"]["publishable_key"].replace(
        "pk_live_", "pk_test_"
    )
    with pytest.raises(ValueError):
        project(value)
    value = profile_input()
    value["receiver"]["enabled"] = True
    with pytest.raises(ValueError):
        project(value)
    value = profile_input()
    value["receiver"]["production"]["native_policy_receipt_sha256"] = "G" * 64
    with pytest.raises(ValueError):
        project(value)


def test_explicit_client_enablement_leaves_receiver_and_source_disabled(tmp_path):
    value = profile_input()
    source = tmp_path / "owner.json"
    original = json.dumps(value).encode()
    source.write_bytes(original)
    output = tmp_path / "enabled-client-projection"
    prepare(source, output, enable_clients=True)
    ios = plistlib.loads((output / "ios-info-fragment.plist").read_bytes())
    desktop = json.loads((output / "desktop-profile.json").read_bytes())
    receiver = json.loads((output / "receiver-profile.json").read_bytes())
    assert ios["CosmasNativeAuth"]["enabled"] is True
    assert ios["ScribeProviderApplication"]["enabled"] is True
    assert desktop["enabled"] is True and desktop["schema"] == 2
    assert receiver["enabled"] is False and value["receiver"]["enabled"] is False
    assert source.read_bytes() == original
    assert json.loads((output / "status.json").read_text())["production_qualified"] is False
    with pytest.raises(ValueError):
        project(value, enable_clients="true")


@pytest.mark.parametrize("platforms", [["ios"], ["desktop"]])
def test_both_enabled_clients_require_both_receiver_platforms(platforms):
    value = profile_input()
    value["receiver"]["platforms"] = platforms
    assert project(value)["desktop"]["enabled"] is False
    with pytest.raises(ValueError):
        project(value, enable_clients=True)


def personal_config(*, audience=None, **changes):
    return configured(
        profile="core-production-personal-v1",
        authority_backend="core-provider-context-v1",
        database_host=None,
        database_name=None,
        database_reader_role=None,
        production={**production(), "audience": audience, "organization_id": None},
        **changes,
    )


@pytest.mark.parametrize("audience", [None, "observed-default-session-audience"])
def test_personal_composition_requires_explicit_production_core_backend_and_receipts(audience):
    value = personal_config(audience=audience)
    config = validate(value)
    for platform in config.platforms:
        settings, verifier = identity_arguments(config, platform)
        assert settings["clerk_audience"] == audience
        assert settings["clerk_organization_id"] is None
        assert settings["clerk_issuer"] == "https://clerk.cosmaneura.com"
        assert settings["data_mode"] == "authorized_beta"
        assert verifier["production_core_personal_session"] is True
        assert verifier["core_provider_session"] is False
        assert verifier["production_native_policy_receipt_sha256"] == "4" * 64
    for changed in [
        value | {"authority_backend": "registry"},
        value | {"profile": "core-production-organization-v1"},
        value | {"production": value["production"] | {"organization_id": "org_other"}},
        value | {"production": value["production"] | {"native_policy_receipt_sha256": ""}},
        value | {"production": value["production"] | {"audience": "contains spaces"}},
    ]:
        with pytest.raises(ValueError):
            validate(changed)


def test_personal_profile_projection_preserves_default_off_and_both_native_protocols():
    original = profile_input()
    original["receiver"] = personal_config() | {"enabled": False}
    result = project(original)
    assert result["receiver"]["enabled"] is False
    assert result["desktop"]["enabled"] is False
    assert result["desktop"]["profile"] == "core-production-personal-v1"
    auth = result["ios"]["CosmasNativeAuth"]
    assert auth["enabled"] is False
    assert auth["identityProfile"] == "core-production-personal-v1"
    assert "organizationId" not in auth and "audience" not in auth
    assert result["ios"]["ScribeProviderReceiver"]["profile"] == "core-production-personal-https-v1"
    assert result["ios"]["ScribeProviderApplication"]["profile"] == "core-production-personal-v1"
    assert result["desktop_auth"]["CosmasNativeAuth"] == auth
    enabled = project(original, enable_clients=True)
    assert enabled["receiver"]["enabled"] is False
    assert enabled["ios"]["CosmasNativeAuth"]["enabled"] is True
