from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from cosmaneura_scribe.settings import Settings
from pydantic import ValidationError


def test_azure_storage_requires_an_account_url() -> None:
    with pytest.raises(ValidationError, match="storage_account_url is required"):
        Settings(storage_backend="azure")


def test_managed_identity_client_id_is_nonsecret_configuration() -> None:
    client_id = uuid4()
    settings = Settings(managed_identity_client_id=client_id)
    assert settings.managed_identity_client_id == client_id


def test_audio_assembly_configuration_is_explicit_and_bounded(tmp_path: Path) -> None:
    settings = Settings(
        audio_encryption_key_id="https://scribe-test.vault.azure.net/keys/scribe-audio",
        audio_assembly_encrypted_temp_directory=tmp_path,
        audio_assembly_max_plaintext_bytes=1_000_000,
    )

    assert str(settings.audio_encryption_key_id).startswith("https://scribe-test.vault.azure.net/")
    assert settings.audio_assembly_encrypted_temp_directory == tmp_path

    with pytest.raises(ValidationError, match="greater than or equal to 1000000"):
        Settings(audio_assembly_max_plaintext_bytes=999_999)

    with pytest.raises(ValidationError, match="versionless Azure Key Vault key ID"):
        Settings(audio_encryption_key_id="https://attacker.invalid/keys/scribe-audio")


def test_postgres_managed_identity_requires_host_and_user() -> None:
    with pytest.raises(ValidationError, match="database_host and database_user are required"):
        Settings(repository_backend="postgres")


def test_local_database_url_is_treated_as_secret() -> None:
    settings = Settings(
        repository_backend="postgres",
        database_url="postgresql+asyncpg://user:password@localhost/cosmaneura_scribe_test",
        database_ssl=False,
    )
    assert "password" not in repr(settings.database_url)


def test_master_platform_handoff_requires_url_and_default_scope() -> None:
    with pytest.raises(ValidationError, match="master_platform_base_url"):
        Settings(master_platform_handoff_enabled=True)

    with pytest.raises(ValidationError, match="must end with /.default"):
        Settings(
            master_platform_handoff_enabled=True,
            master_platform_base_url="https://platform.internal.example",
            master_platform_scope="api://platform/Scribe.Transcript.Write",
        )


def test_master_platform_handoff_configuration_contains_no_secret() -> None:
    settings = Settings(
        master_platform_handoff_enabled=True,
        master_platform_base_url="https://platform.internal.example",
        master_platform_scope="api://platform/.default",
        managed_identity_client_id=uuid4(),
    )

    assert settings.master_platform_scope == "api://platform/.default"
    assert "secret" not in settings.model_dump()


def test_workflow_authentication_requires_complete_nonsecret_configuration() -> None:
    with pytest.raises(ValidationError, match="workflow_api_audience"):
        Settings(workflow_authentication_enabled=True)

    with pytest.raises(ValidationError, match="v2 API application client ID UUID"):
        Settings(
            workflow_authentication_enabled=True,
            entra_tenant_id=uuid4(),
            workflow_api_audience="api://scribe/.default",
            trusted_platform_client_id=uuid4(),
        )


def test_workflow_authentication_configuration_contains_no_secret() -> None:
    settings = Settings(
        workflow_authentication_enabled=True,
        entra_tenant_id=uuid4(),
        workflow_api_audience=str(uuid4()),
        trusted_platform_client_id=uuid4(),
    )

    assert settings.workflow_authentication_enabled is True
    assert "secret" not in settings.model_dump()


def test_transcription_database_principal_requires_complete_identity() -> None:
    with pytest.raises(ValidationError, match="must be configured together"):
        Settings(database_transcription_principal_name="scribe-transcription")

    shared_object_id = uuid4()
    with pytest.raises(ValidationError, match="must be distinct"):
        Settings(
            database_runtime_principal_name="scribe-runtime",
            database_runtime_principal_object_id=shared_object_id,
            database_transcription_principal_name="scribe-transcription",
            database_transcription_principal_object_id=shared_object_id,
        )

    with pytest.raises(ValidationError, match="must be distinct"):
        Settings(
            database_runtime_principal_name="scribe-runtime",
            database_runtime_principal_object_id=uuid4(),
            database_transcription_principal_name="scribe-runtime",
            database_transcription_principal_object_id=uuid4(),
        )


def test_enabled_transcription_job_requires_closed_production_dependencies(
    tmp_path: Path,
) -> None:
    configuration: dict[str, object] = {
        "managed_identity_client_id": uuid4(),
        "storage_backend": "azure",
        "storage_account_url": "https://scribetest.blob.core.windows.net",
        "audio_encryption_key_id": "https://scribe-test.vault.azure.net/keys/scribe-audio",
        "audio_assembly_encrypted_temp_directory": tmp_path,
        "repository_backend": "postgres",
        "database_url": "postgresql+asyncpg://test:test@localhost/scribe",
        "database_ssl": False,
        "transcription_backend": "azure",
        "azure_speech_endpoint": "https://scribe-test.cognitiveservices.azure.com",
        "transcription_job_enabled": True,
    }
    missing_dependency_cases = (
        ({"repository_backend": "memory"}, "PostgreSQL repository"),
        ({"storage_backend": "memory"}, "Azure storage backend"),
        ({"transcription_backend": "none"}, "Azure transcription backend"),
        ({"azure_speech_endpoint": None}, "azure_speech_endpoint"),
        ({"managed_identity_client_id": None}, "managed_identity_client_id"),
        ({"audio_encryption_key_id": None}, "audio_encryption_key_id"),
        ({"audio_assembly_encrypted_temp_directory": None}, "encrypted_temp_directory"),
    )
    for overrides, expected_error in missing_dependency_cases:
        with pytest.raises(ValidationError, match=expected_error):
            Settings(**(configuration | overrides))

    settings = Settings(**configuration)

    assert settings.transcription_job_enabled is True
    assert settings.transcription_job_language_code == "en-US"


@pytest.mark.parametrize(
    "endpoint",
    (
        "http://scribe-test.cognitiveservices.azure.com",
        "https://example.com",
        "https://user@scribe-test.cognitiveservices.azure.com",
        "https://scribe-test.cognitiveservices.azure.com:8443",
        "https://scribe-test.cognitiveservices.azure.com/path",
        "https://scribe-test.cognitiveservices.azure.com?query=true",
        "https://scribe-test.cognitiveservices.azure.com#fragment",
        "https://nested.scribe-test.cognitiveservices.azure.com",
    ),
)
def test_azure_transcription_rejects_non_exact_speech_origins(endpoint: str) -> None:
    with pytest.raises(ValidationError, match="exact Azure Cognitive Services HTTPS origin"):
        Settings(
            transcription_backend="azure",
            azure_speech_endpoint=endpoint,
        )
