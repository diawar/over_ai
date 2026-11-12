"""User-approved GPU structure revision; local DB only, no network/provider calls.

First run --backup /tmp/gpu-structure-before.json and copy it to the host.
Then run with the same --backup and --apply. Refuse changed data or shared fields.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select, text
from app import tenant  # noqa: F401
from app.db import SessionLocal
from app.models import (Attribute, AuditLog, Category, CategoryAttribute,
                        CategoryStructureCheck, ProductAttribute, PropertyRule,
                        PropertyValue, product_categories)
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category

CATEGORY = 17
ORG = 1
REMOVE = ['gpu_board_power_w', 'gpu_slot_width']
ASUS = 'https://www.asus.com/us/motherboards-components/graphics-cards/dual/dual-rtx5060-o8g/techspec/'
GIGABYTE = 'https://www.gigabyte.com/Graphics-Card/GV-N5070AORUS-M-12GD/sp'
MSI = 'https://us.msi.com/Graphics-Card/GeForce-RTX-5060-8G-GAMING-OC/Specification'
MSI_SPEED = 'https://de-store.msi.com/products/geforce-rtx-5060-8g-gaming-oc'
SAPPHIRE = 'https://www.sapphiretech.com/en/consumer/pure-radeon-rx-9070-16g-gddr6'
ADDITIONS = [
    dict(code='gpu_video_outputs', label='Видеовыходы', value_type='list', unit=None,
         note='Перечень записей: тип разъёма, опубликованная версия и количество. '
              'Пример формы: {"type":"DisplayPort","version":"2.1b","count":3}. '
              'Неуказанную версию не выводить из поколения GPU.'),
    dict(code='gpu_max_displays', label='Максимальное количество дисплеев',
         value_type='integer', unit=None, minimum=1,
         note='Максимум одновременно поддерживаемых дисплеев по спецификации точной модели; '
              'не выводить из количества физических видеовыходов.'),
    dict(code='gpu_boost_clock_mhz', label='Частота GPU в режиме Boost',
         value_type='number', unit='MHz', minimum=1,
         note='Опубликованная Boost-частота в штатном режиме точной модели. '
              'Не смешивать с Game Clock, базовой частотой и отдельным программным OC/Extreme Performance. '
              'Если источник не определяет режим частоты, требуется уточнение.'),
    dict(code='gpu_memory_data_rate_gbps', label='Скорость передачи данных видеопамяти',
         value_type='number', unit='Gbps', minimum=0.001,
         note='Эффективная скорость передачи данных на контакт памяти в Гбит/с. '
              'Не путать с частотой в МГц или общей пропускной способностью памяти в ГБ/с.'),
]


def packed(row):
    return {c.name: getattr(row, c.name) for c in row.__table__.columns}


def canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, default=str)


def snapshot(db):
    category = db.get(Category, CATEGORY)
    if category is None or category.organization_id != ORG or category.name != 'Видеокарты':
        raise RuntimeError('Unexpected category')
    attrs = list(db.scalars(select(Attribute).where(Attribute.code.in_(REMOVE)).order_by(Attribute.id)))
    if {a.code for a in attrs} != set(REMOVE) or len(attrs) != 2:
        raise RuntimeError('Expected exactly two removable attributes; may already be applied')
    ids = [a.id for a in attrs]
    links = list(db.scalars(select(CategoryAttribute).where(CategoryAttribute.attribute_id.in_(ids))
                           .order_by(CategoryAttribute.category_id, CategoryAttribute.attribute_id)))
    rules = list(db.scalars(select(PropertyRule).where(PropertyRule.attribute_id.in_(ids))
                           .order_by(PropertyRule.id)))
    values = list(db.scalars(select(ProductAttribute).where(ProductAttribute.attribute_id.in_(ids))
                            .order_by(ProductAttribute.id)))
    dictionary = list(db.scalars(select(PropertyValue).where(PropertyValue.attribute_id.in_(ids))
                                .order_by(PropertyValue.id)))
    if len(links) != 2 or len(rules) != 2 or any(r.category_id != CATEGORY for r in links + rules):
        raise RuntimeError('Removable properties are shared or unexpectedly scoped')
    if any(link.required_for_selection for link in links):
        raise RuntimeError('Unexpected selection requirement')
    pairs = list(db.execute(select(product_categories.c.product_id, product_categories.c.category_id)
                            .where(product_categories.c.product_id.in_([v.product_id for v in values]))))
    if any(cid != CATEGORY for _, cid in pairs) or {pid for pid, _ in pairs} != {v.product_id for v in values}:
        raise RuntimeError('Values exist outside the selected category')
    new_codes = [a['code'] for a in ADDITIONS]
    if list(db.scalars(select(Attribute).where(Attribute.code.in_(new_codes)))) or list(
            db.scalars(select(PropertyRule).where(PropertyRule.code.in_(new_codes)))):
        raise RuntimeError('Proposed property code already exists')
    check = db.get(CategoryStructureCheck, CATEGORY)
    return dict(category=packed(category), attributes=[packed(a) for a in attrs],
                removed_rules=[packed(r) for r in rules], links=[packed(r) for r in links],
                product_values=[packed(v) for v in values], dictionary=[packed(v) for v in dictionary],
                previous_check=packed(check) if check else None,
                category_fingerprint=structure_report(db, CATEGORY)['fingerprint'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    backup = Path(args.backup)
    with SessionLocal() as db:
        db.info['organization_id'] = ORG
        if args.apply:
            lock_validation(db)
            # Stabilize property definitions and values while snapshot is compared and applied.
            db.execute(text('LOCK TABLE attributes, category_attributes, property_rules, '
                            'product_attributes, property_values, category_structure_checks, '
                            'product_categories IN SHARE ROW EXCLUSIVE MODE'))
        else:
            db.execute(text('SET TRANSACTION READ ONLY'))
        before = snapshot(db)
        digest = hashlib.sha256(canonical(before).encode()).hexdigest()
        summary = dict(category_id=CATEGORY, values_to_remove=len(before['product_values']),
                       removed_codes=REMOVE, added_codes=[a['code'] for a in ADDITIONS], backup_sha256=digest)
        if not args.apply:
            with backup.open('x', encoding='utf-8') as out:
                json.dump(before, out, ensure_ascii=False, indent=2, default=str)
            print(json.dumps(dict(summary, mode='preview', database_writes=False), ensure_ascii=False))
            return
        if canonical(json.loads(backup.read_text(encoding='utf-8'))) != canonical(before):
            raise RuntimeError('Database changed since backup; no changes applied')
        ids = [a['id'] for a in before['attributes']]
        db.execute(delete(ProductAttribute).where(ProductAttribute.attribute_id.in_(ids)))
        db.execute(delete(PropertyValue).where(PropertyValue.attribute_id.in_(ids)))
        db.execute(delete(PropertyRule).where(PropertyRule.attribute_id.in_(ids)))
        db.execute(delete(CategoryAttribute).where(CategoryAttribute.attribute_id.in_(ids)))
        db.execute(delete(Attribute).where(Attribute.id.in_(ids)))
        for item in ADDITIONS:
            attach_rule(db, CATEGORY, RuleDefinition(**item, level='recommended', source='internal',
                        required_for_selection=False, ai_blocked=False,
                        evidence_url=ASUS, checked_on='2026-10-31'))
        db.flush()
        revalidate_category(db, CATEGORY)
        now = datetime.now(timezone.utc)
        research = dict(method='codex_official_source_review', external_ai_api_used=False,
            checked_at=now.isoformat(), property_count=13,
            models=[
                dict(manufacturer='ASUS', model='DUAL-RTX5060-O8G', product_id=19622, url=ASUS),
                dict(manufacturer='Gigabyte', model='GV-N5070AORUS M-12GD', product_id=1575, url=GIGABYTE),
                dict(manufacturer='MSI', model='G5060-8GC / GeForce RTX 5060 8G GAMING OC', product_id=16009, url=MSI),
                dict(manufacturer='Sapphire', model='11349-02-20G / PURE Radeon RX 9070 OC', product_id=7451, url=SAPPHIRE)],
            citations=[ASUS, GIGABYTE, MSI, MSI_SPEED, SAPPHIRE],
            added_properties=ADDITIONS, removed_properties=REMOVE,
            notes=['Исследование структуры; значения моделей не переносились в карточки товаров.',
                   'Существующие требования подбора сохранены; четыре новых свойства рекомендованные.',
                   'Частота Gigabyte названа Core Clock; при заполнении Boost необходимо уточнение режима.',
                   'Цвет подтверждается отдельно для точного исполнения модели.'])
        check = db.get(CategoryStructureCheck, CATEGORY)
        if check is None:
            check = CategoryStructureCheck(category_id=CATEGORY, fingerprint='', report={})
            db.add(check)
        check.report = {'research': research}
        check.checked_at = now
        db.flush()
        report = structure_report(db, CATEGORY)
        if report['errors']:
            raise RuntimeError(str(report['errors']))
        check.fingerprint = report['fingerprint']
        db.flush()
        report = structure_report(db, CATEGORY)
        check.report = {**report, 'research': research}
        db.add(AuditLog(action='properties.gpu_structure_revised_offline', object_type='category',
                       object_id=str(CATEGORY), details={**summary, 'research': research,
                       'user_authorization': 'Удалить потребляемую мощность и толщину со значениями; добавить четыре предложенных свойства'}))
        db.commit()
        print(json.dumps(dict(summary, mode='applied', structure_check=report), ensure_ascii=False))


if __name__ == '__main__':
    main()
