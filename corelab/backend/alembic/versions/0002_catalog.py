"""Create supplier source and normalized catalog tables."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002_catalog"
down_revision = "0001_users"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "catalog_sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(40), nullable=False, unique=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("endpoint", sa.String(500), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("source_category_id", sa.String(300), nullable=False),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("categories.id", ondelete="SET NULL")),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("selection_category", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.UniqueConstraint("source_id", "source_category_id", name="uq_category_source_key"),
    )
    op.create_table(
        "products",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("sku", sa.String(120), nullable=False),
        sa.Column("name", sa.String(1000), nullable=False),
        sa.Column("manufacturer_article", sa.String(300)),
        sa.Column("manufacturer", sa.String(300)),
        sa.Column("price", sa.Numeric(18, 2)),
        sa.Column("price_bonus", sa.Numeric(18, 2)),
        sa.Column("price_special", sa.Numeric(18, 2)),
        sa.Column("currency", sa.String(3), server_default="KZT", nullable=False),
        sa.Column("status", sa.String(40), server_default="active", nullable=False),
        sa.Column("is_archived", sa.Boolean()),
        sa.Column("validity_check", sa.Boolean()),
        sa.Column("selection_enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("image_url", sa.String(2000)),
        sa.Column("image_path", sa.String(1000)),
        sa.Column("raw_data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("source_id", "sku", name="uq_product_source_sku"),
    )
    op.create_index("ix_products_sku", "products", ["sku"])
    op.create_table(
        "product_categories",
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_table(
        "attributes",
        sa.Column("id", sa.Integer(), primary_key=True), sa.Column("code", sa.String(160), nullable=False, unique=True),
        sa.Column("label", sa.String(300), nullable=False), sa.Column("value_type", sa.String(40), nullable=False),
        sa.Column("unit", sa.String(80)), sa.Column("normalization", postgresql.JSONB(astext_type=sa.Text())),
    )
    op.create_table(
        "category_attributes",
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("attribute_id", sa.Integer(), sa.ForeignKey("attributes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("required_for_selection", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_table(
        "product_attributes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("attribute_id", sa.Integer(), sa.ForeignKey("attributes.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("value_string", sa.String()), sa.Column("value_number", sa.Numeric(20, 6)),
        sa.Column("value_boolean", sa.Boolean()), sa.Column("value_json", postgresql.JSONB(astext_type=sa.Text())),
        sa.Column("source_url", sa.String(2000)), sa.Column("source_kind", sa.String(40)),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("product_id", "attribute_id", name="uq_product_attribute"),
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.Integer(), primary_key=True), sa.Column("job_type", sa.String(80), nullable=False),
        sa.Column("status", sa.String(40), nullable=False), sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("completed", sa.Integer(), nullable=False), sa.Column("skipped", sa.Integer(), nullable=False),
        sa.Column("failed", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "job_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id", ondelete="SET NULL")),
        sa.Column("status", sa.String(40), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text())),
    )
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("action", sa.String(120), nullable=False), sa.Column("object_type", sa.String(80)),
        sa.Column("object_id", sa.String(160)), sa.Column("details", postgresql.JSONB(astext_type=sa.Text())),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "import_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("status", sa.String(40), nullable=False), sa.Column("records_expected", sa.Integer(), nullable=False),
        sa.Column("records_imported", sa.Integer(), nullable=False), sa.Column("source_downloaded_at", sa.DateTime(timezone=True)),
        sa.Column("snapshot_sha256", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)), sa.Column("error_summary", sa.String(1000)),
    )
    op.create_table(
        "validation_reasons",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(120), nullable=False), sa.Column("message", sa.String(1000), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("validation_reasons")
    op.drop_table("import_logs")
    op.drop_table("audit_logs")
    op.drop_table("job_items")
    op.drop_table("jobs")
    op.drop_table("product_attributes")
    op.drop_table("category_attributes")
    op.drop_table("attributes")
    op.drop_table("product_categories")
    op.drop_index("ix_products_sku", table_name="products")
    op.drop_table("products")
    op.drop_table("categories")
    op.drop_table("catalog_sources")
