"""Synthetic first-window receipts, recovery, atomicity and live consent."""

import asyncio
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from cosmaneura_scribe import creator_preparation_routes, main
from cosmaneura_scribe.audio_keys import AudioEncryptionKeyUnavailable
from cosmaneura_scribe.capture_protocol_v1 import RESERVATION_PLAINTEXT_BUDGET_BYTES
from cosmaneura_scribe.creator_preparation_routes import preparation_keys
from cosmaneura_scribe.creator_review_routes import CreatorReviewRuntime
from cosmaneura_scribe.main import app
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import get_settings
from sqlalchemy import event
from test_audio_assembly import WRAPPED_DEK
from test_capture_protocol_api import CaptureKeyProvider
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture
from test_creator_recording_routes import counts, post

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


def intent(channel="microphone", count=30):
    return {
        "schema_version": "1.0",
        "binding": {"key_version": "capture-key-version", "wrapped_dek": WRAPPED_DEK},
        "bind_idempotency_key": "first-window-bind",
        "lease_idempotency_key": "first-window-lease",
        "reserve_idempotency_key": "first-window-reserve",
        "channel": channel,
        "reservation_count": count,
    }


@pytest_asyncio.fixture
async def initial(capture):
    t = capture.trial
    runtime = CreatorReviewRuntime(t.provider, tenant_ids=frozenset({t.tenant}), enabled=True)
    app.state.creator_review_runtime = runtime

    class Keys(CaptureKeyProvider):
        calls = 0
        closes = 0

        async def get_public_key(self):
            assert t.provider.engine.pool.checkedout() == 0
            self.calls += 1
            return await super().get_public_key()

        async def close(self):
            self.closes += 1

    keys = Keys()
    app.dependency_overrides[preparation_keys] = lambda: keys
    try:
        yield capture, runtime, keys
        assert capture.speech.calls == 0 and not capture.reader.calls
    finally:
        del app.dependency_overrides[preparation_keys]
        del app.state.creator_review_runtime


async def combined(capture, body, key="first-window-outer", headers=None):
    return await post(capture, "recording-window", body, key=key, headers=headers)


async def test_production_dependency_keeps_owner_open_across_metadata_and_window(
    initial, monkeypatch
):
    capture, _, _ = initial

    class LifecycleKeys(CaptureKeyProvider):
        closed = False
        calls = 0

        async def get_public_key(self):
            assert not self.closed
            assert capture.trial.provider.engine.pool.checkedout() == 0
            self.calls += 1
            return await super().get_public_key()

        async def close(self):
            self.closed = True

    shared = LifecycleKeys()
    monkeypatch.setattr(main, "get_audio_encryption_key_provider", lambda: shared)
    app.dependency_overrides[preparation_keys] = creator_preparation_routes.preparation_keys
    t = capture.trial
    result = await capture.client.get(
        f"/v1/captured-sessions/{t.draft.id}/preparation-metadata",
        headers={"X-Scribe-Creator-Actor-ID": t.draft.creator_actor_id},
    )
    assert result.status_code == 200 and not shared.closed
    window = await combined(capture, intent("mixed"))
    assert window.status_code == 200 and shared.calls == 2 and not shared.closed
    assert (await combined(capture, intent("mixed"))).json() == window.json()
    assert shared.calls == 2 and not shared.closed


async def ordinary(capture, body, *, steps=3, creator=False):
    if creator:
        t = capture.trial
        review = await capture.client.get(
            f"/v1/captured-sessions/{t.draft.id}/review",
            headers={"X-Scribe-Creator-Actor-ID": t.draft.creator_actor_id},
        )
        assert review.status_code == 200
    binding = await capture.post("audio-key", body["binding"], body["bind_idempotency_key"])
    assert binding.status_code == 201
    if steps == 1:
        return {"binding": binding.json()}
    lease = (
        await post(
            capture, "capture-lease", {"protocol_version": "1.0"}, key=body["lease_idempotency_key"]
        )
        if creator
        else await capture.post(
            "capture-lease", {"protocol_version": "1.0"}, body["lease_idempotency_key"]
        )
    )
    assert lease.status_code == 201
    value = lease.json()
    if steps == 2:
        return {"binding": binding.json(), "lease": value}
    reserve_body = {
        "protocol_version": "1.0",
        "capture_lease_id": value["lease_id"],
        "capture_lease_generation": value["generation"],
        "channel": body["channel"],
        "first_sequence_number": 0,
        "count": body["reservation_count"],
    }
    batch = (
        await post(capture, "chunk-reservations", reserve_body, key=body["reserve_idempotency_key"])
        if creator
        else await capture.post("chunk-reservations", reserve_body, body["reserve_idempotency_key"])
    )
    assert batch.status_code == 201
    return {
        "schema_version": "1.0",
        "binding": binding.json(),
        "lease": value,
        "reservations": batch.json(),
    }


@pytest.mark.parametrize("channel", ["microphone", "system_audio", "mixed"])
@pytest.mark.parametrize("prior_steps", [0, 1, 2, 3])
async def test_same_ordinary_receipts_survive_partial_commit_and_restart(
    initial, channel, prior_steps
):
    capture, _, keys = initial
    body = intent(channel)
    prior = await ordinary(capture, body, steps=prior_steps) if prior_steps else {}
    result = await combined(capture, body)
    assert result.status_code == 200
    receipt = result.json()
    assert all(receipt[k] == v for k, v in prior.items())
    assert result.headers["cache-control"] == "no-store"
    assert receipt == await ordinary(capture, body)
    assert await counts(capture) == (1, 1)
    await capture.trial.provider.engine.dispose()
    assert (await combined(capture, body)).json() == receipt
    assert (await combined(capture, body, key="second-outer-window")).json() == receipt
    assert keys.calls == (0 if prior_steps else 1) and keys.closes == 3


async def test_concurrent_ordinary_and_combined_claims_produce_one_window(initial):
    capture, _, _ = initial
    body = intent()
    first, second, legacy = await asyncio.wait_for(
        asyncio.gather(combined(capture, body), combined(capture, body), ordinary(capture, body)),
        timeout=15,
    )
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == legacy
    assert await counts(capture) == (1, 1)


@pytest.mark.parametrize("replay", [False, True])
@pytest.mark.parametrize("denial", ["creator", "disabled", "consent", "protocol", "tenant"])
async def test_current_authority_gate_precedes_key_io_and_receipt_publication(
    initial, denial, replay
):
    capture, runtime, keys = initial
    body = intent()
    if replay:
        assert (await combined(capture, body)).status_code == 200
    before = await counts(capture)
    calls = keys.calls
    headers = {}
    if denial == "creator":
        headers["X-Scribe-Creator-Actor-ID"] = "wrong-creator"
    elif denial == "disabled":
        runtime.enabled = False
    elif denial == "consent":
        t = capture.trial
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
    elif denial == "tenant":
        from uuid import uuid4

        app.dependency_overrides[get_verified_tenant_id] = uuid4
    else:
        settings = app.dependency_overrides[get_settings]()
        app.dependency_overrides[get_settings] = lambda: settings.model_copy(
            update={"capture_protocol_enabled": False}
        )
    result = await combined(capture, body, headers=headers)
    assert result.status_code in (404, 409, 503)
    assert keys.calls == calls and await counts(capture) == before


@pytest.mark.parametrize("fault", ["binding", "same_keys", "outer_key", "count", "scope"])
async def test_closed_recipe_rejects_changes_without_claiming_a_window(initial, fault):
    capture, _, keys = initial
    body, key = intent(), "first-window-outer"
    if fault == "binding":
        body["binding"]["tenant_id"] = "injected"
    elif fault == "same_keys":
        body["lease_idempotency_key"] = body["bind_idempotency_key"]
    elif fault == "outer_key":
        key = body["bind_idempotency_key"]
    elif fault == "count":
        body["reservation_count"] = True
    else:
        body["session_id"] = "injected"
    result = await combined(capture, body, key=key)
    assert result.status_code in (409, 422) and keys.calls == 0
    assert await counts(capture) == (0, 0)


async def test_replay_after_key_rotation_keeps_the_original_bound_key(initial, monkeypatch):
    capture, _, keys = initial
    first = await combined(capture, intent())
    assert first.status_code == 200

    async def unavailable_key():
        raise AudioEncryptionKeyUnavailable()

    monkeypatch.setattr(keys, "get_public_key", unavailable_key)
    assert (await combined(capture, intent())).json() == first.json()
    assert await counts(capture) == (1, 1)


@pytest.mark.parametrize("phase", ["fetch", "close"])
async def test_committed_revocation_during_key_io_leaves_no_partial_window(
    initial, monkeypatch, phase
):
    capture, _, keys = initial
    method = keys.get_public_key if phase == "fetch" else keys.close

    async def revoke():
        value = await method()
        t = capture.trial
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
        return value

    monkeypatch.setattr(keys, "get_public_key" if phase == "fetch" else "close", revoke)
    result = await combined(capture, intent())
    assert result.status_code == 409 and await counts(capture) == (0, 0)
    t = capture.trial
    async with t.provider.transaction(t.tenant) as store:
        assert await store.get_session_audio_key(t.tenant, t.draft.id) is None


async def test_reservation_failure_rolls_back_key_lease_and_claims(initial):
    capture, _, _ = initial
    settings = app.dependency_overrides[get_settings]()
    app.dependency_overrides[get_settings] = lambda: settings.model_copy(
        update={"audio_assembly_max_plaintext_bytes": RESERVATION_PLAINTEXT_BUDGET_BYTES}
    )
    body = intent(count=2)
    assert (await combined(capture, body)).status_code == 409
    assert await counts(capture) == (0, 0)
    t = capture.trial
    async with t.provider.transaction(t.tenant) as store:
        assert await store.get_session_audio_key(t.tenant, t.draft.id) is None
        for operation, key in [
            (f"captured.recording-window:{t.draft.id}", "first-window-outer"),
            (f"session.audio-key:{t.draft.id}", body["bind_idempotency_key"]),
            (f"capture.lease.issue:{t.draft.id}", body["lease_idempotency_key"]),
            (f"capture.reservations:{t.draft.id}", body["reserve_idempotency_key"]),
        ]:
            assert (
                await store.get_idempotency(tenant_id=t.tenant, operation=operation, key=key)
                is None
            )
    app.dependency_overrides[get_settings] = lambda: settings
    assert (await combined(capture, body)).status_code == 200


async def test_key_failure_and_cancellation_leave_no_claims(initial, monkeypatch):
    capture, _, keys = initial

    async def failed():
        raise AudioEncryptionKeyUnavailable()

    monkeypatch.setattr(keys, "get_public_key", failed)
    assert (await combined(capture, intent())).status_code == 503
    entered = asyncio.Event()

    async def blocked():
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(keys, "get_public_key", blocked)
    task = asyncio.create_task(combined(capture, intent()))
    await asyncio.wait_for(entered.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert keys.closes == 2 and await counts(capture) == (0, 0)


async def test_post_commit_reply_loss_recovers_the_same_full_window(initial):
    capture, runtime, _ = initial
    original = runtime.repositories.transaction
    lose = True

    @asynccontextmanager
    async def transaction(tenant):
        nonlocal lose
        async with original(tenant) as store:
            yield store
        if lose:
            async with original(tenant) as store:
                batch = await store.get_idempotency(
                    tenant_id=tenant,
                    operation=f"capture.reservations:{capture.trial.draft.id}",
                    key=intent()["reserve_idempotency_key"],
                )
            if batch is not None:
                lose = False
                raise RuntimeError("Synthetic post-commit reply loss")

    runtime.repositories.transaction = transaction
    assert (await combined(capture, intent())).status_code == 500
    assert await counts(capture) == (1, 1)
    recovered = await combined(capture, intent())
    assert recovered.status_code == 200 and recovered.json() == await ordinary(capture, intent())
    assert await counts(capture) == (1, 1)


@pytest.mark.parametrize("mode", ["ordinary", "combined"])
async def test_fresh_window_sql_measurement(initial, record_property, mode):
    capture, _, _ = initial
    statements = []
    engine = capture.trial.provider.engine.sync_engine

    def sql(*_):
        statements.append(True)

    event.listen(engine, "before_cursor_execute", sql)
    try:
        if mode == "ordinary":
            await ordinary(capture, intent(), creator=True)
        else:
            assert (await combined(capture, intent())).status_code == 200
        measured = len(statements)
    finally:
        event.remove(engine, "before_cursor_execute", sql)
    record_property("fresh_window_mode", mode)
    record_property("fresh_window_sql", measured)
    assert measured > 0 and await counts(capture) == (1, 1)
