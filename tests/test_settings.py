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
