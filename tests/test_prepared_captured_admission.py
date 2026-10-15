"""The combined receiver keeps real consent/creator transactions and key fences."""

import asyncio

import pytest
from cosmaneura_scribe.audio_keys import AudioEncryptionKeyUnavailable
from test_captured_admission_routes import admission as admission
from test_captured_admission_routes import body, headers
from test_captured_admission_routes import trial as trial
from test_captured_transcription_worker import capture as capture
from test_creator_preparation_routes import preparation as preparation

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


async def post(capture, **changes):
    return await capture.client.post(
        "/v1/captured-sessions/prepared",
        json={**body(capture.trial), **changes},
        headers=headers(capture.trial),
    )


async def test_combined_equals_ordinary_current_receipts(admission, preparation):
    capture, _ = admission
    _, _, keys = preparation
    result = await post(capture)
    assert result.status_code == 201
    assert result.headers["cache-control"] == "no-store"
    separate = await capture.client.post(
        "/v1/captured-sessions", json=body(capture.trial), headers=headers(capture.trial)
    )
    read = await capture.client.get(
        f"/v1/captured-sessions/{capture.trial.draft.id}/preparation-metadata",
        headers=headers(capture.trial),
    )
    assert result.json() == {
        "schema_version": "1.0",
        "admission": separate.json(),
        "preparation_metadata": read.json(),
    }
    assert keys.calls == keys.closed == 2


async def test_concurrent_exact_replay_keeps_one_session_family(
    admission, preparation, monkeypatch
):
    capture, _ = admission
    _, _, keys = preparation
    from test_capture_protocol_api import CaptureKeyProvider

    # Another concurrent request can hold a DB connection during this one's
    # key call. The sequential test separately checks no local lock crosses I/O.
    monkeypatch.setattr(keys, "get_public_key", lambda: CaptureKeyProvider.get_public_key(keys))
    results = await asyncio.gather(post(capture), post(capture))
    assert all(r.status_code == 201 for r in results)
    assert results[0].json() == results[1].json()


@pytest.mark.parametrize("fault", ["changed", "revoked", "disabled", "body"])
async def test_denied_admission_precedes_key_io(admission, preparation, fault):
    capture, runtime = admission
    _, _, keys = preparation
    changes = {}
    if fault == "changed":
        changes["patient_id"] = "synthetic-other"
    elif fault == "revoked":
        t = capture.trial
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
    elif fault == "disabled":
        runtime.enabled = False
    else:
        changes["creator_actor_id"] = "synthetic-untrusted"
    result = await post(capture, **changes)
    assert result.status_code in (404, 409, 422)
    assert keys.calls == 0
    assert "preparation_metadata" not in result.text


async def test_revocation_during_key_io_publishes_no_partial_result(
    admission, preparation, monkeypatch
):
    capture, _ = admission
    _, _, keys = preparation
    original = keys.get_public_key

    async def revoke():
        result = await original()
        t = capture.trial
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
        return result

    monkeypatch.setattr(keys, "get_public_key", revoke)
    result = await post(capture)
    assert result.status_code == 404
    assert "admission" not in result.json()
    assert keys.calls == keys.closed == 1


async def test_key_failure_recovers_with_the_original_admission_key(
    admission, preparation, monkeypatch
):
    capture, _ = admission
    _, _, keys = preparation
    original = keys.get_public_key

    async def failed():
        raise AudioEncryptionKeyUnavailable()

    monkeypatch.setattr(keys, "get_public_key", failed)
    result = await post(capture)
    assert result.status_code == 503 and "admission" not in result.json()
    # Either endpoint recovers exactly the same committed family, with fresh
    # consent checks. No new idempotency key or replacement session is created.
    legacy = await capture.client.post(
        "/v1/captured-sessions", json=body(capture.trial), headers=headers(capture.trial)
    )
    monkeypatch.setattr(keys, "get_public_key", original)
    replay = await post(capture)
    assert replay.status_code == 201
    assert replay.json()["admission"] == legacy.json()
