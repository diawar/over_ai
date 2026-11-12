"""Store encrypted administrator AI provider credentials."""
from alembic import op
import sqlalchemy as sa

revision = "0008_ai_provider_settings"
down_revision = "0007_category_property_template"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "ai_provider_settings",
        sa.Column("provider", sa.String(length=40), primary_key=True),
        sa.Column("encrypted_api_key", sa.String(length=4000), nullable=False),
        sa.Column("model_id", sa.String(length=120), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("ai_provider_settings")
