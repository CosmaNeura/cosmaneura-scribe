"""Expanded sequence constraints stay bounded and retain reader recovery."""

from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_all_sequence_constraints_are_validated_and_bounded(postgres_urls) -> None:
    engine = create_async_engine(postgres_urls[0], connect_args={"ssl": False})
    try:
        async with engine.connect() as connection:
            constraints = (
                await connection.execute(
                    text("""
                SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
                FROM pg_constraint WHERE conname IN (
                    'audio_chunk_reservations_sequence_number_check',
                    'capture_channel_finalizations_last_sequence_number_check',
                    'source_start_attempts_first_sequence_number_check',
                    'source_start_retirements_first_sequence_number_check'
                )
            """)
                )
            ).all()
            assert len(constraints) == 4
            for name, validated, definition in constraints:
                assert validated, name
                assert ">= 0" in definition and "< 2048" in definition, name
    finally:
        await engine.dispose()


def test_expand_recovery_keeps_compatible_schema() -> None:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    revision = ScriptDirectory.from_config(config).get_revision("227fcc9bf18d")
    assert revision is not None
    with pytest.raises(RuntimeError, match="retains larger capture positions"):
        revision.module.downgrade()
