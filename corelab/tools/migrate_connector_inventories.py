"""Migrate existing connector properties to typed JSON arrays, dry run by default."""
import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.connector_inventory import CONNECTOR_CODES, normalize_connector_inventory
from app.db import SessionLocal
from app.models import (Attribute, AuditLog, CategoryStructureCheck, ProductAttribute,
                        PropertyRule)
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    template = json.loads(Path('/tmp/pc_property_templates.json').read_text(encoding='utf-8'))
    fan_rule = RuleDefinition.model_validate(next(row for category in template
        if category['code'] == 'case_cooling' for row in category['attributes']
        if row['code'] == 'case_fan_connector'))
    with SessionLocal() as db:
        rows = list(db.execute(select(ProductAttribute, Attribute).join(
            Attribute, Attribute.id == ProductAttribute.attribute_id).where(
            Attribute.code.in_(CONNECTOR_CODES), ProductAttribute.value_state == 'known')))
        changes = []
        counts = Counter()
        for row, attr in rows:
            old = row.value_json if row.value_json is not None else row.value_string
            if old is None:
                continue
            new = normalize_connector_inventory(attr.code, old)
            counts[attr.code] += 1
            if old != new or row.value_string is not None:
                changes.append((row, attr.code, new))
        fan_attr = db.scalar(select(Attribute).where(Attribute.code == 'case_fan_connector'))
        fan_db_rule = db.scalar(select(PropertyRule).where(
            PropertyRule.code == 'case_fan_connector', PropertyRule.source == 'internal',
            PropertyRule.active.is_(True)))
        if not fan_attr or not fan_db_rule or fan_db_rule.category_id != 442:
            raise RuntimeError('Case fan rule identity mismatch')
        rule_change = fan_attr.value_type != 'list' or fan_db_rule.definition != fan_rule.model_dump(mode='json')
        print('ROWS', dict(counts), 'CHANGES', len(changes), 'FAN_RULE_CHANGE', rule_change)
        print('UNRESOLVED', sum(1 for _, _, value in changes
            if any(entry['kind'] == 'unresolved' for entry in value)))
        if not args.apply:
            print('DRY RUN: no writes')
            return
        if not changes and not rule_change:
            print('UNCHANGED')
            return
        lock_validation(db)
        for row, _, value in changes:
            row.value_string = None
            row.value_json = value
            row.updated_at = datetime.now(timezone.utc)
        if rule_change:
            fan_attr.value_type = 'list'
            db.flush()
            attach_rule(db, 442, fan_rule, existing=fan_db_rule)
        categories = sorted({rule.category_id for rule in db.scalars(select(PropertyRule).where(
            PropertyRule.code.in_(CONNECTOR_CODES), PropertyRule.active.is_(True),
            PropertyRule.category_id.is_not(None)))})
        for category_id in categories:
            revalidate_category(db, category_id)
        previous = db.get(CategoryStructureCheck, 442)
        report = structure_report(db, 442)
        if previous:
            research = (previous.report or {}).get('research')
            previous.fingerprint = report['fingerprint']
            previous.report = {**report, **({'research': research} if research else {})}
            previous.checked_at = datetime.now(timezone.utc)
        db.add(AuditLog(action='properties.connector_inventories_migrated',
            object_type='category', object_id='442', details={
                'counts': dict(counts), 'changed_rows': len(changes),
                'fan_rule_changed': rule_change}))
        db.commit()
        print('APPLIED', len(changes), 'values')


if __name__ == '__main__':
    main()
