"""Count selectable, priced products without known characteristics per maker."""
import sys

from sqlalchemy import text

from app.db import SessionLocal

category_id = int(sys.argv[1])

with SessionLocal() as db:
    rows = db.execute(text("""
        SELECT p.manufacturer, count(*) AS product_count
        FROM products p
        JOIN product_categories pc ON pc.product_id = p.id
        WHERE pc.category_id = :category_id
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
        GROUP BY p.manufacturer
        ORDER BY product_count DESC, p.manufacturer
    """), {"category_id": category_id})
    for row in rows:
        print(*row, sep=" | ")
