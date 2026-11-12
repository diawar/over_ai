"""Persist one selected property template per category."""
from alembic import op
import sqlalchemy as sa

revision = "0007_category_property_template"
down_revision = "0006_archive_merchant_rules"
branch_labels = depends_on = None


def upgrade():
    op.add_column("categories", sa.Column("property_template_code", sa.String(length=80), nullable=True))


def downgrade():
    op.drop_column("categories", "property_template_code")
