"""Install reviewed component-color rules for white PC selection (offline)."""
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

CATEGORIES = {17: 'graphics_card', 146: 'power_supply', 253: 'ram', 359: 'motherboard', 432: 'pc_case',
              437: 'cpu_air_cooler', 246: 'aio_cooler', 442: 'case_cooling'}
CODE = 'component_color'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--template', default='/tmp/pc_property_templates.json')
    args = parser.parse_args()
    template = json.loads(Path(args.template).read_text(encoding='utf-8'))
    definitions = {row['code']: row for row in template}
    changes = []
    with SessionLocal() as db:
        for category_id, group_code in CATEGORIES.items():
            category = db.get(Category, category_id)
            if not category or category.organization_id != 1 or category.property_template_code != group_code:
                raise RuntimeError(f'Category identity mismatch: {category_id}/{group_code}')
            raw = next((item for item in definitions[group_code]['attributes'] if item['code'] == CODE), None)
            if raw is None:
                raise RuntimeError(f'Missing {CODE} template for {group_code}')
            rule_definition = RuleDefinition.model_validate(raw)
            rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category_id,
                PropertyRule.code == CODE, PropertyRule.source == 'internal'))
            if rule is None or not rule.active or rule.definition != rule_definition.model_dump(mode='json'):
                changes.append((category_id, rule_definition, rule))
                print(f'RULE {category_id} {CODE}: {"ADD" if rule is None else "UPDATE"}')
        if not args.apply:
            print(f'DRY RUN: {len(changes)} rules; no writes.')
            return
        if not changes:
            print('UNCHANGED')
            return
        lock_validation(db)
        now = datetime.now(timezone.utc)
        for category_id, rule_definition, rule in changes:
            attach_rule(db, category_id, rule_definition, existing=rule)
        db.flush()
        for category_id in {row[0] for row in changes}:
            revalidate_category(db, category_id)
            previous = db.get(CategoryStructureCheck, category_id)
            research = (previous.report or {}).get('research') if previous else None
            report = structure_report(db, category_id)
            if previous is None:
                previous = CategoryStructureCheck(category_id=category_id, fingerprint=report['fingerprint'], report={})
                db.add(previous)
            previous.fingerprint = report['fingerprint']
            previous.report = {**report, **({'research': research} if research else {})}
            previous.checked_at = now
            db.add(AuditLog(action='properties.component_color_rule_added', object_type='category',
                object_id=str(category_id), details={'code': CODE, 'checked_on': now.date().isoformat()}))
        db.commit()
        print(f'APPLIED: {len(changes)} category rules.')


if __name__ == '__main__':
    main()
