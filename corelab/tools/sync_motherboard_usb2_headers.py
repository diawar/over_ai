"""Attach verified physical USB 2.0 header counts to eligible motherboards."""
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
CODE = 'motherboard_usb2_headers'
# Number of physical internal headers, not the number of USB ports.
# The A520M-K (22857) specification lists two front USB 2.0 ports. Its
# single physical header is inferred from that layout and the matching manual.
BOARD_VALUES = {
    757: (2, 'https://www.asrock.com/mb/AMD/A520M-HVS/index.asp'),
    1078: (2, 'https://www.gigabyte.com/Motherboard/B840M-H/sp'),
    3580: (2, 'https://www.gigabyte.com/in/Motherboard/B650M-AORUS-ELITE-AX-ICE-rev-1x/sp'),
    4195: (1, 'https://www.asus.com/uk/motherboards-components/motherboards/prime/prime-h610m-k/techspec/'),
    4703: (1, 'https://rog.asus.com/us/motherboards/rog-strix/rog-strix-b760-i-gaming-wifi-model/spec/'),
    5631: (2, 'https://www.asus.com/motherboards-components/motherboards/tuf-gaming/tuf-gaming-b850-e-wifi/techspec/'),
    6034: (1, 'https://www.maxsun.com.cn/2025/0226/6416.html'),
    6075: (2, 'https://www.msi.com/Motherboard/B550-A-PRO/Specification'),
    6258: (2, 'https://www.asus.com/uk/motherboards-components/motherboards/prime/prime-b760m-r-d4/techspec/'),
    8452: (2, 'https://www.gigabyte.com/Motherboard/B760M-D3HP/sp'),
    8513: (2, 'https://www.gigabyte.com/Motherboard/B850M-DS3H-rev-12/sp'),
    9714: (1, 'https://www.gigabyte.com/Motherboard/H610M-K-DDR4-rev-10/sp'),
    15314: (2, 'https://download.msi.com/archive/mnu_exe/mb/MAGX870TOMAHAWKWIFI_English.pdf'),
    16225: (1, 'https://www.asus.com/ca-en/motherboards-components/motherboards/prime/prime-b860m-a-wifi/techspec/'),
    16268: (2, 'https://www.asrock.com/MB/AMD/B650M-HM.2%2B/'),
    19330: (1, 'https://www.maxsun.com/products/ms-challenger-h610m-h'),
    22857: (1, 'https://www.maxsun.com/vi/products/challenger-a520m-k'),
    24430: (2, 'https://www.asrock.com/MB/Intel/B760M-HDVM.2/index.asp'),
    26512: (2, 'https://dlcdnets.asus.com/pub/ASUS/mb/SocketAM4/PRIME_A520M-K/E16800_PRIME_A520M-K_UM_WEB.pdf'),
    29992: (2, 'https://www.asrock.com/MB/Intel/B860M%20Pro-A/index.asp'),
    31388: (2, 'https://www.asrock.com/MB/AMD/B550M-HDV/index.asp'),
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
        eligible = list(db.scalars(select(Product).join(Product.categories).where(
            Product.validity_check.is_(True), Category.id == CATEGORY_ID)))
        if not set(BOARD_VALUES).issubset({row.id for row in eligible}):
            raise RuntimeError('Eligible motherboard catalog changed; review identities')
        rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == CATEGORY_ID,
            PropertyRule.code == CODE, PropertyRule.source == 'internal'))
        rule_change = rule is None or not rule.active or rule.definition != definition.model_dump(mode='json')
        attr = db.scalar(select(Attribute).where(Attribute.code == CODE))
        changes = []
        for product in eligible:
            if product.id not in BOARD_VALUES:
                continue
            if len(product.categories) != 1 or product.categories[0].id != CATEGORY_ID:
                raise RuntimeError(f'Product category mismatch: {product.id}')
            count, source = BOARD_VALUES[product.id]
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product.id,
                ProductAttribute.attribute_id == attr.id)) if attr else None
            if row is None or row.value_state != 'known' or row.value_number != count or row.source_url != source:
                changes.append((product, count, source, row))
                print(f'VALUE product={product.id} {CODE}={count}')
        print(f'RULE {CODE}: {"UPDATE" if rule_change else "UNCHANGED"}')
        if not args.apply:
            print(f'DRY RUN: {int(rule_change)} rule, {len(changes)} values; no writes.')
            return
        if not rule_change and not changes:
            print('UNCHANGED')
            return
        lock_validation(db)
        if rule_change:
            attach_rule(db, CATEGORY_ID, definition, existing=rule)
        db.flush()
        attr = db.scalar(select(Attribute).where(Attribute.code == CODE))
        now = datetime.now(timezone.utc)
        for product, count, source, row in changes:
            if row is None:
                row = ProductAttribute(product_id=product.id, attribute_id=attr.id)
                db.add(row)
            row.value_state = 'known'
            row.value_number = count
            row.source_kind = 'manufacturer_inference' if product.id == 22857 else 'manufacturer_site'
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
        db.add(AuditLog(action='properties.motherboard_usb2_headers_added',
            object_type='category', object_id=str(CATEGORY_ID), details={
                'board_values': len(changes), 'checked_on': now.date().isoformat()}))
        db.commit()
        print(f'APPLIED: {int(rule_change)} rule, {len(changes)} board values.')


if __name__ == '__main__':
    main()
