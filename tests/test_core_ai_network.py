"""Existing Core transport selection, with no AI request or database access."""

from ipaddress import ip_network

import pytest
from cosmaneura_scribe.captured_worker_settings import CapturedWorkerSettings
from cosmaneura_scribe.core_ai_network import (
    CORE_OPENAI_HOST,
    CORE_POSTGRES_HOST,
    CORE_SPEECH_HOST,
    CORE_TRANSLATION_DEPLOYMENT,
    CoreAIEndpointUnavailable,
    CoreAIPublicEndpointGuard,
    ai_endpoint_guard,
)
from cosmaneura_scribe.speech_private_network import PrivateSpeechEndpointGuard
from cosmaneura_scribe.transcription import AzureSpeechTranscriber
from test_captured_worker_job_runner import _settings


def test_default_guard_and_private_configuration_are_unchanged():
    guard = ai_endpoint_guard(CORE_SPEECH_HOST, (ip_network("10.42.1.7/32"),))
    assert type(guard) is PrivateSpeechEndpointGuard
    assert not CapturedWorkerSettings().existing_core_public_ai_enabled


@pytest.mark.asyncio
@pytest.mark.parametrize("host", [CORE_SPEECH_HOST, CORE_OPENAI_HOST])
async def test_explicit_existing_account_accepts_public_dns(host):
    async def resolve(hostname):
        assert hostname == host
        return ("20.42.1.7",)

    await CoreAIPublicEndpointGuard(host, resolver=resolve).verify()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answers",
    [
        (),
        ("10.42.1.7",),
        ("127.0.0.1",),
        ("169.254.169.254",),
        ("20.42.1.7", "10.42.1.7"),
        ("not-an-ip",),
    ],
)
async def test_public_guard_refuses_unsafe_or_mixed_answers(answers):
    async def resolve(_):
        return answers

    with pytest.raises(CoreAIEndpointUnavailable, match="^existing_core_ai_endpoint_unavailable$"):
        await CoreAIPublicEndpointGuard(CORE_SPEECH_HOST, resolver=resolve).verify()


def test_public_mode_rejects_other_accounts_and_private_endpoint_binding():
    with pytest.raises(ValueError):
        CoreAIPublicEndpointGuard("other.cognitiveservices.azure.com")
    with pytest.raises(ValueError):
        ai_endpoint_guard(
            CORE_SPEECH_HOST, (ip_network("10.42.1.7/32"),), existing_core_public=True
        )


def core_settings(tmp_path, stage):
    values = _settings(tmp_path, stage=stage).model_dump()
    values.update(
        existing_core_public_ai_enabled=True,
        database_host=CORE_POSTGRES_HOST,
        azure_speech_private_endpoint_cidrs=(),
        azure_translation_private_endpoint_cidrs=(),
    )
    if stage == "speech":
        values["azure_speech_endpoint"] = "https://" + CORE_SPEECH_HOST
    else:
        values.update(
            azure_translation_endpoint="https://" + CORE_OPENAI_HOST + "/openai/v1",
            azure_translation_deployment=CORE_TRANSLATION_DEPLOYMENT,
        )
    return values


@pytest.mark.parametrize("stage", ["speech", "translation"])
def test_worker_uses_exact_existing_core_postgres_and_ai(tmp_path, stage):
    settings = CapturedWorkerSettings.model_validate(core_settings(tmp_path, stage))
    assert settings.database_host == CORE_POSTGRES_HOST
    assert settings.existing_core_public_ai_enabled


@pytest.mark.parametrize(
    "stage,change",
    [
        ("speech", {"database_host": "other.postgres.database.azure.com"}),
        ("speech", {"database_ssl": False}),
        ("speech", {"managed_identity_client_id": None}),
        ("speech", {"azure_speech_endpoint": "https://other.cognitiveservices.azure.com"}),
        ("translation", {"database_host": "other.postgres.database.azure.com"}),
        ("translation", {"azure_translation_endpoint": "https://other.openai.azure.com"}),
        ("translation", {"azure_translation_deployment": "new-deployment"}),
    ],
)
def test_new_transport_does_not_admit_alternate_resources(tmp_path, stage, change):
    with pytest.raises(ValueError):
        CapturedWorkerSettings.model_validate(core_settings(tmp_path, stage) | change)


def test_public_speech_factory_requires_only_managed_identity(tmp_path, monkeypatch):
    settings = CapturedWorkerSettings.model_validate(core_settings(tmp_path, "speech"))
    for value in ("AzureCliCredential", "DefaultAzureCredential", ""):
        monkeypatch.setenv("AZURE_TOKEN_CREDENTIALS", value)
        with pytest.raises(ValueError, match="existing_core_ai_managed_identity_required"):
            AzureSpeechTranscriber.from_settings(settings)
    calls = []
    monkeypatch.setenv("AZURE_TOKEN_CREDENTIALS", "ManagedIdentityCredential")
    monkeypatch.setattr(
        "cosmaneura_scribe.transcription.DefaultAzureCredential",
        lambda **kwargs: calls.append(kwargs),
    )
    monkeypatch.setattr(
        "cosmaneura_scribe.transcription.TranscriptionClient", lambda **kwargs: None
    )
    result = AzureSpeechTranscriber.from_settings(settings)
    assert type(result._endpoint_guard) is CoreAIPublicEndpointGuard
    assert calls == [
        {
            "managed_identity_client_id": str(settings.managed_identity_client_id),
            "require_envvar": True,
        }
    ]
