"""Independent category requirement for the PC configurator."""

from alembic import op
import sqlalchemy as sa


revision = "0017_category_build_requirement"
down_revision = "0016_mini_app"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("categories", sa.Column("required_for_build", sa.Boolean(), nullable=False,
                                           server_default=sa.false()))


def downgrade():
    op.drop_column("categories", "required_for_build")
