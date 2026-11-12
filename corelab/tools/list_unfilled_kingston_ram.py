"""List eligible RAM for a manufacturer without known properties (read-only)."""

import sys

from sqlalchemy import text

from app.db import SessionLocal


manufacturer = sys.argv[1] if len(sys.argv) > 1 else "Kingston"
category_id = int(sys.argv[2]) if len(sys.argv) > 2 else 253

with SessionLocal() as db:
    rows = db.execute(text("""
        SELECT p.id, p.manufacturer_article, p.name
        FROM products p
        JOIN product_categories pc ON pc.product_id = p.id
        WHERE pc.category_id = :category_id
          AND lower(p.manufacturer) = lower(:manufacturer)
          AND p.selection_enabled = true
          AND p.status = 'active'
          AND NOT coalesce(p.is_archived, false)
          AND NOT EXISTS (
              SELECT 1 FROM product_attributes pa
              WHERE pa.product_id = p.id AND pa.value_state = 'known'
          )
          AND EXISTS (
              SELECT 1 FROM product_source_links l
              JOIN supplier_offers o ON o.id = l.offer_id
              WHERE l.product_id = p.id AND o.is_current = true
                AND NOT coalesce(o.is_archived, false) AND o.price > 0
          )
        ORDER BY p.id
    """), {"manufacturer": manufacturer, "category_id": category_id})
    for row in rows:
        print(*row, sep=' | ')
