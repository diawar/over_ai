"""Install optional cooling-noise rules from the reviewed local template; no API calls."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Category, CategoryStructureCheck, PropertyRule
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category

FIELDS = {437: ('cpu_air_cooler', 'cpu_cooler_fan_noise_dba'),
          246: ('aio_cooler', 'aio_fan_noise_dba')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--template', default='/tmp/pc_property_templates.json')
    args = parser.parse_args()
    template = json.loads(Path(args.template).read_text(encoding='utf-8'))
    changes = []
    with SessionLocal() as db:
        for category_id, (group_code, code) in FIELDS.items():
            category = db.get(Category, category_id)
            if not category or category.organization_id != 1:
                raise RuntimeError(f'Category {category_id} identity mismatch')
            group = next(row for row in template if row['code'] == group_code)
            definition = RuleDefinition.model_validate(next(row for row in group['attributes']
                if row['code'] == code))
            rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category_id,
                PropertyRule.code == code, PropertyRule.source == 'internal'))
            if rule is None or not rule.active or rule.definition != definition.model_dump(mode='json'):
                changes.append((category_id, code, definition, rule))
                print(f'RULE {category_id} {code}: {"ADD" if rule is None else "UPDATE"}')
        if not args.apply:
            print(f'DRY RUN: {len(changes)} rules; no writes.')
            return
        if not changes:
            print('UNCHANGED')
            return
        lock_validation(db)
        now = datetime.now(timezone.utc)
        for category_id, code, definition, rule in changes:
            attach_rule(db, category_id, definition, existing=rule)
        db.flush()
        for category_id in {row[0] for row in changes}:
            revalidate_category(db, category_id)
            previous = db.get(CategoryStructureCheck, category_id)
            research = (previous.report or {}).get('research') if previous else None
            report = structure_report(db, category_id)
            if previous is None:
                previous = CategoryStructureCheck(category_id=category_id,
                    fingerprint=report['fingerprint'], report={})
                db.add(previous)
            previous.fingerprint = report['fingerprint']
            previous.report = {**report, **({'research': research} if research else {})}
            previous.checked_at = now
            db.add(AuditLog(action='properties.cooling_noise_rule_added', object_type='category',
                object_id=str(category_id), details={'codes': [code for cid, code, _, _ in changes
                if cid == category_id], 'checked_on': now.date().isoformat()}))
        db.commit()
        print(f'APPLIED: {len(changes)} rules.')


if __name__ == '__main__':
    main()
