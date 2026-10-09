"""Real transaction/replay tests; no microphone, model, blob upload or live identity."""

import asyncio
from uuid import uuid4

import pytest
import pytest_asyncio
from cosmaneura_scribe.creator_review_routes import CreatorReviewRuntime
from cosmaneura_scribe.main import app
from cosmaneura_scribe.service_auth import (
    EntraWorkflowAuthenticator,
    get_verified_tenant_id,
    get_workflow_authenticator,
)
from cosmaneura_scribe.settings import get_settings
from sqlalchemy import text
from test_audio_assembly import WRAPPED_DEK
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]
KINDS = ("issue", "renew", "reserve")


@pytest_asyncio.fixture
async def prepared(capture):
    t = capture.trial
    runtime = CreatorReviewRuntime(t.provider, tenant_ids=frozenset({t.tenant}), enabled=True)
    app.state.creator_review_runtime = runtime
    try:
        result = await capture.post(
            "audio-key",
            {"key_version": "capture-key-version", "wrapped_dek": WRAPPED_DEK},
            "creator-window-key",
        )
        assert result.status_code == 201
        yield capture, runtime
        assert capture.speech.calls == 0 and not capture.reader.calls
    finally:
        del app.state.creator_review_runtime


async def operation(capture, kind):
    if kind == "issue":
        return "capture-lease", {"protocol_version": "1.0"}
    lease = await capture.post("capture-lease", {"protocol_version": "1.0"}, "initial-lease")
    assert lease.status_code == 201
    value = lease.json()
    if kind == "renew":
        return f"capture-leases/{value['lease_id']}/renew", {
            "protocol_version": "1.0",
            "expected_generation": value["generation"],
        }
    return "chunk-reservations", {
        "protocol_version": "1.0",
        "capture_lease_id": value["lease_id"],
        "capture_lease_generation": value["generation"],
        "channel": "mixed",
        "first_sequence_number": 0,
        "count": 30,
    }


async def post(capture, suffix, body, *, key="creator-window-intent", headers=None):
    t = capture.trial
    return await capture.client.post(
        f"/v1/captured-sessions/{t.draft.id}/{suffix}",
        json=body,
        headers={
            "Idempotency-Key": key,
            "X-Scribe-Creator-Actor-ID": t.draft.creator_actor_id,
            **(headers or {}),
        },
    )


async def counts(capture):
    t = capture.trial
    async with t.provider.transaction(t.tenant) as store:
        return (
            await store._session.scalar(
                text(
                    "SELECT count(*) FROM capture_lease_receipts "
                    "WHERE tenant_id=:tenant AND session_id=:session"
                ),
                {"tenant": t.tenant, "session": t.draft.id},
            ),
            await store._session.scalar(
                text(
                    "SELECT count(*) FROM audio_chunk_reservation_batches "
                    "WHERE tenant_id=:tenant AND session_id=:session"
                ),
                {"tenant": t.tenant, "session": t.draft.id},
            ),
        )


@pytest.mark.parametrize("kind", KINDS)
async def test_concurrent_legacy_and_creator_intent_is_one_durable_receipt(prepared, kind):
    capture, _ = prepared
    suffix, body = await operation(capture, kind)
    before = await counts(capture)
    creator, legacy = await asyncio.wait_for(
        asyncio.gather(
            post(capture, suffix, body), capture.post(suffix, body, "creator-window-intent")
        ),
        timeout=10,
    )
    assert creator.status_code == legacy.status_code == (200 if kind == "renew" else 201)
    assert creator.json() == legacy.json()
    assert creator.headers["cache-control"] == "no-store"
    await capture.trial.provider.engine.dispose()
    replay = await post(capture, suffix, body)
    assert replay.json() == creator.json()
    after = await counts(capture)
    assert after == (before[0] + (kind != "reserve"), before[1] + (kind == "reserve"))


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("replay", [False, True])
@pytest.mark.parametrize("fault", ["creator", "revoked", "tenant", "disabled"])
async def test_current_creator_consent_and_cohort_gate_new_and_replayed_intents(
    prepared,
    kind,
    replay,
    fault,
):
    capture, runtime = prepared
    suffix, body = await operation(capture, kind)
    if replay:
        assert (await post(capture, suffix, body)).status_code in (200, 201)
    before = await counts(capture)
    headers = {}
    if fault == "creator":
        headers["X-Scribe-Creator-Actor-ID"] = "another_creator"
    elif fault == "tenant":
        headers["X-Tenant-ID"] = str(uuid4())
    elif fault == "disabled":
        runtime.enabled = False
    else:
        t = capture.trial
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
    result = await post(capture, suffix, body, headers=headers)
    assert result.status_code in (404, 409)
    assert await counts(capture) == before
    if fault == "creator":
        # A rejected creator cannot poison the rightful owner's retained key.
        assert (await post(capture, suffix, body)).status_code in (200, 201)


@pytest.mark.parametrize("kind", KINDS)
async def test_required_headers_closed_body_and_workload_auth(prepared, kind):
    capture, _ = prepared
    suffix, body = await operation(capture, kind)
    before = await counts(capture)
    t = capture.trial
    path = f"/v1/captured-sessions/{t.draft.id}/{suffix}"
    missing = await capture.client.post(
        path, json=body, headers={"Idempotency-Key": "missing-creator"}
    )
    assert missing.status_code == 422
    injected = await post(capture, suffix, {**body, "creator_actor_id": "untrusted"})
    assert injected.status_code == 422
    override = app.dependency_overrides.pop(get_verified_tenant_id)
    settings = app.dependency_overrides[get_settings]()
    app.dependency_overrides[get_workflow_authenticator] = lambda: EntraWorkflowAuthenticator(
        settings, decoder=lambda _: {}
    )
    try:
        assert (await post(capture, suffix, body)).status_code == 401
    finally:
        app.dependency_overrides[get_verified_tenant_id] = override
        del app.dependency_overrides[get_workflow_authenticator]
    assert await counts(capture) == before


@pytest.mark.parametrize("kind", KINDS)
async def test_changed_payload_keeps_original_intent_conflict(prepared, kind):
    capture, _ = prepared
    suffix, body = await operation(capture, kind)
    if kind == "issue":
        # Issuance has no second valid body; its replay is covered above.
        assert (await post(capture, suffix, {"protocol_version": "2.0"})).status_code == 422
        return
    assert (await post(capture, suffix, body)).status_code in (200, 201)
    before = await counts(capture)
    field = "expected_generation" if kind == "renew" else "count"
    changed = {**body, field: body[field] + 1}
    assert (await post(capture, suffix, changed)).status_code == 409
    assert await counts(capture) == before
