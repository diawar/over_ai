"""Optional memory timings for budget comparison, in the rated frequency profile."""
from alembic import op
revision = '0029_memory_timings'
down_revision = '0028_product_links'
branch_labels = None
depends_on = None


def upgrade():
    for category, code, label in [
        ('Оперативная память', 'memory_profiles', 'Профили памяти EXPO / XMP'),
        ('Материнские платы', 'motherboard_memory_profiles', 'Поддерживаемые профили памяти EXPO / XMP'),
    ]:
        from sqlalchemy import text
        connection = op.get_bind()
        connection.execute(text("""
            INSERT INTO attributes (organization_id, code, label, value_type)
            SELECT DISTINCT organization_id, :code, :label, 'list'
            FROM categories WHERE name = :category
            ON CONFLICT (organization_id, code) DO NOTHING
        """), dict(code=code, label=label, category=category))
        connection.execute(text("""
            INSERT INTO category_attributes (organization_id, category_id, attribute_id, required_for_selection, ai_blocked)
            SELECT c.organization_id, c.id, a.id, false, false FROM categories c
            JOIN attributes a ON a.organization_id=c.organization_id
            WHERE c.name=:category AND a.code=:code
            ON CONFLICT (category_id, attribute_id) DO NOTHING
        """),
            dict(category=category, code=code))
    op.execute("""
        INSERT INTO attributes (organization_id, code, label, value_type)
        SELECT DISTINCT organization_id, 'memory_timings',
            'Тайминги при заявленной частоте (CL-tRCD-tRP-tRAS)', 'string'
        FROM categories WHERE name = 'Оперативная память'
        ON CONFLICT (organization_id, code) DO NOTHING
    """)
    op.execute("""
        INSERT INTO category_attributes (organization_id, category_id, attribute_id, required_for_selection, ai_blocked)
        SELECT c.organization_id, c.id, a.id, false, false
        FROM categories c JOIN attributes a ON a.organization_id = c.organization_id
        WHERE c.name = 'Оперативная память' AND a.code = 'memory_timings'
        ON CONFLICT (category_id, attribute_id) DO NOTHING
    """)


def downgrade():
    # Preserve catalog data and any values entered after upgrading.
    pass
