"""Transactional SQLite/PostgreSQL upgrades, including pre-Alembic installations."""
import json
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
BASELINE = "0001_existing_care"


def configuration(connection):
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS))
    config.attributes["connection"] = connection
    return config


def upgrade(engine, revision="head"):
    with engine.connect() as connection:
        # SQLite's legacy transaction mode does not begin for DDL; make rollback real.
        if engine.dialect.name == "sqlite":
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        elif engine.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(7261736570686)"))
        else:
            raise RuntimeError("Parse migrations support SQLite and PostgreSQL only")
        try:
            config = configuration(connection)
            inspector = inspect(connection)
            tables = set(inspector.get_table_names())
            manifest = json.loads((MIGRATIONS / "legacy_columns.json").read_text())
            if "alembic_version" not in tables and tables.intersection(manifest):
                # Never stamp a partial/unknown database and silently skip missing schema.
                missing = {
                    table: sorted(set(columns) - {
                        col["name"] for col in inspector.get_columns(table)
                    }) if table in tables else columns
                    for table, columns in manifest.items()
                }
                missing = {key: value for key, value in missing.items() if value}
                if missing:
                    raise RuntimeError("Incomplete legacy schema; restore/repair before upgrade: %s" % missing)
                command.stamp(config, BASELINE)
            command.upgrade(config, revision)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise


if __name__ == "__main__":
    from .config import get_settings
    from .database import Database
    database = Database(get_settings().database_url)
    upgrade(database.engine)
    print("Parse database upgraded.")
