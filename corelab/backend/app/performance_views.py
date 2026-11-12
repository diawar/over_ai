from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_db
from .models import Product, Category, CatalogSource, ProductAttribute, Attribute, product_categories
from .performance_models import files, group_models


def performance_router(admin_dependency):
    router = APIRouter(prefix='/api/v1/admin/performance-models', dependencies=[Depends(admin_dependency)])

    @router.get('')
    def models(response: Response, scenario: Literal['gaming', 'creative', 'photoshop', 'blender_cpu', 'blender_gpu', 'twinmotion'] = 'gaming',
               status: Literal['all', 'pending'] = 'pending', q: str = Query('', max_length=150),
               page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), db: Session = Depends(get_db)):
        response.headers['Cache-Control'] = 'private, no-store'
        org_id = db.info['organization_id']
        rows = db.execute(select(Product, Category.name).join(
            product_categories, product_categories.c.product_id == Product.id).join(
            Category, Category.id == product_categories.c.category_id).join(
            CatalogSource, CatalogSource.id == Product.source_id).where(
            Product.organization_id == org_id, Category.organization_id == org_id,
            CatalogSource.organization_id == org_id, CatalogSource.code == 'corelab',
            Category.name.in_(['Процессоры', 'Видеокарты']))).all()
        products = {p.id: dict(id=p.id, name=p.name, sku=p.sku, manufacturer=p.manufacturer,
            type='cpu' if category == 'Процессоры' else 'gpu', selection_enabled=p.selection_enabled,
            validity_check=p.validity_check, attributes={}) for p, category in rows}
        if products:
            for value, attr in db.execute(select(ProductAttribute, Attribute).join(
                Attribute, Attribute.id == ProductAttribute.attribute_id).where(
                ProductAttribute.organization_id == org_id, Attribute.organization_id == org_id,
                ProductAttribute.product_id.in_(products), ProductAttribute.value_state == 'known',
                Attribute.code.in_(['gpu_graphics_processor', 'gpu_memory_gb', 'cores', 'socket']))):
                products[value.product_id]['attributes'][attr.code] = (
                    float(value.value_number) if value.value_number is not None else value.value_string)
        try:
            registry, data = files()
            groups = group_models(products.values(), scenario, registry, data)
        except (OSError, ValueError, KeyError):
            raise HTTPException(503, 'Реестр оценок временно недоступен')
        summary = dict(models=len(groups), pending=sum(row['status'] != 'measured' for row in groups), products=len(products))
        groups = [row for row in groups if (status == 'all' or row['status'] != 'measured') and
                  (not q or q.casefold() in str(row).casefold())]
        return dict(items=groups[(page-1)*page_size:page*page_size], total=len(groups), summary=summary,
                    scenario=scenario, registry_version=registry['version'])
    return router
