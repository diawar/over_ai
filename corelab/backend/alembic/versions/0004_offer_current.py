"""Track whether a supplier offer appeared in the latest full snapshot."""
from alembic import op
import sqlalchemy as sa

revision = "0004_offer_current"
down_revision = "0003_supplier_offers"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("supplier_offers", sa.Column("is_current", sa.Boolean(), server_default=sa.true(), nullable=False))


def downgrade():
    op.drop_column("supplier_offers", "is_current")
