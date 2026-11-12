"""New registrations must complete setup; existing organizations remain available."""
from alembic import op
import sqlalchemy as sa

revision = "0023_organization_onboarding"
down_revision = "0022_branch_calendars"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("organizations", sa.Column("onboarding_required", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("organizations", sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("users", sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade():
    op.drop_column("users", "is_active")
    op.drop_column("organizations", "is_active")
    op.drop_column("organizations", "onboarding_required")
