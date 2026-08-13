from __future__ import annotations

import pytest
from cosmaneura_scribe.main import app, get_repository
from cosmaneura_scribe.repository import InMemoryRepository
from fastapi.testclient import TestClient


@pytest.fixture
def repository() -> InMemoryRepository:
    return InMemoryRepository()


@pytest.fixture
def client(repository: InMemoryRepository) -> TestClient:
    app.dependency_overrides[get_repository] = lambda: repository
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
