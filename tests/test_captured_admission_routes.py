"""Configured receiver admission: real local storage, synthetic identity."""

import asyncio
import json
import os
from dataclasses import asdict
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from cosmaneura_scribe.captured_admission_routes import CapturedAdmissionRuntime
from cosmaneura_scribe.captured_source_runtime import (
    CapturedSourceRepositoryProvider,
    CapturedSourceRuntime,
)
from cosmaneura_scribe.main import app
from cosmaneura_scribe.normalized_source_persistence import CapturedSessionCreate
from cosmaneura_scribe.service_auth import (
    EntraWorkflowAuthenticator,
    get_verified_tenant_id,
    get_workflow_authenticator,
)
from cosmaneura_scribe.settings import get_settings
from sqlalchemy.ext.asyncio import create_async_engine
from test_captured_source_runtime import Trial, _remove_owned_fixture_rows
from test_captured_transcription_worker import capture as capture
from test_normalized_source_persistence import _consent, _draft

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def trial(postgres_urls):
    tenant, consent = uuid4(), _consent()
    if wire := os.getenv("SCRIBE_CONFIGURED_WIRE_SCOPE"):
        path = Path(wire)
        assert str(path).startswith("/private/tmp/scribe-configured-core.")
        tenant = UUID(json.loads(await asyncio.to_thread(path.read_text))["tenant_id"])
    draft = CapturedSessionCreate(**asdict(_draft(consent)))
    provider = CapturedSourceRepositoryProvider(
        create_async_engine(postgres_urls[1], connect_args={"ssl": False})
    )
    try:
        if not wire:
            async with provider.transaction(tenant) as store:
                await store.add_consent(tenant, consent)
        yield Trial(
            provider,
            CapturedSourceRuntime(provider, enabled=True),
            tenant,
            consent,
            draft,
            postgres_urls[0],
        )
    finally:
        await provider.close()
        await _remove_owned_fixture_rows(postgres_urls[0], tenant)


@pytest_asyncio.fixture
async def admission(capture):
    trial = capture.trial
    runtime = CapturedAdmissionRuntime(
        trial.provider, tenant_ids=frozenset({trial.tenant}), enabled=True
    )
    app.state.captured_admission_runtime = runtime
    try:
        yield capture, runtime
    finally:
        del app.state.captured_admission_runtime


def body(trial):
    return dict(
        schema_version="1.0",
        id=str(trial.draft.id),
        appointment_id=trial.draft.appointment_id,
        practitioner_id=trial.draft.practitioner_id,
        patient_id=trial.draft.patient_id,
        consent_record_id=str(trial.consent.id),
        modality=trial.draft.modality.value,
        language_mode=trial.draft.language_mode.value,
    )


def headers(trial):
    return {
        "X-Scribe-Creator-Actor-ID": trial.draft.creator_actor_id,
        "Idempotency-Key": "configured-admission-one",
    }


async def test_concurrent_admission_and_fresh_runtime_exact_replay(admission):
    capture, _ = admission
    trial = capture.trial

    async def post():
        return await capture.client.post(
            "/v1/captured-sessions", json=body(trial), headers=headers(trial)
        )

    results = await asyncio.gather(post(), post())
    assert [r.status_code for r in results] == [201, 201]
    assert results[0].json() == results[1].json()
    assert results[0].headers["cache-control"] == "no-store"
    app.state.captured_admission_runtime = CapturedAdmissionRuntime(
        trial.provider, tenant_ids=frozenset({trial.tenant}), enabled=True
    )
    assert (await post()).json() == results[0].json()
    assert capture.speech.calls == 0


async def test_changes_and_revoked_consent_cannot_replay(admission):
    capture, _ = admission
    trial = capture.trial

    async def post(payload=None, extra=None):
        return await capture.client.post(
            "/v1/captured-sessions",
            json=payload or body(trial),
            headers={**headers(trial), **(extra or {})},
        )

    assert (await post()).status_code == 201
    assert (await post({**body(trial), "language_mode": "en-US"})).status_code == 409
    assert (await post(extra={"X-Scribe-Creator-Actor-ID": "different"})).status_code == 409
    assert (await post(extra={"X-Tenant-ID": str(uuid4())})).status_code == 404
    assert (
        await post({**body(trial), "patient_id": "different"}, {"Idempotency-Key": "different-key"})
    ).status_code == 404
    async with trial.provider.transaction(trial.tenant) as store:
        await store.revoke_consent(trial.tenant, trial.consent.id)
    assert (await post()).status_code == 404
    assert capture.speech.calls == 0


async def test_closed_body_default_off_and_existing_workload_auth(admission):
    capture, runtime = admission
    trial = capture.trial

    async def post(payload=None, trusted=None):
        return await capture.client.post(
            "/v1/captured-sessions",
            json=payload or body(trial),
            headers=headers(trial) if trusted is None else trusted,
        )

    assert (await post({**body(trial), "creator_actor_id": "untrusted"})).status_code == 422
    assert (await post(trusted={})).status_code == 422
    assert (await post({**body(trial), "language_mode": "auto"})).status_code == 422
    runtime.enabled = False
    assert (await post()).status_code == 404
    runtime.enabled = True
    override = app.dependency_overrides.pop(get_verified_tenant_id)
    settings = app.dependency_overrides[get_settings]()
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings, decoder=lambda _: {}
    )
    try:
        assert (await post()).status_code == 401
    finally:
        app.dependency_overrides[get_verified_tenant_id] = override
        del app.dependency_overrides[get_workflow_authenticator]
    assert capture.speech.calls == 0
