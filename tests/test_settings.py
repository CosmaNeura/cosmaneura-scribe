from __future__ import annotations

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
