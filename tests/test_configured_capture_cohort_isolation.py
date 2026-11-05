"""Two synthetic admitted practices remain isolated under real PostgreSQL RLS."""

from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from cosmaneura_scribe.captured_admission_routes import (
    CapturedAdmissionRequestV1,
    CapturedAdmissionRuntime,
)
from cosmaneura_scribe.captured_source_runtime import CapturedSourceRepositoryProvider
from cosmaneura_scribe.repository import CaptureIngestModeError
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from test_captured_source_runtime import _remove_owned_fixture_rows
from test_normalized_source_persistence import _consent, _draft

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


@asynccontextmanager
async def _practices(postgres_urls):
    provider = CapturedSourceRepositoryProvider(
        create_async_engine(postgres_urls[1], connect_args={"ssl": False})
    )
    tenants = (uuid4(), uuid4())
    requests = []
    try:
        for tenant in tenants:
            consent = _consent()
            async with provider.transaction(tenant) as store:
                await store.add_consent(tenant, consent)
            payload = asdict(_draft(consent))
            del payload["creator_actor_id"]
            requests.append(CapturedAdmissionRequestV1(schema_version="1.0", **payload))
        yield provider, tenants, requests
    finally:
        await provider.close()
        for tenant in tenants:
            await _remove_owned_fixture_rows(postgres_urls[0], tenant)


async def test_two_practices_admit_but_foreign_consent_and_request_context_refuse(postgres_urls):
    async with _practices(postgres_urls) as (provider, tenants, requests):
        runtime = CapturedAdmissionRuntime(provider, tenant_ids=frozenset(tenants), enabled=True)
        for tenant, request in zip(tenants, requests, strict=True):
            receipt = await runtime.admit(tenant, "synthetic_core_actor", "same-key", request)
            assert receipt.id == request.id
        for tenant, request in ((uuid4(), requests[0]), (tenants[0], requests[1])):
            with pytest.raises(HTTPException) as error:
                await runtime.admit(tenant, "synthetic_core_actor", "foreign-key", request)
            assert error.value.status_code == 404
        async with provider.transaction(tenants[0]) as store:
            assert await store.get_session(tenants[1], requests[1].id) is None
        async with provider.transaction(tenants[1]) as store:
            assert await store.get_session(tenants[0], requests[0].id) is None


async def test_claim_cannot_cross_admitted_practice_transaction(postgres_urls):
    async with _practices(postgres_urls) as (provider, tenants, requests):
        runtime = CapturedAdmissionRuntime(provider, tenant_ids=frozenset(tenants), enabled=True)
        for tenant, request in zip(tenants, requests, strict=True):
            await runtime.admit(tenant, "synthetic_core_actor", "cohort-admit", request)
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant, true)"),
                    {"tenant": str(tenant)},
                )
                for status in ("capturing", "uploaded"):
                    await connection.execute(
                        text(
                            "UPDATE scribe_sessions SET status=:status "
                            "WHERE tenant_id=:tenant AND id=:id"
                        ),
                        {"status": status, "tenant": tenant, "id": request.id},
                    )
        now = datetime.now(UTC)
        claim = dict(
            job_id=uuid4(),
            lease_token=uuid4(),
            now=now,
            lease_until=now + timedelta(minutes=5),
            max_attempts=3,
        )
        async with provider.transaction(tenants[0]) as store:
            with pytest.raises(CaptureIngestModeError):
                await store.claim_transcription_job(tenants[1], requests[1].id, **claim)
        async with provider.transaction(tenants[1]) as store:
            job = await store.claim_transcription_job(tenants[1], requests[1].id, **claim)
            assert job is not None and job.session_id == requests[1].id
        async with provider.transaction(tenants[0]) as store:
            assert await store.transcription_job_for(tenants[1], requests[1].id) is None
