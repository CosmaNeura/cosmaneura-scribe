"""Real creator/consent transactions; synthetic keys and audio only."""

import asyncio
from uuid import uuid4

import pytest
import pytest_asyncio
from cosmaneura_scribe import creator_preparation_routes, main
from cosmaneura_scribe.audio_keys import AudioEncryptionKeyUnavailable
from cosmaneura_scribe.creator_preparation_routes import preparation_keys
from cosmaneura_scribe.creator_review_routes import CreatorReviewRuntime
from cosmaneura_scribe.main import app, get_audio_encryption_key_provider
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import get_settings
from sqlalchemy import event
from test_audio_assembly import WRAPPED_DEK
from test_capture_protocol_api import CaptureKeyProvider
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def preparation(capture):
    t = capture.trial
    runtime = CreatorReviewRuntime(t.provider, tenant_ids=frozenset({t.tenant}), enabled=True)
    app.state.creator_review_runtime = runtime

    class Keys(CaptureKeyProvider):
        calls = 0
        closed = 0

        async def get_public_key(self):
            assert t.provider.engine.pool.checkedout() == 0
            self.calls += 1
            return await super().get_public_key()

        async def close(self):
            self.closed += 1

    keys = Keys()
    app.dependency_overrides[preparation_keys] = lambda: keys
    try:
        yield capture, runtime, keys
        assert capture.speech.calls == 0 and not capture.reader.calls
    finally:
        del app.dependency_overrides[preparation_keys]
        del app.state.creator_review_runtime


async def metadata(capture, **headers):
    t = capture.trial
    return await capture.client.get(
        f"/v1/captured-sessions/{t.draft.id}/preparation-metadata",
        headers={"X-Scribe-Creator-Actor-ID": t.draft.creator_actor_id, **headers},
    )


async def test_metadata_matches_existing_receipts_without_capture(preparation):
    capture, _, keys = preparation
    t = capture.trial
    review = await capture.client.get(
        f"/v1/captured-sessions/{t.draft.id}/review",
        headers={"X-Scribe-Creator-Actor-ID": t.draft.creator_actor_id},
    )
    public = await capture.client.get("/v1/audio-encryption-key")
    capabilities = await capture.client.get(f"/v1/sessions/{t.draft.id}/capture-capabilities")
    result = await metadata(capture)
    assert result.status_code == 200
    assert result.json() == {
        "schema_version": "1.0",
        "review": review.json(),
        "encryption_key": public.json(),
        "capabilities": capabilities.json(),
    }
    assert result.headers["cache-control"] == "no-store"
    assert keys.calls == keys.closed == 1
    assert t.provider.engine.pool.checkedout() == 0


async def test_production_dependency_closes_only_its_owned_client_before_key_binding(
    preparation, monkeypatch
):
    capture, _, _ = preparation
    created = []

    class LifecycleKeys(CaptureKeyProvider):
        closed = False

        async def get_public_key(self):
            if self.closed:
                raise RuntimeError("Synthetic key client is closed")
            return await super().get_public_key()

        async def close(self):
            self.closed = True

    shared = LifecycleKeys()
    app.dependency_overrides[get_audio_encryption_key_provider] = lambda: shared
    monkeypatch.setattr(main, "get_audio_encryption_key_provider", lambda: shared)
    app.dependency_overrides[preparation_keys] = creator_preparation_routes.preparation_keys

    def build(_settings):
        provider = LifecycleKeys()
        created.append(provider)
        return provider

    monkeypatch.setattr(creator_preparation_routes, "build_audio_encryption_key_provider", build)
    # Exercise the actual preparation dependency, twice, followed by the same
    # ordinary key-binding endpoint used by installed recording preparation.
    for _ in range(2):
        assert (await metadata(capture)).status_code == 200
    assert len(created) == 2 and all(provider.closed for provider in created)
    assert not shared.closed
    result = await capture.post(
        "audio-key",
        {"key_version": "capture-key-version", "wrapped_dek": WRAPPED_DEK},
        "metadata-lifetime-bind",
    )
    assert result.status_code == 201 and not shared.closed


async def test_one_receiver_read_reduces_real_database_work(preparation, record_property):
    capture, _, _ = preparation
    t, counts = capture.trial, []

    def statement(*_args):
        counts.append(True)

    event.listen(t.provider.engine.sync_engine, "before_cursor_execute", statement)
    try:
        review_path = f"/v1/captured-sessions/{t.draft.id}/review"
        headers = {"X-Scribe-Creator-Actor-ID": t.draft.creator_actor_id}
        # Actual old Core sequence: review; review + public key; review + caps.
        for path in (
            review_path,
            review_path,
            "/v1/audio-encryption-key",
            review_path,
            f"/v1/sessions/{t.draft.id}/capture-capabilities",
        ):
            assert (await capture.client.get(path, headers=headers)).status_code == 200
        old = len(counts)
        counts.clear()
        assert (await metadata(capture)).status_code == 200
        current = len(counts)
    finally:
        event.remove(t.provider.engine.sync_engine, "before_cursor_execute", statement)
    assert 0 < current < old
    record_property("preceding_database_statements", old)
    record_property("combined_database_statements", current)


@pytest.mark.parametrize(
    "denial", ["creator", "cohort", "disabled", "consent", "tenant", "protocol"]
)
async def test_denial_precedes_public_key_io(preparation, denial):
    capture, runtime, keys = preparation
    t, headers = capture.trial, {}
    if denial == "creator":
        headers["X-Scribe-Creator-Actor-ID"] = "other-synthetic-creator"
    elif denial == "cohort":
        runtime.tenant_ids = frozenset({uuid4()})
    elif denial == "disabled":
        runtime.enabled = False
    elif denial == "consent":
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
    elif denial == "tenant":
        app.dependency_overrides[get_verified_tenant_id] = lambda: uuid4()
    else:
        settings = app.dependency_overrides[get_settings]()
        app.dependency_overrides[get_settings] = lambda: settings.model_copy(
            update={"capture_protocol_enabled": False}
        )
    result = await metadata(capture, **headers)
    assert result.status_code in (404, 409, 503)
    assert keys.calls == 0 and keys.closed == 1
    assert "encryption_key" not in result.json()


@pytest.mark.parametrize("phase", ["fetch", "close"])
async def test_committed_consent_revocation_during_key_io_prevents_publication(
    preparation, monkeypatch, phase
):
    capture, _, keys = preparation
    method = keys.get_public_key if phase == "fetch" else keys.close

    async def revoke():
        result = await method()
        t = capture.trial
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
        return result

    monkeypatch.setattr(keys, "get_public_key" if phase == "fetch" else "close", revoke)
    result = await metadata(capture)
    assert result.status_code == 404 and "encryption_key" not in result.json()
    assert keys.calls == keys.closed == 1


async def test_key_failure_and_cancellation_publish_no_partial_result(preparation, monkeypatch):
    capture, _, keys = preparation

    async def failed():
        raise AudioEncryptionKeyUnavailable()

    monkeypatch.setattr(keys, "get_public_key", failed)
    result = await metadata(capture)
    assert result.status_code == 503 and "review" not in result.json()
    entered = asyncio.Event()

    async def blocked():
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(keys, "get_public_key", blocked)
    task = asyncio.create_task(metadata(capture))
    await asyncio.wait_for(entered.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert keys.closed == 2 and capture.trial.provider.engine.pool.checkedout() == 0
