from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest
from cosmaneura_scribe.session_state_v1 import (
    SESSION_STATUS_TRANSITIONS,
    SessionIngestMode,
    SessionStatus,
    can_transition_session,
    render_status_values,
    render_transition_predicate,
)


def _load_migration_0005() -> Any:
    path = Path(__file__).parents[1] / "alembic/versions/0005_session_status_transitions.py"
    spec = spec_from_file_location("migration_0005_session_status_transitions", path)
    assert spec is not None and spec.loader is not None
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _load_migration_0008() -> Any:
    path = Path(__file__).parents[1] / "alembic/versions/0008_external_async_transcript.py"
    spec = spec_from_file_location("migration_0008_external_async_transcript", path)
    assert spec is not None and spec.loader is not None
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _normalize_sql(value: str) -> str:
    return " ".join(value.split())


def test_v1_transition_predicate_is_pinned() -> None:
    assert render_transition_predicate() == (
        "OLD.status = NEW.status\n"
        "                OR (OLD.status = 'created' AND NEW.status IN ('capturing', 'failed'))\n"
        "                OR (OLD.status = 'capturing' AND NEW.status IN ('uploaded', 'failed'))\n"
        "                OR (OLD.status = 'uploaded' AND NEW.status IN "
        "('processing', 'transcript_ready', 'failed'))\n"
        "                OR (OLD.status = 'processing' AND NEW.status IN "
        "('transcript_ready', 'failed'))\n"
        "                OR (OLD.status = 'transcript_ready' AND NEW.status IN "
        "('handed_off', 'failed'))\n"
        "                OR (OLD.status = 'handed_off' AND NEW.status IN ('failed'))\n"
        "                OR (OLD.status = 'failed' AND NEW.status IN ('uploaded'))"
    )


def test_v1_status_values_are_pinned() -> None:
    assert render_status_values() == (
        "'created', 'capturing', 'uploaded', 'processing', "
        "'transcript_ready', 'handed_off', 'failed'"
    )


@pytest.mark.parametrize("old", SessionStatus)
@pytest.mark.parametrize("new", SessionStatus)
def test_default_ingest_mode_preserves_every_v1_transition(
    old: SessionStatus,
    new: SessionStatus,
) -> None:
    expected = old == new or new in SESSION_STATUS_TRANSITIONS[old]

    assert can_transition_session(old, new) is expected
    assert (
        can_transition_session(
            old,
            new,
            ingest_mode=SessionIngestMode.CHUNK_UPLOAD,
        )
        is expected
    )


@pytest.mark.parametrize("old", SessionStatus)
@pytest.mark.parametrize("new", SessionStatus)
def test_external_async_mode_adds_only_direct_transcript_delivery(
    old: SessionStatus,
    new: SessionStatus,
) -> None:
    expected = (
        old == new
        or new in SESSION_STATUS_TRANSITIONS[old]
        or (old == SessionStatus.CREATED and new == SessionStatus.TRANSCRIPT_READY)
    )

    assert (
        can_transition_session(
            old,
            new,
            ingest_mode=SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
        )
        is expected
    )


def test_external_async_transition_predicate_is_explicitly_guarded() -> None:
    predicate = render_transition_predicate(ingest_mode_expression="OLD.ingest_mode")

    assert (
        "OLD.ingest_mode = 'external_async_transcript' AND OLD.status = 'created' "
        "AND NEW.status = 'transcript_ready'"
    ) in predicate
    assert "external_async_transcript" not in render_transition_predicate()


def test_0008_predicates_are_pinned_to_the_domain_contract() -> None:
    migration = _load_migration_0008()

    assert _normalize_sql(migration.CHUNK_UPLOAD_TRANSITION_PREDICATE) == _normalize_sql(
        render_transition_predicate()
    )
    assert _normalize_sql(migration.INGEST_MODE_TRANSITION_PREDICATE) == _normalize_sql(
        render_transition_predicate(ingest_mode_expression="OLD.ingest_mode")
    )


def test_0008_upgrade_and_downgrade_are_schema_only_and_default_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migration = _load_migration_0008()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    assert len(statements) == 6
    assert statements[0] == "SET LOCAL lock_timeout = '5s'"
    assert statements[1] == "SET LOCAL statement_timeout = '60s'"
    assert "ingest_mode text NOT NULL DEFAULT 'chunk_upload'" in statements[2]
    assert "scribe_sessions_ingest_mode_check" in statements[2]
    assert "OLD.ingest_mode = 'external_async_transcript'" in statements[3]
    assert "reject_scribe_session_ingest_mode_mutation" in statements[4]
    assert "scribe_sessions_ingest_mode_immutable" in statements[5]
    assert "consent" not in " ".join(statements).lower()

    statements.clear()
    migration.downgrade()

    assert len(statements) == 8
    assert statements[0] == "SET LOCAL lock_timeout = '5s'"
    assert statements[1] == "SET LOCAL statement_timeout = '60s'"
    assert "refusing to remove ingest_mode" in statements[2]
    assert "external_async_transcript" in statements[2]
    assert "OLD.ingest_mode" not in statements[3]
    assert statements[-1] == "ALTER TABLE scribe_sessions DROP COLUMN IF EXISTS ingest_mode"


def test_0005_downgrade_restores_previous_trigger_and_status_constraint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migration = _load_migration_0005()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.downgrade()

    assert len(statements) == 3
    assert "OLD.status = 'handed_off' AND NEW.status = 'failed'" in statements[0]
    assert "OLD.status = 'failed'" not in statements[0]
    assert statements[1] == (
        "ALTER TABLE scribe_sessions DROP CONSTRAINT IF EXISTS scribe_sessions_status_check"
    )
    assert statements[2] == (
        "ALTER TABLE scribe_sessions ADD CONSTRAINT scribe_sessions_status_check "
        "CHECK (status IN ('created', 'capturing', 'uploaded', 'processing', "
        "'transcript_ready', 'handed_off', 'failed'))"
    )
