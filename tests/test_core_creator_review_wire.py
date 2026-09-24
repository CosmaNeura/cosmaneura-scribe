"""Opt-in local HTTP receiver for the approved Core consumer rehearsal.

Launched by Core's test with matching synthetic admission metadata. Speech,
translation, workload tokens and native audio are fixtures; no live services.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
from dataclasses import asdict, replace
from pathlib import Path
from uuid import UUID

import pytest
import pytest_asyncio
import uvicorn
from cosmaneura_scribe.captured_source_runtime import (
    CapturedSourceRepositoryProvider,
    CapturedSourceRuntime,
)
from cosmaneura_scribe.creator_review_routes import CreatorReviewRuntime
from cosmaneura_scribe.main import app
from cosmaneura_scribe.normalized_source_persistence import CapturedSessionCreate
from cosmaneura_scribe.schemas import ConsentRecord
from sqlalchemy.ext.asyncio import create_async_engine
from test_captured_processing import Flow
from test_captured_processing import flow as flow
from test_captured_source_runtime import Trial, _remove_owned_fixture_rows
from test_captured_transcription_worker import capture as capture
from test_normalized_source_persistence import _consent, _draft

pytestmark = [
    pytest.mark.postgres,
    pytest.mark.asyncio,
    pytest.mark.skipif(
        not os.getenv("SCRIBE_CORE_WIRE_SCOPE"), reason="explicit Core wire fixture required"
    ),
]


@pytest_asyncio.fixture
async def trial(postgres_urls: tuple[str, str]):
    path = Path(os.environ["SCRIBE_CORE_WIRE_SCOPE"])
    assert str(path).startswith("/private/tmp/scribe-core-review.")
    scope = json.loads(await asyncio.to_thread(path.read_text))
    tenant = UUID(scope["tenant_id"])
    request = scope["session_request"]
    consent = ConsentRecord.model_validate({**_consent().model_dump(),
        "id": UUID(request["consent_record_id"]),
        "appointment_id": request["appointment_id"],
        "practitioner_id": request["practitioner_id"],
        "patient_id": request["patient_id"],
        "modality": request["modality"],
    })
    draft = replace(CapturedSessionCreate(**asdict(_draft(consent))),
                    id=UUID(scope["session_id"]), creator_actor_id=scope["creator_actor_id"])
    provider = CapturedSourceRepositoryProvider(
        create_async_engine(postgres_urls[1], connect_args={"ssl": False})
    )
    runtime = CapturedSourceRuntime(provider, enabled=True)
    try:
        async with provider.transaction(tenant) as repository:
            await repository.add_consent(tenant, consent)
        await runtime.admit(tenant_id=tenant, draft=draft)
        yield Trial(provider, runtime, tenant, consent, draft, postgres_urls[0])
    finally:
        await provider.close()
        await _remove_owned_fixture_rows(postgres_urls[0], tenant)


async def test_local_core_review_receiver(flow: Flow):
    path = Path(os.environ["SCRIBE_CORE_WIRE_SCOPE"])
    await flow.capture.record()
    await flow.runtime.process(**flow.scope)

    def fresh_runtime():
        return CreatorReviewRuntime(flow.capture.trial.provider,
            tenant_ids=frozenset({flow.capture.trial.tenant}), enabled=True)

    app.state.creator_review_runtime = fresh_runtime()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.01)
        assert server.started
        path.with_suffix(".ready").write_text(str(listener.getsockname()[1]))
        for _ in range(1200):
            if (path.with_suffix(".restart").exists()
                    and not path.with_suffix(".restarted").exists()):
                app.state.creator_review_runtime = fresh_runtime()
                path.with_suffix(".restarted").write_text("rebound")
            if path.with_suffix(".revoke").exists() and not path.with_suffix(".revoked").exists():
                trial = flow.capture.trial
                async with trial.provider.transaction(trial.tenant) as store:
                    await store.revoke_consent(trial.tenant, trial.consent.id)
                path.with_suffix(".revoked").write_text("revoked")
            if path.with_suffix(".done").exists():
                break
            await asyncio.sleep(0.1)
        else:
            pytest.fail("Core wire fixture timed out")
        assert await flow.counts() == (1, 1, 1)
        assert flow.capture.speech.calls == 1 and len(flow.translator.calls) == 1
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, timeout=5)
        listener.close()
        del app.state.creator_review_runtime
