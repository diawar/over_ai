"""Move the shared working calendar into independent branch calendars."""
from copy import deepcopy
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0022_branch_calendars"
down_revision = "0021_organization_operations"
branch_labels = None
depends_on = None


def migrate_operations(original):
    value = deepcopy(original)
    calendar = {"weekly_days_off": value.pop("weekly_days_off", [5, 6]),
                "calendar_exceptions": value.pop("calendar_exceptions", [])}
    for branch in value.get("branches", []):
        for key, items in calendar.items():
            branch.setdefault(key, deepcopy(items))
    value["version"] = value.get("version", 0) + 1
    return value


def upgrade():
    organizations = sa.table("organizations", sa.column("id", sa.Integer), sa.column("operations", JSONB))
    connection = op.get_bind()
    for row in connection.execute(sa.select(organizations.c.id, organizations.c.operations).where(organizations.c.operations.is_not(None))).mappings():
        connection.execute(organizations.update().where(organizations.c.id == row["id"]).values(operations=migrate_operations(row["operations"])))


def downgrade():
    # Independent calendars cannot be merged without losing organization settings.
    pass
