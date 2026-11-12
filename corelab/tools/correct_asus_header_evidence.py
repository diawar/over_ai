"""Correct the two total-count mistakes from cc-more; no network/provider calls."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import select
from app.db import SessionLocal
from app.models import Attribute, Product, ProductAttribute, AuditLog
from app.cooling_inventory import normalize_cooling_inventory
from app.validity import lock_validation, revalidate_product

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    evidence = json.loads(Path('/evidence/offline-core-cooling-properties-2026-10-29-cc-more.json').read_text(encoding='utf-8'))
    with SessionLocal() as db:
        lock_validation(db)
        attr = db.scalar(select(Attribute).where(Attribute.organization_id == 1, Attribute.code == 'motherboard_fan_headers'))
        for item in evidence['products']:
            p = db.scalar(select(Product).where(Product.id == item['product_id']).with_for_update())
            if p.organization_id != 1 or p.manufacturer != item['manufacturer'] or p.manufacturer_article != item['article']:
                raise RuntimeError('Exact product identity changed')
            row = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == p.id, ProductAttribute.attribute_id == attr.id))
            value = normalize_cooling_inventory(attr.code, item['values'][attr.code])
            if row.value_json == value:
                print(f'UNCHANGED {p.id}')
                continue
            old = normalize_cooling_inventory(attr.code, normalize_cooling_inventory(
                attr.code, 3 if p.id == 3502 else 4))
            if row.value_json != old or row.source_url != item['source_url']:
                raise RuntimeError('Concurrent or unrelated header evidence; correction cancelled')
            print(f'CORRECT {p.id}: {old} -> {value}')
            if args.apply:
                db.add(AuditLog(action='properties.header_evidence_corrected', object_type='product', object_id=str(p.id),
                    details={'code': attr.code, 'previous': row.value_json, 'value': value,
                             'source_url': item['source_url'], 'reason': 'Total fan headers misinterpreted as chassis headers; corrected against ASUS specifications'}))
                row.value_json = value
                row.updated_at = datetime.now(timezone.utc)
                db.flush()
                revalidate_product(db, p)
        if args.apply:
            db.commit()
        print('APPLIED' if args.apply else 'DRY RUN')

if __name__ == '__main__':
    main()
