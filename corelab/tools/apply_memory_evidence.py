"""Apply exact-product official evidence locally; no AI or network calls."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import select
from app.db import SessionLocal
from app.models import Product, Attribute, ProductAttribute, AuditLog
from app.validity import lock_validation, revalidate_product

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
filename = 'offline-memory-profiles-2026-11-04.json'
evidence = json.loads(Path('/evidence', filename).read_text(encoding='utf-8'))
changes = []
with SessionLocal() as db:
    lock_validation(db)
    db.info['organization_id'] = 1
    for item in evidence['products']:
        product = db.scalar(select(Product).where(Product.id == item['id'], Product.organization_id == 1).with_for_update())
        assert product and product.name == item['name'], item['id']
        assert item['quotes'] and item['source_url'].startswith('https://')
        if item.get('frequency'):
            frequency = db.scalar(select(ProductAttribute.value_number).join(Attribute).where(
                ProductAttribute.product_id == product.id, Attribute.code == 'memory_frequency'))
            assert float(frequency) == item['frequency'], (product.id, frequency)
        for code, value in item['values'].items():
            assert code in ('memory_timings', 'memory_profiles', 'motherboard_memory_profiles')
            if code != 'memory_timings':
                assert isinstance(value, list) and value and set(value) <= {'EXPO', 'XMP', 'XMP 2.0', 'XMP 3.0'}
            else:
                assert isinstance(value, str) and value
            attribute = db.scalar(select(Attribute).where(Attribute.organization_id == 1, Attribute.code == code))
            assert attribute
            row = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
                ProductAttribute.attribute_id == attribute.id).with_for_update())
            before = None if row is None else {k: getattr(row, k) for k in
                ('value_string', 'value_json', 'value_state', 'source_url', 'source_kind')}
            existing = None if row is None else row.value_string if code == 'memory_timings' else row.value_json
            if row and row.value_state == 'known' and existing == value:
                continue
            assert not row or row.value_state != 'known' or existing is None, (product.id, code, before)
            changes.append({'product_id': product.id, 'code': code, 'before': before,
                'after': value, 'source_url': item['source_url']})
            if args.apply:
                if row is None:
                    row = ProductAttribute(organization_id=1, product_id=product.id, attribute_id=attribute.id)
                    db.add(row)
                row.value_string = value if code == 'memory_timings' else None
                row.value_json = value if code != 'memory_timings' else None
                row.value_number = row.value_boolean = None
                row.value_state = 'known'
                row.source_url = item['source_url']
                row.source_kind = 'official_web'
                row.updated_at = datetime.now(timezone.utc)
        if args.apply:
            db.flush()
            revalidate_product(db, product)
    if args.apply and changes:
        audit = AuditLog(organization_id=1, action='properties.memory_offline_filled', object_type='products',
            object_id='memory_2026_11_04', details={'evidence_file': filename, 'ai_api_calls': 0, 'changes': changes})
        db.add(audit)
        db.flush()
        print('AUDIT', audit.id)
        db.commit()
    print(json.dumps({'mode': 'apply' if args.apply else 'preview', 'products': len({c['product_id'] for c in changes}),
        'values': len(changes)}, ensure_ascii=False))
