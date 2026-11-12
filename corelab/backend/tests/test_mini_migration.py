"""Migration smoke on a dedicated database, never the catalog database."""
import os
import subprocess
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url


def test_stage11_migration_roundtrip():
    source = make_url(os.environ["DATABASE_URL"])
    target = source.set(database="corelab_stage11_migration_test")
    admin = create_engine(source.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as db:
        if not db.scalar(text("SELECT 1 FROM pg_database WHERE datname='corelab_stage11_migration_test'")):
            db.execute(text("CREATE DATABASE corelab_stage11_migration_test"))
    admin.dispose()
    env = {**os.environ, "DATABASE_URL": target.render_as_string(hide_password=False)}
    engine = create_engine(target)
    for command, expected in [("upgrade", True), ("downgrade", False), ("upgrade", True)]:
        revision = "0015_organization_short_name" if command == "downgrade" else "head"
        subprocess.run(["alembic", command, revision], env=env, check=True, capture_output=True)
        columns = {c["name"] for c in inspect(engine).get_columns("organizations")}
        assert ("mini_app_enabled" in columns) == expected
    engine.dispose()
