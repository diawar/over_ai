"""Explicit organization availability in the shared Mini App."""
from alembic import op
import sqlalchemy as sa

revision = "0016_mini_app"
down_revision = "0015_organization_short_name"
branch_labels = None
depends_on = None

def upgrade():
    op.add_column("organizations", sa.Column("mini_app_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))

def downgrade():
    op.drop_column("organizations", "mini_app_enabled")
