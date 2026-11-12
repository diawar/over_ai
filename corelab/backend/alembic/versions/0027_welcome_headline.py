"""Organization-specific mini-app welcome headline."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0027_welcome_headline'
down_revision = '0026_e2e_default_color'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('organizations', sa.Column('welcome_headline', postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column('organizations', 'welcome_headline')
