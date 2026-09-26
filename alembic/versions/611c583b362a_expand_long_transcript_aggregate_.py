"""Expand long transcript aggregate capacity

Revision ID: 611c583b362a
Revises: 227fcc9bf18d
Create Date: 2026-09-25 22:17:16.893969
"""

from alembic import op

revision = "611c583b362a"
down_revision = "227fcc9bf18d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '30s'")
    for table, name, lower, upper in (
        (
            "normalized_source_transcripts",
            "normalized_source_transcripts_total_content_chars_check",
            1,
            500000,
        ),
        ("normalized_working_transcripts", "ck_working_transcript_content_size", 0, 1000000),
    ):
        op.drop_constraint(name, table, type_="check", schema="public")
        op.create_check_constraint(
            name, table, f"total_content_chars BETWEEN {lower} AND {upper}", schema="public"
        )


def downgrade() -> None:
    raise RuntimeError("expand recovery retains larger transcript capacity")
