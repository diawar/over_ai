"""Non-destructive, data-driven property requirements."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0005_property_rules"
down_revision = "0004_offer_current"
branch_labels = depends_on = None


def upgrade():
    op.add_column("category_attributes", sa.Column("ai_blocked", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("product_attributes", sa.Column("value_state", sa.String(24), nullable=False, server_default="known"))
    op.create_table("property_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("scope", sa.String(40), nullable=False),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("categories.id", ondelete="RESTRICT")),
        sa.Column("attribute_id", sa.Integer(), sa.ForeignKey("attributes.id", ondelete="RESTRICT")),
        sa.Column("code", sa.String(160), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("definition", postgresql.JSONB(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.UniqueConstraint("scope", "source", "code", name="uq_property_rule_scope"))
    op.create_table("category_structure_checks",
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("report", postgresql.JSONB(), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))


def downgrade():
    op.drop_table("category_structure_checks")
    op.drop_table("property_rules")
    op.drop_column("product_attributes", "value_state")
    op.drop_column("category_attributes", "ai_blocked")
