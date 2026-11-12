"""Read-only local builder fixture export; no HTTP or provider API calls."""
import json
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.db import SessionLocal
from app.mini_views import eligible
from app.models import (Attribute, CatalogSource, Category, CategoryAttribute, Organization,
                        Product, ProductAttribute, ProductSourceLink, SupplierOffer)
from app.organization_operations import Operations

with SessionLocal() as db:
    org_id = 1
    db.info['organization_id'] = org_id
    products, ids = {}, {}
    for p, offer in db.execute(select(Product, SupplierOffer).join(
        ProductSourceLink, ProductSourceLink.product_id == Product.id).join(
        SupplierOffer, SupplierOffer.id == ProductSourceLink.offer_id).join(
        CatalogSource, CatalogSource.id == SupplierOffer.source_id).where(
        *eligible(org_id), Product.sku.startswith('p1:'), CatalogSource.code == 'p1',
        SupplierOffer.organization_id == org_id, SupplierOffer.is_current.is_(True),
        SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0,
        SupplierOffer.currency == 'KZT', CatalogSource.organization_id == org_id
    ).options(selectinload(Product.categories))):
        sku = p.sku.removeprefix('p1:')
        category = next(c.name for c in p.categories if c.organization_id == org_id and c.selection_category)
        item = products.setdefault(sku, dict(skuOver=sku, name=p.name, article=p.manufacturer_article,
            manufacturer=p.manufacturer, category=category, attributes={}, offers=[]))
        ids[p.id] = sku
        item['offers'].append(dict(price=str(offer.price), dealersData=offer.raw_data.get('dealersData')))
    for row, attr in db.execute(select(ProductAttribute, Attribute).join(Attribute).where(
        ProductAttribute.product_id.in_(ids), ProductAttribute.organization_id == org_id,
        Attribute.organization_id == org_id, ProductAttribute.value_state == 'known')):
        value = row.value_string
        if row.value_number is not None:
            value = int(row.value_number) if attr.value_type == 'integer' else float(row.value_number)
        elif row.value_boolean is not None:
            value = row.value_boolean
        elif row.value_json is not None:
            value = row.value_json
        if value is not None:
            products[ids[row.product_id]]['attributes'][attr.code] = value
    categories = list(db.scalars(select(Category).where(Category.organization_id == org_id,
        Category.selection_category.is_(True))))
    required = {c.id: [] for c in categories}
    for cid, code in db.execute(select(CategoryAttribute.category_id, Attribute.code).join(Attribute).where(
        CategoryAttribute.category_id.in_(required), CategoryAttribute.required_for_selection.is_(True))):
        required[cid].append(code)
    rules = [dict(category=c.name, required=c.required_for_build, attributes=sorted(required[c.id])) for c in categories]
    org = db.get(Organization, org_id)
    print(json.dumps(dict(items=list(products.values()), rules=rules,
        operations=Operations.model_validate(org.operations or {}).model_dump(mode='json')), ensure_ascii=False))
