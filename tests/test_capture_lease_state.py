"""Lease observation never issues or renews capture authority."""

import asyncio
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from cosmaneura_scribe.configured_capture_service import (
    bind_configured_capture_service,
    unbind_configured_capture_service,
)
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.repository import CaptureLeaseCloseReason
from cosmaneura_scribe.settings import Settings
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from test_capture_protocol_api import _create_capture_session, _headers, _issue_lease
from test_capture_protocol_api import capture_client as capture_client

from alembic import command


def test_observe_missing_current_closed_and_foreign_lease(capture_client, repository_backend):
    tenant = uuid4()
    session = _create_capture_session(capture_client, tenant, "lease-state")
    path = f"/v1/sessions/{session['id']}/capture-lease-state"
    empty = capture_client.get(path, headers=_headers(tenant))
    assert empty.status_code == 200
    assert empty.json()["current_lease"] is None and not empty.json()["lease_closed"]
    lease = _issue_lease(capture_client, tenant, session["id"], "lease-state")
    assert capture_client.get(path, headers=_headers(tenant)).json()["current_lease"] == lease
    assert capture_client.get(path, headers=_headers(uuid4())).status_code == 404

    async def close():
        async with repository_backend.provider.transaction(tenant) as store:
            assert await store.close_capture_lease(
                tenant,
                UUID(session["id"]),
                expected_lease_id=UUID(lease["lease_id"]),
                expected_generation=lease["generation"],
                reason=CaptureLeaseCloseReason.CAPTURE_STOPPED,
            )

    repository_backend.portal.call(close)
    closed = capture_client.get(path, headers=_headers(tenant))
    assert closed.status_code == 200
    assert closed.json()["lease_closed"] and closed.json()["current_lease"] == lease


def test_lease_observation_is_default_off(client):
    assert (
        client.get(
            f"/v1/sessions/{uuid4()}/capture-lease-state", headers=_headers(uuid4())
        ).status_code
        == 503
    )


@pytest.mark.postgres
def test_configured_binding_and_expand_recovery(postgres_urls):
    settings = Settings(
        configured_capture_enabled=True,
        configured_capture_tenant_ids=frozenset({uuid4()}),
        capture_protocol_enabled=True,
        repository_backend="postgres",
        database_ssl=False,
        database_url=postgres_urls[0],
        workflow_authentication_enabled=True,
        entra_tenant_id=uuid4(),
        workflow_api_audience=str(uuid4()),
        trusted_platform_client_id=uuid4(),
    )
    provider = build_postgres_provider(settings)
    app = FastAPI()
    bind_configured_capture_service(app, settings, provider)
    assert not hasattr(app.state, "source_extension_runtime")
    bind_configured_capture_service(
        app, settings.model_copy(update={"configured_capture_continuation_enabled": True}), provider
    )
    assert app.state.source_extension_runtime.enabled
    assert app.state.source_extension_runtime.tenant_ids == settings.configured_capture_tenant_ids
    unbind_configured_capture_service(app)
    assert not hasattr(app.state, "source_extension_runtime")
    asyncio.run(provider.close())

    async def retained_state():
        engine = create_async_engine(postgres_urls[0], connect_args={"ssl": False})
        try:
            async with engine.connect() as connection:
                version = await connection.scalar(text("SELECT version_num FROM alembic_version"))
                count = await connection.scalar(
                    text("SELECT count(*) FROM source_start_extensions")
                )
                fences = (
                    await connection.execute(
                        text(
                            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                            "WHERE oid='source_start_extensions'::regclass"
                        )
                    )
                ).one()
                return version, count, tuple(fences)
        finally:
            await engine.dispose()

    before = asyncio.run(retained_state())
    assert before[0] == "b0d93127cafe" and before[2] == (True, True)
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", postgres_urls[0])
    with pytest.raises(RuntimeError, match="retains dormant native extension history"):
        command.downgrade(config, "611c583b362a")
    assert asyncio.run(retained_state()) == before
