"""Current-row authorization with real read-only PostgreSQL snapshots, no audio."""

import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import Session
from test_receiver import (
    ROOT,
    AppointmentObservation,
    BoxContext,
    CoreCaptureAccount,
    EncounterWorkspace,
    PatientLink,
    Principal,
    client,
    core_created_opening,
    receiver,
    source_sequence_payload,
)
from test_receiver import (
    engine as engine,
)
from test_receiver import (
    harness as harness,
)


@pytest_asyncio.fixture
async def async_receiver(harness, engine):  # noqa: F811 - imported pytest fixtures
    h = harness
    h.legacy_engine = engine
    h.async_engine = create_async_engine(
        "postgresql+asyncpg:///" + engine.url.database,
        connect_args={
            "host": str(ROOT / "socket"),
            "port": 55483,
            "server_settings": {"statement_timeout": "5000", "lock_timeout": "2000"},
        },
        hide_parameters=True,
    )
    h.receiver.engine = h.async_engine
    try:
        async with h.async_engine.connect():
            pass
        yield h
    finally:
        h.receiver.engine = engine
        await h.async_engine.dispose()


async def selected(h):
    return await h.receiver.registry_read(
        lambda bind: h.receiver.selected(
            h.headers["Authorization"],
            UUID(h.revision),
            UUID(h.workspace),
            bind=bind,
        )
    )


@pytest.mark.asyncio
async def test_trace_identity_spans_survive_actual_async_registry_handoff(async_receiver):
    h = async_receiver
    h.receiver._provider_trace_enabled = True
    workspace, lookups = core_created_opening(h)
    async with client(h) as connection:
        result = await connection.post(
            "/provider/v1/source-start-ready",
            json={
                **source_sequence_payload(h),
                "workspace_id": str(workspace),
            },
        )
    assert result.status_code == 200
    trace = json.loads(result.headers["x-scribe-provider-trace"])
    assert trace["counts"]["selection_check"] == len(lookups) == 6
    assert trace["counts"]["identity_check"] == 24
    assert trace["counts"]["registry"] == 30
    assert len(h.wire.calls) == 3


@pytest.mark.asyncio
async def test_same_authorized_selection_uses_four_queries_instead_of_nine(async_receiver):
    h = async_receiver
    counts = {"legacy": 0, "current": 0}

    def counter(label):
        def count(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.lstrip().upper().startswith("SELECT "):
                counts[label] += 1

        return count

    legacy_counter, current_counter = counter("legacy"), counter("current")
    event.listen(h.legacy_engine, "before_cursor_execute", legacy_counter)
    event.listen(h.async_engine.sync_engine, "before_cursor_execute", current_counter)
    try:
        h.receiver.engine = h.legacy_engine
        expected = h.receiver.selected(
            h.headers["Authorization"],
            UUID(h.revision),
            UUID(h.workspace),
        )
        h.receiver.engine = h.async_engine
        assert await selected(h) == expected
    finally:
        h.receiver.engine = h.async_engine
        event.remove(h.legacy_engine, "before_cursor_execute", legacy_counter)
        event.remove(h.async_engine.sync_engine, "before_cursor_execute", current_counter)
    assert counts == {"legacy": 9, "current": 4}


@pytest.mark.asyncio
async def test_actual_transaction_is_read_only_repeatable_read(async_receiver):
    h = async_receiver
    observed = await h.receiver.registry_read(
        lambda bind: (
            bind.scalar(text("SHOW transaction_read_only")),
            bind.scalar(text("SHOW transaction_isolation")),
        )
    )
    assert observed == ("on", "repeatable read")

    def read_identity(bind):
        with Session(bind) as session:
            return h.receiver.identity(session, h.headers["Authorization"])

    identity = await h.receiver.registry_read(read_identity)
    with Session(h.legacy_engine) as session:
        with pytest.raises(receiver.InvalidRequest):
            h.receiver.read_only_appointment(session, identity, UUID(h.workspace))
    with h.legacy_engine.connect() as bind, Session(bind) as session:
        with pytest.raises(receiver.InvalidRequest):
            h.receiver.read_only_appointment(session, identity, UUID(h.workspace))


def revoke(h, kind):
    if kind == "workspace_owner":
        actor = str(uuid4())
        with Session(h.legacy_engine) as session:
            session.add(
                Principal(
                    id=actor,
                    box_id=h.box,
                    principal_type="human",
                    state="active",
                    display_name="Invented replacement owner",
                )
            )
            session.commit()
        h.mutate(EncounterWorkspace, h.workspace, owner_id=actor)
        return
    cases = {
        "account": (CoreCaptureAccount, h.account, {"revoked_at": datetime.now(UTC)}),
        "principal_state": (Principal, h.actor, {"state": "inactive"}),
        "principal_type": (Principal, h.actor, {"principal_type": "bot"}),
        "principal_deleted": (Principal, h.actor, {"tombstoned_at": datetime.now(UTC)}),
        "appointment_source": (AppointmentObservation, h.appointment, {"source": "synthetic"}),
        "link_state": (PatientLink, h.link, {"state": "pending"}),
        "link_revoked": (PatientLink, h.link, {"revoked_at": datetime.now(UTC)}),
    }
    model, row, changes = cases[kind]
    h.mutate(model, row, **changes)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "account",
        "principal_state",
        "principal_type",
        "principal_deleted",
        "workspace_owner",
        "appointment_source",
        "link_state",
        "link_revoked",
    ],
)
async def test_joined_selection_denies_invalid_current_rows_before_core(async_receiver, kind):
    h = async_receiver
    payload = source_sequence_payload(h)
    revoke(h, kind)
    async with client(h) as c:
        result = await c.post("/provider/v1/source-start-ready", json=payload)
    assert result.status_code == 403 and not h.wire.calls
    assert "preparation" not in result.json()


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["other_owner", "other_box", "missing"])
async def test_read_only_route_denies_foreign_or_missing_workspace(async_receiver, target):
    h = async_receiver
    wid = str(uuid4())
    with Session(h.legacy_engine) as session:
        if target == "other_owner":
            wid = session.scalar(
                select(EncounterWorkspace.id).where(
                    EncounterWorkspace.owner_id == h.other,
                )
            )
        elif target == "other_box":
            box, actor, link, appointment = (str(uuid4()) for _ in range(4))
            session.add(BoxContext(id=box, display_name="Invented other box"))
            session.flush()
            session.add(
                Principal(
                    id=actor,
                    box_id=box,
                    principal_type="human",
                    state="active",
                    display_name="Invented other owner",
                )
            )
            session.add(
                PatientLink(
                    id=link,
                    box_id=box,
                    source_pair_key=str(uuid4()),
                    label="Invented other visit",
                    state="confirmed",
                )
            )
            session.flush()
            session.add(
                AppointmentObservation(
                    id=appointment,
                    box_id=box,
                    external_id="appointment_01j00000000000000000000000",
                    source="cosmaneura_core",
                    start_at=datetime.now(UTC),
                    patient_label="Invented other visit",
                    patient_link_id=link,
                )
            )
            session.flush()
            session.add(
                EncounterWorkspace(
                    id=wid,
                    box_id=box,
                    owner_id=actor,
                    appointment_id=appointment,
                    patient_link_id=link,
                    create_key=str(uuid4()),
                )
            )
            session.commit()
    payload = {**source_sequence_payload(h), "workspace_id": wid}
    async with client(h) as c:
        result = await c.post("/provider/v1/source-start-ready", json=payload)
    assert result.status_code == 403 and not h.wire.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", [1, 2, 3])
@pytest.mark.parametrize("kind", ["account", "workspace_owner", "link_revoked"])
async def test_new_snapshot_observes_committed_revocation_after_each_core_io(
    async_receiver,
    boundary,
    kind,
):
    h = async_receiver
    payload = source_sequence_payload(h)

    def after(_path):
        if len(h.wire.calls) == boundary:
            revoke(h, kind)

    h.wire.after = after
    async with client(h) as c:
        result = await c.post("/provider/v1/source-start-ready", json=payload)
    assert result.status_code == 403
    assert "preparation" not in result.json() and "authorization" not in result.json()
    assert len(h.wire.calls) == boundary


@pytest.mark.asyncio
async def test_source_sequence_keeps_original_keys_nonces_and_three_core_calls(async_receiver):
    h = async_receiver
    payload = source_sequence_payload(h)
    async with client(h) as c:
        result = await c.post("/provider/v1/source-start-ready", json=payload)
    assert result.status_code == 200
    assert result.json()["preparation"]["request_nonce"] == payload["request_nonce"]
    assert result.json()["authorization"]["request_nonce"] == payload["authorize_request_nonce"]
    assert len(h.wire.calls) == 3 and h.wire.operations == ["source_start_sequence"]
