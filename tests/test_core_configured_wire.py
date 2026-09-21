"""Opt-in local Scribe server for Core's configured admission/SOAP rehearsal."""

import asyncio
import json
import os
import socket
from pathlib import Path

import pytest
import uvicorn
from cosmaneura_scribe.captured_admission_routes import (
    CapturedAdmissionRequestV1,
    CapturedAdmissionRuntime,
)
from cosmaneura_scribe.creator_review_routes import CreatorReviewRuntime
from cosmaneura_scribe.main import app
from test_captured_admission_routes import trial as trial
from test_captured_processing import flow as flow
from test_captured_transcription_worker import capture as capture

pytestmark = [
    pytest.mark.postgres,
    pytest.mark.asyncio,
    pytest.mark.skipif(
        not os.getenv("SCRIBE_CONFIGURED_WIRE_SCOPE"), reason="explicit Core fixture required"
    ),
]


async def test_local_configured_receiver(flow):
    path = Path(os.environ["SCRIBE_CONFIGURED_WIRE_SCOPE"])
    trial = flow.capture.trial

    def bind():
        scope = dict(tenant_ids=frozenset({trial.tenant}), enabled=True)
        app.state.captured_admission_runtime = CapturedAdmissionRuntime(trial.provider, **scope)
        app.state.creator_review_runtime = CreatorReviewRuntime(trial.provider, **scope)

    bind()
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
            if (
                path.with_suffix(".restart").exists()
                and not path.with_suffix(".restarted").exists()
            ):
                bind()
                path.with_suffix(".restarted").touch()
            if path.with_suffix(".capture").exists() and not path.with_suffix(".captured").exists():
                data = json.loads(path.with_suffix(".capture").read_text())
                request = CapturedAdmissionRequestV1.model_validate(data["session_request"])
                trial.draft = request.draft(data["creator_actor_id"])
                async with trial.provider.transaction(trial.tenant) as store:
                    trial.consent = await store.get_consent(trial.tenant, request.consent_record_id)
                assert trial.consent is not None
                await flow.capture.record()
                await flow.runtime.process(**flow.scope)
                path.with_suffix(".captured").touch()
            if path.with_suffix(".revoke").exists() and not path.with_suffix(".revoked").exists():
                async with trial.provider.transaction(trial.tenant) as store:
                    await store.revoke_consent(trial.tenant, trial.consent.id)
                path.with_suffix(".revoked").touch()
            if path.with_suffix(".done").exists():
                break
            await asyncio.sleep(0.1)
        else:
            pytest.fail("Core configured fixture timed out")
        assert await flow.counts() == (1, 1, 1)
        assert flow.capture.speech.calls == 1 and len(flow.translator.calls) == 1
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, timeout=5)
        listener.close()
        del app.state.captured_admission_runtime
        del app.state.creator_review_runtime
