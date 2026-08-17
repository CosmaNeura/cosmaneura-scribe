"""Unify runtime and database session status transitions.

Revision ID: 0005
Revises: 0004
"""

from cosmaneura_scribe.session_state_v1 import (
    render_status_values,
    render_transition_predicate,
)

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

PREVIOUS_TRANSITION_PREDICATE = """
OLD.status = NEW.status
OR (OLD.status = 'created' AND NEW.status IN ('capturing', 'failed'))
OR (OLD.status = 'capturing' AND NEW.status IN ('uploaded', 'failed'))
OR (OLD.status = 'uploaded' AND NEW.status IN ('processing', 'transcript_ready', 'failed'))
OR (OLD.status = 'processing' AND NEW.status IN ('transcript_ready', 'failed'))
OR (OLD.status = 'transcript_ready' AND NEW.status IN ('handed_off', 'failed'))
OR (OLD.status = 'handed_off' AND NEW.status = 'failed')
""".strip()
PREVIOUS_STATUS_VALUES = (
    "'created', 'capturing', 'uploaded', 'processing', 'transcript_ready', 'handed_off', 'failed'"
)


def _transition_function(predicate: str) -> str:
    return f"""
        CREATE OR REPLACE FUNCTION enforce_scribe_session_status_transition()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF {predicate} THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'invalid scribe session status transition: % -> %',
                OLD.status, NEW.status
                USING ERRCODE = '23514';
        END;
        $$
    """


def _replace_status_constraint(status_values: str) -> None:
    op.execute("ALTER TABLE scribe_sessions DROP CONSTRAINT IF EXISTS scribe_sessions_status_check")
    op.execute(
        "ALTER TABLE scribe_sessions "
        f"ADD CONSTRAINT scribe_sessions_status_check CHECK (status IN ({status_values}))"
    )


def upgrade() -> None:
    op.execute(_transition_function(render_transition_predicate()))
    _replace_status_constraint(render_status_values())


def downgrade() -> None:
    op.execute(_transition_function(PREVIOUS_TRANSITION_PREDICATE))
    _replace_status_constraint(PREVIOUS_STATUS_VALUES)
