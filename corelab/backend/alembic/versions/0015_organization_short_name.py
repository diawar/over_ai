"""Add a short display name for organizations."""

from alembic import op
import sqlalchemy as sa


revision = "0015_organization_short_name"
down_revision = "0014_organization_branding"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("organizations", sa.Column("short_name", sa.String(100), nullable=True))


def downgrade():
    op.drop_column("organizations", "short_name")
