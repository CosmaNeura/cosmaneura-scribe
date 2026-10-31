"""Offline fixed child profile/dispatch checks, without credentials or data."""

import json
from contextlib import asynccontextmanager
from uuid import uuid4

import core_bundle_child as child
import httpx
import pytest
from cosmaneura_scribe.core_ai_network import (
    CORE_OPENAI_HOST,
    CORE_SPEECH_HOST,
    CORE_TRANSLATION_DEPLOYMENT,
)
from fastapi import FastAPI


def configuration(profile):
    principal, oid = child._PRINCIPALS[profile]
    fields = {
        "repository_backend": "postgres",
        "database_host": child.CORE_POSTGRES_HOST,
        "database_name": "cosmaneura_scribe",
        "database_user": principal,
        "database_ssl": "true",
        "database_pool_size": "2" if profile == "api" else "1",
        "database_max_overflow": "0",
        "audio_encryption_key_id": child.KEY_ID,
        "managed_identity_client_id": str(
            {
                "api": child.API_CLIENT_ID,
                "speech": child.SPEECH_CLIENT_ID,
                "translation": child.TRANSLATION_CLIENT_ID,
            }[profile]
        ),
    }
    for name, role in [
        ("runtime", "api"),
        ("transcription", "speech"),
        ("translation", "translation"),
    ]:
        fields["database_" + name + "_principal_name"] = child._PRINCIPALS[role][0]
        fields["database_" + name + "_principal_object_id"] = str(child._PRINCIPALS[role][1])
    if profile == "api":
        fields.update(
            workflow_authentication_enabled="true",
            entra_tenant_id=str(uuid4()),
            workflow_api_audience=str(uuid4()),
            trusted_platform_client_id=str(child.API_CLIENT_ID),
        )
    else:
        fields.update(
            captured_worker_enabled="true",
            captured_worker_stage=profile,
            captured_worker_batch_size="1",
            configured_capture_tenant_ids=json.dumps([str(uuid4())]),
            existing_core_public_ai_enabled="true",
        )
    if profile in {"api", "speech"}:
        fields.update(
            storage_backend="azure",
            storage_account_url=child.BLOB_ORIGIN,
            storage_container_name="audio",
        )
    if profile == "speech":
        fields.update(
            transcription_backend="azure",
            azure_speech_endpoint="https://" + CORE_SPEECH_HOST,
            audio_assembly_encrypted_temp_directory=str(child.WORKER_TEMP),
        )
    elif profile == "translation":
        fields.update(
            azure_translation_endpoint="https://" + CORE_OPENAI_HOST + "/openai/v1",
            azure_translation_deployment=CORE_TRANSLATION_DEPLOYMENT,
        )
    return {
        "schema_version": 1,
        "enabled": True,
        "environment": {"COSMANEURA_SCRIBE_" + key.upper(): value for key, value in fields.items()},
    }


@pytest.mark.parametrize("profile", ["api", "speech", "translation"])
def test_disabled_profiles_do_not_load_settings(profile, monkeypatch):
    monkeypatch.setitem(child._PROFILES, profile, lambda: pytest.fail("no settings construction"))
    assert (
        child.load_environment('{"schema_version":1,"enabled":false,"environment":{}}', profile)
        is None
    )


@pytest.mark.parametrize("profile", ["api", "speech", "translation"])
def test_exact_existing_profiles_preserve_host_environment(profile, monkeypatch):
    monkeypatch.setenv("CORE_SECRET_FIXTURE", "isolated")
    result = child.load_environment(json.dumps(configuration(profile)), profile)
    assert result["AZURE_TOKEN_CREDENTIALS"] == "ManagedIdentityCredential"
    assert child.os.environ["CORE_SECRET_FIXTURE"] == "isolated"
    assert "COSMANEURA_SCRIBE_DATABASE_HOST" not in child.os.environ


@pytest.mark.parametrize(
    "profile,key,value",
    [
        ("api", "DATABASE_URL", "postgres://wrong"),
        ("api", "DATABASE_HOST", "other.postgres.database.azure.com"),
        ("api", "DATABASE_RUNTIME_PRINCIPAL_OBJECT_ID", str(uuid4())),
        ("api", "MANAGED_IDENTITY_CLIENT_ID", str(child.TRANSLATION_CLIENT_ID)),
        ("api", "TRUSTED_PLATFORM_CLIENT_ID", str(uuid4())),
        ("speech", "STORAGE_ACCOUNT_URL", "https://other.blob.core.windows.net/"),
        ("speech", "AUDIO_ENCRYPTION_KEY_ID", "https://other.vault.azure.net/keys/other"),
        ("speech", "CAPTURED_WORKER_BATCH_SIZE", "8"),
        ("translation", "DATABASE_TRANSLATION_PRINCIPAL_OBJECT_ID", str(uuid4())),
        ("translation", "MANAGED_IDENTITY_CLIENT_ID", str(child.API_CLIENT_ID)),
    ],
)
def test_other_resources_principals_and_unbounded_profiles_deny(profile, key, value):
    config = configuration(profile)
    config["environment"]["COSMANEURA_SCRIBE_" + key] = value
    with pytest.raises(
        child.BundleUnavailable, match="^scribe_core_bundle_configuration_unavailable$"
    ):
        child.load_environment(json.dumps(config), profile)


@pytest.mark.parametrize(
    "raw",
    [
        "{}",
        '{"schema_version":1,"schema_version":1}',
        '{"schema_version":1,"enabled":false,"environment":{"COSMANEURA_SCRIBE_DATABASE_URL":"wrong"}}',
    ],
)
def test_missing_duplicate_or_disabled_configuration_values_deny(raw):
    with pytest.raises(child.BundleUnavailable):
        child.load_environment(raw, "api")


@pytest.mark.asyncio
async def test_child_keeps_receiver_api_and_health_separate_and_runs_both_lifespans():
    events = []

    def application(name):
        @asynccontextmanager
        async def lifespan(_):
            events.append(name + "-start")
            yield
            events.append(name + "-stop")

        app = FastAPI(lifespan=lifespan)

        @app.get("/{path:path}")
        def get(path):
            return {"source": name}

        return app

    runtime = child.ScribeChild(application("api"), application("receiver"))
    async with child._running(runtime):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=runtime), base_url="http://127.0.0.1"
        ) as client:
            assert (await client.get("/v1/sessions")).json() == {"source": "api"}
            assert (await client.get("/provider/v1/catalog")).json() == {"source": "receiver"}
            assert (await client.get("/__core_bundle_health")).status_code == 204
            assert (
                await client.get("/service/v1/agent/scribe/provider-context")
            ).status_code == 404
    assert events == ["api-start", "receiver-start", "receiver-stop", "api-stop"]


def test_root_identity_cannot_start_a_scribe_child(monkeypatch):
    monkeypatch.setattr(child.os, "geteuid", lambda: 0)
    monkeypatch.setattr(child, "load_environment", lambda *_: pytest.fail("no configuration load"))
    with pytest.raises(child.BundleUnavailable, match="^scribe_core_bundle_worker_unavailable$"):
        child.worker_main("speech")
