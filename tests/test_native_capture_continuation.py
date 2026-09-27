"""Actual receiver, durable renewal chain and original-owner Stop; invented data only."""

from contextlib import asynccontextmanager
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from conftest import verified_test_tenant
from cosmaneura_scribe.capture_protocol_v1 import MAX_CHUNKS
from cosmaneura_scribe.main import app, get_repository_provider
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings, get_settings
from cosmaneura_scribe.source_extension_contract import SourceExtensionIntent
from cosmaneura_scribe.source_extension_runtime import (
    SourceExtensionRepository,
    SourceExtensionRepositoryProvider,
    SourceExtensionRuntime,
)
from pydantic import ValidationError
from sqlalchemy.exc import DBAPIError
from test_source_start_configured_acl import Scope, _act
from test_source_start_configured_acl import scope as scope

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


@asynccontextmanager
async def receiver(scope, trial):
    settings = Settings(
        capture_protocol_enabled=True,
        repository_backend="postgres",
        database_url=scope.settings.database_url,
        database_ssl=False,
        workflow_authentication_enabled=True,
        entra_tenant_id=uuid4(),
        workflow_api_audience=str(uuid4()),
        trusted_platform_client_id=uuid4(),
    )
    overrides = dict(app.dependency_overrides)
    prior = getattr(app.state, "source_extension_runtime", None)
    app.dependency_overrides.update(
        {
            get_repository_provider: lambda: trial.provider,
            get_settings: lambda: settings,
            get_verified_tenant_id: verified_test_tenant,
        }
    )
    app.state.source_extension_runtime = SourceExtensionRuntime(
        SourceExtensionRepositoryProvider(scope.runtime),
        tenant_ids=frozenset({scope.tenant}),
        enabled=True,
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://synthetic.invalid",
            headers={
                "X-Tenant-ID": str(trial.tenant),
                "X-Scribe-Creator-Actor-ID": trial.draft.creator_actor_id,
            },
        ) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(overrides)
        delattr(app.state, "source_extension_runtime")
        if prior is not None:
            app.state.source_extension_runtime = prior


async def pending(scope, trial, owner, client, *, previous=None, first=80, channel="mixed"):
    generation = previous["receipt"]["lease_generation"] if previous else owner.lease_generation
    prefix = f"/v1/sessions/{trial.draft.id}"
    lease = await client.post(
        f"{prefix}/capture-leases/{owner.lease_id}/renew",
        json={"protocol_version": "1.0", "expected_generation": generation},
        headers={"Idempotency-Key": f"renew-{generation:08}"},
    )
    assert lease.status_code == 200, lease.text
    renewed = lease.json()
    batch = await client.post(
        f"{prefix}/chunk-reservations",
        json={
            "protocol_version": "1.0",
            "capture_lease_id": renewed["lease_id"],
            "capture_lease_generation": renewed["generation"],
            "channel": channel,
            "first_sequence_number": first,
            "count": 90,
        },
        headers={"Idempotency-Key": f"batch-{generation:08}"},
    )
    assert batch.status_code == 201, batch.text
    original = owner.model_dump(mode="json")
    original["owner_proof"] = owner.owner_proof.get_secret_value()
    return {
        "schema_version": "1.0",
        "owner": original,
        "previous_extension_id": previous["receipt"]["extension_id"] if previous else None,
        "lease_receipt_id": renewed["receipt_id"],
        "lease_generation": renewed["generation"],
        "capture_authorized_until": renewed["expires_at"],
        "reservation_batch_id": batch.json()["batch_id"],
        "first_sequence_number": first,
        "reservation_count": 90,
    }, renewed


async def extend(client, trial, body, key="native-extension-0001", **headers):
    return await client.post(
        f"/v1/captured-sessions/{trial.draft.id}/source-extension",
        json=body,
        headers={"Idempotency-Key": key, **headers},
    )


async def issued(scope, *, count=90):
    trial, owner = await scope.capture(reservation_count=count)
    await _act(scope.source(), trial, owner, "prepare")
    await _act(scope.source(), trial, owner, "authorize")
    return trial, owner


async def test_two_renewals_replay_and_original_owner_stop(scope: Scope):
    trial, owner = await issued(scope)
    async with receiver(scope, trial) as client:
        body, lease = await pending(scope, trial, owner, client)
        first = await extend(client, trial, body)
        assert first.status_code == 200, first.text
        assert first.headers["cache-control"] == "no-store"
        assert first.json()["secret"] == owner.owner_proof.get_secret_value()
        assert (await extend(client, trial, body)).json() == first.json()
        assert (
            await extend(client, trial, body, "native-extension-new-key")
        ).json() == first.json()
        view = await client.get(f"/v1/sessions/{trial.draft.id}/capture-lease-state")
        assert view.status_code == 200
        assert view.json()["current_lease"] == lease and not view.json()["lease_closed"]
        second_body, _ = await pending(
            scope, trial, owner, client, previous=first.json(), first=160
        )
        second = await extend(client, trial, second_body, "native-extension-0002")
        assert second.status_code == 200, second.text
        assert (
            second.json()["receipt"]["source_start_id"]
            == first.json()["receipt"]["source_start_id"]
        )
        assert (
            second.json()["receipt"]["previous_extension_id"]
            == first.json()["receipt"]["extension_id"]
        )
        stopped = await _act(scope.source(), trial, owner, "stop")
        assert stopped.state == "stopped"
        assert (await extend(client, trial, second_body, "retry-after-stop")).status_code == 404
    rows = await scope.query(
        scope.runtime,
        scope.tenant,
        "SELECT count(*) FROM source_start_extensions "
        "WHERE tenant_id=:tenant AND session_id=:session",
        tenant=scope.tenant,
        session=trial.draft.id,
    )
    assert rows.scalar_one() == 2
    assert (
        await scope.query(
            scope.runtime,
            uuid4(),
            "SELECT count(*) FROM source_start_extensions WHERE session_id=:session",
            session=trial.draft.id,
        )
    ).scalar_one() == 0
    for sql in (
        "UPDATE source_start_extensions SET lease_generation=20 WHERE session_id=:session",
        "DELETE FROM source_start_extensions WHERE session_id=:session",
    ):
        with pytest.raises(DBAPIError):
            await scope.query(scope.admin, scope.tenant, sql, session=trial.draft.id)
    for engine in (scope.speech, scope.translation):
        with pytest.raises(DBAPIError):
            await scope.query(engine, scope.tenant, "SELECT * FROM source_start_extensions")


@pytest.mark.parametrize(
    "mutation", ["batch", "first", "count", "proof", "creator", "tenant", "previous"]
)
async def test_mismatched_authority_or_reservations_cannot_extend(scope: Scope, mutation):
    trial, owner = await issued(scope)
    async with receiver(scope, trial) as client:
        body, _ = await pending(scope, trial, owner, client)
        headers = {}
        if mutation == "batch":
            body["reservation_batch_id"] = str(uuid4())
        elif mutation == "first":
            body["first_sequence_number"] = 81
        elif mutation == "count":
            body["reservation_count"] = 89
        elif mutation == "proof":
            body["owner"]["owner_proof"] = "b" * 64
        elif mutation == "creator":
            headers["X-Scribe-Creator-Actor-ID"] = "invented-other-creator"
        elif mutation == "tenant":
            headers["X-Tenant-ID"] = str(uuid4())
        else:
            body["previous_extension_id"] = str(uuid4())
        response = await extend(client, trial, body, **headers)
        assert response.status_code in {404, 409}, response.text
        assert owner.owner_proof.get_secret_value() not in response.text
    assert (
        await scope.query(
            scope.admin,
            scope.tenant,
            "SELECT count(*) FROM source_start_extensions "
            "WHERE tenant_id=:tenant AND session_id=:session",
            tenant=scope.tenant,
            session=trial.draft.id,
        )
    ).scalar_one() == 0


async def test_wrong_channel_and_revoked_consent_are_rejected(scope: Scope):
    trial, owner = await issued(scope)
    async with receiver(scope, trial) as client:
        body, lease = await pending(scope, trial, owner, client)
        wrong_channel = await client.post(
            f"/v1/sessions/{trial.draft.id}/chunk-reservations",
            json={
                "protocol_version": "1.0",
                "capture_lease_id": lease["lease_id"],
                "capture_lease_generation": lease["generation"],
                "channel": "microphone",
                "first_sequence_number": 80,
                "count": 90,
            },
            headers={"Idempotency-Key": "wrong-channel-batch"},
        )
        assert wrong_channel.status_code == 409
        async with trial.provider.transaction(trial.tenant) as store:
            await store.revoke_consent(trial.tenant, trial.consent.id)
        assert (await extend(client, trial, body)).status_code == 404
        assert (
            await client.get(f"/v1/sessions/{trial.draft.id}/capture-lease-state")
        ).status_code in {403, 404, 409}
        assert (await _act(scope.source(), trial, owner, "stop")).state == "stopped"


async def test_expired_capability_replay_does_not_refresh_or_write(scope: Scope, monkeypatch):
    trial, owner = await issued(scope)
    async with receiver(scope, trial) as client:
        body, _ = await pending(scope, trial, owner, client)
        response = await extend(client, trial, body)
        assert response.status_code == 200, response.text
        clock = SourceExtensionRepository._now

        async def later(self):
            return await clock(self) + timedelta(seconds=16)

        monkeypatch.setattr(SourceExtensionRepository, "_now", later)
        assert (await extend(client, trial, body)).status_code == 409
    assert (
        await scope.query(
            scope.runtime,
            scope.tenant,
            "SELECT count(*) FROM source_start_extensions WHERE session_id=:session",
            session=trial.draft.id,
        )
    ).scalar_one() == 1


async def test_current_scribe_capacity_and_masked_validation(scope: Scope):
    trial, owner = await issued(scope, count=1081)
    async with receiver(scope, trial) as client:
        body, _ = await pending(scope, trial, owner, client, first=1080)
        response = await extend(client, trial, body)
        assert response.status_code == 200, response.text
        assert response.json()["receipt"]["maximum_sequence_number"] == 1169
        model = SourceExtensionIntent.model_validate(body)
        assert "a" * 64 not in model.model_dump_json() and "a" * 64 not in repr(model)
        body["reservation_count"] = True
        response = await extend(client, trial, body, "invalid-extension-0001")
        assert response.status_code == 422 and "a" * 64 not in response.text
        body.update(reservation_count=90, first_sequence_number=MAX_CHUNKS - 1)
        with pytest.raises(ValidationError):
            SourceExtensionIntent.model_validate(body)


async def test_extension_runtime_is_default_off(scope: Scope):
    trial, owner = await issued(scope)
    async with receiver(scope, trial) as client:
        body, _ = await pending(scope, trial, owner, client)
        app.state.source_extension_runtime.enabled = False
        assert (await extend(client, trial, body)).status_code == 404
        delattr(app.state, "source_extension_runtime")
        try:
            assert (await extend(client, trial, body)).status_code == 404
        finally:
            app.state.source_extension_runtime = None
    with pytest.raises(ValidationError, match="native continuation requires configured capture"):
        Settings(configured_capture_continuation_enabled=True)
