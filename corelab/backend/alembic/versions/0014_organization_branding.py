"""Store organization logos and primary colors."""

from alembic import op
import sqlalchemy as sa


revision = "0014_organization_branding"
down_revision = "0013_organization_statistics"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("organizations", sa.Column("primary_color", sa.String(7), nullable=False,
                                               server_default="#5146e5"))
    op.add_column("organizations", sa.Column("logo_data", sa.LargeBinary(), nullable=True))
    op.add_column("organizations", sa.Column("logo_content_type", sa.String(32), nullable=True))


def downgrade():
    op.drop_column("organizations", "logo_content_type")
    op.drop_column("organizations", "logo_data")
    op.drop_column("organizations", "primary_color")
