"""Organization SKU link feeds."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision = '0028_product_links'
down_revision = '0027_welcome_headline'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('organizations', sa.Column('product_links', postgresql.JSONB(), nullable=True))

def downgrade():
    op.drop_column('organizations', 'product_links')
