"""Optional Google identity; existing accounts remain unchanged."""
from alembic import op
import sqlalchemy as sa

revision = '0024_google_identity'
down_revision = '0023_organization_onboarding'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('google_sub', sa.String(255), nullable=True))
    op.add_column('users', sa.Column('google_email', sa.String(320), nullable=True))
    op.create_unique_constraint('uq_users_google_sub', 'users', ['google_sub'])


def downgrade():
    op.drop_constraint('uq_users_google_sub', 'users', type_='unique')
    op.drop_column('users', 'google_email')
    op.drop_column('users', 'google_sub')
