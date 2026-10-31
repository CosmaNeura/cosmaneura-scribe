from pathlib import Path
from shutil import copytree
from typing import cast

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from cosmaneura_scribe import database_bootstrap, migrations
from cosmaneura_scribe.settings import Settings
from sqlalchemy.engine import Connection


def test_bundle_bootstrap_selects_scribe_chain_from_core_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = Path(__file__).parents[1]
    bundle = tmp_path / "scribe-migrations"
    bundle.mkdir()
    (bundle / "alembic.ini").write_bytes((source / "alembic.ini").read_bytes())
    copytree(source / "alembic", bundle / "alembic")
    core = tmp_path / "core"
    core.mkdir()
    (core / "alembic.ini").write_text("[alembic]\nscript_location=migrations\n")
    core_versions = core / "migrations/versions"
    core_versions.mkdir(parents=True)
    (core_versions / "core.py").write_text(
        'revision = "3d40e4e90e05"\ndown_revision = None\n'
    )
    monkeypatch.chdir(core)
    monkeypatch.setattr(migrations, "_BUNDLED_MIGRATIONS", bundle, raising=False)
    connection = cast(Connection, object())
    selected: list[Config] = []

    def upgrade(config: Config, target: str) -> None:
        assert target == "head" and config.attributes["connection"] is connection
        assert ScriptDirectory.from_config(config).get_heads() == ["0024"]
        selected.append(config)

    monkeypatch.setattr(migrations.command, "upgrade", upgrade)
    migrations._upgrade(connection)
    assert len(selected) == 1
    assert selected[0].config_file_name == str(bundle / "alembic.ini")


def test_checkout_migration_selection_remains_compatible(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(Path(__file__).parents[1])
    monkeypatch.setattr(migrations, "_BUNDLED_MIGRATIONS", Path("/unavailable-scribe-migrations"))
    assert ScriptDirectory.from_config(migrations._migration_config()).get_heads() == ["0024"]


def test_bootstrap_refuses_core_config_and_incomplete_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "alembic.ini").write_text("[alembic]\nscript_location=migrations\n")
    monkeypatch.chdir(tmp_path)
    missing_bundle = tmp_path / "scribe-migrations"
    monkeypatch.setattr(migrations, "_BUNDLED_MIGRATIONS", missing_bundle)
    with pytest.raises(RuntimeError, match="Scribe migration directory"):
        migrations._migration_config()
    missing_bundle.mkdir()
    with pytest.raises(RuntimeError, match="Scribe migration configuration"):
        migrations._migration_config()


@pytest.mark.asyncio
async def test_bootstrap_refuses_wrong_assets_before_any_principal_or_acl_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(migrations, "_BUNDLED_MIGRATIONS", tmp_path / "missing")

    async def forbidden(_settings: Settings) -> None:
        raise AssertionError("Invalid assets reached principal changes")

    monkeypatch.setattr(database_bootstrap, "_ensure_database_principals", forbidden)
    settings = Settings(_env_file=None, repository_backend="postgres",
                        database_url="postgresql+asyncpg://synthetic:synthetic@localhost/unused")
    with pytest.raises(RuntimeError, match="Scribe migration configuration"):
        await database_bootstrap.bootstrap_database(settings)
