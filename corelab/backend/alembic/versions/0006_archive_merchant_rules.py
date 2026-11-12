"""Archive external feed rules; keep historical rows and audit history."""
from alembic import op
import sqlalchemy as sa

revision = "0006_archive_merchant_rules"
down_revision = "0005_property_rules"
branch_labels = depends_on = None


def upgrade():
    op.execute(sa.text("""
        UPDATE property_rules
        SET active = false, revision = revision + 1
        WHERE active = true AND (
            source = 'gmc' OR
            (scope = 'global' AND source = 'internal' AND code IN (
                'google_product_category', 'product_type', 'additional_image_link'
            ))
        )
    """))


def downgrade():
    # Do not reactivate archived rules: that could restore behavior the owner removed.
    pass
