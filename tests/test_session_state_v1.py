from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest
from cosmaneura_scribe.session_state_v1 import (
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


def test_external_async_transcript_has_one_additive_direct_transition() -> None:
    assert not can_transition_session(SessionStatus.CREATED, SessionStatus.TRANSCRIPT_READY)
    assert can_transition_session(
        SessionStatus.CREATED,
        SessionStatus.TRANSCRIPT_READY,
        ingest_mode=SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
    )
    assert not can_transition_session(
        SessionStatus.CREATED,
        SessionStatus.UPLOADED,
        ingest_mode=SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
    )


def test_external_async_transcript_predicate_is_explicitly_guarded() -> None:
    predicate = render_transition_predicate(ingest_mode_expression="OLD.ingest_mode")

    assert (
        "OLD.ingest_mode = 'external_async_transcript' AND OLD.status = 'created' "
        "AND NEW.status = 'transcript_ready'"
    ) in predicate
    assert "external_async_transcript" not in render_transition_predicate()


def test_0008_upgrade_and_downgrade_preserve_rolling_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migration = _load_migration_0008()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    assert len(statements) == 6
    assert "ingest_mode text NOT NULL DEFAULT 'chunk_upload'" in statements[0]
    assert "external_async_transcript" in statements[0]
    assert "OLD.ingest_mode = 'external_async_transcript'" in statements[1]
    assert "reject_scribe_session_ingest_mode_mutation" in statements[2]
    assert "scribe_sessions_ingest_mode_immutable" in statements[3]
    assert "enforce_consent_revocation" in statements[4]
    assert "consent_records_revocation_immutable" in statements[5]

    statements.clear()
    migration.downgrade()

    assert len(statements) == 7
    assert "OLD.ingest_mode" not in statements[0]
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
