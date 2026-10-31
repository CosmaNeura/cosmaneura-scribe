from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.engine import Connection

from alembic import command

from .postgres_repository import build_postgres_provider
from .settings import Settings, get_settings

_BUNDLED_MIGRATIONS = Path("/opt/scribe/migrations")


def _migration_config() -> Config:
    # A paired image retains Core's cwd and Core's alembic.ini. Select only
    # Scribe's separately packaged assets, with the ordinary checkout fallback.
    root = _BUNDLED_MIGRATIONS if _BUNDLED_MIGRATIONS.exists() else Path.cwd()
    config_path = root / "alembic.ini"
    if not config_path.is_file() or config_path.is_symlink():
        raise RuntimeError("Scribe migration configuration is unavailable")
    config = Config(str(config_path))
    if config.get_main_option("script_location") != "alembic":
        raise RuntimeError("Scribe migration directory is unavailable")
    config.set_main_option("script_location", str(root / "alembic"))
    scripts = ScriptDirectory.from_config(config)
    if scripts.get_bases() != ["0001"] or len(scripts.get_heads()) != 1:
        raise RuntimeError("Scribe migration chain is unavailable")
    return config


def _upgrade(connection: Connection) -> None:
    config = _migration_config()
    config.attributes["connection"] = connection
    command.upgrade(config, "head")


def validate_migration_assets() -> None:
    _migration_config()


async def upgrade_database(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    if settings.repository_backend != "postgres":
        raise RuntimeError("Database migrations require repository_backend=postgres")
    validate_migration_assets()
    provider = build_postgres_provider(settings)
    try:
        async with provider.engine.begin() as connection:
            await connection.run_sync(_upgrade)
    finally:
        await provider.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply Cosmaneura Scribe database migrations.")
    parser.add_argument("action", choices=["upgrade"])
    arguments = parser.parse_args()
    if arguments.action == "upgrade":
        asyncio.run(upgrade_database())


if __name__ == "__main__":
    main()
