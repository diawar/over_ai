"""Read-only audit of required DB rules and known values used by PC builder."""
import re
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Attribute, Category, CategoryAttribute, Product, ProductAttribute, PropertyRule


source = Path('/tmp/pc-builder.cjs').read_text(encoding='utf-8')
block = re.search(r'const CHECKED_ATTRIBUTES = new Set\(\[(.*?)\]\)', source, re.S)
if not block:
    raise RuntimeError('Builder attribute list not found')
codes = set(re.findall(r"'([a-z][a-z0-9_]+)'", block.group(1)))

with SessionLocal() as db:
    rows = list(db.execute(select(PropertyRule, Category).join(
        Category, Category.id == PropertyRule.category_id).where(
        PropertyRule.code.in_(codes), PropertyRule.active.is_(True),
        PropertyRule.source == 'internal', Category.organization_id == 1)))
    missing = []
    for rule, category in rows:
        if category.name == 'Системы водяного / жидкостного охлаждения (СЖО)' and rule.code == 'cpu_cooler_tdp_w':
            continue  # The builder uses radiator size, not AIO TDP.
        link = db.get(CategoryAttribute, (category.id, rule.attribute_id)) if rule.attribute_id else None
        required = bool(rule.definition.get('required_for_selection') and link and link.required_for_selection)
        if not required:
            missing.append((category.name, rule.code))
    print(f'BUILDER CODES {len(codes)}; ACTIVE RULES {len(rows)}; NOT REQUIRED {len(missing)}')
    for category, code in sorted(missing):
        print(f'  {category}: {code}')
    for rule, category in rows:
        if (category.name, rule.code) not in missing:
            continue
        eligible = list(db.scalars(select(Product).join(Product.categories).where(
            Product.validity_check.is_(True), Category.id == category.id)))
        present = set(db.scalars(select(ProductAttribute.product_id).where(
            ProductAttribute.attribute_id == rule.attribute_id,
            ProductAttribute.value_state == 'known',
            ProductAttribute.product_id.in_([row.id for row in eligible]))))
        print(f'    COVERAGE {category.name}: {rule.code}: {len(present)}/{len(eligible)}')
        for product in eligible:
            if product.id not in present:
                print(f'      MISSING {product.id}: {product.name}')
    print('NO ACTIVE RULE:', ', '.join(sorted(codes - {rule.code for rule, _ in rows})))
    for product_id in (14971, 23523):
        product = db.get(Product, product_id)
        if product:
            values = dict(db.execute(select(Attribute.code, ProductAttribute.value_number).join(
                ProductAttribute, ProductAttribute.attribute_id == Attribute.id).where(
                ProductAttribute.product_id == product_id,
                Attribute.code.in_({'case_drive_bays_25','case_drive_bays_35'}))).all())
            print('CASE', product_id, product.manufacturer, product.manufacturer_article, values)
