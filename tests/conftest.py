from __future__ import annotations

from typing import Annotated
from uuid import UUID

import pytest
from cosmaneura_scribe.main import app, get_repository, get_repository_provider
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from fastapi import Header
from fastapi.testclient import TestClient


def verified_test_tenant(
    tenant_id: Annotated[UUID, Header(alias="X-Tenant-ID")],
) -> UUID:
    return tenant_id


@pytest.fixture
def repository() -> InMemoryRepository:
    return InMemoryRepository()


@pytest.fixture
def client(repository: InMemoryRepository) -> TestClient:
    app.dependency_overrides[get_repository] = lambda: repository
    app.dependency_overrides[get_repository_provider] = lambda: repository
    app.dependency_overrides[get_verified_tenant_id] = verified_test_tenant
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
