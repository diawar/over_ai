"""Store numeric product property values with two decimal places."""

from alembic import op
import sqlalchemy as sa


revision = "0011_numeric_values_two_decimals"
down_revision = "0010_property_values"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("product_attributes", "value_number",
                    existing_type=sa.Numeric(20, 6), type_=sa.Numeric(20, 2),
                    postgresql_using="round(value_number, 2)")
    op.execute("""
        UPDATE property_values AS pv
        SET value_key = round((pv.value_json #>> '{}')::numeric, 2)::text,
            value_json = to_jsonb(round((pv.value_json #>> '{}')::numeric, 2)::text)
        FROM attributes AS a
        WHERE a.id = pv.attribute_id AND a.value_type IN ('number', 'integer')
    """)


def downgrade():
    op.alter_column("product_attributes", "value_number",
                    existing_type=sa.Numeric(20, 2), type_=sa.Numeric(20, 6))
    op.execute("""
        UPDATE property_values AS pv
        SET value_key = round((pv.value_json #>> '{}')::numeric, 6)::text,
            value_json = to_jsonb(round((pv.value_json #>> '{}')::numeric, 6)::text)
        FROM attributes AS a
        WHERE a.id = pv.attribute_id AND a.value_type IN ('number', 'integer')
    """)
