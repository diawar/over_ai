"""Read-only inventory of air coolers and their builder properties."""
from sqlalchemy import select, func

from app.db import SessionLocal
from app.models import (Attribute, Category, Product, ProductAttribute,
                        ProductSourceLink, PropertyRule, SupplierOffer)


with SessionLocal() as db:
    rule = db.scalar(select(PropertyRule).where(
        PropertyRule.code == 'cpu_cooler_height_mm', PropertyRule.source == 'internal',
        PropertyRule.active.is_(True)))
    if rule is None:
        raise RuntimeError('Air cooler rule missing')
    category = db.get(Category, rule.category_id)
    codes = ('cpu_cooler_sockets', 'cpu_cooler_height_mm', 'cpu_cooler_tdp_w', 'cpu_cooler_type')
    attrs = {row.code: row for row in db.scalars(select(Attribute).where(Attribute.code.in_(codes)))}
    products = list(db.scalars(select(Product).join(Product.categories).where(
        Category.id == category.id).order_by(Product.id)))
    print(f'CATEGORY {category.id} {category.name}; products={len(products)}')
    for product in products:
        if product.status != 'active' or product.is_archived or not product.selection_enabled:
            continue
        values = {}
        for code, attr in attrs.items():
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product.id,
                ProductAttribute.attribute_id == attr.id,
                ProductAttribute.value_state == 'known'))
            if row:
                values[code] = row.value_json if row.value_json is not None else (
                    row.value_number if row.value_number is not None else row.value_string)
        offer_count = db.scalar(select(func.count(SupplierOffer.id)).join(ProductSourceLink,
            ProductSourceLink.offer_id == SupplierOffer.id).where(
            ProductSourceLink.product_id == product.id, SupplierOffer.is_current.is_(True),
            SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0)) or 0
        if offer_count == 0 or product.validity_check or not values.get('cpu_cooler_sockets') or \
           not values.get('cpu_cooler_tdp_w') or not values.get('cpu_cooler_height_mm') or \
           values['cpu_cooler_height_mm'] > 165:
            continue
        if values.get('cpu_cooler_type') or 'AM5' not in values['cpu_cooler_sockets']:
            continue
        min_price = db.scalar(select(func.min(SupplierOffer.price)).join(ProductSourceLink,
            ProductSourceLink.offer_id == SupplierOffer.id).where(
            ProductSourceLink.product_id == product.id, SupplierOffer.is_current.is_(True),
            SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0))
        print({'id': product.id, 'manufacturer': product.manufacturer,
               'article': product.manufacturer_article, 'name': product.name,
               'valid': product.validity_check, 'status': product.status,
               'selection': product.selection_enabled, 'offers': offer_count, 'price': min_price,
               'facts': values})
