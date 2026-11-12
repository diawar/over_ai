"""Limit each product to at most one category."""
from alembic import op
import sqlalchemy as sa

revision = "0009_one_category_per_product"
down_revision = "0008_ai_provider_settings"
branch_labels = None
depends_on = None


def upgrade():
    duplicate = op.get_bind().execute(sa.text(
        "SELECT product_id FROM product_categories GROUP BY product_id HAVING COUNT(*) > 1 LIMIT 1"
    )).first()
    if duplicate:
        raise RuntimeError(
            f"Product {duplicate[0]} has multiple categories; reconcile category links before migration"
        )
    op.create_unique_constraint(
        "uq_product_single_category", "product_categories", ["product_id"]
    )


def downgrade():
    op.drop_constraint("uq_product_single_category", "product_categories", type_="unique")
