"""Synthetic continuation transactions: no microphone, upload, speech or live identity."""

import asyncio
from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
from cosmaneura_scribe.capture_protocol_v1 import RESERVATION_PLAINTEXT_BUDGET_BYTES
from cosmaneura_scribe.captured_source_runtime import CapturedSourceRepositoryProvider
from cosmaneura_scribe.main import app
from cosmaneura_scribe.settings import get_settings
from test_captured_source_runtime import trial as trial
from test_captured_transcription_worker import capture as capture
from test_creator_recording_routes import counts, post
from test_creator_recording_routes import prepared as prepared
from test_normalized_source_persistence import _expire_normalized_source

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


async def intent(capture, *, channel="mixed"):
    response = await capture.post("capture-lease", {"protocol_version": "1.0"}, "initial-lease")
    assert response.status_code == 201
    lease = response.json()
    return {
        "schema_version": "1.0",
        "channel": channel,
        "first_sequence_number": 0,
        "previous_lease_id": lease["lease_id"],
        "previous_lease_generation": lease["generation"],
        "renew_idempotency_key": "continuation-renew-one",
        "reservation_idempotency_key": "continuation-reserve-one",
    }


async def combined(capture, body, *, key="continuation-outer-one", headers=None):
    return await post(capture, "continuation-window", body, key=key, headers=headers)


async def assert_unclaimed(capture, body, *, key="continuation-outer-one"):
    t = capture.trial
    async with t.provider.transaction(t.tenant) as store:
        for operation, claim_key in (
            (f"captured.continuation-window:{t.draft.id}", key),
            (
                f"capture.lease.renew:{t.draft.id}:{body['previous_lease_id']}",
                body["renew_idempotency_key"],
            ),
            (f"capture.reservations:{t.draft.id}", body["reservation_idempotency_key"]),
        ):
            assert (
                await store.get_idempotency(tenant_id=t.tenant, operation=operation, key=claim_key)
                is None
            )


@pytest.mark.parametrize("channel", ["microphone", "mixed"])
async def test_concurrent_and_restarted_reply_recovery_share_ordinary_receipts(prepared, channel):
    c, _ = prepared
    body = await intent(c, channel=channel)
    renewal_body = {"protocol_version": "1.0", "expected_generation": 1}
    renewal_path = f"capture-leases/{body['previous_lease_id']}/renew"
    first, concurrent, ordinary = await asyncio.wait_for(
        asyncio.gather(
            combined(c, body),
            combined(c, body),
            c.post(renewal_path, renewal_body, body["renew_idempotency_key"]),
        ),
        timeout=15,
    )
    assert first.status_code == concurrent.status_code == ordinary.status_code == 200
    receipt = first.json()
    assert first.headers["cache-control"] == "no-store"
    assert receipt == concurrent.json()
    assert receipt["lease"] == ordinary.json()
    assert receipt["lease"]["generation"] == 2
    reservations = receipt["reservations"]["reservations"]
    assert len(reservations) == 90 and all(row["channel"] == channel for row in reservations)
    await c.trial.provider.engine.dispose()
    assert (await combined(c, body)).json() == receipt
    reserve = await c.post(
        "chunk-reservations",
        {
            "protocol_version": "1.0",
            "capture_lease_id": body["previous_lease_id"],
            "capture_lease_generation": 2,
            "channel": channel,
            "first_sequence_number": 0,
            "count": len(reservations),
        },
        body["reservation_idempotency_key"],
    )
    assert reserve.status_code == 201 and reserve.json() == receipt["reservations"]
    assert await counts(c) == (2, 1)
    assert (
        await c.trial.query(
            "SELECT count(*) FROM audit_events WHERE tenant_id=:tenant AND entity_id=:session "
            "AND action='capture_continuation.prepared'"
        )
    ).scalar_one() == 1
    # A new outer intent can adopt those exact component receipts and gets its
    # own metadata audit without another renewal or capacity allocation.
    assert (await combined(c, body, key="another-outer-intent")).json() == receipt
    assert await counts(c) == (2, 1)
    assert (
        await c.trial.query(
            "SELECT count(*) FROM audit_events WHERE tenant_id=:tenant AND entity_id=:session "
            "AND action='capture_continuation.prepared'"
        )
    ).scalar_one() == 2


async def test_exact_count_survives_depleted_budget_and_reuses_existing_positions(prepared):
    c, _ = prepared
    body = await intent(c)
    settings = app.dependency_overrides[get_settings]()
    app.dependency_overrides[get_settings] = lambda: settings.model_copy(
        update={"audio_assembly_max_plaintext_bytes": 2 * RESERVATION_PLAINTEXT_BUDGET_BYTES}
    )
    result = await combined(c, body)
    assert result.status_code == 200
    receipt = result.json()
    saved = receipt["reservations"]["reservations"]
    assert len(saved) == 2
    assert (await combined(c, body)).json() == receipt
    overlap = {
        **body,
        "first_sequence_number": 1,
        "previous_lease_generation": 2,
        "renew_idempotency_key": "continuation-renew-two",
        "reservation_idempotency_key": "continuation-reserve-two",
    }
    response = await combined(c, overlap, key="continuation-outer-two")
    assert response.status_code == 200
    assert response.json()["lease"]["generation"] == 3
    reused = response.json()["reservations"]["reservations"]
    assert len(reused) == 1 and reused[0]["object_id"] == saved[1]["object_id"]
    assert (await combined(c, body)).json() == receipt
    exhausted = {
        **overlap,
        "first_sequence_number": 2,
        "previous_lease_generation": 3,
        "renew_idempotency_key": "continuation-renew-three",
        "reservation_idempotency_key": "continuation-reserve-three",
    }
    assert (await combined(c, exhausted, key="continuation-outer-three")).status_code == 409
    assert await counts(c) == (3, 2)
    await assert_unclaimed(c, exhausted, key="continuation-outer-three")


async def test_post_commit_transport_loss_recovers_without_a_second_renewal(prepared):
    c, runtime = prepared
    body = await intent(c)

    class LostReply(CapturedSourceRepositoryProvider):
        lose = True

        @asynccontextmanager
        async def transaction(self, tenant_id):
            async with super().transaction(tenant_id) as repository:
                yield repository
            if self.lose:
                self.lose = False
                raise RuntimeError("synthetic response loss after commit")

    runtime.repositories = LostReply(c.trial.provider.engine)
    lost = await combined(c, body)
    # The safe-error middleware masks the post-commit transport exception.
    assert lost.status_code == 500
    assert "synthetic response loss" not in lost.text
    assert await counts(c) == (2, 1)
    # A fresh receiver instance has no process-local receipt or count cache.
    runtime.repositories = CapturedSourceRepositoryProvider(c.trial.provider.engine)
    recovered = await combined(c, body)
    assert recovered.status_code == 200
    assert recovered.json()["lease"]["generation"] == 2
    assert (await combined(c, body)).json() == recovered.json()
    assert await counts(c) == (2, 1)


@pytest.mark.parametrize("fault", ["gap", "generation", "lease"])
async def test_failed_reservation_or_renewal_rolls_back_all_component_claims(prepared, fault):
    c, _ = prepared
    body = await intent(c)
    changed = dict(body)
    if fault == "gap":
        changed["first_sequence_number"] = 5
    elif fault == "generation":
        changed["previous_lease_generation"] = 9
    else:
        changed["previous_lease_id"] = str(uuid4())
    assert (await combined(c, changed)).status_code == 409
    assert await counts(c) == (1, 0)
    await assert_unclaimed(c, changed)
    assert (await combined(c, body)).status_code == 200


@pytest.mark.parametrize("replay", [False, True])
@pytest.mark.parametrize(
    "fault", ["creator", "tenant", "revoked", "completed", "expired", "disabled"]
)
async def test_current_authority_and_retention_gate_new_and_replayed_windows(
    prepared, replay, fault
):
    c, runtime = prepared
    body = await intent(c)
    if replay:
        assert (await combined(c, body)).status_code == 200
    before = await counts(c)
    headers = {}
    t = c.trial
    if fault == "creator":
        headers["X-Scribe-Creator-Actor-ID"] = "another_creator"
    elif fault == "tenant":
        headers["X-Tenant-ID"] = str(uuid4())
    elif fault == "disabled":
        runtime.enabled = False
    elif fault in {"completed", "expired"}:
        # Publish fixed synthetic result metadata directly: no captured audio or
        # speech provider. Retention starts only after a legitimate source exists.
        completion = await t.processing()
        await t.runtime.publish_speech_result(
            tenant_id=t.tenant, session_id=t.draft.id, completion=completion
        )
        if fault == "expired":
            await _expire_normalized_source(t.provider, t.tenant, t.draft.id, admin_url=t.admin_url)
    else:
        async with t.provider.transaction(t.tenant) as store:
            await store.revoke_consent(t.tenant, t.consent.id)
    denied = await combined(c, body, headers=headers)
    assert denied.status_code in (404, 409)
    assert "lease" not in denied.json()
    assert await counts(c) == before
    if not replay:
        await assert_unclaimed(c, body)


async def test_closed_contract_and_changed_outer_or_component_identity_do_not_mutate(prepared):
    c, _ = prepared
    body = await intent(c)
    for field, value in (
        ("creator_actor_id", "untrusted"),
        ("first_sequence_number", True),
        ("previous_lease_generation", True),
        ("first_sequence_number", 2048),
        ("channel", "system_audio"),
        ("renew_idempotency_key", "short"),
        ("renew_idempotency_key", "invalid\x00key"),
        ("reservation_idempotency_key", "invalid\nkey"),
    ):
        assert (await combined(c, {**body, field: value})).status_code == 422
    assert await counts(c) == (1, 0)
    assert (await combined(c, body)).status_code == 200
    changed = {**body, "first_sequence_number": 1}
    assert (await combined(c, changed)).status_code == 409
    assert (await combined(c, changed, key="different-outer-key")).status_code == 409
    assert await counts(c) == (2, 1)
