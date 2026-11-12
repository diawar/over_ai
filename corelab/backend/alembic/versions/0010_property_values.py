"""Store property values that have no assigned products yet."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0010_property_values"
down_revision = "0009_one_category_per_product"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "property_values",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("attribute_id", sa.Integer(), sa.ForeignKey("attributes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("value_key", sa.String(), nullable=False),
        sa.Column("value_json", JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("attribute_id", "value_key", name="uq_property_value_key"),
    )


def downgrade():
    op.drop_table("property_values")
