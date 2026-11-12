"""Remove pending paid catalog jobs; preserve catalog data and completed history."""
from alembic import op

revision = '0031_retire_paid_loading'
down_revision = '0030_ai_explanation_receipts'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""DELETE FROM job_items WHERE status IN ('queued', 'running', 'paused')
        AND job_id IN (SELECT id FROM jobs
            WHERE job_type IN ('property_load', 'property_structure'))""")
    op.execute("""DELETE FROM jobs
        WHERE job_type IN ('property_load', 'property_structure')
        AND status IN ('queued', 'running', 'paused')""")


def downgrade():
    # Removed billing requests must never be recreated by a schema rollback.
    pass
