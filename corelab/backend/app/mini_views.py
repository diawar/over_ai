"""Versioned, tenant-scoped catalog contract for the shared Mini App."""
from datetime import datetime
import hashlib
import hmac
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, JsonValue, StrictBool
from sqlalchemy import String, cast, exists, func, or_, select, text
from sqlalchemy.orm import Session, selectinload

from .db import get_db
from .config import get_settings
from .mini_auth import (Consumer, available_organization, bot_config, consumer_session,
                        issue_consumer, launch_target, organization_session, validate_init_data)
from .models import (Attribute, AuditLog, CatalogSource, Category, CategoryAttribute, Organization, Product, PropertyRule,
                     ProductAttribute, ProductSourceLink, SupplierOffer, product_categories)
from .property_service import GLOBAL_FIELD_CODES


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Launch(Input):
    bot: str = Field(default="corelab", pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    init_data: str = Field(min_length=1, max_length=16384)
    remembered_organization_id: int | None = Field(default=None, gt=0)


class ChooseShop(Input):
    organization_id: int = Field(gt=0)


class AccessSettings(Input):
    enabled: StrictBool


class Shop(BaseModel):
    id: int
    name: str
    short_name: str | None
    primary_color: str
    logo_url: str | None


class Shops(BaseModel):
    items: list[Shop]
    total: int
    page: int
    page_size: int


class SessionResult(BaseModel):
    access_token: str
    token_type: Literal["bearer"]
    expires_in: int
    organization: Shop | None
    campaign: str | None
    launch_error: Literal["shop_unavailable", "invalid_shop_link"] | None = None


class Context(BaseModel):
    organization: Shop
    campaign: str | None
    preview: bool


class CategoryView(BaseModel):
    id: int
    name: str
    parent_id: int | None


class Categories(BaseModel):
    items: list[CategoryView]
    total: int
    page: int
    page_size: int


class PropertyView(BaseModel):
    code: str
    label: str
    value_type: str
    value: JsonValue
    unit: str | None
    value_state: Literal["known", "unknown", "not_applicable"]


class OfferView(BaseModel):
    id: int
    source_id: int
    price: str | None
    currency: str
    warehouses: list[str]
    snapshot_at: datetime


class ProductView(BaseModel):
    id: int
    organization_id: int
    sku: str
    name: str
    article: str | None
    manufacturer: str | None
    image_url: str | None
    status: Literal["Доступен для Конфигуратора"] = "Доступен для Конфигуратора"
    category: CategoryView
    attributes: list[PropertyView]
    price: str | None
    currency: str
    offers: list[OfferView]


class Products(BaseModel):
    items: list[ProductView]
    total: int
    page: int
    page_size: int
    schema_version: Literal["1"] = "1"


def shop_view(row):
    return Shop(id=row.id, name=row.name, short_name=row.short_name, primary_color=row.primary_color,
                logo_url=f"/api/v1/organizations/{row.id}/branding/logo" if row.logo_content_type else None)


def session_result(db, consumer, launch_error=None):
    org = available_organization(db, consumer.organization_id, consumer.preview) if consumer.organization_id else None
    return SessionResult(**issue_consumer(consumer), organization=shop_view(org) if org else None,
                         campaign=consumer.campaign, launch_error=launch_error)


def eligible(organization_id):
    category = exists(select(Category.id).join(product_categories, product_categories.c.category_id == Category.id).where(
        product_categories.c.product_id == Product.id, Category.organization_id == organization_id,
        Category.selection_category.is_(True)))
    characteristics = exists(select(ProductAttribute.id).join(Attribute, Attribute.id == ProductAttribute.attribute_id).where(
        ProductAttribute.product_id == Product.id, ProductAttribute.organization_id == organization_id,
        Attribute.organization_id == organization_id, Attribute.code.notin_(GLOBAL_FIELD_CODES),
        ProductAttribute.value_state == "known", or_(
            ProductAttribute.value_string.is_not(None) & (func.length(func.trim(ProductAttribute.value_string)) > 0),
            ProductAttribute.value_number.is_not(None), ProductAttribute.value_boolean.is_not(None),
            ProductAttribute.value_json.is_not(None) &
            cast(ProductAttribute.value_json, String).notin_(["null", "[]", "{}", '\"\"']))))
    return [Product.organization_id == organization_id, Product.validity_check.is_(True),
            Product.selection_enabled.is_(True), Product.source_id.in_(select(CatalogSource.id).where(
                CatalogSource.organization_id == organization_id, CatalogSource.code == "corelab")), category, characteristics]


def product_views(db, products, org_id):
    ids = [p.id for p in products]
    if not ids:
        return []
    properties = {pid: [] for pid in ids}
    for row, attr in db.execute(select(ProductAttribute, Attribute).join(Attribute).where(
            ProductAttribute.product_id.in_(ids), ProductAttribute.organization_id == org_id,
            Attribute.organization_id == org_id).order_by(Attribute.code)):
        value = row.value_string
        if row.value_number is not None:
            value = int(row.value_number) if attr.value_type == "integer" else float(row.value_number)
        elif row.value_boolean is not None:
            value = row.value_boolean
        elif row.value_json is not None:
            value = row.value_json
        properties[row.product_id].append(PropertyView(code=attr.code, label=attr.label, value_type=attr.value_type,
            unit=attr.unit, value=value if row.value_state == "known" else None, value_state=row.value_state))
    offers = {pid: [] for pid in ids}
    prices = {pid: [] for pid in ids}
    currencies = {p.id: p.currency for p in products}
    for pid, offer in db.execute(select(ProductSourceLink.product_id, SupplierOffer).join(
            SupplierOffer, SupplierOffer.id == ProductSourceLink.offer_id).join(CatalogSource, CatalogSource.id == SupplierOffer.source_id).where(
            ProductSourceLink.product_id.in_(ids), ProductSourceLink.organization_id == org_id,
            SupplierOffer.organization_id == org_id, CatalogSource.organization_id == org_id,
            SupplierOffer.is_current.is_(True)).order_by(SupplierOffer.id)):
        price = offer.price if offer.price is not None and offer.price > 0 else None
        if price is not None and offer.currency == currencies[pid]:
            prices[pid].append(price)
        raw_warehouses = offer.raw_data.get("dealersData")
        offers[pid].append(OfferView(id=offer.id, source_id=offer.source_id, price=str(price) if price else None,
            currency=offer.currency, warehouses=[s for s in raw_warehouses if isinstance(s, str)] if isinstance(raw_warehouses, list) else [],
            snapshot_at=offer.imported_at))
    result = []
    for p in products:
        category = next(c for c in p.categories if c.organization_id == org_id and c.selection_category)
        result.append(ProductView(id=p.id, organization_id=org_id, sku=p.sku, name=p.name,
            article=p.manufacturer_article, manufacturer=p.manufacturer, image_url=p.image_url,
            category=CategoryView(id=category.id, name=category.name, parent_id=category.parent_id),
            attributes=properties[p.id], price=str(min(prices[p.id])) if prices[p.id] else None,
            currency=p.currency, offers=offers[p.id]))
    return result


def no_cache(response: Response):
    response.headers["Cache-Control"] = "private, no-store"


def mini_router():
    router = APIRouter(prefix="/api/v1", tags=["Mini App"], dependencies=[Depends(no_cache)])

    @router.get("/internal/builder/availability", include_in_schema=False)
    def builder_availability(request: Request, organization_id: int = Query(1, gt=0), db: Session = Depends(get_db)):
        signed_value = "corelab-builder-products-v1" if organization_id == 1 else f"corelab-builder-products-v1:{organization_id}"
        expected = hmac.new(get_settings().session_secret.encode(), signed_value.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(request.headers.get("X-CoreLab-Builder-Auth", ""), expected):
            raise HTTPException(403, "Forbidden")
        from .mini_auth import available_organization
        db.info["organization_id"] = organization_id
        available_organization(db, organization_id)
        return {"available": True}

    @router.get("/internal/builder/products", include_in_schema=False)
    def builder_products(request: Request, organization_id: int = Query(1, gt=0), db: Session = Depends(get_db)):
        secret = get_settings().session_secret.encode()
        signed_value = "corelab-builder-products-v1" if organization_id == 1 else f"corelab-builder-products-v1:{organization_id}"
        expected = hmac.new(secret, signed_value.encode(), hashlib.sha256).hexdigest()
        supplied = request.headers.get("X-CoreLab-Builder-Auth", "")
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(403, "Forbidden")
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        db.execute(text("SET TRANSACTION READ ONLY"))
        db.info["organization_id"] = organization_id
        organization = db.get(Organization, organization_id)
        if organization is None or not organization.is_active or organization.onboarding_required or not organization.mini_app_enabled:
            raise HTTPException(404, "Organization not found")
        selected_categories = list(db.scalars(select(Category).where(
            Category.organization_id == organization_id, Category.selection_category.is_(True)).order_by(Category.id)))
        selected_ids = [row.id for row in selected_categories]
        required_rows = db.execute(select(CategoryAttribute.category_id, Attribute.code).join(
            Attribute, Attribute.id == CategoryAttribute.attribute_id).where(
            CategoryAttribute.category_id.in_(selected_ids),
            CategoryAttribute.required_for_selection.is_(True), Attribute.organization_id == organization_id)).all()
        required_by_category = {row.id: [] for row in selected_categories}
        for category_id, code in required_rows:
            required_by_category[category_id].append(code)
        rules = [{"category": row.name, "required": row.required_for_build,
                  "attributes": sorted(required_by_category[row.id])} for row in selected_categories]
        rule_revisions = [list(row) for row in db.execute(select(
            PropertyRule.category_id, PropertyRule.code, PropertyRule.revision).where(
            PropertyRule.category_id.in_(selected_ids), PropertyRule.active.is_(True)).order_by(
            PropertyRule.category_id, PropertyRule.code)).all()]
        version_payload = {"categories": rules, "property_rule_revisions": rule_revisions,
                           "builder_rule_engine": "2026-10-20-2",
                           "organization_operations": organization.operations}
        rules_version = hashlib.sha256(json.dumps(version_payload, ensure_ascii=False,
                                                  sort_keys=True).encode()).hexdigest()
        rows = db.execute(select(Product, SupplierOffer).join(
            ProductSourceLink, ProductSourceLink.product_id == Product.id).join(
            SupplierOffer, SupplierOffer.id == ProductSourceLink.offer_id).join(
            CatalogSource, CatalogSource.id == SupplierOffer.source_id).where(
            *eligible(organization_id),
            *([Product.sku.startswith("p1:"), CatalogSource.code == "p1"] if organization_id == 1 else []),
            SupplierOffer.organization_id == organization_id,
            SupplierOffer.is_current.is_(True), SupplierOffer.is_archived.is_not(True),
            SupplierOffer.price > 0, SupplierOffer.currency == "KZT",
            CatalogSource.organization_id == organization_id).options(
            selectinload(Product.categories))).all()
        products = {}
        product_ids = {}
        for product, offer in rows:
            sku = product.sku.removeprefix("p1:") if organization_id == 1 else product.sku
            if organization_id == 1 and not sku.isdigit():
                continue
            category = next((c.name for c in product.categories if c.organization_id == organization_id and c.selection_category), None)
            if not category:
                continue
            item = products.setdefault(sku, {"skuOver": sku, "name": product.name,
                "productUrl": (organization.product_links or {}).get('items', {}).get(sku),
                "article": product.manufacturer_article, "manufacturer": product.manufacturer,
                "category": category, "attributes": {}, "offers": []})
            product_ids[product.id] = sku
            item["offers"].append({"price": str(offer.price),
                "dealersData": offer.raw_data.get("dealersData")})
        if product_ids:
            values = db.execute(select(ProductAttribute, Attribute).join(
                Attribute, Attribute.id == ProductAttribute.attribute_id).where(
                ProductAttribute.product_id.in_(product_ids), ProductAttribute.organization_id == organization_id,
                Attribute.organization_id == organization_id, ProductAttribute.value_state == "known"))
            for row, attr in values:
                value = row.value_string
                if row.value_number is not None:
                    value = int(row.value_number) if attr.value_type == "integer" else float(row.value_number)
                elif row.value_boolean is not None:
                    value = row.value_boolean
                elif row.value_json is not None:
                    value = row.value_json
                if value is not None:
                    products[product_ids[row.product_id]]["attributes"][attr.code] = value
        from .organization_operations import Operations
        return {"items": list(products.values()), "rules": rules, "rulesVersion": rules_version,
                "operations": Operations.model_validate(organization.operations or {}).model_dump(mode="json"),
                "organization": shop_view(organization).model_dump()}

    @router.post("/mini-app/session", response_model=SessionResult)
    def launch(body: Launch, db: Session = Depends(get_db)):
        config = bot_config(body.bot)
        data = validate_init_data(body.init_data, config.token.get_secret_value())
        launch_error = None
        try:
            target, campaign = launch_target(data.get("start_param"))
        except HTTPException:
            target, campaign = None, None
            launch_error = "invalid_shop_link"
        if config.organization_id and target and target != config.organization_id:
            raise HTTPException(403, "This bot belongs to another shop")
        org_id = (target or config.organization_id or body.remembered_organization_id) if launch_error is None else None
        if config.organization_id and launch_error:
            raise HTTPException(404, "Invalid shop link")
        # Explicit unavailable links never silently resolve to a different shop.
        if org_id:
            try:
                available_organization(db, org_id)
            except HTTPException:
                if config.organization_id:
                    raise
                if target:
                    launch_error = "shop_unavailable"
                org_id = None
                campaign = None
        consumer = Consumer(bot=body.bot, organization_id=org_id,
            bound_organization_id=config.organization_id, campaign=campaign)
        if org_id:
            db.add(AuditLog(organization_id=org_id, action="mini_app.launch", object_type="organization",
                object_id=str(org_id), details={"bot": body.bot, "campaign": campaign}))
            db.commit()
        return session_result(db, consumer, launch_error)

    @router.get("/mini-app/organizations", response_model=Shops)
    def shops(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
              consumer: Consumer = Depends(consumer_session), db: Session = Depends(get_db)):
        conditions = [Organization.is_active.is_(True), Organization.onboarding_required.is_(False)]
        if not consumer.preview: conditions.append(Organization.mini_app_enabled.is_(True))
        if consumer.bound_organization_id:
            conditions.append(Organization.id == consumer.bound_organization_id)
        total = db.scalar(select(func.count()).select_from(Organization).where(*conditions))
        rows = db.scalars(select(Organization).where(*conditions).order_by(Organization.id).offset((page-1)*page_size).limit(page_size))
        return Shops(items=[shop_view(row) for row in rows], total=total, page=page, page_size=page_size)

    @router.post("/mini-app/organization", response_model=SessionResult)
    def choose(body: ChooseShop, consumer: Consumer = Depends(consumer_session), db: Session = Depends(get_db)):
        if consumer.bound_organization_id and body.organization_id != consumer.bound_organization_id:
            raise HTTPException(403, "This session is bound to another shop")
        available_organization(db, body.organization_id, consumer.preview)
        return session_result(db, consumer.model_copy(update={"organization_id": body.organization_id, "campaign": None}))

    @router.get("/mini-app/context", response_model=Context)
    def context(consumer: Consumer = Depends(organization_session), db: Session = Depends(get_db)):
        return Context(organization=shop_view(available_organization(db, consumer.organization_id, consumer.preview)),
                       campaign=consumer.campaign, preview=consumer.preview)

    @router.get("/categories", response_model=Categories)
    def categories(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
                   consumer: Consumer = Depends(organization_session), db: Session = Depends(get_db)):
        allowed = select(product_categories.c.category_id).join(Product, Product.id == product_categories.c.product_id).where(*eligible(consumer.organization_id))
        conditions = [Category.organization_id == consumer.organization_id, Category.id.in_(allowed), Category.selection_category.is_(True)]
        total = db.scalar(select(func.count()).select_from(Category).where(*conditions))
        rows = db.scalars(select(Category).where(*conditions).order_by(Category.id).offset((page-1)*page_size).limit(page_size))
        return Categories(items=[CategoryView(id=c.id, name=c.name, parent_id=c.parent_id) for c in rows], total=total, page=page, page_size=page_size)

    @router.get("/selection/products", response_model=Products)
    @router.get("/products", response_model=Products)
    def products(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
                 category_id: int | None = Query(None, gt=0), q: str = Query("", max_length=200),
                 consumer: Consumer = Depends(organization_session), db: Session = Depends(get_db)):
        conditions = eligible(consumer.organization_id)
        if category_id:
            conditions.append(Product.categories.any(id=category_id))
        if q.strip():
            conditions.append(or_(*(column.icontains(q.strip(), autoescape=True) for column in (
                Product.name, Product.sku, Product.manufacturer_article, Product.manufacturer))))
        total = db.scalar(select(func.count()).select_from(Product).where(*conditions))
        rows = list(db.scalars(select(Product).options(selectinload(Product.categories)).where(*conditions)
            .order_by(Product.id).offset((page-1)*page_size).limit(page_size)))
        return Products(items=product_views(db, rows, consumer.organization_id), total=total, page=page, page_size=page_size)

    @router.get("/products/{product_id}", response_model=ProductView)
    def product(product_id: int, consumer: Consumer = Depends(organization_session), db: Session = Depends(get_db)):
        row = db.scalar(select(Product).options(selectinload(Product.categories)).where(
            Product.id == product_id, *eligible(consumer.organization_id)))
        if row is None:
            raise HTTPException(404, "Product not found")
        return product_views(db, [row], consumer.organization_id)[0]

    return router


def mini_admin_router(admin, chief, csrf):
    router = APIRouter(prefix="/api/v1/admin/mini-app", tags=["Mini App administration"], dependencies=[Depends(no_cache)])

    @router.get("/settings")
    def settings(user=Depends(admin), db: Session = Depends(get_db)):
        org = db.get(Organization, user.organization_id)
        return {"enabled": org.mini_app_enabled, "start_param": f"shop_{org.id}"}

    @router.put("/settings", dependencies=[Depends(csrf)])
    def save(body: AccessSettings, user=Depends(chief), db: Session = Depends(get_db)):
        org = db.get(Organization, user.organization_id)
        org.mini_app_enabled = body.enabled
        db.add(AuditLog(organization_id=org.id, user_id=user.id, action="mini_app.availability_changed",
            object_type="organization", object_id=str(org.id), details={"enabled": body.enabled}))
        db.commit()
        return {"enabled": org.mini_app_enabled, "start_param": f"shop_{org.id}"}

    @router.post("/preview", response_model=SessionResult, dependencies=[Depends(csrf)])
    def preview(user=Depends(admin), db: Session = Depends(get_db)):
        return session_result(db, Consumer(bot="admin-preview", preview=True,
            organization_id=user.organization_id, bound_organization_id=user.organization_id))

    return router
