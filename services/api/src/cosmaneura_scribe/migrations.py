from __future__ import annotations

import argparse
import asyncio

from alembic.config import Config
from sqlalchemy.engine import Connection

from alembic import command

from .postgres_repository import build_postgres_provider
from .settings import Settings, get_settings


def _upgrade(connection: Connection) -> None:
    config = Config("alembic.ini")
    config.attributes["connection"] = connection
    command.upgrade(config, "head")


async def upgrade_database(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    if settings.repository_backend != "postgres":
        raise RuntimeError("Database migrations require repository_backend=postgres")
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
