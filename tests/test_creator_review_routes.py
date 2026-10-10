from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
import pytest_asyncio
from cosmaneura_scribe import creator_review_routes
from cosmaneura_scribe.captured_processing import CapturedProcessingUnavailable
from cosmaneura_scribe.captured_source_runtime import CapturedSourceRepository
from cosmaneura_scribe.creator_review_routes import CreatorReviewRuntime
from cosmaneura_scribe.main import app
from cosmaneura_scribe.service_auth import (
    EntraWorkflowAuthenticator,
    get_verified_tenant_id,
    get_workflow_authenticator,
)
from cosmaneura_scribe.settings import get_settings
from cosmaneura_scribe.transcription_worker import TranscriptionWorkerError
from test_captured_processing import Flow
from test_captured_processing import flow as flow
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


@pytest.mark.parametrize(
    ("publication", "stored_code", "expected"),
    [
        (False, None, "CapturedSpeechProcessingFailed"),
        (True, None, "CapturedSpeechPublicationFailed"),
        (False, "private detail must never be logged", "CapturedSpeechFailureUnclassified"),
    ],
)
async def test_failure_observation_preserves_wire_and_creator_scope(
    review, monkeypatch, publication, stored_code, expected
):
    flow, _ = review
    await flow.capture.record()
    worker = flow.capture.worker()
    if publication:

        async def fail_publication(**_kwargs):
            raise RuntimeError("private publication detail must never be logged")

        monkeypatch.setattr(worker._runtime, "publish_speech_result", fail_publication)
    else:
        flow.capture.speech.fail = True
    for _ in range(3):
        with pytest.raises(TranscriptionWorkerError):
            await worker.process(**flow.scope)
    if stored_code:
        original = CapturedSourceRepository.transcription_job_for

        async def changed_code(self, tenant_id, session_id):
            job = await original(self, tenant_id, session_id)
            assert job is not None
            return job.model_copy(update={"last_error_code": stored_code})

        monkeypatch.setattr(CapturedSourceRepository, "transcription_job_for", changed_code)
    events = []
    monkeypatch.setattr(creator_review_routes, "log_event", lambda **event: events.append(event))
    client, path = flow.capture.client, _path(flow)
    denied = await client.get(path, headers={"X-Scribe-Creator-Actor-ID": "another-creator"})
    assert denied.status_code == 404 and events == []
    response = await client.get(path, headers=_headers(flow))
    assert response.status_code == 200
    assert response.json()["status"] == "speech_failed" and response.json()["source"] is None
    assert "last_error_code" not in response.json()
    assert events == [
        {
            "action": "captured_review.speech_failure_observed",
            "tenant_id": flow.capture.trial.tenant,
            "entity_id": flow.capture.trial.draft.id,
            "error_class": expected,
        }
    ]
    async with flow.capture.trial.provider.transaction(flow.capture.trial.tenant) as store:
        await store.revoke_consent(flow.capture.trial.tenant, flow.capture.trial.consent.id)
    assert (await client.get(path, headers=_headers(flow))).status_code == 404
    assert len(events) == 1


@pytest_asyncio.fixture
async def review(flow: Flow):
    runtime = CreatorReviewRuntime(
        flow.capture.trial.provider, tenant_ids=frozenset({flow.capture.trial.tenant}), enabled=True
    )
    app.state.creator_review_runtime = runtime
    try:
        yield flow, runtime
    finally:
        del app.state.creator_review_runtime


def _path(flow: Flow) -> str:
    return f"/v1/captured-sessions/{flow.capture.trial.draft.id}/review"


def _headers(flow: Flow, **extra: str) -> dict[str, str]:
    return {"X-Scribe-Creator-Actor-ID": flow.capture.trial.draft.creator_actor_id, **extra}


def _decision(view: dict, *, decision: str = "accepted") -> dict:
    queue = view["review_queue"]
    item = queue["items"][0]
    return {
        "schema_version": "1.0",
        "expected_source_transcript_version": queue["source_transcript_version"],
        "source_segment_id": item["source_segment_id"],
        "expected_source_segment_version": item["source_segment_version"],
        "translation_id": item["translation_id"],
        "expected_translation_version": item["translation_version"],
        "decision": decision,
    }


async def test_capture_progress_translation_review_and_exact_retry(review):
    flow, _ = review
    client, path, headers = flow.capture.client, _path(flow), _headers(flow)
    before = await client.get(path, headers=headers)
    assert before.status_code == 200 and before.json()["status"] == "created"
    assert before.json()["source"] is None
    await flow.capture.record()
    uploaded = await client.get(path, headers=headers)
    assert uploaded.json()["status"] == "uploaded"
    await flow.runtime.process(**flow.scope)
    response = await client.get(path, headers=headers)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    view = response.json()
    assert view["status"] == "review_required" and not view["working"]["note_ready"]
    source = view["source"]
    body, headers = _decision(view), {**headers, "Idempotency-Key": "review-decision-one"}
    results = await asyncio.gather(
        *(client.post(path, json=body, headers=headers) for _ in range(2))
    )
    assert [result.status_code for result in results] == [200, 200]
    assert results[0].json() == results[1].json()
    assert await flow.counts() == (1, 1, 1)
    # New receiver instance resolves the durable receipt after a lost response.
    app.state.creator_review_runtime = CreatorReviewRuntime(
        flow.capture.trial.provider, tenant_ids=frozenset({flow.capture.trial.tenant}), enabled=True
    )
    replay = await client.post(path, json=body, headers=headers)
    assert replay.json() == results[0].json()
    current = (await client.get(path, headers=headers)).json()
    assert current["working"]["note_ready"] and current["source"] == source
    assert current["review_queue"]["items"] == []
    conflict = await client.post(path, json={**body, "decision": "rejected"}, headers=headers)
    assert conflict.status_code == 409
    assert await flow.counts() == (1, 1, 1)
    assert flow.capture.speech.calls == 1 and len(flow.translator.calls) == 1


async def test_creator_cohort_and_real_auth_dependency_are_required(review):
    flow, runtime = review
    client, path = flow.capture.client, _path(flow)
    assert (
        await client.get(path, headers=_headers(flow, **{"X-Scribe-Creator-Actor-ID": "other"}))
    ).status_code == 404
    assert (await client.get(path)).status_code == 422
    runtime.enabled = False
    assert (await client.get(path, headers=_headers(flow))).status_code == 404
    runtime.enabled = True
    runtime.tenant_ids = frozenset({uuid4()})
    assert (await client.get(path, headers=_headers(flow))).status_code == 404
    runtime.tenant_ids = frozenset({flow.capture.trial.tenant})
    override = app.dependency_overrides.pop(get_verified_tenant_id)
    settings = app.dependency_overrides[get_settings]()
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings, decoder=lambda _token: {}
    )
    try:
        # No workload token: an arbitrary browser actor header cannot grant access.
        assert (await client.get(path, headers=_headers(flow))).status_code == 401
    finally:
        app.dependency_overrides[get_verified_tenant_id] = override
        del app.dependency_overrides[get_workflow_authenticator]


async def test_rejection_and_revoked_consent_do_not_publish_or_replay(review):
    flow, _ = review
    client, path, headers = flow.capture.client, _path(flow), _headers(flow)
    await flow.capture.record()
    await flow.runtime.process(**flow.scope)
    view = (await client.get(path, headers=headers)).json()
    body = _decision(view, decision="rejected")
    headers["Idempotency-Key"] = "review-rejected-one"
    result = await client.post(path, json=body, headers=headers)
    assert result.status_code == 200
    current = (await client.get(path, headers=headers)).json()
    assert not current["working"]["note_ready"]
    assert current["status"] == "translation_pending"
    async with flow.capture.trial.provider.transaction(flow.capture.trial.tenant) as store:
        await store.revoke_consent(flow.capture.trial.tenant, flow.capture.trial.consent.id)
    assert (await client.get(path, headers=headers)).status_code == 404
    assert (await client.post(path, json=body, headers=headers)).status_code == 404


async def test_review_body_cannot_supply_creator_or_omit_retry_identity(review):
    flow, _ = review
    client, path, headers = flow.capture.client, _path(flow), _headers(flow)
    await flow.capture.record()
    await flow.runtime.process(**flow.scope)
    body = _decision((await client.get(path, headers=headers)).json())
    assert (await client.post(path, json=body, headers=headers)).status_code == 422
    headers["Idempotency-Key"] = "review-invalid-one"
    result = await client.post(
        path, json={**body, "creator_actor_id": "arbitrary"}, headers=headers
    )
    assert result.status_code == 422 and "arbitrary" not in result.text
    result = await client.post(
        path, json={**body, "expected_translation_version": True}, headers=headers
    )
    assert result.status_code == 422
    assert await flow.counts() == (1, 1, 0)


async def test_read_only_progress_tracks_current_jobs_without_replaying_calls(review, monkeypatch):
    flow, _ = review
    client, path, headers = flow.capture.client, _path(flow), _headers(flow)
    await flow.capture.record()
    await flow.capture.process()
    await flow.runtime._jobs.prepare_dispatch(**flow.scope)

    async def progress():
        response = await client.get(path, headers=headers)
        assert response.status_code == 200
        view = response.json()
        spanish = next(row for row in view["source"]["segments"] if row["source_locale"] == "es-US")
        for item in view["translation_progress"]:
            assert item["source_segment_id"] == spanish["source_segment_id"]
            assert item["source_segment_version"] == spanish["source_segment_version"]
            assert set(item) == {"source_segment_id", "source_segment_version", "state"}
        return [item["state"] for item in view["translation_progress"]]

    assert await progress() == ["queued"]
    assert flow.translator.calls == [] and await flow.counts() == (1, 0, 0)
    flow.translator.block = True
    saved, publish = asyncio.Event(), asyncio.Event()
    original = flow.runtime._committer.commit_completed_translation_job

    class PausedCommitter:
        async def commit_completed_translation_job(self, job):
            saved.set()
            await publish.wait()
            return await original(job)

    async def lose_marker(*args, **kwargs):
        raise OSError("synthetic marker unavailable")

    monkeypatch.setattr(flow.runtime, "_committer", PausedCommitter())
    monkeypatch.setattr(flow.runtime._jobs, "mark_attempt_committed", lose_marker)
    task = asyncio.create_task(flow.runtime.process(**flow.scope))
    try:
        await asyncio.wait_for(flow.translator.started.wait(), timeout=5)
        assert await progress() == ["unconfirmed"]
        assert await progress() == ["unconfirmed"]
        assert len(flow.translator.calls) == 1
        flow.translator.release.set()
        await asyncio.wait_for(saved.wait(), timeout=5)
        assert await progress() == ["result_saved"]
        publish.set()
        with pytest.raises(CapturedProcessingUnavailable):
            await asyncio.wait_for(task, timeout=5)
        # The published attempt is authoritative even when its job marker lags.
        assert await progress() == []
        assert len(flow.translator.calls) == 1 and await flow.counts() == (1, 1, 0)
        assert (
            await client.get(path, headers=_headers(flow, **{"X-Scribe-Creator-Actor-ID": "other"}))
        ).status_code == 404
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
