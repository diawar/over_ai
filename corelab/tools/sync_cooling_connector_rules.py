"""Install cooling inventories without fabricating product facts. Safe to rerun."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from app.cooling_inventory import COOLING_CODES, normalize_cooling_inventory
from app.db import SessionLocal
from app.models import (Attribute, AuditLog, Category, CategoryStructureCheck,
                        ProductAttribute, PropertyRule)
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category

GROUPS = {359: ('motherboard', 'Материнские платы'),
          437: ('cpu_air_cooler', 'Кулеры для процессоров'),
          246: ('aio_cooler', 'Системы водяного / жидкостного охлаждения (СЖО)')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--template', default='/app/app/pc_property_templates.json')
    args = parser.parse_args()
    templates = {group['code']: group for group in json.loads(Path(args.template).read_text(encoding='utf-8'))}
    with SessionLocal() as db:
        lock_validation(db)
        changes, values, seen_attributes = [], [], set()
        for category_id, (group, name) in GROUPS.items():
            category = db.get(Category, category_id)
            if not category or category.organization_id != 1 or category.name != name:
                raise RuntimeError(f'Category identity changed: {category_id}')
            for data in templates[group]['attributes']:
                if data['code'] not in COOLING_CODES:
                    continue
                definition = RuleDefinition.model_validate(data)
                rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category_id,
                    PropertyRule.code == definition.code, PropertyRule.source == 'internal'))
                attr = db.scalar(select(Attribute).where(Attribute.organization_id == 1,
                    Attribute.code == definition.code))
                if rule is None or not rule.active or rule.definition != definition.model_dump(mode='json') or (attr and attr.label != definition.label):
                    changes.append((category_id, definition, rule))
                if attr and attr.id not in seen_attributes:
                    seen_attributes.add(attr.id)
                    for row in db.scalars(select(ProductAttribute).where(ProductAttribute.attribute_id == attr.id)):
                        if row.value_state != 'known':
                            continue
                        old = row.value_json if row.value_json is not None else row.value_number if row.value_number is not None else row.value_string
                        normalized = normalize_cooling_inventory(definition.code, old)
                        if normalized != old:
                            values.append((row, normalized))
        print(f'RULES {len(changes)}; VALUES {len(values)}; no new product facts')
        if not args.apply:
            print('DRY RUN: no writes')
            return
        if not changes and not values:
            print('UNCHANGED')
            return
        for category_id, definition, rule in changes:
            attach_rule(db, category_id, definition, existing=rule)
            attr = db.scalar(select(Attribute).where(Attribute.organization_id == 1,
                Attribute.code == definition.code))
            attr.label = definition.label
        previous_values = [{'product_id': row.product_id, 'attribute_id': row.attribute_id,
                            'value': row.value_json} for row, _ in values]
        for row, value in values:
            row.value_json, row.value_number, row.value_string = value, None, None
        db.flush()
        for category_id in GROUPS:
            revalidate_category(db, category_id)
            previous = db.get(CategoryStructureCheck, category_id)
            report = structure_report(db, category_id)
            if previous:
                previous.fingerprint, previous.report = report['fingerprint'], report
                previous.checked_at = datetime.now(timezone.utc)
        db.add(AuditLog(action='properties.cooling_connectors_added', object_type='categories',
            object_id='359,437,246', details={'rules': len(changes), 'normalized_values': len(values),
                                           'product_facts_added': 0, 'previous_values': previous_values}))
        db.commit()
        print('APPLIED')


if __name__ == '__main__':
    main()
