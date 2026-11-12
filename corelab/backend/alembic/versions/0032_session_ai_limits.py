"""Revocable admin sessions and persistent organization AI request limits."""
from alembic import op
import sqlalchemy as sa

revision = '0032_session_ai_limits'
down_revision = '0031_retire_paid_loading'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('admin_sessions',
        sa.Column('token_hash', sa.String(64), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('password_fingerprint', sa.String(64), nullable=False),
        sa.Column('expires_at', sa.Integer(), nullable=False))
    op.create_index('ix_admin_sessions_user_id', 'admin_sessions', ['user_id'])
    op.create_index('ix_admin_sessions_expires_at', 'admin_sessions', ['expires_at'])
    op.create_table('ai_usage_budgets',
        sa.Column('organization_id', sa.Integer(), sa.ForeignKey('organizations.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('minute', sa.Integer(), nullable=False),
        sa.Column('minute_count', sa.Integer(), nullable=False),
        sa.Column('day', sa.Integer(), nullable=False),
        sa.Column('day_count', sa.Integer(), nullable=False))
    op.create_table('ai_request_leases',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('organization_id', sa.Integer(), sa.ForeignKey('organizations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('expires_at', sa.Integer(), nullable=False))
    op.create_index('ix_ai_request_leases_organization_id', 'ai_request_leases', ['organization_id'])


def downgrade():
    op.drop_table('ai_request_leases')
    op.drop_table('ai_usage_budgets')
    op.drop_table('admin_sessions')
