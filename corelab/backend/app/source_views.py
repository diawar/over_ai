"""Read-only views of client price lists, including retained offline snapshots."""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pathlib import Path
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from .db import get_db
from .models import CatalogSource, ImportLog, Product, ProductSourceLink, SupplierOffer


def source_router(admin_dependency):
    router = APIRouter(prefix="/api/v1/admin/sources", dependencies=[Depends(admin_dependency)])

    @router.get("/price-list-template.xls")
    def price_list_template():
        return FileResponse(Path(__file__).parent / "templates" / "price-list-template.xls",
                            media_type="application/vnd.ms-excel", filename="price-list-template.xls")

    @router.get("")
    def sources(db: Session = Depends(get_db)):
        result = []
        for source in db.scalars(select(CatalogSource).where(CatalogSource.code != "corelab").order_by(CatalogSource.id)):
            count = db.scalar(select(func.count()).select_from(SupplierOffer).where(SupplierOffer.source_id == source.id, SupplierOffer.is_current.is_(True)))
            latest = db.scalar(select(ImportLog).where(ImportLog.source_id == source.id, ImportLog.status == "completed").order_by(ImportLog.id.desc()).limit(1))
            result.append({"id": source.id, "name": source.name, "code": source.code, "total": count, "is_active": source.is_active,
                           "downloaded_at": latest.source_downloaded_at if latest else None})
        return {"items": result}

    @router.get("/{source_id}/products")
    def products(source_id: int, q: str = Query("", max_length=200), category: str = "",
                 archived: str = Query("all", pattern="^(all|active|archived)$"),
                 presence: str = Query("current", pattern="^(all|current|missing)$"),
                 sort: str = Query("name", pattern="^(name|price_asc|price_desc)$"),
                 page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
                 db: Session = Depends(get_db)):
        source = db.get(CatalogSource, source_id)
        if source is None or source.code == "corelab":
            raise HTTPException(404, "Source not found")
        raw = SupplierOffer.raw_data
        name, article, maker = (raw[key].astext for key in ("name", "article", "manufacturer"))
        cat = raw["category"].astext
        conditions = [SupplierOffer.source_id == source_id]
        if presence == "current":
            conditions.append(SupplierOffer.is_current.is_(True))
        elif presence == "missing":
            conditions.append(SupplierOffer.is_current.is_(False))
        if q.strip():
            conditions.append(or_(*(column.icontains(q.strip(), autoescape=True) for column in
                                    (name, article, maker, SupplierOffer.sku))))
        if category:
            conditions.append(cat == category)
        if archived != "all":
            conditions.append(SupplierOffer.is_archived.is_(True) if archived == "archived" else SupplierOffer.is_archived.is_not(True))
        total = db.scalar(select(func.count()).select_from(SupplierOffer).where(*conditions))
        effective_price = func.nullif(SupplierOffer.price, 0)
        order = {"name": name.asc(), "price_asc": effective_price.asc().nulls_last(),
                 "price_desc": effective_price.desc().nulls_last()}[sort]
        rows = db.execute(select(SupplierOffer, ProductSourceLink.product_id, Product.name)
                          .outerjoin(ProductSourceLink, ProductSourceLink.offer_id == SupplierOffer.id)
                          .outerjoin(Product, Product.id == ProductSourceLink.product_id)
                          .where(*conditions).order_by(order, SupplierOffer.id)
                          .offset((page - 1) * page_size).limit(page_size)).all()
        categories = list(db.scalars(select(cat).where(SupplierOffer.source_id == source_id,
                            cat.is_not(None), cat != "").distinct().order_by(cat)))
        return {"total": total, "categories": categories, "items": [
            {"id": offer.id, "sku": offer.sku, "name": offer.raw_data.get("name"),
             "article": offer.raw_data.get("article"), "manufacturer": offer.raw_data.get("manufacturer"),
             "category": offer.raw_data.get("category"), "price": offer.raw_data.get("priceLoan"),
             "price_bonus": offer.raw_data.get("priceBonus"), "price_special": offer.raw_data.get("priceSpecial"),
             "archived": offer.is_archived, "warehouses": offer.raw_data.get("dealersData") or [],
             "is_current": offer.is_current,
             "link_status": "linked" if product_id else "unlinked",
             "core_product_id": product_id, "core_product_name": product_name}
            for offer, product_id, product_name in rows]}

    return router
