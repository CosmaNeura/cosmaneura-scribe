from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest
from cosmaneura_scribe.session_state_v1 import (
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
