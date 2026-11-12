"""Install reviewed CPU power connector facts and selection rules; dry run by default."""
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


BOARD_CATEGORY = 359
PSU_CATEGORY = 146
BOARD_CODE = 'motherboard_cpu_power_connectors'
PSU_CODE = 'psu_cpu_connectors'
ONE_8 = ['1 x CPU 8-pin']
ONE_4 = ['1 x CPU 4-pin']
TWO_8 = ['2 x CPU 8-pin']
BOARD_FACTS = (
    (757, 'ASRock', 'A520M-HVS', ONE_4, 'https://www.asrock.com/mb/AMD/A520M-HVS/index.asp'),
    (1078, 'Gigabyte', 'B840M H', ONE_8, 'https://www.gigabyte.com/Motherboard/B840M-H/sp'),
    (3580, 'Gigabyte', 'B650M AORUS ELITE AX ICE', ONE_8, 'https://www.gigabyte.com/in/Motherboard/B650M-AORUS-ELITE-AX-ICE-rev-1x/sp'),
    (4195, 'ASUS', 'PRIME H610M-K', ONE_8, 'https://www.asus.com/uk/motherboards-components/motherboards/prime/prime-h610m-k/techspec/'),
    (4703, 'ASUS', 'ROG STRIX B760-I GAMING WIFI', ONE_8, 'https://rog.asus.com/us/motherboards/rog-strix/rog-strix-b760-i-gaming-wifi-model/spec/'),
    (5631, 'ASUS', 'TUF GAMING B850-E WIFI', ONE_8, 'https://dlcdnets.asus.com/pub/ASUS/mb/SocketAM5/TUF_GAMING_B850-E_WIFI/E25818_TUF_GAMING_B850-E_WIFI_EM_WEB.pdf?model=TUF+GAMING+B850-E+WIFI'),
    (6034, 'MaxSun', 'MS-Challenger H610M-H', ONE_8, 'https://www.maxsun.com.cn/2025/0226/6416.html'),
    (6075, 'MSI', 'B550-A PRO', ONE_8, 'https://download.msi.com/archive/mnu_exe/mb/B550-APRO_EN.pdf'),
    (6258, 'ASUS', 'PRIME B760M-R D4', ONE_8, 'https://www.asus.com/uk/motherboards-components/motherboards/prime/prime-b760m-r-d4/techspec/'),
    (8452, 'Gigabyte', 'B760M D3HP DDR5', ONE_8, 'https://www.gigabyte.com/Motherboard/B760M-D3HP/sp'),
    (8513, 'Gigabyte', 'B850M DS3H', ONE_8, 'https://www.gigabyte.com/Motherboard/B850M-DS3H-rev-12/sp'),
    (9714, 'Gigabyte', 'H610M K DDR4', ONE_8, 'https://www.gigabyte.com/Motherboard/H610M-K-DDR4-rev-10/sp'),
    (15314, 'MSI', 'MAG X870 TOMAHAWK WIFI', TWO_8, 'https://download.msi.com/archive/mnu_exe/mb/MAGX870TOMAHAWKWIFI_English.pdf'),
    (16225, 'ASUS', 'PRIME B860M-A WIFI', ONE_8, 'https://www.asus.com/ca-en/motherboards-components/motherboards/prime/prime-b860m-a-wifi/techspec/'),
    (16268, 'ASRock', 'B650M-H/M.2+', ONE_8, 'https://www.asrock.com/MB/AMD/B650M-HM.2%2B/'),
    (19330, 'MaxSun', 'MS-Challenger H610M-H V1', ONE_8, 'https://www.maxsun.com/products/ms-challenger-h610m-h'),
    (22857, 'MaxSun', 'Challenger A520M-K', ONE_8, 'https://www.maxsun.com/vi/products/challenger-a520m-k'),
    (24430, 'ASRock', 'B760M-HDV/M.2', ONE_8, 'https://www.asrock.com/MB/Intel/B760M-HDVM.2/index.asp'),
    (26512, 'ASUS', 'PRIME A520M-K', ONE_8, 'https://www.asus.com/eg-en/motherboards-components/motherboards/prime/prime-a520m-k/techspec/'),
    (29992, 'ASRock', 'B860M PRO-A', ONE_8, 'https://download.asrock.com/Manual/B860M%20Pro-A.pdf'),
    (31388, 'ASRock', 'B550M-HDV', ONE_4, 'https://www.asrock.com/MB/AMD/B550M-HDV/index.asp'),
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    templates = {row['code']: row for row in json.loads(
        Path('/tmp/pc_property_templates.json').read_text(encoding='utf-8'))}
    definitions = {
        (category_id, code): RuleDefinition.model_validate(next(row for row in templates[template]['attributes']
            if row['code'] == code))
        for category_id, template, code in ((BOARD_CATEGORY, 'motherboard', BOARD_CODE),
                                            (PSU_CATEGORY, 'power_supply', PSU_CODE))
    }
    with SessionLocal() as db:
        for category_id, name in ((BOARD_CATEGORY, 'Материнские платы'),
                                  (PSU_CATEGORY, 'Блоки питания')):
            category = db.get(Category, category_id)
            if not category or category.name != name or category.organization_id != 1:
                raise RuntimeError(f'Category identity mismatch: {category_id}')
        changes = []
        for (category_id, code), definition in definitions.items():
            rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category_id,
                PropertyRule.code == code, PropertyRule.source == 'internal'))
            if rule is None or not rule.active or rule.definition != definition.model_dump(mode='json'):
                changes.append((category_id, code, definition, rule))
                print(f'RULE {category_id} {code}: {"ADD" if rule is None else "UPDATE"}')
        facts = []
        for product_id, manufacturer, article, value, source_url in BOARD_FACTS:
            product = db.get(Product, product_id)
            if not product or product.manufacturer != manufacturer or product.manufacturer_article != article or \
                    len(product.categories) != 1 or product.categories[0].id != BOARD_CATEGORY:
                raise RuntimeError(f'Exact product identity mismatch: {product_id}')
            attr = db.scalar(select(Attribute).where(Attribute.code == BOARD_CODE))
            existing = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product_id,
                ProductAttribute.attribute_id == attr.id)) if attr else None
            if existing is None or existing.value_json != value or existing.source_url != source_url:
                facts.append((product_id, value, source_url))
                print(f'VALUE product={product_id} {value}')
        if not args.apply:
            print(f'DRY RUN: {len(changes)} rules, {len(facts)} board values; no writes.')
            return
        if not changes and not facts:
            print('UNCHANGED')
            return
        lock_validation(db)
        for category_id, _code, definition, rule in changes:
            attach_rule(db, category_id, definition, existing=rule)
        db.flush()
        now = datetime.now(timezone.utc)
        attr = db.scalar(select(Attribute).where(Attribute.code == BOARD_CODE))
        for product_id, value, source_url in facts:
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product_id,
                ProductAttribute.attribute_id == attr.id))
            if row is None:
                row = ProductAttribute(product_id=product_id, attribute_id=attr.id)
                db.add(row)
            row.value_state = 'known'
            row.value_json = value
            row.source_kind = 'manufacturer_site'
            row.source_url = source_url
            row.updated_at = now
        for category_id in (BOARD_CATEGORY, PSU_CATEGORY):
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
        db.add(AuditLog(action='properties.cpu_power_connector_rules_added',
            object_type='category', object_id=str(BOARD_CATEGORY), details={
                'board_values': len(facts), 'rule_changes': len(changes),
                'checked_at': now.date().isoformat()}))
        db.commit()
        print(f'APPLIED: {len(changes)} rules, {len(facts)} board values.')


if __name__ == '__main__':
    main()
