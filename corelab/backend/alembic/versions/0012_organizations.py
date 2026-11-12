"""Assign existing data and users to the first organization."""

from alembic import op
import sqlalchemy as sa


revision = "0012_organizations"
down_revision = "0011_numeric_values_two_decimals"
branch_labels = None
depends_on = None


OWNED_TABLES = (
    "users", "catalog_sources", "categories", "products", "supplier_offers",
    "product_source_links", "attributes", "property_values", "category_attributes",
    "product_attributes", "jobs", "job_items", "audit_logs", "import_logs",
    "validation_reasons", "property_rules", "category_structure_checks", "ai_provider_settings",
)


def upgrade():
    op.create_table("organizations",
                    sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("name", sa.String(200), nullable=False, unique=True))
    op.execute("INSERT INTO organizations (id, name) VALUES (1, 'ТОО \"OVER-SHOP.KZ\"')")
    op.execute("SELECT setval(pg_get_serial_sequence('organizations', 'id'), 1, true)")
    for table in OWNED_TABLES:
        op.add_column(table, sa.Column("organization_id", sa.Integer(), nullable=False, server_default="1"))
        op.create_foreign_key(f"fk_{table}_organization", table, "organizations", ["organization_id"], ["id"])
        if table != "ai_provider_settings":
            op.create_index(f"ix_{table}_organization_id", table, ["organization_id"])
    op.execute("UPDATE users SET role = 'chief_admin' WHERE lower(username) = 'diawar86'")
    op.drop_constraint("catalog_sources_code_key", "catalog_sources", type_="unique")
    op.create_unique_constraint("uq_source_organization_code", "catalog_sources", ["organization_id", "code"])
    op.drop_constraint("attributes_code_key", "attributes", type_="unique")
    op.create_unique_constraint("uq_attribute_organization_code", "attributes", ["organization_id", "code"])
    op.drop_constraint("uq_property_rule_scope", "property_rules", type_="unique")
    op.create_unique_constraint("uq_property_rule_scope", "property_rules", ["organization_id", "scope", "source", "code"])
    op.drop_constraint("ai_provider_settings_pkey", "ai_provider_settings", type_="primary")
    op.create_primary_key("ai_provider_settings_pkey", "ai_provider_settings", ["organization_id", "provider"])


def downgrade():
    op.drop_constraint("ai_provider_settings_pkey", "ai_provider_settings", type_="primary")
    op.create_primary_key("ai_provider_settings_pkey", "ai_provider_settings", ["provider"])
    op.drop_constraint("uq_property_rule_scope", "property_rules", type_="unique")
    op.create_unique_constraint("uq_property_rule_scope", "property_rules", ["scope", "source", "code"])
    op.drop_constraint("uq_attribute_organization_code", "attributes", type_="unique")
    op.create_unique_constraint("attributes_code_key", "attributes", ["code"])
    op.drop_constraint("uq_source_organization_code", "catalog_sources", type_="unique")
    op.create_unique_constraint("catalog_sources_code_key", "catalog_sources", ["code"])
    op.execute("UPDATE users SET role = 'admin' WHERE role = 'chief_admin'")
    for table in reversed(OWNED_TABLES):
        if table != "ai_provider_settings":
            op.drop_index(f"ix_{table}_organization_id", table_name=table)
        op.drop_constraint(f"fk_{table}_organization", table, type_="foreignkey")
        op.drop_column(table, "organization_id")
    op.drop_table("organizations")
