"""Allow each organization to turn off AI without deleting provider keys."""

from alembic import op
import sqlalchemy as sa


revision = "0018_ai_enabled"
down_revision = "0017_category_build_requirement"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("organizations", sa.Column("ai_enabled", sa.Boolean(), nullable=False,
                                             server_default=sa.true()))


def downgrade():
    op.drop_column("organizations", "ai_enabled")
