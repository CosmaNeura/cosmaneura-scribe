from __future__ import annotations

import json
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from test_captured_processing import flow as flow
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture
from test_creator_review_routes import _decision, _headers, _path
from test_creator_review_routes import review as review
from test_normalized_source_persistence import _expire_normalized_source

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


async def ready(flow):
    await flow.capture.record()
    await flow.runtime.process(**flow.scope)
    path, headers, client = _path(flow), _headers(flow), flow.capture.client
    view = (await client.get(path, headers=headers)).json()
    result = await client.post(
        path, headers={**headers, "Idempotency-Key": "synthetic-accept"}, json=_decision(view)
    )
    assert result.status_code == 200
    return (await client.get(path, headers=headers)).json()


def request(view):
    segment = next(row for row in view["source"]["segments"] if row["source_locale"] == "en-US")
    return {
        "schema_version": "1.0",
        "expected_source_transcript_version": view["source"]["source_transcript_version"],
        "expected_working_transcript_id": view["working"]["working_transcript_id"],
        "expected_working_transcript_version": view["working"]["working_transcript_version"],
        "corrections": [
            {
                "source_segment_id": segment["source_segment_id"],
                "expected_source_segment_version": segment["source_segment_version"],
                "content": "Synthetic corrected wording. No real patient.",
            }
        ],
        "speakers": [
            {
                "speaker_id": segment["speaker_id"],
                "role": "clinician",
                "display_name": "Fictional Dr. Avery",
                "detail": None,
            }
        ],
    }


async def test_edit_publishes_working_version_preserves_source_and_replays_after_later_edit(review):
    flow, _ = review
    before = await ready(flow)
    client, path = flow.capture.client, _path(flow)
    headers = _headers(flow, **{"Idempotency-Key": "synthetic-correction-one"})
    body = request(before)
    response = await client.post(path + "/edit", headers=headers, json=body)
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert (
        receipt["working_transcript_version"] == before["working"]["working_transcript_version"] + 1
    )
    current = (await client.get(path, headers=headers)).json()
    assert current["source"] == before["source"] and current["working"]["note_ready"]
    segment = next(
        row
        for row in current["working"]["segments"]
        if row["source_segment_id"] == body["corrections"][0]["source_segment_id"]
    )
    assert segment["content"] == body["corrections"][0]["content"]
    assert segment["speaker_role"] == "clinician"
    assert current["review_edits"][0]["request"] == body
    assert current["editing_allowed"] is True
    changed = {
        **body,
        "expected_working_transcript_version": receipt["working_transcript_version"],
        "corrections": [],
        "speakers": [{**body["speakers"][0], "role": "other", "detail": "interpreter"}],
    }
    second = await client.post(
        path + "/edit",
        json=changed,
        headers=_headers(flow, **{"Idempotency-Key": "synthetic-correction-two"}),
    )
    assert second.status_code == 200, second.text
    replay = await client.post(path + "/edit", headers=headers, json=body)
    assert replay.json() == receipt
    history = (await client.get(path, headers=headers)).json()["review_edits"]
    assert len(history) == 2 and history[0]["request"] == body
    conflict = await client.post(path + "/edit", headers=headers, json=changed)
    assert conflict.status_code == 409
    stale = await client.post(
        path + "/edit",
        json=body,
        headers=_headers(flow, **{"Idempotency-Key": "synthetic-stale-new-key"}),
    )
    assert stale.status_code == 409


async def test_edit_is_creator_scoped_revalidates_consent_and_does_not_bypass_translation(review):
    flow, _ = review
    await flow.capture.record()
    await flow.runtime.process(**flow.scope)
    client, path, headers = flow.capture.client, _path(flow), _headers(flow)
    view = (await client.get(path, headers=headers)).json()
    body = request(view)
    spanish = next(row for row in view["source"]["segments"] if row["source_locale"] == "es-US")
    blocked = {
        **body,
        "corrections": [
            {
                "source_segment_id": spanish["source_segment_id"],
                "expected_source_segment_version": spanish["source_segment_version"],
                "content": "Unreviewed.",
            }
        ],
    }
    headers["Idempotency-Key"] = "synthetic-blocked-edit"
    assert (await client.post(path + "/edit", json=blocked, headers=headers)).status_code == 409
    assert (
        await client.post(
            path + "/edit",
            json=body,
            headers={**headers, "X-Scribe-Creator-Actor-ID": "other-creator"},
        )
    ).status_code == 404
    assert (await client.post(path + "/edit", json=body, headers=headers)).status_code == 200
    async with flow.capture.trial.provider.transaction(flow.capture.trial.tenant) as store:
        await store.revoke_consent(flow.capture.trial.tenant, flow.capture.trial.consent.id)
    assert (await client.post(path + "/edit", json=body, headers=headers)).status_code == 404


async def test_edit_body_and_immutable_database_evidence_are_closed(review):
    flow, _ = review
    view = await ready(flow)
    client, path = flow.capture.client, _path(flow)
    headers = _headers(flow, **{"Idempotency-Key": "synthetic-closed-edit"})
    body = request(view)
    for invalid in [
        {**body, "creator_actor_id": "untrusted"},
        {**body, "expected_working_transcript_version": True},
        {**body, "speakers": [{**body["speakers"][0], "role": "unknown"}]},
        {**body, "speakers": [{**body["speakers"][0], "detail": "interpreter"}]},
    ]:
        result = await client.post(path + "/edit", json=invalid, headers=headers)
        assert result.status_code == 422 and "Fictional" not in result.text
    unknown = {**body, "speakers": [{**body["speakers"][0], "speaker_id": str(uuid4())}]}
    assert (await client.post(path + "/edit", json=unknown, headers=headers)).status_code == 409
    assert (await client.post(path + "/edit", json=body, headers=headers)).status_code == 200
    for statement in [
        "UPDATE creator_transcript_edits SET request = request",
        "DELETE FROM creator_transcript_edits",
    ]:
        with pytest.raises(DBAPIError):
            async with flow.capture.trial.provider.transaction(flow.capture.trial.tenant) as store:
                await store._session.execute(
                    text(statement + " WHERE tenant_id = :tenant"),
                    {"tenant": flow.capture.trial.tenant},
                )


async def test_edit_history_obeys_tenant_visibility_and_existing_retention_purge(review):
    flow, _ = review
    view = await ready(flow)
    client, path = flow.capture.client, _path(flow)
    headers = _headers(flow, **{"Idempotency-Key": "synthetic-retention-edit"})
    result = await client.post(path + "/edit", json=request(view), headers=headers)
    assert result.status_code == 200
    trial = flow.capture.trial
    async with trial.provider.transaction(uuid4()) as store:
        count = await store._session.scalar(text("SELECT count(*) FROM creator_transcript_edits"))
        assert count == 0
    await _expire_normalized_source(
        trial.provider, trial.tenant, trial.draft.id, admin_url=trial.admin_url
    )
    assert (await client.get(path, headers=headers)).status_code == 404
    async with trial.provider.transaction(trial.tenant) as store:
        await store.purge_normalized_source_content(trial.tenant, trial.draft.id)
        assert (
            await store._session.scalar(text("SELECT count(*) FROM creator_transcript_edits")) == 0
        )


@pytest.mark.parametrize(
    "invalid", ["unknown_field", "numeric_name", "numeric_detail", "control_name"]
)
async def test_database_rejects_unreadable_immutable_speaker_evidence(review, invalid):
    flow, _ = review
    view = await ready(flow)
    body = request(view)
    speaker = body["speakers"][0]
    if invalid == "unknown_field":
        speaker["unrecognized"] = speaker.pop("display_name")
    elif invalid == "numeric_name":
        speaker["display_name"] = 42
    elif invalid == "numeric_detail":
        speaker["detail"] = 42
    else:
        speaker["display_name"] = "Synthetic\nProvider"
    trial = flow.capture.trial
    with pytest.raises(DBAPIError, match="creator speaker target invalid"):
        async with trial.provider.transaction(trial.tenant) as store:
            await store._session.execute(
                text("""
                INSERT INTO creator_transcript_edits
                    (tenant_id,session_id,edit_id,source_transcript_version,prior_working_version,
                     result_working_version,creator_actor_id,request)
                VALUES (:tenant,:session,:edit,:source,:prior,:result,:actor,
                        CAST(:request AS jsonb))
            """),
                {
                    "tenant": trial.tenant,
                    "session": trial.draft.id,
                    "edit": uuid4(),
                    "source": body["expected_source_transcript_version"],
                    "prior": body["expected_working_transcript_version"],
                    "result": body["expected_working_transcript_version"] + 1,
                    "actor": trial.draft.creator_actor_id,
                    "request": json.dumps(body),
                },
            )
