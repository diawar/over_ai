"""Fill reviewed missing scalar properties and CPU cooler socket lists locally."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import select
from app.db import SessionLocal
from app.models import Attribute, AuditLog, CatalogSource, Product, ProductAttribute, PropertyRule
from app.property_engine import RuleDefinition, normalize
from app.validity import lock_validation, revalidate_product

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', required=True)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
assert Path(args.evidence).name == args.evidence
plan = json.loads((Path('/evidence') / args.evidence).read_text(encoding='utf-8'))
assert plan['organization_id'] == 1
columns = ('value_string', 'value_number', 'value_boolean', 'value_json')

def snapshot(row):
    if row is None:
        return None
    return {**{c: str(getattr(row, c)) if c == 'value_number' and getattr(row,c) is not None
               else getattr(row,c) for c in columns}, 'value_state': row.value_state,
            'source_url': row.source_url, 'source_kind': row.source_kind,
            'updated_at': row.updated_at.isoformat()}

with SessionLocal() as db:
    db.info['organization_id'] = 1
    lock_validation(db)
    changes, touched = [], {}
    for item in plan['products']:
        p = db.scalar(select(Product).join(CatalogSource).where(Product.id == item['product_id'],
            Product.organization_id == 1, CatalogSource.code == 'corelab').with_for_update(of=Product))
        assert p and (p.sku, p.name, p.manufacturer_article) == (
            item['expected_sku'], item['expected_name'], item['expected_article'])
        for code, entry in item['properties'].items():
            assert entry['evidence'] and entry['source_url'].startswith('https://')
            attr = db.scalar(select(Attribute).where(Attribute.organization_id == 1, Attribute.code == code))
            assert attr
            rules = list(db.scalars(select(PropertyRule).where(PropertyRule.organization_id == 1,
                PropertyRule.active.is_(True), PropertyRule.source == 'internal',
                PropertyRule.category_id.in_([c.id for c in p.categories]), PropertyRule.attribute_id == attr.id)))
            assert rules, (p.id, code, 'no active category rule')
            value = entry['value']
            for r in rules:
                rule = RuleDefinition.model_validate(r.definition)
                # Conditional values require a dedicated reviewed import, not this scalar helper.
                assert rule.applies_when is None and rule.condition is None
                assert normalize(value, rule) == value
                assert attr.value_type == rule.value_type
            assert attr.value_type in ('string', 'enum', 'integer', 'number', 'boolean') or (
                attr.value_type == 'list' and code in ('cpu_cooler_sockets', 'motherboard_supported_cpu_series', 'motherboard_m2_interfaces', 'motherboard_cpu_power_connectors', 'motherboard_internal_usb_headers', 'motherboard_fan_headers', 'motherboard_lighting_headers')
                and isinstance(value, list) and value
                and all(isinstance(v, (str, dict)) and bool(v) for v in value)
                and len(value) == len({json.dumps(v, sort_keys=True) for v in value}))
            row = db.scalar(select(ProductAttribute).where(ProductAttribute.organization_id == 1,
                ProductAttribute.product_id == p.id, ProductAttribute.attribute_id == attr.id).with_for_update())
            actual = next((getattr(row,c) for c in columns if row is not None and getattr(row,c) is not None), None)
            if row and row.value_state == 'known' and actual is not None and normalize(actual, rule) == value:
                continue
            before = snapshot(row)
            assert before == entry['expected_before'], (p.id, code, 'stale evidence')
            assert row is None or (row.value_state == 'unknown' and actual in (None, '', [])), (p.id, code, 'not missing')
            changes.append(dict(product_id=p.id, attribute_id=attr.id, code=code, before=before,
                after=value, source_url=entry['source_url'], evidence=entry['evidence']))
            touched[p.id] = (p, p.validity_check)
            if args.apply:
                if row is None:
                    row = ProductAttribute(organization_id=1, product_id=p.id, attribute_id=attr.id)
                    db.add(row)
                for c in columns:
                    setattr(row,c,None)
                column = 'value_json' if attr.value_type == 'list' else 'value_number' if attr.value_type in ('number','integer') else 'value_boolean' if attr.value_type == 'boolean' else 'value_string'
                setattr(row,column,value)
                row.value_state, row.source_url = 'known', entry['source_url']
                row.source_kind = 'manufacturer_document' if '.pdf' in entry['source_url'].lower() else 'manufacturer_site'
                row.updated_at = datetime.now(timezone.utc)
    if args.apply and changes:
        db.flush()
        for p, old_validity in touched.values():
            result = revalidate_product(db,p)
            assert old_validity is not True or result['validity_check'] is True, (p.id,result)
        audit = AuditLog(organization_id=1,action='properties.offline_missing_filled',object_type='products',
            object_id=','.join(map(str,touched)),details=dict(evidence_file=args.evidence,api_calls=0,changes=changes))
        db.add(audit)
        db.flush()
        audit_id = audit.id
        db.commit()
    else:
        audit_id = None
    print(json.dumps(dict(mode='apply' if args.apply else 'preview',properties=len(changes),
        products=len(touched),audit_id=audit_id,changes=changes),ensure_ascii=False,default=str))
