"""Separate supplier price rows from canonical CoreLab products."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_supplier_offers"
down_revision = "0002_catalog"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "supplier_offers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("sku", sa.String(120), nullable=False),
        sa.Column("raw_data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("price", sa.Numeric(18, 2)), sa.Column("price_bonus", sa.Numeric(18, 2)),
        sa.Column("price_special", sa.Numeric(18, 2)),
        sa.Column("currency", sa.String(3), server_default="KZT", nullable=False),
        sa.Column("is_archived", sa.Boolean()),
        sa.Column("imported_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("source_id", "sku", name="uq_offer_source_sku"),
    )
    op.create_table(
        "product_source_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("offer_id", sa.Integer(), sa.ForeignKey("supplier_offers.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.UniqueConstraint("product_id", "offer_id", name="uq_product_offer_link"),
    )
    op.create_index("ix_supplier_offers_source_id", "supplier_offers", ["source_id"])
    op.create_index("ix_supplier_offers_sku", "supplier_offers", ["sku"])


def downgrade():
    op.drop_index("ix_supplier_offers_sku", table_name="supplier_offers")
    op.drop_index("ix_supplier_offers_source_id", table_name="supplier_offers")
    op.drop_table("product_source_links")
    op.drop_table("supplier_offers")
