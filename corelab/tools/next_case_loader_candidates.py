"""Read-only queue of eligible case products missing configurator properties."""
import argparse
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import (Attribute, Category, CategoryAttribute, Product,
                        ProductAttribute, ProductSourceLink, SupplierOffer)


CATEGORY_ID = 432
parser = argparse.ArgumentParser()
parser.add_argument('--limit', type=int, default=30)
args = parser.parse_args()
if args.limit < 1:
    raise SystemExit('--limit must be positive')

with SessionLocal() as db:
    category = db.get(Category, CATEGORY_ID)
    required = dict(db.execute(select(Attribute.id, Attribute.code).join(CategoryAttribute,
        CategoryAttribute.attribute_id == Attribute.id).where(
        CategoryAttribute.category_id == CATEGORY_ID,
        CategoryAttribute.required_for_selection.is_(True))).all())
    products = list(db.scalars(select(Product).join(Product.categories).where(
        Category.id == CATEGORY_ID, Product.status == 'active',
        Product.is_archived.is_not(True), Product.selection_enabled.is_(True))))
    rows = []
    for product in products:
        if len(product.categories) != 1:
            continue
        offer = db.scalar(select(func.min(SupplierOffer.price)).join(ProductSourceLink,
            ProductSourceLink.offer_id == SupplierOffer.id).where(
            ProductSourceLink.product_id == product.id, SupplierOffer.is_current.is_(True),
            SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0))
        if offer is None:
            continue
        known = set(db.scalars(select(Attribute.code).join(ProductAttribute,
            ProductAttribute.attribute_id == Attribute.id).where(
            ProductAttribute.product_id == product.id,
            ProductAttribute.value_state == 'known')))
        missing = [code for code in required.values() if code not in known]
        if missing:
            rows.append((len(missing), offer, product, sorted(missing)))
    rows.sort(key=lambda row: (row[0], row[1], row[2].id))
    print(f'CATEGORY {category.id} {category.name}; eligible missing={len(rows)}')
    for missing_count, price, product, missing in rows[:args.limit]:
        print(f'{product.id}\t{product.manufacturer}\t{product.manufacturer_article}\t{price}\t'
              f'{missing_count}/{len(required)}\t{product.name}\t{",".join(missing)}')
