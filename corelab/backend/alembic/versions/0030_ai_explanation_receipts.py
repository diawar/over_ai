"""Persist explanation results and prevent duplicate paid requests."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '0030_ai_explanation_receipts'
down_revision = '0029_memory_timings'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('ai_explanation_receipts',
        sa.Column('organization_id', sa.Integer(), sa.ForeignKey('organizations.id'), primary_key=True),
        sa.Column('request_id', sa.String(64), primary_key=True),
        sa.Column('payload_hash', sa.String(64), nullable=False),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('started_at', sa.Integer(), nullable=False),
        sa.Column('result', JSONB(), nullable=True),
        sa.Column('error_code', sa.String(40), nullable=True))


def downgrade():
    op.drop_table('ai_explanation_receipts')
