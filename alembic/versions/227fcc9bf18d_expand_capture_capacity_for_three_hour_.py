"""Expand capture sequence capacity without changing retained records.

Revision ID: 227fcc9bf18d
Revises: 0023_unstarted_retirement
"""

from alembic import op

revision = "227fcc9bf18d"
down_revision = "0023_unstarted_retirement"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Fail/roll back the transactional DDL rather than wait on active capture.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '30s'")
    for table, column in (
        ("audio_chunk_reservations", "sequence_number"),
        ("capture_channel_finalizations", "last_sequence_number"),
        ("source_start_attempts", "first_sequence_number"),
        ("source_start_retirements", "first_sequence_number"),
    ):
        name = f"{table}_{column}_check"
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"{column} >= 0 AND {column} < 2048")


def downgrade() -> None:
    raise RuntimeError("expand recovery retains larger capture positions")
