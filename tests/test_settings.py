from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.captured_worker_settings import CapturedWorkerSettings
from cosmaneura_scribe.settings import Settings
from pydantic import ValidationError
from test_captured_worker_job_runner import _settings as _captured_worker_settings


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


def test_capture_protocol_is_false_by_default() -> None:
    settings = Settings()

    assert settings.capture_protocol_enabled is False

    with pytest.raises(ValidationError, match="requires workflow authentication and PostgreSQL"):
        Settings(capture_protocol_enabled=True)


def test_external_ingest_admission_is_false_by_default_and_dependency_closed() -> None:
    tenant_id = uuid4()
    defaults = Settings()
    assert defaults.external_ingest_admission_enabled is False
    assert defaults.external_ingest_beta_tenant_ids == frozenset()

    enabled: dict[str, object] = {
        "external_ingest_admission_enabled": True,
        "external_ingest_beta_tenant_ids": frozenset({tenant_id}),
        "workflow_authentication_enabled": True,
        "entra_tenant_id": uuid4(),
        "workflow_api_audience": str(uuid4()),
        "trusted_platform_client_id": uuid4(),
        "repository_backend": "postgres",
        "database_url": "postgresql+asyncpg://test:test@localhost/scribe",
        "database_ssl": False,
    }
    assert Settings(**enabled).external_ingest_beta_tenant_ids == frozenset({tenant_id})

    for overrides in (
        {"workflow_authentication_enabled": False},
        {"repository_backend": "memory"},
        {"external_ingest_beta_tenant_ids": frozenset()},
    ):
        with pytest.raises(
            ValidationError,
            match="requires workflow authentication, PostgreSQL, and exactly one",
        ):
            Settings(**(enabled | overrides))

    with pytest.raises(ValidationError, match="tenant IDs must be nonzero"):
        Settings(
            external_ingest_beta_tenant_ids=frozenset({UUID(int=0)}),
        )
    with pytest.raises(ValidationError):
        Settings(
            external_ingest_beta_tenant_ids=frozenset({uuid4(), uuid4()}),
        )


def test_external_ingest_beta_tenant_parses_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = uuid4()
    monkeypatch.setenv(
        "COSMANEURA_SCRIBE_EXTERNAL_INGEST_BETA_TENANT_IDS",
        f'["{tenant_id}"]',
    )

    settings = Settings(_env_file=None)

    assert settings.external_ingest_admission_enabled is False
    assert settings.external_ingest_beta_tenant_ids == frozenset({tenant_id})


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


def test_delivery_reconciler_database_principal_is_complete_and_distinct() -> None:
    with pytest.raises(ValidationError, match="must be configured together"):
        Settings(database_delivery_reconciler_principal_name="scribe-delivery-reconciler")

    shared_object_id = uuid4()
    with pytest.raises(ValidationError, match="must be distinct"):
        Settings(
            database_runtime_principal_name="scribe-runtime",
            database_runtime_principal_object_id=shared_object_id,
            database_delivery_reconciler_principal_name="scribe-delivery-reconciler",
            database_delivery_reconciler_principal_object_id=shared_object_id,
        )


def test_derived_writer_database_permissions_are_false_default_and_dependency_closed() -> None:
    defaults = Settings()
    assert defaults.derived_writer_database_permissions_enabled is False

    runtime_object_id = uuid4()
    translation_object_id = uuid4()
    enabled: dict[str, object] = {
        "derived_writer_database_permissions_enabled": True,
        "repository_backend": "postgres",
        "database_url": "postgresql+asyncpg://test:test@localhost/scribe",
        "database_ssl": False,
        "database_runtime_principal_name": "scribe-runtime",
        "database_runtime_principal_object_id": runtime_object_id,
        "database_translation_principal_name": "scribe-translation",
        "database_translation_principal_object_id": translation_object_id,
    }
    assert Settings(**enabled).derived_writer_database_permissions_enabled is True

    for overrides, expected_error in (
        ({"repository_backend": "memory"}, "PostgreSQL"),
        ({"database_runtime_principal_name": None}, "runtime"),
        ({"database_runtime_principal_object_id": None}, "runtime"),
        ({"database_translation_principal_name": None}, "translation"),
        ({"database_translation_principal_object_id": None}, "translation"),
    ):
        with pytest.raises(ValidationError, match=expected_error):
            Settings(**(enabled | overrides))


def test_all_database_principal_names_and_object_ids_are_pairwise_distinct() -> None:
    configured: dict[str, object] = {
        "database_runtime_principal_name": "scribe-runtime",
        "database_runtime_principal_object_id": uuid4(),
        "database_transcription_principal_name": "scribe-transcription",
        "database_transcription_principal_object_id": uuid4(),
        "database_translation_principal_name": "scribe-translation",
        "database_translation_principal_object_id": uuid4(),
        "database_delivery_reconciler_principal_name": "scribe-delivery-reconciler",
        "database_delivery_reconciler_principal_object_id": uuid4(),
    }
    Settings(**configured)

    principals = (
        ("database_runtime_principal_name", "database_runtime_principal_object_id"),
        ("database_transcription_principal_name", "database_transcription_principal_object_id"),
        ("database_translation_principal_name", "database_translation_principal_object_id"),
        (
            "database_delivery_reconciler_principal_name",
            "database_delivery_reconciler_principal_object_id",
        ),
    )
    for first_index, (first_name, first_object_id) in enumerate(principals):
        for second_name, second_object_id in principals[first_index + 1 :]:
            with pytest.raises(ValidationError, match="distinct"):
                Settings(**(configured | {second_name: configured[first_name]}))
            with pytest.raises(ValidationError, match="distinct"):
                Settings(**(configured | {second_object_id: configured[first_object_id]}))


def test_enabled_delivery_reconciler_job_requires_closed_dependencies() -> None:
    configuration: dict[str, object] = {
        "managed_identity_client_id": uuid4(),
        "repository_backend": "postgres",
        "database_url": "postgresql+asyncpg://test:test@localhost/scribe",
        "database_ssl": False,
        "master_platform_handoff_enabled": True,
        "master_platform_base_url": "https://platform.internal.example",
        "master_platform_scope": "api://platform/.default",
        "delivery_reconciler_job_enabled": True,
    }
    for overrides, expected_error in (
        ({"repository_backend": "memory"}, "PostgreSQL repository"),
        ({"master_platform_handoff_enabled": False}, "master platform handoff"),
        ({"managed_identity_client_id": None}, "managed_identity_client_id"),
    ):
        with pytest.raises(ValidationError, match=expected_error):
            Settings(**(configuration | overrides))

    assert Settings(**configuration).delivery_reconciler_job_enabled is True


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
        "azure_speech_private_endpoint_cidrs": ("10.42.1.7/32",),
        "transcription_job_enabled": True,
    }
    missing_dependency_cases = (
        ({"repository_backend": "memory"}, "PostgreSQL repository"),
        ({"storage_backend": "memory"}, "Azure storage backend"),
        ({"transcription_backend": "none"}, "Azure transcription backend"),
        ({"azure_speech_endpoint": None}, "azure_speech_endpoint"),
        ({"azure_speech_private_endpoint_cidrs": ()}, "private_endpoint_cidrs"),
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
            azure_speech_private_endpoint_cidrs=("10.42.1.7/32",),
        )


def test_enabled_speech_smoke_requires_private_azure_and_managed_identity() -> None:
    configuration: dict[str, object] = {
        "managed_identity_client_id": uuid4(),
        "transcription_backend": "azure",
        "azure_speech_endpoint": "https://scribe-test.cognitiveservices.azure.com",
        "azure_speech_private_endpoint_cidrs": ("10.42.1.7/32",),
        "speech_smoke_enabled": True,
    }
    with pytest.raises(ValidationError, match="Azure transcription backend"):
        Settings(**(configuration | {"transcription_backend": "none"}))
    with pytest.raises(ValidationError, match="managed_identity_client_id"):
        Settings(**(configuration | {"managed_identity_client_id": None}))

    assert Settings(**configuration).speech_smoke_enabled is True


def test_private_speech_cidrs_parse_from_container_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "COSMANEURA_SCRIBE_AZURE_SPEECH_PRIVATE_ENDPOINT_CIDRS",
        '["10.42.1.7/32"]',
    )

    settings = Settings(
        _env_file=None,
        transcription_backend="azure",
        azure_speech_endpoint="https://scribe-test.cognitiveservices.azure.com",
    )

    assert str(settings.azure_speech_private_endpoint_cidrs[0]) == "10.42.1.7/32"


def test_worker_capacity_matches_protocol_ceiling() -> None:
    assert Settings().audio_assembly_max_plaintext_bytes == 402_653_184
    with pytest.raises(ValidationError):
        Settings(audio_assembly_max_plaintext_bytes=402_653_185)


@pytest.mark.parametrize("stage", ["speech", "translation"])
def test_worker_settings_are_false_default_and_stage_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stage: str
) -> None:
    for name in list(os.environ):
        if name.startswith("COSMANEURA_SCRIBE_"):
            monkeypatch.delenv(name)
    defaults = CapturedWorkerSettings()
    assert defaults.captured_worker_enabled is False
    assert defaults.captured_worker_stage is None

    settings = _captured_worker_settings(tmp_path, stage=stage)
    assert settings.captured_worker_stage == stage

    invalid = settings.model_dump()
    invalid["database_user"] = "wrong-principal"
    with pytest.raises(ValueError, match="captured_worker_bindings_invalid"):
        CapturedWorkerSettings(**invalid)
