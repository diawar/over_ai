"""Install required-to-load front USB inventories and seed reviewed catalog facts.

Run inside the backend container with --apply after a dry run. USB fit remains a
customer warning, never a reason to reject a configuration.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.connector_inventory import normalize_connector_inventory
from app.db import SessionLocal
from app.models import (Attribute, AuditLog, Category, CategoryAttribute, Product,
                        ProductAttribute, PropertyRule)
from app.property_engine import RuleDefinition, normalize
from app.property_service import attach_rule
from app.validity import lock_validation, revalidate_category


CASES = {
    2167: ('https://www.asus.com/motherboards-components/cases/tuf-gaming/tuf-gaming-gt301/techspec/',
           ['2 x USB 3.1 Gen1']),
    7494: ('https://www.fsplifestyle.com/en/product/S342.html',
           ['2 x USB 3.0', '1 x Type-C']),
    14971: ('https://www.deepcool.com/products/Cases/CG330-3F-Panoramic-Glass-Panels-Dual-Chamber-M-ATX-Case/2025/21959.shtml',
            ['1 x USB 3.0', '2 x USB 2.0']),
    23523: ('https://www.montechpc.com/X5',
            ['1 x USB 2.0', '1 x USB 3.0', '1 x Type-C']),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    templates = {item['code']: item for item in json.loads(Path(
        '/tmp/pc_property_templates.json').read_text(encoding='utf-8'))}
    definitions = {
        359: RuleDefinition.model_validate(next(row for row in templates['motherboard']['attributes']
            if row['code'] == 'motherboard_internal_usb_headers')),
        432: RuleDefinition.model_validate(next(row for row in templates['pc_case']['attributes']
            if row['code'] == 'case_front_usb_headers')),
    }
    with SessionLocal() as db:
        eligible = {}
        for category_id in definitions:
            category = db.get(Category, category_id)
            if category is None or category.organization_id != 1:
                raise RuntimeError(f'Category {category_id} changed')
            eligible[category_id] = list(db.scalars(select(Product).join(Product.categories).where(
                Product.validity_check.is_(True), Category.id == category_id)))
        if len(eligible[359]) != 21 or {row.id for row in eligible[432]} != set(CASES):
            raise RuntimeError('Eligible catalog changed; review USB evidence before applying')
        board_old = db.scalar(select(Attribute).where(Attribute.organization_id == 1,
            Attribute.code == 'motherboard_usb2_headers'))
        new_board_attr = db.scalar(select(Attribute).where(Attribute.organization_id == 1,
            Attribute.code == 'motherboard_internal_usb_headers'))
        facts = {}
        for board in eligible[359]:
            source = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == board.id,
                ProductAttribute.attribute_id == board_old.id,
                ProductAttribute.value_state == 'known')) if board_old else None
            if source is not None and source.value_number is not None and source.source_url:
                count = int(source.value_number)
                raw = f'{count} x USB 2.0 internal header'
                facts[(359, board.id)] = ([{'kind': 'usb2_9pin', 'count': count, 'raw': raw}],
                                           source.source_url, source.source_kind)
            else:
                current = db.scalar(select(ProductAttribute).where(
                    ProductAttribute.product_id == board.id,
                    ProductAttribute.attribute_id == new_board_attr.id,
                    ProductAttribute.value_state == 'known')) if new_board_attr else None
                if current is None or not current.value_json or not current.source_url:
                    raise RuntimeError(f'No reviewed USB headers for board {board.id}')
                facts[(359, board.id)] = (current.value_json, current.source_url,
                                           current.source_kind)
        for product_id, (url, ports) in CASES.items():
            facts[(432, product_id)] = (ports, url, 'manufacturer_inference')
        changes = []
        for category_id, definition in definitions.items():
            rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category_id,
                PropertyRule.code == definition.code, PropertyRule.source == 'internal'))
            if rule is None or not rule.active or rule.definition != definition.model_dump(mode='json'):
                changes.append(('rule', category_id, definition.code))
            attr = db.scalar(select(Attribute).where(Attribute.organization_id == 1,
                Attribute.code == definition.code))
            for product in eligible[category_id]:
                value, url, source_kind = facts[(category_id, product.id)]
                normalized = normalize(normalize_connector_inventory(definition.code, value), definition)
                old = db.scalar(select(ProductAttribute).where(
                    ProductAttribute.product_id == product.id,
                    ProductAttribute.attribute_id == attr.id)) if attr else None
                if old is None or old.value_state != 'known' or old.value_json != normalized or old.source_url != url:
                    changes.append(('value', product.id, normalized))
        for item in changes:
            print(item)
        old_rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == 359,
            PropertyRule.code == 'motherboard_usb2_headers', PropertyRule.source == 'internal'))
        legacy_rows = list(db.scalars(select(ProductAttribute).where(
            ProductAttribute.attribute_id == board_old.id))) if board_old else []
        if legacy_rows and {row.product_id for row in legacy_rows} != {row.id for row in eligible[359]}:
            raise RuntimeError('Legacy USB 2.0 values exist outside the reviewed board set')
        if old_rule and old_rule.active or legacy_rows:
            changes.append(('retire', 'motherboard_usb2_headers', len(legacy_rows)))
            print(changes[-1])
        if not args.apply:
            print(f'DRY RUN: {len(changes)} changes')
            return
        if not changes:
            print('UNCHANGED')
            return
        lock_validation(db)
        now = datetime.now(timezone.utc)
        for category_id, definition in definitions.items():
            rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category_id,
                PropertyRule.code == definition.code, PropertyRule.source == 'internal'))
            attach_rule(db, category_id, definition, existing=rule)
            db.flush()
            attr = db.scalar(select(Attribute).where(Attribute.organization_id == 1,
                Attribute.code == definition.code))
            for product in eligible[category_id]:
                value, url, source_kind = facts[(category_id, product.id)]
                normalized = normalize(normalize_connector_inventory(definition.code, value), definition)
                row = db.scalar(select(ProductAttribute).where(
                    ProductAttribute.product_id == product.id,
                    ProductAttribute.attribute_id == attr.id))
                if row is None:
                    row = ProductAttribute(product_id=product.id, attribute_id=attr.id)
                    db.add(row)
                row.value_state = 'known'
                row.value_json = normalized
                row.source_kind = source_kind
                row.source_url = url
                row.updated_at = now
            revalidate_category(db, category_id)
            db.add(AuditLog(action='properties.front_usb_inventories_added', object_type='category',
                            object_id=str(category_id), details={'products': len(eligible[category_id])}))
        for row in legacy_rows:
            db.delete(row)
        if old_rule and old_rule.active:
            old_rule.active = False
            old_rule.revision += 1
        if board_old:
            old_link = db.get(CategoryAttribute, (359, board_old.id))
            if old_link:
                old_link.required_for_selection = False
        revalidate_category(db, 359)
        db.commit()
        print(f'APPLIED: {len(eligible[359])} boards and {len(eligible[432])} cases')


if __name__ == '__main__':
    main()
