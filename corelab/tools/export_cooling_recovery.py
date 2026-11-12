"""Export public product identities, existing evidence and received research; no API."""
import json
from pathlib import Path
from sqlalchemy import select
from app.db import SessionLocal
from app.models import Attribute, ProductAttribute, JobItem
from cooling_recovery_cohort import cohort, CODES

with SessionLocal() as db:
    output = []
    for product in cohort(db, 45789):
        values, sources = {}, set()
        for row, attr in db.execute(select(ProductAttribute, Attribute).join(Attribute).where(
                ProductAttribute.product_id == product.id)):
            if row.source_url:
                sources.add(row.source_url)
            if attr.code in CODES[product.categories[0].id]:
                values[attr.code] = {'value': row.value_json, 'state': row.value_state, 'source_url': row.source_url}
        received = [{'item_id': item.id, 'status': item.status, 'reason': item.details.get('reason'),
                     'values': item.details.get('researched_values')} for item in db.scalars(
            select(JobItem).where(JobItem.product_id == product.id).order_by(JobItem.id))
            if (item.details or {}).get('fill_missing_codes') and (item.details or {}).get('researched_values')]
        output.append({'product_id': product.id, 'category_id': product.categories[0].id,
            'manufacturer': product.manufacturer, 'article': product.manufacturer_article, 'name': product.name,
            'restored': product.validity_check is True, 'values': values, 'sources': sorted(sources), 'received': received})
    Path('/tmp/cooling-recovery.json').write_text(json.dumps({'products': output}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'EXPORTED {len(output)} products; no API calls')
