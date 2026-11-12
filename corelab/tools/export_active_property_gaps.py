"""Export every missing active internal property, including partial cards.

Read-only database access. No provider calls. Includes active products without
offers or with selection disabled so that loader eligibility cannot hide gaps.
"""
import argparse
import json
from collections import Counter
from pathlib import Path
from sqlalchemy import text
from app.db import SessionLocal

QUERY = text("""
SELECT p.id product_id, pc.category_id, p.manufacturer,
       p.manufacturer_article article, p.selection_enabled,
       r.code, coalesce(ca.ai_blocked,false) ai_blocked,
       coalesce(ca.required_for_selection,false) required_for_selection,
       pa.value_state,
       EXISTS (SELECT 1 FROM product_source_links l
         JOIN supplier_offers o ON o.id=l.offer_id
         WHERE l.product_id=p.id AND o.is_current
         AND NOT coalesce(o.is_archived,false) AND o.price>0) has_current_offer
FROM products p JOIN product_categories pc ON pc.product_id=p.id
JOIN property_rules r ON r.category_id=pc.category_id
  AND r.organization_id=p.organization_id AND r.active AND r.source='internal'
LEFT JOIN category_attributes ca ON ca.category_id=pc.category_id
  AND ca.attribute_id=r.attribute_id
LEFT JOIN product_attributes pa ON pa.product_id=p.id AND pa.attribute_id=r.attribute_id
WHERE p.organization_id=1 AND p.status='active' AND NOT coalesce(p.is_archived,false)
  AND pc.category_id IN (246,359,437)
  AND (pa.id IS NULL OR pa.value_state NOT IN ('known','not_applicable'))
ORDER BY pc.category_id,p.id,r.code
""")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/tmp/active-property-gaps.json')
    args = parser.parse_args()
    with SessionLocal() as db:
        gaps = [dict(row) for row in db.execute(QUERY).mappings()]
    summary = {}
    for category_id in sorted({row['category_id'] for row in gaps}):
        rows = [row for row in gaps if row['category_id'] == category_id]
        summary[category_id] = {'products': len({r['product_id'] for r in rows}),
                                'missing_values': len(rows),
                                'fields': dict(Counter(r['code'] for r in rows))}
    Path(args.output).write_text(json.dumps({'summary': summary, 'gaps': gaps},
        ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))

if __name__ == '__main__':
    main()
