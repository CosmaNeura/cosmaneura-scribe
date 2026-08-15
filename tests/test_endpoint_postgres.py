from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

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
