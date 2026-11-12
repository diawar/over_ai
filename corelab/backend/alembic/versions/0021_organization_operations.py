"""Organization branches, transit times, assembly and working calendar."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0021_organization_operations"
down_revision = "0020_retire_p1_source"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("organizations", sa.Column("operations", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("organizations", "operations")
