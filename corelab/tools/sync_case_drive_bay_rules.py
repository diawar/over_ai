"""Add shared drive bays and correct reviewed case capacities; dry run by default."""
import argparse
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (Attribute, AuditLog, Category, CategoryStructureCheck,
                        Product, ProductAttribute, PropertyRule)
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category


CATEGORY_ID = 432
RULE_CODES = ('case_drive_bays_25', 'case_drive_bays_35', 'case_drive_bays_shared_25_35')
VALUES = (
    (2167, 'ASUS', '90DC0040-B49000', 'case_drive_bays_25', 6,
     'https://www.asus.com/sg/motherboards-components/cases/tuf-gaming/tuf-gaming-gt301/techspec/'),
    (2167, 'ASUS', '90DC0040-B49000', 'case_drive_bays_shared_25_35', 2,
     'https://www.asus.com/sg/motherboards-components/cases/tuf-gaming/tuf-gaming-gt301/techspec/'),
    (7494, 'FSP', 'S342-BA', 'case_drive_bays_shared_25_35', 0,
     'https://www.fsplifestyle.com/en/product/S342.html'),
    # Both manufacturers publish separate maxima but not simultaneous placement.
    # min(max25,max35)=2 is a safe upper bound on shared positions.
    (14971, 'DeepCool', 'R-CG330-BKNGM3-G', 'case_drive_bays_shared_25_35', 2,
     'https://www.deepcool.com/products/Cases/CG330-3F-Panoramic-Glass-Panels-Dual-Chamber-M-ATX-Case/2025/21959.shtml'),
    (23523, 'Montech', 'X5 -B', 'case_drive_bays_shared_25_35', 2,
     'https://www.montechpc.com/x5'),
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    templates = {row['code']: row for row in json.loads(
        Path('/tmp/pc_property_templates.json').read_text(encoding='utf-8'))}
    definitions = {row['code']: RuleDefinition.model_validate(row)
                   for row in templates['pc_case']['attributes'] if row['code'] in RULE_CODES}
    with SessionLocal() as db:
        category = db.get(Category, CATEGORY_ID)
        if category is None or category.name != 'Корпуса' or category.organization_id != 1:
            raise RuntimeError('Case category identity mismatch')
        changes = []
        for code in RULE_CODES:
            rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == CATEGORY_ID,
                PropertyRule.code == code, PropertyRule.source == 'internal'))
            if rule is None or not rule.active or rule.definition != definitions[code].model_dump(mode='json'):
                changes.append((code, rule))
                print(f"RULE {code}: {'ADD' if rule is None else 'UPDATE'}")
        value_changes = []
        for product_id, manufacturer, article, code, value, source_url in VALUES:
            product = db.get(Product, product_id)
            if (product is None or product.manufacturer != manufacturer or
                    product.manufacturer_article != article or
                    len(product.categories) != 1 or product.categories[0].id != CATEGORY_ID):
                raise RuntimeError(f'Exact product identity mismatch for {product_id}')
            attr = db.scalar(select(Attribute).where(Attribute.code == code))
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product_id,
                ProductAttribute.attribute_id == attr.id)) if attr else None
            if row is None or row.value_number != value or row.source_url != source_url:
                if product_id == 2167 and code == 'case_drive_bays_25' and (row is None or row.value_number != 4):
                    raise RuntimeError('Unexpected existing ASUS 2.5-inch bay count')
                value_changes.append((product_id, code, value, source_url))
                print(f'VALUE product={product_id} {code}={value}')
        if not args.apply:
            print(f'DRY RUN: {len(changes)} rules, {len(value_changes)} values; no writes.')
            return
        if not changes and not value_changes:
            print('UNCHANGED')
            return
        lock_validation(db)
        for code, rule in changes:
            attach_rule(db, CATEGORY_ID, definitions[code], existing=rule)
        db.flush()
        now = datetime.now(timezone.utc)
        for product_id, code, value, source_url in value_changes:
            attr = db.scalar(select(Attribute).where(Attribute.code == code))
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product_id,
                ProductAttribute.attribute_id == attr.id))
            if row is None:
                row = ProductAttribute(product_id=product_id, attribute_id=attr.id)
                db.add(row)
            row.value_state = 'known'
            row.value_number = Decimal(value)
            row.source_kind = 'conservative_bound' if product_id in (14971, 23523) else 'manufacturer_site'
            row.source_url = source_url
            row.updated_at = now
            db.add(AuditLog(action='properties.drive_bay_evidence_updated',
                object_type='product', object_id=str(product_id), details={
                    'code': code, 'value': value, 'source_url': source_url,
                    'checked_at': now.date().isoformat(),
                    'conservative_upper_bound': product_id in (14971, 23523)}))
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
        db.add(AuditLog(action='properties.shared_drive_bay_rule_added',
            object_type='category', object_id=str(CATEGORY_ID), details={
                'codes': list(RULE_CODES), 'reviewed_values': [
                    {'product_id': pid, 'code': code, 'value': value}
                    for pid, code, value, _ in value_changes]}))
        db.commit()
        print(f'APPLIED: {len(changes)} rules, {len(value_changes)} values.')


if __name__ == '__main__':
    main()
