"""Permit a new native interval after a background-uploaded chunk.

Revision ID: e9c4b7220d31
Revises: b0d93127cafe
"""

from alembic import op

revision = "e9c4b7220d31"
down_revision = "b0d93127cafe"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Replace exactly one predicate in the installed history guard. Preserve
    # its consent/creator/lease checks, immutable history and function identity.
    op.execute("""
DO $$
DECLARE definition text; previous text := 's.status = ''created''';
BEGIN
    SELECT pg_get_functiondef('public.enforce_source_start_history()'::regprocedure)
        INTO STRICT definition;
    IF length(definition) - length(replace(definition, previous, ''))
       <> length(previous) THEN
        RAISE EXCEPTION 'unexpected native source history predicate';
    END IF;
    EXECUTE replace(definition, previous, 's.status IN (''created'', ''capturing'')');
END;
$$;
    """)


def downgrade() -> None:
    raise RuntimeError("expand recovery retains native resume history")
