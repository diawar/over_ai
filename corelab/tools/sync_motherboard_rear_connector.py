"""Add the required rear-connector flag to the currently eligible board models."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (Attribute, AuditLog, Category, CategoryStructureCheck,
                        Product, ProductAttribute, PropertyRule)
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category


CATEGORY_ID = 359
CODE = 'motherboard_rear_connector'
BOARD_SOURCES = {
    757: 'https://www.asrock.com/mb/AMD/A520M-HVS/index.asp',
    1078: 'https://www.gigabyte.com/Motherboard/B840M-H/sp',
    3580: 'https://www.gigabyte.com/in/Motherboard/B650M-AORUS-ELITE-AX-ICE-rev-1x/sp',
    4195: 'https://www.asus.com/uk/motherboards-components/motherboards/prime/prime-h610m-k/techspec/',
    4703: 'https://rog.asus.com/us/motherboards/rog-strix/rog-strix-b760-i-gaming-wifi-model/spec/',
    5631: 'https://www.asus.com/motherboards-components/motherboards/tuf-gaming/tuf-gaming-b850-e-wifi/techspec/',
    6034: 'https://www.maxsun.com.cn/2025/0226/6416.html',
    6075: 'https://www.msi.com/Motherboard/B550-A-PRO/Specification',
    6258: 'https://www.asus.com/uk/motherboards-components/motherboards/prime/prime-b760m-r-d4/techspec/',
    8452: 'https://www.gigabyte.com/Motherboard/B760M-D3HP/sp',
    8513: 'https://www.gigabyte.com/Motherboard/B850M-DS3H-rev-12/sp',
    9714: 'https://www.gigabyte.com/Motherboard/H610M-K-DDR4-rev-10/sp',
    15314: 'https://www.msi.com/Motherboard/MAG-X870-TOMAHAWK-WIFI/Specification',
    16225: 'https://www.asus.com/ca-en/motherboards-components/motherboards/prime/prime-b860m-a-wifi/techspec/',
    16268: 'https://www.asrock.com/MB/AMD/B650M-HM.2%2B/',
    19330: 'https://www.maxsun.com/products/ms-challenger-h610m-h',
    22857: 'https://www.maxsun.com/vi/products/challenger-a520m-k',
    24430: 'https://www.asrock.com/MB/Intel/B760M-HDVM.2/index.asp',
    26512: 'https://www.asus.com/eg-en/motherboards-components/motherboards/prime/prime-a520m-k/techspec/',
    29992: 'https://www.asrock.com/MB/Intel/B860M%20Pro-A/index.asp',
    31388: 'https://www.asrock.com/MB/AMD/B550M-HDV/index.asp',
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    template = json.loads(Path('/tmp/pc_property_templates.json').read_text(encoding='utf-8'))
    motherboard = next(row for row in template if row['code'] == 'motherboard')
    definition = RuleDefinition.model_validate(next(row for row in motherboard['attributes']
        if row['code'] == CODE))
    with SessionLocal() as db:
        category = db.get(Category, CATEGORY_ID)
        if not category or category.name != 'Материнские платы' or category.organization_id != 1:
            raise RuntimeError('Motherboard category identity mismatch')
        rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == CATEGORY_ID,
            PropertyRule.code == CODE, PropertyRule.source == 'internal'))
        rule_change = rule is None or not rule.active or rule.definition != definition.model_dump(mode='json')
        if rule_change:
            print(f'RULE {CODE}: {"ADD" if rule is None else "UPDATE"}')
        attr = db.scalar(select(Attribute).where(Attribute.code == CODE))
        values = []
        eligible = list(db.scalars(select(Product).join(Product.categories).where(
            Product.validity_check.is_(True), Category.id == CATEGORY_ID)))
        if len(eligible) != len(BOARD_SOURCES) or {row.id for row in eligible} != set(BOARD_SOURCES):
            raise RuntimeError('Eligible motherboard catalog changed; review exact identities before applying')
        for product in eligible:
            if len(product.categories) != 1 or product.categories[0].id != CATEGORY_ID:
                raise RuntimeError(f'Product category mismatch: {product.id}')
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product.id,
                ProductAttribute.attribute_id == attr.id)) if attr else None
            source = BOARD_SOURCES[product.id]
            if row is None or row.value_boolean is not False or row.source_url != source:
                values.append((product, source, row))
                print(f'VALUE product={product.id} {CODE}=false')
        if not args.apply:
            print(f'DRY RUN: {int(rule_change)} rule, {len(values)} board values; no writes.')
            return
        if not rule_change and not values:
            print('UNCHANGED')
            return
        lock_validation(db)
        if rule_change:
            attach_rule(db, CATEGORY_ID, definition, existing=rule)
        db.flush()
        attr = db.scalar(select(Attribute).where(Attribute.code == CODE))
        now = datetime.now(timezone.utc)
        for product, source, row in values:
            if row is None:
                row = ProductAttribute(product_id=product.id, attribute_id=attr.id)
                db.add(row)
            row.value_state = 'known'
            row.value_boolean = False
            row.source_kind = 'manufacturer_site'
            row.source_url = source
            row.updated_at = now
        revalidate_category(db, CATEGORY_ID)
        previous = db.get(CategoryStructureCheck, CATEGORY_ID)
        research = (previous.report or {}).get('research') if previous else None
        report = structure_report(db, CATEGORY_ID)
        if previous is None:
            previous = CategoryStructureCheck(category_id=CATEGORY_ID,
                fingerprint=report['fingerprint'], report={})
            db.add(previous)
        previous.fingerprint = report['fingerprint']
        previous.report = {**report, **({'research': research} if research else {})}
        previous.checked_at = now
        db.add(AuditLog(action='properties.motherboard_rear_connector_added',
            object_type='category', object_id=str(CATEGORY_ID), details={
                'board_values': len(values), 'checked_on': now.date().isoformat()}))
        db.commit()
        print(f'APPLIED: {int(rule_change)} rule, {len(values)} board values.')


if __name__ == '__main__':
    main()
