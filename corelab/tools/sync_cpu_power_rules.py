"""Local audited migration of CPU cooling requirements, without provider calls."""
import argparse
import json
from pathlib import Path
from datetime import datetime, timezone
from sqlalchemy import select
from app.db import SessionLocal
from app.models import PropertyRule, CategoryStructureCheck, AuditLog, Product, ProductAttribute, Attribute
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
with SessionLocal() as db:
    seeds = list(db.scalars(select(PropertyRule).where(PropertyRule.code == 'cpu_tdp_w', PropertyRule.active.is_(True))))
    backup = []
    for seed in seeds:
        if seed.category_id is None:
            continue
        db.info['organization_id'] = seed.organization_id
        rules = list(db.scalars(select(PropertyRule).where(PropertyRule.category_id == seed.category_id,
            PropertyRule.organization_id == seed.organization_id, PropertyRule.source == 'internal')))
        by_code = {r.code: r for r in rules}
        backup.extend({'id': r.id, 'organization_id': r.organization_id, 'definition': r.definition} for r in rules)
        tdp = {**seed.definition, 'level': 'required', 'required_for_selection': False}
        definitions = [tdp]
        for code, label, note in [
            ('cpu_max_turbo_power_w', 'Максимальная мощность Intel (MTP)', 'Intel: опубликованная Maximum Turbo Power. Не заменять базовым TDP. Для AMD не заполнять.'),
            ('cpu_ppt_w', 'Предел мощности AMD (PPT)', 'AMD: опубликованный штатный PPT точной модели. Для Intel не заполнять. Если неизвестен, сборщик использует TDP × 1.5 для Ryzen 7/9, × 1.35 для остальных AMD; расчёт не записывается как паспортное значение.')]:
            previous = by_code.get(code)
            definitions.append({**(previous.definition if previous else {}), 'code': code, 'label': label,
                'value_type': 'number', 'unit': 'W', 'minimum': 1, 'level': 'recommended',
                'required_for_selection': False, 'note': note})
        print(f'CPU category={seed.category_id} org={seed.organization_id}: TDP loading required; selection uses MTP/PPT')
        if args.apply:
            lock_validation(db)
            for definition in definitions:
                attach_rule(db, seed.category_id, RuleDefinition.model_validate(definition), by_code.get(definition['code']))
            db.flush()
            revalidate_category(db, seed.category_id)
            report = structure_report(db, seed.category_id)
            check = db.get(CategoryStructureCheck, seed.category_id)
            if check:
                research = (check.report or {}).get('research')
                check.fingerprint = report['fingerprint']
                check.report = {**report, **({'research': research} if research else {})}
                check.checked_at = datetime.now(timezone.utc)
            db.add(AuditLog(action='properties.cpu_cooling_power_rules', object_type='category',
                object_id=str(seed.category_id), details={'previous': [r for r in backup if r['organization_id'] == seed.organization_id]}))
    # Show saved facts for the reported pair without changing product values.
    for p in db.scalars(select(Product).where(Product.name.ilike('%9950X%') | Product.name.ilike('%SE-214-XT V2%'))):
        facts = list(db.execute(select(Attribute.code, ProductAttribute.value_number, ProductAttribute.value_string)
            .join(ProductAttribute, ProductAttribute.attribute_id == Attribute.id).where(ProductAttribute.product_id == p.id,
            Attribute.code.in_(['cpu_tdp_w', 'cpu_max_turbo_power_w', 'cpu_ppt_w', 'cpu_cooler_tdp_w']))))
        print(p.id, p.name, [tuple(map(str, f)) for f in facts])
    if args.apply:
        Path('/tmp/cpu-power-rules-before.json').write_text(json.dumps(backup, ensure_ascii=False, default=str), encoding='utf-8')
        db.commit()
        print('APPLIED')
