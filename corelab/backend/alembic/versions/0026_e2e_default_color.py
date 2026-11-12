"""Use e2e pink until an organization chooses its own color."""
from alembic import op

revision = '0026_e2e_default_color'
down_revision = '0025_remove_google_identity'
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column('organizations', 'primary_color', server_default='#ff416c')
    # Preserve all non-default colors and explicitly saved indigo choices.
    op.execute("""
        UPDATE organizations AS organization SET primary_color = '#ff416c'
        WHERE lower(organization.primary_color) = '#5146e5'
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs AS event
            WHERE event.action = 'settings.organization_color_changed'
              AND event.object_type = 'organization'
              AND event.object_id = CAST(organization.id AS text)
          )
    """)


def downgrade():
    # Do not rewrite colors: a company may have chosen e2e pink explicitly.
    op.alter_column('organizations', 'primary_color', server_default='#5146e5')
