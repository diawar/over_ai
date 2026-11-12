"""Install optional, manufacturer-sourced motherboard feature rules."""
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


CATEGORY_ID = 359
CODES = ('motherboard_lan', 'motherboard_wifi_built_in',
         'motherboard_wifi', 'motherboard_usb4_ports')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--template', default='/tmp/pc_property_templates.json')
    args = parser.parse_args()
    template = json.loads(Path(args.template).read_text(encoding='utf-8'))
    motherboard = next(row for row in template if row['code'] == 'motherboard')
    definitions = {row['code']: RuleDefinition.model_validate(row)
                   for row in motherboard['attributes'] if row['code'] in CODES}
    if set(definitions) != set(CODES):
        raise RuntimeError('Motherboard feature template incomplete')
    with SessionLocal() as db:
        category = db.get(Category, CATEGORY_ID)
        if not category or category.name != 'Материнские платы' or category.organization_id != 1:
            raise RuntimeError('Motherboard category identity mismatch')
        changes = []
        for code in CODES:
            row = db.scalar(select(PropertyRule).where(PropertyRule.category_id == CATEGORY_ID,
                PropertyRule.code == code, PropertyRule.source == 'internal'))
            definition = definitions[code]
            if row is None or not row.active or row.definition != definition.model_dump(mode='json'):
                changes.append((code, definition, row))
                print(f'RULE {code}: {"ADD" if row is None else "UPDATE"}')
        if not args.apply:
            print(f'DRY RUN: {len(changes)} rules; no writes.')
            return
        if not changes:
            print('UNCHANGED')
            return
        lock_validation(db)
        now = datetime.now(timezone.utc)
        for _, definition, row in changes:
            attach_rule(db, CATEGORY_ID, definition, existing=row)
        db.flush()
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
        db.add(AuditLog(action='properties.motherboard_platform_features_added',
            object_type='category', object_id=str(CATEGORY_ID),
            details={'codes': [code for code, _, _ in changes],
                     'checked_on': now.date().isoformat()}))
        db.commit()
        print(f'APPLIED: {len(changes)} motherboard feature rules.')


if __name__ == '__main__':
    main()
