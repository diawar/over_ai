"""Read-only coverage audit for required configurator properties."""
from collections import Counter

from sqlalchemy import select, func

from app.db import SessionLocal
from app.models import (Attribute, Category, CategoryAttribute, Product,
                        ProductAttribute, ProductSourceLink, PropertyRule,
                        SupplierOffer)


with SessionLocal() as db:
    categories = list(db.scalars(select(Category).where(
        Category.organization_id == 1, Category.selection_category.is_(True)).order_by(Category.id)))
    for category in categories:
        required = db.execute(select(Attribute.id, Attribute.code).join(CategoryAttribute,
            CategoryAttribute.attribute_id == Attribute.id).where(
            CategoryAttribute.category_id == category.id,
            CategoryAttribute.required_for_selection.is_(True))).all()
        if not required:
            continue
        products = list(db.scalars(select(Product).join(Product.categories).where(
            Category.id == category.id, Product.status == 'active', Product.is_archived.is_not(True),
            Product.selection_enabled.is_(True))))
        missing_counts = Counter()
        affected = []
        with_offers = 0
        for product in products:
            offers = db.scalar(select(func.count(SupplierOffer.id)).join(ProductSourceLink,
                ProductSourceLink.offer_id == SupplierOffer.id).where(
                ProductSourceLink.product_id == product.id, SupplierOffer.is_current.is_(True),
                SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0)) or 0
            with_offers += offers > 0
            missing = []
            for attribute_id, code in required:
                known = db.scalar(select(ProductAttribute.id).where(
                    ProductAttribute.product_id == product.id,
                    ProductAttribute.attribute_id == attribute_id,
                    ProductAttribute.value_state == 'known').limit(1))
                if known is None:
                    missing.append(code)
                    missing_counts[code] += 1
            if missing and offers:
                affected.append((product.id, product.manufacturer, product.manufacturer_article,
                                 product.name, missing))
        print(f'CATEGORY {category.id} {category.name} active={len(products)} '
              f'with_offers={with_offers} missing_products={len(affected)}')
        print('  MISSING_FIELDS ' + ', '.join(f'{code}:{count}' for code, count in
                                                missing_counts.most_common()))
        for row in affected[:20]:
            print('  PRODUCT', row)
