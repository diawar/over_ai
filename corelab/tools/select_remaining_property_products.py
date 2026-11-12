"""Read-only: choose price-diverse eligible products in categories lacking evidence."""
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import (Attribute, Category, Product, ProductAttribute, ProductSourceLink,
                        SupplierOffer, product_categories)
from app.property_service import GLOBAL_FIELD_CODES

TARGETS = {246, 343, 442}

with SessionLocal() as db:
    categories = {c.id: c for c in db.scalars(select(Category).where(Category.id.in_(TARGETS)))}
    offers = select(ProductSourceLink.product_id.label('product_id'),
        func.min(SupplierOffer.price).label('price')).join(SupplierOffer,
        ProductSourceLink.offer_id == SupplierOffer.id).where(
        SupplierOffer.is_current.is_(True), SupplierOffer.is_archived.is_not(True),
        SupplierOffer.price > 0).group_by(ProductSourceLink.product_id).subquery()
    technical = select(ProductAttribute.product_id).join(Attribute).where(
        Attribute.code.notin_(GLOBAL_FIELD_CODES)).subquery()
    single_category = select(product_categories.c.product_id).group_by(
        product_categories.c.product_id).having(func.count(product_categories.c.category_id) == 1).subquery()
    for category_id in sorted(TARGETS):
        category = categories.get(category_id)
        if category is None:
            print('CATEGORY MISSING', category_id)
            continue
        rows = list(db.execute(select(Product, offers.c.price).join(product_categories,
            product_categories.c.product_id == Product.id).join(offers,
            offers.c.product_id == Product.id).where(
            product_categories.c.category_id == category_id,
            Product.id.in_(select(single_category.c.product_id)), Product.is_archived.is_not(True),
            Product.status == 'active', Product.selection_enabled.is_(True),
            Product.manufacturer.is_not(None), Product.manufacturer != '',
            Product.manufacturer_article.is_not(None), Product.manufacturer_article != '',
            ~Product.id.in_(select(technical.c.product_id)))))
        candidates = []
        for product, price in rows:
            if category_id == 442 and (product.manufacturer.casefold() == 'no name' or not any(
                    marker in product.name.casefold() for marker in ('вентилятор для корпуса', 'комплект вентиляторов'))):
                continue
            candidates.append((price, product))
        candidates.sort(key=lambda item: (item[0], item[1].id))
        take = min(15, len(candidates))
        indexes = [round(i * (len(candidates) - 1) / (take - 1)) for i in range(take)] if take > 1 else ([0] if take else [])
        print(f'\nCATEGORY {category.id} {category.name}: {take}/15; candidates={len(candidates)}')
        for index in indexes:
            price, p = candidates[index]
            print(f'{p.id}\t{p.sku}\t{p.manufacturer}\t{p.manufacturer_article}\t{price}\t{p.name}')
