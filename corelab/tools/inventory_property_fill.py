from sqlalchemy import select

from app.db import SessionLocal
from app.models import (AIProviderSetting, CatalogSource, Category, Job, JobItem, Product,
                        PropertyRule, ProductAttribute, product_categories)
from app.property_service import has_technical_values, structure_report


with SessionLocal() as db:
    provider = db.get(AIProviderSetting, (1, "openai"))
    print(f"provider_configured={provider is not None}; model={provider.model_id if provider else 'none'}")
    source_id = db.scalar(select(CatalogSource.id).where(CatalogSource.code == "corelab"))
    categories = list(db.scalars(select(Category).where(Category.source_id == source_id).order_by(Category.id)))
    for category in categories:
        rules = list(db.scalars(select(PropertyRule).where(PropertyRule.category_id == category.id,
            PropertyRule.source == "internal", PropertyRule.active.is_(True))))
        if not rules:
            continue
        report = structure_report(db, category.id)
        products = list(db.scalars(select(Product).join(product_categories).where(
            product_categories.c.category_id == category.id, Product.is_archived.is_not(True),
            Product.manufacturer.is_not(None), Product.manufacturer != "",
            Product.manufacturer_article.is_not(None), Product.manufacturer_article != "").order_by(Product.id)))
        pending = []
        for product in products:
            if len(product.categories) != 1 or has_technical_values(db, product.id):
                continue
            attempted = db.scalar(select(JobItem.id).join(Job).where(Job.job_type == "property_load",
                JobItem.product_id == product.id).limit(1))
            if not attempted:
                pending.append(product)
        print(f"category_id={category.id}; name={category.name}; rules={len(rules)}; current={report['current']}; structure={report['structure_status']}; ai_load_allowed={report['ai_load_allowed']}; candidates={len(pending)}; first15=" + ",".join(str(p.id) for p in pending[:15]))
