"""Administrative catalog views and category selection settings."""
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import hmac
import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from typing import Any, Literal
from urllib.parse import urlsplit

from .ai_research import _approved_retailer
from .db import get_db
from .config import get_settings
from .models import (Attribute, AuditLog, CatalogSource, Category, Product,
                     CategoryAttribute, ProductAttribute, ProductSourceLink,
                     PropertyRule, SupplierOffer, ValidationReason, product_categories)
from .property_engine import RuleDefinition, condition_value, normalize
from .property_service import defaults
from .validity import lock_validation, revalidate_category, revalidate_product


class CategorySelection(BaseModel):
    selection_category: StrictBool | None = None
    required_for_build: StrictBool | None = None

    @model_validator(mode="after")
    def at_least_one_setting(self):
        if self.selection_category is None and self.required_for_build is None:
            raise ValueError("Укажите настройку категории")
        return self


class ProductSelection(BaseModel):
    selection_enabled: StrictBool


class ProductAttributeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value_state: Literal["known", "unknown", "not_applicable"]
    value: Any = None
    source_kind: Literal["manual", "manufacturer_site", "manufacturer_document", "ai_official", "retailer_site", "ai_retailer"] = "manual"
    source_url: str | None = Field(default=None, max_length=2000)

    @field_validator("source_url")
    @classmethod
    def valid_source_url(cls, value):
        if value is not None:
            parsed = urlsplit(value)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username:
                raise ValueError("Источник должен быть абсолютной ссылкой HTTP(S)")
        return value

    @model_validator(mode="after")
    def state_value(self):
        if self.value_state == "known" and self.value is None:
            raise ValueError("Для известного значения укажите характеристику")
        if self.value_state != "known" and self.value is not None:
            raise ValueError("Для неизвестного или неприменимого значения поле value должно быть пустым")
        if self.source_kind != "manual" and not self.source_url:
            raise ValueError("Для указанного источника добавьте ссылку")
        if self.source_kind in ("retailer_site", "ai_retailer") and not _approved_retailer(self.source_url):
            raise ValueError("Для магазина разрешены только shop.kz, dns-shop.kz, technodom.kz и pricerunner.com по HTTPS")
        return self


class DeleteProductAttributeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_value_state: Literal["known", "unknown", "not_applicable"]
    expected_value: Any = None
    expected_source_kind: str | None = None
    expected_source_url: str | None = None


class BulkProductAttributeInput(ProductAttributeInput):
    product_ids: list[int] = Field(min_length=1, max_length=100)
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{0,159}$")

    @field_validator("product_ids")
    @classmethod
    def unique_product_ids(cls, value):
        if any(product_id <= 0 for product_id in value) or len(set(value)) != len(value):
            raise ValueError("Выберите товары без повторов")
        return value


class BulkProductAttributeApply(BulkProductAttributeInput):
    preview_token: str = Field(min_length=20, max_length=160)


def _stored_attribute_value(row, attribute):
    if row is None:
        return None
    if row.value_string is not None:
        return row.value_string
    if row.value_number is not None:
        return int(row.value_number) if attribute.value_type == "integer" else float(row.value_number)
    if row.value_boolean is not None:
        return row.value_boolean
    return row.value_json


def _canonical_hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _bulk_attribute_plan(db, body, *, lock_products=False):
    source_id = _source_id(db)
    if source_id is None:
        raise HTTPException(409, "Каталог CoreLab ещё не загружен")
    query = select(Product).where(Product.id.in_(body.product_ids), Product.source_id == source_id).order_by(Product.id)
    if lock_products:
        query = query.with_for_update()
    products = list(db.scalars(query))
    if len(products) != len(body.product_ids):
        raise HTTPException(404, "Один или несколько выбранных товаров не найдены в каталоге")
    attribute = db.scalar(select(Attribute).where(Attribute.code == body.code))
    if attribute is None:
        raise HTTPException(422, "Свойство не найдено")
    category_ids = sorted({category.id for product in products for category in product.categories})
    links = set(db.scalars(select(CategoryAttribute.category_id).where(
        CategoryAttribute.category_id.in_(category_ids), CategoryAttribute.attribute_id == attribute.id
    ))) if category_ids else set()
    if any(not product.categories or any(category.id not in links for category in product.categories)
           for product in products):
        raise HTTPException(422, "Свойство должно входить в структуру категории каждого выбранного товара")

    rules = {rule.category_id: RuleDefinition.model_validate(rule.definition) for rule in db.scalars(select(PropertyRule).where(
        PropertyRule.active.is_(True), PropertyRule.source == "internal", PropertyRule.code == body.code,
        PropertyRule.category_id.in_(category_ids)
    ).order_by(PropertyRule.category_id, PropertyRule.id))}
    definitions = [rules.get(category_id) or RuleDefinition(
        code=attribute.code, label=attribute.label, source="internal", level="optional",
        value_type=attribute.value_type, unit=attribute.unit,
        normalization=attribute.normalization or {}) for category_id in category_ids]
    if not definitions or any((rule.value_type, rule.unit) != (definitions[0].value_type, definitions[0].unit)
                              for rule in definitions[1:]):
        raise HTTPException(422, "Свойство имеет противоречивые типы в категориях выбранных товаров")
    normalized_values = []
    if body.value_state == "known":
        try:
            normalized_values = [normalize(body.value, rule) for rule in definitions]
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from exc
        if any(value != normalized_values[0] or type(value) is not type(normalized_values[0])
               for value in normalized_values[1:]):
            raise HTTPException(422, "Значение нормализуется по-разному в категориях выбранных товаров")
    normalized = normalized_values[0] if normalized_values else None

    existing_rows = list(db.execute(select(ProductAttribute, ProductAttribute.product_id).where(
        ProductAttribute.product_id.in_(body.product_ids), ProductAttribute.attribute_id == attribute.id
    )))
    existing = {row.product_id: row for row, _ in existing_rows}
    previews, snapshot = [], []
    for product in products:
        row = existing.get(product.id)
        previous = {"value_state": row.value_state, "value": _stored_attribute_value(row, attribute),
                    "source_kind": row.source_kind, "source_url": row.source_url,
                    "updated_at": row.updated_at.isoformat() if row.updated_at else None} if row else None
        previews.append({"product_id": product.id, "name": product.name, "sku": product.sku,
                         "category": product.categories[0].name if product.categories else None,
                         "will_overwrite": row is not None, "previous": previous})
        snapshot.append({"product_id": product.id,
                         "categories": sorted(category.id for category in product.categories),
                         "status": product.status, "previous": previous})
    rule_fingerprint = [rule.model_dump(mode="json") for rule in definitions]
    fingerprint = _canonical_hash({"snapshot": snapshot, "rules": rule_fingerprint})
    return {"products": products, "attribute": attribute, "definition": definitions[0],
            "normalized": normalized, "previews": previews, "overwrite_count": len(existing),
            "insert_count": len(products) - len(existing), "fingerprint": fingerprint}


def _bulk_preview_token(user_id, body, plan, expires):
    payload = body.model_dump(exclude={"preview_token"}, mode="json") if isinstance(body, BulkProductAttributeApply) else body.model_dump(mode="json")
    payload["product_ids"] = sorted(payload["product_ids"])
    message = f"{user_id}:{expires}:{_canonical_hash(payload)}:{plan['fingerprint']}"
    signature = hmac.new(get_settings().session_secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{expires}.{signature}"


def _bulk_available_attributes(db, product_ids):
    source_id = _source_id(db)
    products = list(db.scalars(select(Product).where(Product.id.in_(product_ids), Product.source_id == source_id)))
    if len(products) != len(product_ids):
        raise HTTPException(404, "Один или несколько выбранных товаров не найдены в каталоге")
    options_by_product = []
    for product in products:
        options_by_product.append({option["code"]: option for option in _available_attributes(db, product)})
    common_codes = set.intersection(*(set(options) for options in options_by_product)) if options_by_product else set()
    return [options_by_product[0][code] for code in sorted(common_codes)]


def _source_id(db):
    return db.scalar(select(CatalogSource.id).where(CatalogSource.code == "corelab"))


def _attributes(db, product_ids):
    result = defaultdict(list)
    if not product_ids:
        return result
    rows = db.execute(select(ProductAttribute, Attribute)
                      .join(Attribute, Attribute.id == ProductAttribute.attribute_id)
                      .where(ProductAttribute.product_id.in_(product_ids))
                      .order_by(Attribute.label, ProductAttribute.id))
    for value, attribute in rows:
        actual = (value.value_string if value.value_string is not None else
                  (int(value.value_number) if attribute.value_type == "integer" else float(value.value_number)) if value.value_number is not None else
                  value.value_boolean if value.value_boolean is not None else value.value_json)
        result[value.product_id].append({"code": attribute.code, "label": attribute.label,
                                         "value": actual, "unit": attribute.unit,
                                         "value_state": value.value_state,
                                         "source_url": value.source_url,
                                         "source_kind": value.source_kind})
    return result


def _required_value_completeness(db, category_ids_by_product, attributes, products_by_id):
    """Return completion ratios, parsing each rule only once per request."""
    category_ids = {category_id for ids in category_ids_by_product.values() for category_id in ids}
    rules_by_category = defaultdict(list)
    legacy_by_category = defaultdict(list)
    global_rules = []
    rule_query = select(PropertyRule).where(
        PropertyRule.active.is_(True),
        (PropertyRule.scope == "global") | PropertyRule.category_id.in_(category_ids)
    ) if category_ids else select(PropertyRule).where(
        PropertyRule.active.is_(True), PropertyRule.scope == "global")
    definitions = {}
    for rule in db.scalars(rule_query):
        definitions[rule.id] = RuleDefinition.model_validate(rule.definition)
        if rule.scope == "global":
            global_rules.append(rule)
        elif rule.source in ("internal", "gmc"):
            rules_by_category[rule.category_id].append(rule)
    if category_ids:
        for link, attribute in db.execute(select(CategoryAttribute, Attribute).join(
                Attribute, Attribute.id == CategoryAttribute.attribute_id
        ).where(CategoryAttribute.category_id.in_(category_ids),
                CategoryAttribute.required_for_selection.is_(True))):
            if not any(rule.source == "internal" and rule.attribute_id == attribute.id
                       for rule in rules_by_category[link.category_id]):
                legacy_by_category[link.category_id].append(attribute.code)

    default_rules = defaults()["rules"]
    default_values = {rule["code"]: rule["default_value"] for rule in default_rules
                      if rule.get("default_value") is not None}
    default_codes = set(default_values)
    category_rules = {}
    result = {}
    for product_id, product_category_ids in category_ids_by_product.items():
        product_attributes = attributes.get(product_id, [])
        product = products_by_id[product_id]
        values = {"id": product.sku, "title": product.name, "brand": product.manufacturer,
                  "mpn": product.manufacturer_article, "image_link": product.image_url, **default_values}
        for item in product_attributes:
            if item["code"] not in values or item["code"] in default_codes:
                values[item["code"]] = {"state": item["value_state"], "value": item["value"]}
        known_codes = set()
        for code, value in values.items():
            state, actual = (value.get("state"), value.get("value")) if isinstance(value, dict) and "state" in value else ("known", value)
            if state == "known" and actual is not None and actual != "" and actual != []:
                known_codes.add(code)
        required_codes, selection_codes = set(), set()
        category_key = tuple(product_category_ids)
        if category_key not in category_rules:
            category_rules[category_key] = [
                (row.scope != "global", definitions[row.id])
                for row in global_rules + [rule for category_id in product_category_ids
                                          for rule in rules_by_category[category_id]]]
        for local, definition in category_rules[category_key]:
            if definition.applies_when and condition_value(definition.applies_when, values, {}) is not True:
                continue
            is_required = definition.level == "required"
            if definition.level == "conditional" and definition.condition is not None:
                is_required = condition_value(definition.condition, values, {}) is True
            if is_required:
                required_codes.add(definition.code)
            if (local and definition.source == "internal"
                    and definition.required_for_selection):
                selection_codes.add(definition.code)
        for category_id in product_category_ids:
            selection_codes.update(legacy_by_category[category_id])

        def ratio(codes):
            total = len(codes)
            filled = len(codes & known_codes)
            return {"filled": filled, "total": total,
                    "percent": round(filled * 100 / total, 1) if total else None}

        result[product_id] = {"required": ratio(required_codes), "selection": ratio(selection_codes)}
    return result


def _completeness_attributes(db, product_ids):
    """Only load value/state columns needed for ratios, without ORM value objects."""
    result = defaultdict(list)
    if not product_ids:
        return result
    for row in db.execute(select(
            ProductAttribute.product_id, Attribute.code, Attribute.value_type,
            ProductAttribute.value_state, ProductAttribute.value_string,
            ProductAttribute.value_number, ProductAttribute.value_boolean,
            ProductAttribute.value_json,
    ).join(Attribute, Attribute.id == ProductAttribute.attribute_id)
            .where(ProductAttribute.product_id.in_(product_ids))
            .order_by(Attribute.label, ProductAttribute.id)):
        actual = (row.value_string if row.value_string is not None else
                  (int(row.value_number) if row.value_type == "integer" else float(row.value_number))
                  if row.value_number is not None else
                  row.value_boolean if row.value_boolean is not None else row.value_json)
        result[row.product_id].append({"code": row.code, "value_state": row.value_state, "value": actual})
    return result


def _available_attributes(db, product):
    category_ids = [category.id for category in product.categories]
    if not category_ids:
        return []
    rows = db.execute(select(Attribute, CategoryAttribute).join(
        CategoryAttribute, CategoryAttribute.attribute_id == Attribute.id
    ).where(CategoryAttribute.category_id.in_(category_ids)).order_by(Attribute.label, Attribute.id)).all()
    rule_rows = db.scalars(select(PropertyRule).where(
        PropertyRule.active.is_(True), PropertyRule.source == "internal",
        PropertyRule.category_id.in_(category_ids)
    ).order_by(PropertyRule.category_id, PropertyRule.id))
    rules_by_code = {}
    for rule_row in rule_rows:
        rules_by_code.setdefault(rule_row.code, []).append(RuleDefinition.model_validate(rule_row.definition))
    result, seen = [], set()
    for attribute, _link in rows:
        if attribute.id in seen:
            continue
        seen.add(attribute.id)
        rules = rules_by_code.get(attribute.code, [])
        shape_conflict = any((r.value_type, r.unit) != (rules[0].value_type, rules[0].unit) for r in rules[1:])
        rule = rules[0] if rules else None
        value_lists = [r.allowed_values for r in rules if r.allowed_values]
        allowed_values = ([value for value in value_lists[0] if all(any(
            type(value) is type(candidate) and value == candidate for candidate in values
        ) for values in value_lists[1:])] if value_lists else [])
        value_conflict = bool(value_lists and not allowed_values)
        minimum = max((r.minimum for r in rules if r.minimum is not None), default=None)
        maximum = min((r.maximum for r in rules if r.maximum is not None), default=None)
        range_conflict = minimum is not None and maximum is not None and minimum > maximum
        editable = not shape_conflict and not value_conflict and not range_conflict
        edit_reason = ("Свойство имеет противоречивые типы в категориях товара" if shape_conflict else
                       "У свойства нет общих допустимых значений для категорий товара" if value_conflict else
                       "Диапазоны свойства в категориях товара не пересекаются" if range_conflict else None)
        result.append({"code": attribute.code, "label": attribute.label,
                       "value_type": rule.value_type if rule else attribute.value_type,
                       "unit": rule.unit if rule else attribute.unit,
                       "allowed_values": allowed_values if value_lists else [],
                       "minimum": minimum, "maximum": maximum,
                       "max_length": min((r.max_length for r in rules if r.max_length is not None), default=None),
                       "format": rule.format if rule else None,
                       "normalization": rule.normalization if rule else (attribute.normalization or {}),
                       "editable": editable, "edit_reason": edit_reason})
    return result


def catalog_router(admin_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/catalog", dependencies=[Depends(admin_dependency)])

    @router.get("/categories")
    def categories(db: Session = Depends(get_db)):
        core_id = _source_id(db)
        if core_id is None:
            return {"items": []}
        counts = (select(product_categories.c.category_id.label("category_id"),
                         func.count(Product.id).label("total"),
                         func.count(Product.id).filter(Product.validity_check.is_(True)).label("valid"))
                  .join(Product, Product.id == product_categories.c.product_id)
                  .where(Product.source_id == core_id)
                  .group_by(product_categories.c.category_id).subquery())
        rows = db.execute(select(Category, counts.c.total, counts.c.valid)
                          .outerjoin(counts, counts.c.category_id == Category.id)
                          .where(Category.source_id == core_id)
                          .order_by(Category.name, Category.id))
        return {"items": [{"id": cat.id, "parent_id": cat.parent_id, "name": cat.name,
                            "selection_category": cat.selection_category,
                            "required_for_build": cat.required_for_build,
                            "total": total or 0, "valid": valid or 0}
                           for cat, total, valid in rows]}

    @router.patch("/categories/{category_id}", dependencies=[Depends(csrf_dependency)])
    def set_category_selection(category_id: int, body: CategorySelection,
                               db: Session = Depends(get_db), user=Depends(admin_dependency)):
        lock_validation(db)
        category = db.get(Category, category_id)
        if category is None or category.source_id != _source_id(db):
            raise HTTPException(404, "Category not found")
        if body.selection_category is not None:
            previous = category.selection_category
            category.selection_category = body.selection_category
            previous_required = category.required_for_build
            if not body.selection_category:
                category.required_for_build = False
            db.add(AuditLog(user_id=user.id, action="category.selection_changed", object_type="category",
                            object_id=str(category.id),
                            details={"old": previous, "selection_category": body.selection_category}))
            if previous_required != category.required_for_build:
                db.add(AuditLog(user_id=user.id, action="category.build_requirement_changed", object_type="category",
                                object_id=str(category.id), details={"old": previous_required, "new": False}))
            revalidate_category(db, category_id)
        if body.required_for_build is not None:
            if body.required_for_build and not category.selection_category:
                raise HTTPException(409, "Сначала включите участие категории в конфигураторе")
            previous = category.required_for_build
            category.required_for_build = body.required_for_build
            db.add(AuditLog(user_id=user.id, action="category.build_requirement_changed", object_type="category",
                            object_id=str(category.id),
                            details={"old": previous, "new": body.required_for_build}))
        db.commit()
        return {"id": category.id, "selection_category": category.selection_category,
                "required_for_build": category.required_for_build}

    @router.get("")
    def products(q: str = Query("", max_length=200), category_id: int | None = None,
                 validity: str = Query("all", pattern="^(all|true|false|null)$"),
                 sort: str = Query("name", pattern="^(name|price_asc|price_desc|required_asc|required_desc|pc_required_asc|pc_required_desc)$"),
                 page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
                 db: Session = Depends(get_db)):
        core_source_id = _source_id(db)
        if core_source_id is None:
            return {"total": 0, "items": [],
                    "validity_counts": {"all": 0, "true": 0, "false": 0, "null": 0}}

        conditions = [Product.source_id == core_source_id]
        if q.strip():
            term = q.strip()
            conditions.append(or_(Product.name.icontains(term, autoescape=True),
                                  Product.manufacturer_article.icontains(term, autoescape=True),
                                  Product.manufacturer.icontains(term, autoescape=True),
                                  Product.sku.icontains(term, autoescape=True)))
        if category_id is not None:
            category_rows = list(db.execute(select(Category.id, Category.parent_id).where(
                Category.source_id == core_source_id)))
            if category_id not in {row.id for row in category_rows}:
                raise HTTPException(404, "Category not found")
            selected = {category_id}
            while True:
                expanded = selected | {row.id for row in category_rows if row.parent_id in selected}
                if expanded == selected:
                    break
                selected = expanded
            conditions.append(Product.id.in_(select(product_categories.c.product_id).where(
                product_categories.c.category_id.in_(selected))))
        validity_counts_row = db.execute(select(
            func.count(Product.id).label("all"),
            func.count(Product.id).filter(Product.validity_check.is_(True)).label("true"),
            func.count(Product.id).filter(Product.validity_check.is_(False)).label("false"),
            func.count(Product.id).filter(Product.validity_check.is_(None)).label("null"),
        ).where(*conditions)).one()
        validity_counts = {key: int(getattr(validity_counts_row, key) or 0)
                           for key in ("all", "true", "false", "null")}
        filtered_conditions = list(conditions)
        if validity != "all":
            filtered_conditions.append(Product.validity_check.is_(
                None if validity == "null" else validity == "true"))

        total = db.scalar(select(func.count()).select_from(Product).where(*filtered_conditions)) or 0
        linked_offers = (select(
            ProductSourceLink.product_id.label("product_id"),
            func.count(SupplierOffer.id).filter(SupplierOffer.is_current.is_(True)).label("offer_count"),
            func.min(func.nullif(SupplierOffer.price, 0))
                .filter(SupplierOffer.is_current.is_(True)).label("current_price"),
        ).join(SupplierOffer, SupplierOffer.id == ProductSourceLink.offer_id)
         .group_by(ProductSourceLink.product_id).subquery())
        completeness_sort = sort in ("required_asc", "required_desc", "pc_required_asc", "pc_required_desc")
        order = {
            "name": Product.name.asc(),
            "price_asc": linked_offers.c.current_price.asc().nulls_last(),
            "price_desc": linked_offers.c.current_price.desc().nulls_last(),
        }.get(sort, Product.id.asc())
        product_query = (select(Product, linked_offers.c.offer_count, linked_offers.c.current_price)
                         .outerjoin(linked_offers, linked_offers.c.product_id == Product.id)
                         .where(*filtered_conditions).order_by(order, Product.id))
        if completeness_sort:
            # Rank the whole filtered catalog using compact rows. Offers, full products,
            # and display attributes are fetched only after selecting the requested page.
            candidates = db.execute(select(
                Product.id, Product.sku, Product.name, Product.manufacturer,
                Product.manufacturer_article, Product.image_url,
            ).where(*filtered_conditions)).all()
            candidate_ids = [product.id for product in candidates]
            candidate_categories = {product_id: [] for product_id in candidate_ids}
            if candidate_ids:
                for product_id, category_id in db.execute(select(
                        product_categories.c.product_id, Category.id
                ).join(Category, Category.id == product_categories.c.category_id)
                        .where(product_categories.c.product_id.in_(candidate_ids)).order_by(Category.name)):
                    candidate_categories[product_id].append(category_id)
            completeness = _required_value_completeness(
                db, candidate_categories, _completeness_attributes(db, candidate_ids),
                {product.id: product for product in candidates})
            metric = "required" if sort.startswith("required_") else "selection"
            descending = sort.endswith("_desc")
            ranked = sorted(candidates, key=lambda product: (
                completeness[product.id][metric]["percent"] is None,
                (-(completeness[product.id][metric]["percent"] or 0)
                 if descending else completeness[product.id][metric]["percent"] or 0),
                product.name.casefold(), product.id,
            ))[(page - 1) * page_size:page * page_size]
            selected_ids = [product.id for product in ranked]
            page_rows = {row[0].id: row for row in db.execute(
                product_query.where(Product.id.in_(selected_ids)))} if selected_ids else {}
            rows = [page_rows[product_id] for product_id in selected_ids]
        else:
            rows = db.execute(product_query.offset((page - 1) * page_size).limit(page_size)).all()
        product_ids = [product.id for product, _, _ in rows]
        attributes = _attributes(db, product_ids)
        category_rows = (db.execute(select(product_categories.c.product_id, Category.id, Category.name)
                                    .join(Category, Category.id == product_categories.c.category_id)
                                    .where(product_categories.c.product_id.in_(product_ids))
                                    .order_by(Category.name)).all() if product_ids else [])
        product_categories_map = defaultdict(list)
        for product_id, cat_id, name in category_rows:
            product_categories_map[product_id].append({"id": cat_id, "name": name})
        category_ids_by_product = {
            product_id: [category["id"] for category in product_categories_map[product_id]]
            for product_id in product_ids
        }
        if not completeness_sort:
            completeness = _required_value_completeness(
                db, category_ids_by_product, attributes, {product.id: product for product, _, _ in rows})
        return {
            "total": total,
            "validity_counts": validity_counts,
            "items": [{
                "id": product.id,
                "sku": product.sku,
                "name": product.name,
                "article": product.manufacturer_article,
                "manufacturer": product.manufacturer,
                "categories": product_categories_map[product.id],
                "status": product.status,
                "validity_check": product.validity_check,
                "selection_enabled": product.selection_enabled,
                "current_offer_count": offer_count or 0,
                "current_price": str(current_price) if current_price is not None else None,
                "currency": product.currency,
                "attributes": attributes[product.id],
                "required_value_completeness": completeness[product.id]["required"],
                "pc_selection_completeness": completeness[product.id]["selection"],
            } for product, offer_count, current_price in rows],
        }

    @router.get("/bulk-attributes/options")
    def bulk_attribute_options(product_ids: list[int] = Query(),
                               db: Session = Depends(get_db)):
        if not product_ids or len(product_ids) > 100 or len(set(product_ids)) != len(product_ids) or any(product_id <= 0 for product_id in product_ids):
            raise HTTPException(422, "Выберите от 1 до 100 товаров без повторов")
        return {"items": _bulk_available_attributes(db, product_ids)}

    @router.post("/bulk-attributes/preview", dependencies=[Depends(csrf_dependency)])
    def bulk_attribute_preview(body: BulkProductAttributeInput, db: Session = Depends(get_db),
                               user=Depends(admin_dependency)):
        plan = _bulk_attribute_plan(db, body)
        expires = int(time.time()) + 600
        return {"attribute": {"code": plan["attribute"].code, "label": plan["attribute"].label,
                               "value_type": plan["definition"].value_type, "unit": plan["definition"].unit},
                "value_state": body.value_state, "value": plan["normalized"],
                "source_kind": body.source_kind, "source_url": body.source_url,
                "selected_count": len(plan["products"]), "overwrite_count": plan["overwrite_count"],
                "insert_count": plan["insert_count"], "items": plan["previews"],
                "preview_token": _bulk_preview_token(user.id, body, plan, expires),
                "expires_at": expires}

    @router.post("/bulk-attributes/apply", dependencies=[Depends(csrf_dependency)])
    def bulk_attribute_apply(body: BulkProductAttributeApply, db: Session = Depends(get_db),
                             user=Depends(admin_dependency)):
        lock_validation(db)
        plan = _bulk_attribute_plan(db, body, lock_products=True)
        try:
            expires_text, _signature = body.preview_token.split(".", 1)
            expires = int(expires_text)
        except (ValueError, TypeError):
            raise HTTPException(409, "Предпросмотр недействителен; сформируйте его заново")
        if expires < int(time.time()) or expires > int(time.time()) + 600:
            raise HTTPException(409, "Предпросмотр устарел; сформируйте его заново")
        expected_token = _bulk_preview_token(user.id, body, plan, expires)
        if not hmac.compare_digest(expected_token, body.preview_token):
            raise HTTPException(409, "Данные или товары изменились после предпросмотра; сформируйте его заново")

        batch_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        results = []
        for product in plan["products"]:
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product.id,
                ProductAttribute.attribute_id == plan["attribute"].id
            ).with_for_update())
            created = row is None
            old_state = row.value_state if row else None
            old_value = _stored_attribute_value(row, plan["attribute"])
            old_source_kind = row.source_kind if row else None
            old_source_url = row.source_url if row else None
            if row is None:
                row = ProductAttribute(product_id=product.id, attribute_id=plan["attribute"].id)
                db.add(row)
            row.value_string = row.value_number = row.value_boolean = row.value_json = None
            if body.value_state == "known":
                value_type = plan["definition"].value_type
                if value_type in ("string", "enum", "url"):
                    row.value_string = plan["normalized"]
                elif value_type in ("number", "integer"):
                    row.value_number = plan["normalized"]
                elif value_type == "boolean":
                    row.value_boolean = plan["normalized"]
                else:
                    row.value_json = plan["normalized"]
            row.value_state = body.value_state
            row.source_kind, row.source_url, row.updated_at = body.source_kind, body.source_url, now
            validation = revalidate_product(db, product)
            db.add(AuditLog(user_id=user.id, action="product.bulk_attribute_changed", object_type="product",
                            object_id=str(product.id), details={
                                "batch_id": batch_id, "code": body.code, "created": created,
                                "old_state": old_state, "old_value": old_value,
                                "new_state": body.value_state, "new_value": plan["normalized"],
                                "old_source_kind": old_source_kind, "old_source_url": old_source_url,
                                "source_kind": body.source_kind, "source_url": body.source_url,
                            }))
            results.append({"product_id": product.id, "validity_check": validation["validity_check"]})
        db.commit()
        return {"batch_id": batch_id, "updated_count": len(results),
                "overwrite_count": plan["overwrite_count"], "insert_count": plan["insert_count"],
                "items": results}

    @router.get("/{product_id}")
    def product_detail(product_id: int, db: Session = Depends(get_db)):
        product = db.get(Product, product_id)
        if product is None or product.source_id != _source_id(db):
            raise HTTPException(404, "Product not found")
        offers = db.execute(select(SupplierOffer, CatalogSource.name)
                            .join(ProductSourceLink, ProductSourceLink.offer_id == SupplierOffer.id)
                            .join(CatalogSource, CatalogSource.id == SupplierOffer.source_id)
                            .where(ProductSourceLink.product_id == product_id)
                            .order_by(CatalogSource.name, SupplierOffer.id)).all()
        reasons = list(db.scalars(select(ValidationReason.message).where(
            ValidationReason.product_id == product_id).order_by(ValidationReason.id)))
        return {"id": product.id, "sku": product.sku, "name": product.name,
                "article": product.manufacturer_article, "manufacturer": product.manufacturer,
                "status": product.status, "validity_check": product.validity_check,
                "selection_enabled": product.selection_enabled,
                "categories": [{"id": cat.id, "name": cat.name} for cat in product.categories],
                "attributes": _attributes(db, [product_id])[product_id],
                "available_attributes": _available_attributes(db, product),
                "validation_reasons": reasons,
                "offers": [{"source": source_name, "sku": offer.sku,
                            "price": str(offer.price) if offer.price is not None else None,
                            "currency": offer.currency, "is_current": offer.is_current}
                           for offer, source_name in offers]}

    @router.patch("/{product_id}/attributes/{code}", dependencies=[Depends(csrf_dependency)])
    def save_product_attribute(product_id: int, code: str, body: ProductAttributeInput,
                               db: Session = Depends(get_db), user=Depends(admin_dependency)):
        lock_validation(db)
        product = db.get(Product, product_id)
        if product is None or product.source_id != _source_id(db):
            raise HTTPException(404, "Product not found")
        attribute = db.scalar(select(Attribute).where(Attribute.code == code))
        category_ids = [category.id for category in product.categories]
        linked = attribute is not None and bool(category_ids) and db.scalar(select(CategoryAttribute.attribute_id).where(
            CategoryAttribute.category_id.in_(category_ids), CategoryAttribute.attribute_id == attribute.id
        )) is not None
        if not linked:
            raise HTTPException(422, "Свойство не входит в структуру категорий товара")

        rules = list(db.scalars(select(PropertyRule).where(
            PropertyRule.active.is_(True), PropertyRule.source == "internal",
            PropertyRule.code == code, PropertyRule.category_id.in_(category_ids)
        ).order_by(PropertyRule.category_id, PropertyRule.id)))
        definitions = [RuleDefinition.model_validate(rule.definition) for rule in rules]
        if definitions and any((r.value_type, r.unit) != (definitions[0].value_type, definitions[0].unit) for r in definitions[1:]):
            raise HTTPException(422, "Свойство имеет противоречивые типы в категориях товара")
        rule = definitions[0] if definitions else RuleDefinition(
            code=attribute.code, label=attribute.label, source="internal", level="optional",
            value_type=attribute.value_type, unit=attribute.unit,
            normalization=attribute.normalization or {})
        normalized = None
        if body.value_state == "known":
            try:
                normalized = [normalize(body.value, current) for current in definitions] if definitions else [normalize(body.value, rule)]
            except (ValueError, TypeError) as exc:
                raise HTTPException(422, str(exc)) from exc
            normalized = normalized[0]

        row = db.scalar(select(ProductAttribute).where(
            ProductAttribute.product_id == product_id,
            ProductAttribute.attribute_id == attribute.id
        ).with_for_update())
        created = row is None
        if row is None:
            row = ProductAttribute(product_id=product_id, attribute_id=attribute.id)
            db.add(row)
        old_state, old_source = row.value_state if not created else None, row.source_kind if not created else None
        row.value_string = row.value_number = row.value_boolean = row.value_json = None
        if body.value_state == "known":
            if rule.value_type in ("string", "enum", "url"):
                row.value_string = normalized
            elif rule.value_type in ("number", "integer"):
                row.value_number = normalized
            elif rule.value_type == "boolean":
                row.value_boolean = normalized
            else:
                row.value_json = normalized
        row.value_state = body.value_state
        row.source_kind, row.source_url = body.source_kind, body.source_url
        revalidate_product(db, product)
        db.add(AuditLog(user_id=user.id, action="product.attribute_changed", object_type="product_attribute",
                        object_id=f"{product_id}:{code}", details={
                            "created": created, "old_state": old_state, "new_state": body.value_state,
                            "old_source_kind": old_source, "source_kind": body.source_kind,
                        }))
        db.commit()
        return {"product_id": product_id, "code": code, "value_state": row.value_state,
                "value": normalized, "unit": attribute.unit, "source_kind": row.source_kind,
                "source_url": row.source_url, "validity_check": product.validity_check}

    @router.delete("/{product_id}/attributes/{code}", dependencies=[Depends(csrf_dependency)])
    def delete_product_attribute(product_id: int, code: str, body: DeleteProductAttributeInput,
                                 db: Session = Depends(get_db), user=Depends(admin_dependency)):
        lock_validation(db)
        product = db.get(Product, product_id)
        if product is None or product.source_id != _source_id(db):
            raise HTTPException(404, "Товар не найден")
        attribute = db.scalar(select(Attribute).where(Attribute.code == code))
        if attribute is None:
            raise HTTPException(404, "Свойство не найдено")
        row = db.scalar(select(ProductAttribute).where(
            ProductAttribute.product_id == product_id,
            ProductAttribute.attribute_id == attribute.id,
        ).with_for_update())
        if row is None:
            raise HTTPException(404, "Свойство у товара не найдено")
        current = {"value_state": row.value_state, "value": _stored_attribute_value(row, attribute),
                   "source_kind": row.source_kind, "source_url": row.source_url}
        expected = {"value_state": body.expected_value_state, "value": body.expected_value,
                    "source_kind": body.expected_source_kind, "source_url": body.expected_source_url}
        if _canonical_hash(current) != _canonical_hash(expected):
            raise HTTPException(409, "Свойство изменилось. Обновите карточку и повторите удаление")
        db.delete(row)
        revalidate_product(db, product)
        db.add(AuditLog(user_id=user.id, action="product.attribute_deleted", object_type="product_attribute",
                        object_id=f"{product_id}:{code}", details={"code": code, "old_state": current["value_state"],
                                                                    "old_value": current["value"],
                                                                    "old_source_kind": current["source_kind"]}))
        db.commit()
        return {"product_id": product_id, "code": code, "validity_check": product.validity_check}

    @router.post("/{product_id}/recheck", dependencies=[Depends(csrf_dependency)])
    def recheck(product_id: int, db: Session = Depends(get_db)):
        lock_validation(db)
        product = db.get(Product, product_id)
        if product is None or product.source_id != _source_id(db):
            raise HTTPException(404, "Товар не найден")
        result = revalidate_product(db, product)
        db.commit()
        return result

    @router.patch("/{product_id}/selection", dependencies=[Depends(csrf_dependency)])
    def selection(product_id: int, body: ProductSelection, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        lock_validation(db)
        product = db.get(Product, product_id)
        if product is None or product.source_id != _source_id(db):
            raise HTTPException(404, "Товар не найден")
        old = product.selection_enabled
        product.selection_enabled = body.selection_enabled
        db.add(AuditLog(user_id=user.id, action="product.selection_changed", object_type="product",
                        object_id=str(product.id), details={"old": old, "selection_enabled": body.selection_enabled}))
        result = revalidate_product(db, product)
        db.commit()
        return {**result, "selection_enabled": product.selection_enabled}

    return router
