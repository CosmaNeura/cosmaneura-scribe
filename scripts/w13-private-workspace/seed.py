"""Create only the six required tables in the newly owned Unix-socket database."""

from __future__ import annotations

from datetime import UTC, datetime

from cosmas_os.db import Base
from cosmas_os.models import (
    AppointmentObservation,
    BoxContext,
    EncounterWorkspace,
    ExternalIdentity,
    PatientLink,
    Principal,
)
from server import CONFIG, ROOT, engine
from sqlalchemy import inspect
from sqlalchemy.orm import Session

if engine.url.database != "w13_connection_test" or not (ROOT / "pg/PG_VERSION").is_file():
    raise RuntimeError("Not the newly owned runtime database")
if inspect(engine).get_table_names():
    raise RuntimeError("Refusing to reseed an existing schema")
tables = [
    BoxContext,
    Principal,
    ExternalIdentity,
    PatientLink,
    AppointmentObservation,
    EncounterWorkspace,
]
Base.metadata.create_all(engine, tables=[model.__table__ for model in tables])
with Session(engine) as session:
    session.add(BoxContext(id=CONFIG["box"], display_name="W13 isolated synthetic connection"))
    session.flush()
    session.add(
        Principal(
            id=CONFIG["actor"],
            box_id=CONFIG["box"],
            principal_type="human",
            display_name="Tester",
            state="active",
            is_owner=True,
        )
    )
    session.flush()
    session.add(
        ExternalIdentity(
            box_id=CONFIG["box"],
            principal_id=CONFIG["actor"],
            provider="clerk",
            issuer=CONFIG["issuer"],
            subject=CONFIG["subject"],
            organization_id=CONFIG["organization"],
            reviewed_by="owner-selected Tester",
            evidence_ref="W13 selected development account; dashboard readback 2026-09-22",
        )
    )
    link = PatientLink(
        box_id=CONFIG["box"],
        source_pair_key="w13-owned-connection",
        label="Invented connection visit",
        state="confirmed",
        confirmed_by_principal_id=CONFIG["actor"],
        attested_at=datetime.now(UTC),
    )
    session.add(link)
    session.flush()
    session.add(
        AppointmentObservation(
            box_id=CONFIG["box"],
            external_id="w13-owned-connection",
            source="synthetic",
            start_at=datetime.now(UTC),
            patient_label="Invented connection visit",
            patient_link_id=link.id,
        )
    )
    session.commit()
print("Prepared six local tables, one reviewed Tester binding and one invented encounter.")
