"""Refresh planner statistics after assigning organization ownership."""

from alembic import op


revision = "0013_organization_statistics"
down_revision = "0012_organizations"
branch_labels = None
depends_on = None


def upgrade():
    # 0012 backfilled organization_id for every existing row. Without fresh
    # statistics PostgreSQL assumes only a handful of rows match the new
    # column, which can turn catalog joins into repeated full scans.
    for table in (
        "products", "supplier_offers", "product_source_links", "categories",
        "product_categories", "product_attributes", "attributes",
        "category_attributes", "property_values", "catalog_sources",
        "property_rules", "validation_reasons", "import_logs", "audit_logs",
        "jobs", "job_items", "users", "ai_provider_settings",
        "category_structure_checks",
    ):
        op.execute(f"ANALYZE {table}")


def downgrade():
    # Planner statistics are derived data and do not need to be rolled back.
    pass
