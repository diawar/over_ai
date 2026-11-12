"""Apply reviewed local evidence atomically, with backups and stale-data guards. No API."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import select
from app.cooling_inventory import normalize_cooling_inventory
from app.db import SessionLocal
from app.models import Attribute, AuditLog, Product, ProductAttribute
from app.validity import lock_validation, revalidate_product

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
parser.add_argument('--evidence', default='offline-core-cooling-properties-2026-11-03-am4-normalization.json')
args = parser.parse_args()
assert Path(args.evidence).name == args.evidence
path = Path('/evidence') / args.evidence
plan = json.loads(path.read_text(encoding='utf-8'))
assert plan['organization_id'] == 1
with SessionLocal() as db:
    db.info['organization_id'] = 1
    lock_validation(db)
    changes = []
    for item in plan['products']:
        product = db.scalar(select(Product).where(Product.id == item['product_id'],
            Product.organization_id == 1).with_for_update())
        assert product and product.sku == item['expected_sku'] and product.name == item['expected_name']
        for code, value in item['values'].items():
            attribute = db.scalar(select(Attribute).where(Attribute.organization_id == 1, Attribute.code == code))
            row = db.scalar(select(ProductAttribute).where(ProductAttribute.organization_id == 1,
                ProductAttribute.product_id == product.id, ProductAttribute.attribute_id == attribute.id).with_for_update())
            assert row is not None
            normalized = normalize_cooling_inventory(code, value)
            assert normalize_cooling_inventory(code, normalized) == normalized
            if row.value_json == normalized and row.source_url == item['source_url']:
                continue
            old = item['expected_before'][code]
            assert (row.value_json == old['value'] and row.value_state == old['state'] and
                    row.source_url == old['source_url']), f'Stale evidence for {product.id} {code}'
            assert all(v is None for v in (row.value_number, row.value_string, row.value_boolean))
            changes.append((product, row, normalized, item, code))
    print(json.dumps({'mode': 'APPLY' if args.apply else 'PREVIEW', 'count': len(changes),
        'changes': [dict(product_id=p.id, code=c, before=r.value_json, after=v)
                    for p,r,v,i,c in changes]}, ensure_ascii=False))
    if not args.apply:
        raise SystemExit(0)
    if not changes:
        print('UNCHANGED')
        raise SystemExit(0)
    backup = []
    for product, row, value, item, code in changes:
        backup.append(dict(product_id=product.id, attribute_id=row.attribute_id, code=code,
            before=dict(value_json=row.value_json, source_url=row.source_url, source_kind=row.source_kind,
                value_state=row.value_state, updated_at=row.updated_at.isoformat()),
            after=value, sources=[item['source_url'], *item['supporting_sources']], notes=item['notes']))
        row.value_json = value
        row.source_url = item['source_url']
        row.source_kind = 'manufacturer_document' if '.pdf' in item['source_url'].lower() else 'manufacturer_site'
        row.updated_at = datetime.now(timezone.utc)
    db.flush()
    for product in {p.id: p for p, *_ in changes}.values():
        result = revalidate_product(db, product)
        assert result['validity_check'] is True, (product.id, result)
    audit = AuditLog(organization_id=1, action='properties.am4_cooling_normalized',
        object_type='products', object_id=','.join(str(p.id) for p, *_ in changes),
        details=dict(origin='user_authorized_offline_research', api_calls=0,
            evidence_file=path.name, changes=backup))
    db.add(audit)
    db.flush()
    audit_id = audit.id
    db.commit()
    print(json.dumps({'applied': len(changes), 'audit_id': audit_id, 'api_calls': 0}))
