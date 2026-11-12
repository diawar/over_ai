"""Convert verified SYS_FAN/CHA_FAN counts to typed JSON inventories."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.connector_inventory import normalize_connector_inventory
from app.db import SessionLocal
from app.models import (Attribute, AuditLog, Category, CategoryStructureCheck,
                        Product, ProductAttribute, PropertyRule)
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    template = json.loads(Path('/tmp/pc_property_templates.json').read_text(encoding='utf-8'))
    definition = RuleDefinition.model_validate(next(row for category in template
        if category['code'] == 'motherboard' for row in category['attributes']
        if row['code'] == 'motherboard_fan_headers'))
    with SessionLocal() as db:
        category = db.get(Category, 359)
        if not category or category.name != 'Материнские платы' or category.organization_id != 1:
            raise RuntimeError('Motherboard category identity mismatch')
        attr = db.scalar(select(Attribute).where(Attribute.code == definition.code))
        rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == 359,
            PropertyRule.code == definition.code, PropertyRule.source == 'internal'))
        if not attr or not rule or not rule.active:
            raise RuntimeError('Fan header rule missing')
        products = list(db.scalars(select(Product).join(Product.categories).where(
            Category.id == 359, Product.validity_check.is_(True))))
        if len(products) != 21:
            raise RuntimeError('Eligible motherboard count changed')
        changes = []
        for product in products:
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product.id,
                ProductAttribute.attribute_id == attr.id))
            if not row or not row.source_url or row.value_state != 'known':
                raise RuntimeError(f'Missing verified header count: {product.id}')
            if isinstance(row.value_json, list):
                continue
            if row.value_number is None or row.value_number != int(row.value_number):
                raise RuntimeError(f'Unexpected header count: {product.id}')
            value = normalize_connector_inventory(definition.code, int(row.value_number))
            changes.append((row, value))
            print(f'VALUE product={product.id} {definition.code}={value[0]["count"]}')
        rule_change = attr.value_type != 'list' or rule.definition != definition.model_dump(mode='json')
        print(f'RULE_CHANGE {rule_change}; VALUES {len(changes)}')
        if not args.apply:
            print('DRY RUN: no writes')
            return
        if not changes and not rule_change:
            print('UNCHANGED')
            return
        lock_validation(db)
        now = datetime.now(timezone.utc)
        for row, value in changes:
            row.value_number = None
            row.value_json = value
            row.updated_at = now
        if rule_change:
            attr.value_type = 'list'
            db.flush()
            attach_rule(db, 359, definition, existing=rule)
        revalidate_category(db, 359)
        previous = db.get(CategoryStructureCheck, 359)
        report = structure_report(db, 359)
        if previous:
            research = (previous.report or {}).get('research')
            previous.fingerprint = report['fingerprint']
            previous.report = {**report, **({'research': research} if research else {})}
            previous.checked_at = now
        db.add(AuditLog(action='properties.motherboard_fan_headers_structured',
            object_type='category', object_id='359', details={'values': len(changes)}))
        db.commit()
        print(f'APPLIED {len(changes)} values')


if __name__ == '__main__':
    main()
