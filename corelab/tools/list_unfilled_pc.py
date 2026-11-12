"""Read-only summary of selectable PC components lacking known properties."""

from sqlalchemy import text

from app.db import SessionLocal


with SessionLocal() as db:
    rows = db.execute(text("""
        WITH eligible AS (
          SELECT c.id category_id, c.name category_name, p.id product_id,
                 p.manufacturer, p.manufacturer_article, p.name product_name
          FROM categories c
          JOIN product_categories pc ON pc.category_id = c.id
          JOIN products p ON p.id = pc.product_id
          WHERE c.selection_category = true AND p.selection_enabled = true
            AND p.status = 'active' AND NOT coalesce(p.is_archived, false)
            AND EXISTS (
              SELECT 1 FROM product_source_links l
              JOIN supplier_offers o ON o.id = l.offer_id
              WHERE l.product_id = p.id AND o.is_current = true
                AND NOT coalesce(o.is_archived, false) AND o.price > 0
            )
            AND NOT EXISTS (
              SELECT 1 FROM product_attributes pa
              WHERE pa.product_id = p.id AND pa.value_state = 'known'
            )
        ), ranked AS (
          SELECT *, row_number() OVER (PARTITION BY category_id ORDER BY product_id) rn,
                 count(*) OVER (PARTITION BY category_id) missing_count
          FROM eligible
        )
        SELECT category_id, category_name, missing_count, product_id,
               manufacturer, manufacturer_article, product_name
        FROM ranked WHERE rn <= 6
        ORDER BY missing_count DESC, category_id, rn
    """))
    for row in rows:
        print(*row, sep=' | ')
