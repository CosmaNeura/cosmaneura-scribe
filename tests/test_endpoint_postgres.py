from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
from collections.abc import AsyncGenerator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.main import app, get_repository_provider
from cosmaneura_scribe.postgres_repository import (
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import Repository
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

CONSENT_REQUEST_PROGRAM = r"""
import json
import os
from uuid import UUID

from cosmaneura_scribe.main import app, get_repository_provider
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings
from fastapi.testclient import TestClient

tenant_id = UUID(os.environ["SCRIBE_TEST_TENANT_ID"])
provider = build_postgres_provider(
    Settings(
        repository_backend="postgres",
        database_url=os.environ["SCRIBE_TEST_APP_DATABASE_URL"],
        database_ssl=False,
        database_pool_size=1,
        database_max_overflow=0,
    )
)
app.dependency_overrides[get_repository_provider] = lambda: provider
app.dependency_overrides[get_verified_tenant_id] = lambda: tenant_id
try:
    with TestClient(app) as client:
        response = client.post(
            "/v1/consents",
            headers={
                "X-Tenant-ID": str(tenant_id),
                "Idempotency-Key": "cross-process-consent-0001",
            },
            json={
                "appointment_id": "appointment-cross-process",
                "practitioner_id": "practitioner-cross-process",
                "patient_id": "patient-cross-process",
                "modality": "virtual",
                "participant_regions": ["FL", "OH"],
                "method": "pre_visit_form",
                "all_parties_consented": True,
                "granted_at": "2026-08-15T12:00:00Z",
            },
        )
        client.portal.call(provider.close)
finally:
    app.dependency_overrides.clear()

print(json.dumps({"status_code": response.status_code, "body": response.json()}, sort_keys=True))
"""


def _request_consent_in_fresh_process(
    *,
    app_url: str,
    tenant_id: str,
    hash_seed: str,
) -> dict[str, Any]:
    root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    source_path = str(root / "services" / "api" / "src")
    existing_pythonpath = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = (
        source_path
        if not existing_pythonpath
        else os.pathsep.join((source_path, existing_pythonpath))
    )
    environment.update(
        {
            "PYTHONHASHSEED": hash_seed,
            "SCRIBE_TEST_APP_DATABASE_URL": app_url,
            "SCRIBE_TEST_TENANT_ID": tenant_id,
        }
    )
    completed = subprocess.run(
        [sys.executable, "-c", CONSENT_REQUEST_PROGRAM],
        cwd=root,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


@pytest.mark.postgres
def test_consent_replay_survives_provider_restart_in_a_new_process(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = str(uuid4())

    first = _request_consent_in_fresh_process(
        app_url=app_url,
        tenant_id=tenant_id,
        hash_seed="1",
    )
    replay = _request_consent_in_fresh_process(
        app_url=app_url,
        tenant_id=tenant_id,
        hash_seed="2",
    )

    assert first["status_code"] == 201
    assert replay["status_code"] == 201
    assert replay["body"]["id"] == first["body"]["id"]


class ConcurrentClaimGate:
    def __init__(self) -> None:
        self._entered = 0
        self._lock = asyncio.Lock()
        self._both_entered = asyncio.Event()

    async def wait(self) -> None:
        async with self._lock:
            self._entered += 1
            if self._entered == 2:
                self._both_entered.set()
        await asyncio.wait_for(self._both_entered.wait(), timeout=5)


class CoordinatedRepository:
    def __init__(self, repository: Repository, gate: ConcurrentClaimGate) -> None:
        self._repository = repository
        self._gate = gate

    def __getattr__(self, name: str) -> Any:
        return getattr(self._repository, name)

    async def claim_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
        request_fingerprint: str,
        entity_id: UUID,
    ) -> UUID | None:
        await self._gate.wait()
        return await self._repository.claim_idempotency(
            tenant_id=tenant_id,
            operation=operation,
            key=key,
            request_fingerprint=request_fingerprint,
            entity_id=entity_id,
        )


class CoordinatedProvider:
    def __init__(
        self,
        provider: PostgresRepositoryProvider,
        gate: ConcurrentClaimGate,
    ) -> None:
        self._provider = provider
        self._gate = gate

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        async with self._provider.transaction(tenant_id) as repository:
            yield CoordinatedRepository(repository, self._gate)  # type: ignore[misc]

    async def health(self) -> None:
        await self._provider.health()

    async def close(self) -> None:
        await self._provider.close()


async def _idempotency_row_count(
    database_url: str,
    *,
    tenant_id: UUID,
    key: str,
) -> int:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.connect() as connection:
            count = await connection.scalar(
                text(
                    "SELECT count(*) FROM idempotency_records "
                    "WHERE tenant_id = :tenant_id "
                    "AND operation = 'consent.create' "
                    "AND idempotency_key = :key"
                ),
                {"tenant_id": tenant_id, "key": key},
            )
            return int(count or 0)
    finally:
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.parametrize("same_body", [True, False], ids=["replay", "conflict"])
def test_concurrent_http_idempotency_claims_are_serialized(
    postgres_urls: tuple[str, str],
    same_body: bool,
) -> None:
    admin_url, app_url = postgres_urls
    tenant_id = uuid4()
    key = f"concurrent-consent-{uuid4()}"
    provider = build_postgres_provider(
        Settings(
            repository_backend="postgres",
            database_url=app_url,
            database_ssl=False,
            database_pool_size=4,
            database_max_overflow=0,
        )
    )
    coordinated = CoordinatedProvider(provider, ConcurrentClaimGate())
    app.dependency_overrides[get_repository_provider] = lambda: coordinated
    app.dependency_overrides[get_verified_tenant_id] = lambda: tenant_id
    first_body = {
        "appointment_id": "appointment-concurrent-a",
        "practitioner_id": "practitioner-concurrent",
        "patient_id": "patient-concurrent",
        "modality": "virtual",
        "participant_regions": ["FL", "OH"],
        "method": "pre_visit_form",
        "all_parties_consented": True,
        "granted_at": "2026-08-15T12:00:00Z",
    }
    second_body = dict(first_body)
    if not same_body:
        second_body["appointment_id"] = "appointment-concurrent-b"
    request_barrier = threading.Barrier(3)

    try:
        with TestClient(app, raise_server_exceptions=False) as client:

            def submit(body: dict[str, object]) -> tuple[int, dict[str, object]]:
                request_barrier.wait(timeout=5)
                response = client.post(
                    "/v1/consents",
                    headers={
                        "X-Tenant-ID": str(tenant_id),
                        "Idempotency-Key": key,
                    },
                    json=body,
                )
                return response.status_code, response.json()

            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(submit, first_body)
                second = executor.submit(submit, second_body)
                request_barrier.wait(timeout=5)
                responses = [first.result(timeout=10), second.result(timeout=10)]
            client.portal.call(coordinated.close)
    finally:
        app.dependency_overrides.clear()

    statuses = sorted(status_code for status_code, _ in responses)
    if same_body:
        assert statuses == [201, 201]
        assert responses[0][1]["id"] == responses[1][1]["id"]
    else:
        assert statuses == [201, 409]
    assert asyncio.run(_idempotency_row_count(admin_url, tenant_id=tenant_id, key=key)) == 1
