"""Actual configured grant SQL without Core/API imports or any database.

Run directly; pytest/conftest and service bootstrap are deliberately not loaded.
This source contract check qualifies emitted SQL, not effective deployed rights.
"""

from __future__ import annotations

import ast
import asyncio
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import dialect

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "services/api/src/cosmaneura_scribe/database_bootstrap.py"
TENANT = UUID("00000000-0000-0000-0000-000000000001")
SPEECH = UUID("00000000-0000-0000-0000-000000000002")
TRANSLATION = UUID("00000000-0000-0000-0000-000000000003")


class Connection:
    def __init__(self) -> None:
        self.dialect = dialect()
        self.statements: list[str] = []

    async def execute(self, statement: object) -> None:
        self.statements.append(str(statement))


class Begin(AbstractAsyncContextManager[Connection]):
    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    async def __aenter__(self) -> Connection:
        return self.connection

    async def __aexit__(self, *args: object) -> None:
        return None


class Provider:
    def __init__(self, connection: Connection) -> None:
        self.engine = SimpleNamespace(begin=lambda: Begin(connection))
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def emitted(source: str, *, enabled: bool = True) -> list[str]:
    names = {
        "_grant_configured_worker_permissions",
        "_grant_working_transcript_permissions",
        "_translation_session_scope_policy_name",
        "_quoted_identifier",
    }
    selected = [
        node
        for node in ast.parse(source).body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name in names
    ]
    assert {node.name for node in selected} == names
    connection = Connection()
    provider = Provider(connection)

    def source_provider(settings: object) -> Provider:
        return provider

    namespace: dict[str, Any] = {
        "text": text,
        "UUID": UUID,
        "build_postgres_provider": source_provider,
    }
    # Annotation postponement avoids importing Settings/API/identity/storage.
    module = ast.Module(
        body=[
            ast.ImportFrom(
                module="__future__",
                names=[ast.alias(name="annotations")],
                level=0,
            ),
            *selected,
        ],
        type_ignores=[],
    )
    exec(compile(ast.fix_missing_locations(module), str(SOURCE), "exec"), namespace)
    settings = SimpleNamespace(
        configured_worker_database_permissions_enabled=enabled,
        configured_capture_tenant_ids=frozenset({TENANT}),
        database_transcription_principal_name="synthetic_speech",
        database_transcription_principal_object_id=SPEECH,
        database_translation_principal_name="synthetic_translation",
        database_translation_principal_object_id=TRANSLATION,
        database_runtime_principal_name="synthetic_runtime",
    )
    asyncio.run(namespace["_grant_configured_worker_permissions"](settings))
    assert provider.closed is enabled
    return connection.statements


def required_creator_policies(statements: list[str]) -> None:
    for object_id, role in ((SPEECH, "synthetic_speech"), (TRANSLATION, "synthetic_translation")):
        policy = "scribe_configured_" + object_id.hex + "_cohort"
        assert (
            f"CREATE POLICY {policy} ON creator_transcript_edits AS RESTRICTIVE FOR ALL "
            f"TO {role} USING (tenant_id='{TENANT}'::uuid) "
            f"WITH CHECK (tenant_id='{TENANT}'::uuid)"
        ) in statements
        assert f"DROP POLICY IF EXISTS {policy} ON creator_transcript_edits" in statements


def main() -> None:
    source = SOURCE.read_text()
    current = emitted(source)
    required_creator_policies(current)
    # The preceding source must fail the actual emitted-policy requirement,
    # while all grant SQL and mode/status restrictions remain identical.
    needle = '                "creator_transcript_edits",\n'
    assert source.count(needle) == 1
    original = emitted(source.replace(needle, "", 1))
    try:
        required_creator_policies(original)
    except AssertionError:
        pass
    else:
        raise AssertionError("Pre-fix worker policies unexpectedly fenced creator edits")
    assert [s for s in current if s.startswith("GRANT ")] == [
        s for s in original if s.startswith("GRANT ")
    ]
    additions = [s for s in current if s not in original]
    assert len(additions) == 4
    assert all("synthetic_runtime" not in s for s in additions)
    assert all("tenant_isolation" not in s for s in additions)
    assert all(s in current for s in original)
    assert emitted(source, enabled=False) == []
    print(
        "PASS: exact two worker creator-edit cohort policies; grants/mode/status fences preserved; "
        "default disabled; no database/API/conftest used"
    )


if __name__ == "__main__":
    main()


def test_configured_worker_cohort_source() -> None:
    main()
