"""Retire the p1 integration, retaining snapshot rows and canonical products."""
from alembic import op
import sqlalchemy as sa

revision = "0020_retire_p1_source"
down_revision = "0019_source_refresh"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("catalog_sources", sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.execute("UPDATE catalog_sources SET is_active = false, endpoint = 'local://archive/p1' WHERE code = 'p1'")
    op.drop_constraint("ck_source_refresh_hours", "catalog_sources", type_="check")
    for name in ("next_refresh_at", "refresh_finished_at", "refresh_started_at", "refresh_error", "refresh_status", "refresh_hours", "auto_refresh"):
        op.drop_column("catalog_sources", name)


def downgrade():
    # Schema rollback never restores credentials, schedules or remote access.
    op.add_column("catalog_sources", sa.Column("auto_refresh", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("catalog_sources", sa.Column("refresh_hours", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("catalog_sources", sa.Column("refresh_status", sa.String(20), nullable=False, server_default="idle"))
    op.add_column("catalog_sources", sa.Column("refresh_error", sa.String(500)))
    for name in ("refresh_started_at", "refresh_finished_at", "next_refresh_at"):
        op.add_column("catalog_sources", sa.Column(name, sa.DateTime(timezone=True)))
    op.create_check_constraint("ck_source_refresh_hours", "catalog_sources", "refresh_hours BETWEEN 1 AND 23")
    op.drop_column("catalog_sources", "is_active")
