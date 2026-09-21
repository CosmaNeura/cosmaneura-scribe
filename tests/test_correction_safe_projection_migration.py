from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest
from alembic.config import Config
from conftest import APP_ROLE
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command

pytestmark = pytest.mark.postgres

HARDENED_FUNCTIONS = (
    "enforce_normalized_translation_attempt",
    "enforce_normalized_translation_review",
    "enforce_working_child_insert",
    "enforce_working_header_insert",
    "enforce_working_transcript_complete",
)
ROOT = Path(__file__).resolve().parents[1]


async def _function_metadata(
    database_url: str,
) -> dict[str, tuple[str, bool, list[str] | None]]:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            rows = (
                await connection.execute(
                    text(
                        """
                        SELECT procedure.proname,
                               pg_catalog.pg_get_functiondef(procedure.oid),
                               procedure.prosecdef,
                               procedure.proconfig
                        FROM pg_catalog.pg_proc AS procedure
                        JOIN pg_catalog.pg_namespace AS namespace
                          ON namespace.oid = procedure.pronamespace
                        WHERE namespace.nspname = 'public'
                          AND procedure.pronargs = 0
                          AND procedure.proname = ANY(:functions)
                        ORDER BY procedure.proname
                        """
                    ),
                    {"functions": list(HARDENED_FUNCTIONS)},
                )
            ).all()
            return {
                name: (definition, security_definer, configuration)
                for name, definition, security_definer, configuration in rows
            }
    finally:
        await engine.dispose()


async def _public_execute_functions(database_url: str) -> set[str]:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            rows = (
                await connection.execute(
                    text(
                        """
                        SELECT routine_name
                        FROM information_schema.role_routine_grants
                        WHERE routine_schema = 'public'
                          AND grantee = 'PUBLIC'
                          AND privilege_type = 'EXECUTE'
                          AND routine_name = ANY(:functions)
                        """
                    ),
                    {"functions": list(HARDENED_FUNCTIONS)},
                )
            ).all()
            return {row[0] for row in rows}
    finally:
        await engine.dispose()


async def _current_revision(database_url: str) -> str:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
            assert isinstance(revision, str)
            return revision
    finally:
        await engine.dispose()


async def _restore_recreated_test_table_permissions(database_url: str) -> None:
    # This historical downgrade also removes/recreates the later empty job table.
    # Restore only its disposable test-role grant, never runtime/bootstrap grants.
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "GRANT SELECT, INSERT, UPDATE, DELETE "
                    f"ON encrypted_translation_jobs TO {APP_ROLE}"
                )
            )
    finally:
        await engine.dispose()


def _assert_hardened(definitions: dict[str, tuple[str, bool, list[str] | None]]) -> None:
    assert set(definitions) == set(HARDENED_FUNCTIONS)
    for definition, security_definer, configuration in definitions.values():
        assert security_definer is False
        assert configuration == ["search_path=pg_catalog, public"]
        assert "%ROWTYPE" not in definition
        assert re.search(r"\bSELECT\s+\*", definition, re.IGNORECASE) is None
        assert re.search(r"\bsource\.\*", definition, re.IGNORECASE) is None

    complete = definitions["enforce_working_transcript_complete"][0]
    assert "SELECT ordinal, source_segment_id, source_segment_version, code\n" in complete
    assert "FROM expected\n                    EXCEPT" in complete
    assert "FROM actual\n                    EXCEPT" in complete


def test_current_head_uses_only_explicit_trigger_reads(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    definitions = asyncio.run(_function_metadata(admin_url))

    _assert_hardened(definitions)
    assert asyncio.run(_public_execute_functions(admin_url)) == set()


def test_forward_retained_recovery_is_safe_and_reapplicable(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, _ = postgres_urls
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", admin_url)

    before = asyncio.run(_function_metadata(admin_url))
    _assert_hardened(before)
    try:
        command.downgrade(config, "0013")
        assert asyncio.run(_current_revision(admin_url)) == "0013"
        retained = asyncio.run(_function_metadata(admin_url))
        _assert_hardened(retained)
        assert retained == before
        assert asyncio.run(_public_execute_functions(admin_url)) == set()
    finally:
        command.upgrade(config, "head")
        asyncio.run(_restore_recreated_test_table_permissions(admin_url))

    assert asyncio.run(_current_revision(admin_url)) == "0018_translation_jobs"
    reapplied = asyncio.run(_function_metadata(admin_url))
    _assert_hardened(reapplied)
    assert reapplied == before
    assert asyncio.run(_public_execute_functions(admin_url)) == set()


def test_downgrade_is_disposable_database_only() -> None:
    migration = (ROOT / "alembic/versions/0014_correction_safe_projection.py").read_text()
    assert "current_database() !~ '_test$'" in migration


def test_migration_does_not_expand_authority_or_hide_pointer_mutation() -> None:
    migration = (ROOT / "alembic/versions/0014_correction_safe_projection.py").read_text()
    assert "GRANT " not in migration
    assert "CREATE ROLE" not in migration
    assert "SECURITY DEFINER" not in migration
    assert "current_working_transcript_version :=" not in migration
