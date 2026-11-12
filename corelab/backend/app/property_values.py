"""Browse stored property values and merge exact variants of any supported type."""

from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .catalog_views import _source_id
from .db import get_db
from .models import (Attribute, AuditLog, Category, CategoryAttribute, Product, ProductAttribute,
                     PropertyRule, PropertyValue, product_categories)
from .property_engine import RuleDefinition, normalize
from .validity import lock_validation, revalidate_product


class MergeValuesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sources: list[str] = Field(min_length=1)
    target: str = Field(min_length=1)
    expected_counts: dict[str, int] = Field(min_length=2)


class CreateValueInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: Any


class UpdateValueInput(CreateValueInput):
    key: str
    expected_count: int = Field(ge=0)


class DeleteValueInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str
    expected_count: int = Field(ge=0)


class DeleteAttributeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str
    expected_product_count: int = Field(ge=0)


VALUE_COLUMNS = {
    "string": ProductAttribute.value_string, "enum": ProductAttribute.value_string,
    "url": ProductAttribute.value_string, "number": ProductAttribute.value_number,
    "integer": ProductAttribute.value_number, "boolean": ProductAttribute.value_boolean,
    "list": ProductAttribute.value_json,
}


def value_key(value, value_type: str) -> str:
    if value_type == "boolean":
        return "true" if value else "false"
    if value_type == "list":
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return str(value)


def prepare_value(attribute: Attribute, raw):
    try:
        rule = RuleDefinition(code=attribute.code, label=attribute.label, level="optional",
                              value_type=attribute.value_type, unit=attribute.unit,
                              normalization=attribute.normalization or {},
                              allowed_values=[raw] if attribute.value_type == "enum" and isinstance(raw, str) else [])
        value = normalize(raw, rule)
        if attribute.value_type in ("number", "integer"):
            value = Decimal(str(value)).quantize(Decimal("0.01"))
            if abs(value) >= Decimal("100000000000000"):
                raise ValueError("Число выходит за допустимый диапазон")
        return value
    except (ValueError, TypeError, InvalidOperation) as exc:
        raise HTTPException(422, str(exc)) from exc


def stored_value(value, value_type: str):
    return str(value) if value_type in ("number", "integer") else value


def attribute_rows(db: Session, attribute_id: int, column):
    return list(db.scalars(select(ProductAttribute)
                           .join(Product, Product.id == ProductAttribute.product_id)
                           .where(Product.source_id == _source_id(db),
                                  ProductAttribute.attribute_id == attribute_id,
                                  ProductAttribute.value_state == "known", column.is_not(None))
                           .order_by(ProductAttribute.id).with_for_update(of=ProductAttribute)))


def values_router(admin_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/properties/dictionary",
                       dependencies=[Depends(admin_dependency)])

    @router.get("")
    def attributes(db: Session = Depends(get_db)):
        source_id = _source_id(db)
        counts = dict(db.execute(select(ProductAttribute.attribute_id, func.count(ProductAttribute.id))
                                 .join(Product, Product.id == ProductAttribute.product_id)
                                 .where(Product.source_id == source_id, ProductAttribute.value_state == "known")
                                 .group_by(ProductAttribute.attribute_id)).all())
        selection_ids = set(db.scalars(select(CategoryAttribute.attribute_id).join(
            Category, Category.id == CategoryAttribute.category_id).where(
            Category.source_id == source_id, Category.selection_category.is_(True),
            CategoryAttribute.required_for_selection.is_(True))))
        rows = db.scalars(select(Attribute).order_by(Attribute.label, Attribute.code))
        return {"items": [{"id": row.id, "code": row.code, "label": row.label,
                           "value_type": row.value_type, "filled_count": counts.get(row.id, 0),
                           "used_for_selection": row.id in selection_ids}
                          for row in rows]}

    @router.get("/{attribute_id}/values")
    def values(attribute_id: int, db: Session = Depends(get_db)):
        attribute = db.get(Attribute, attribute_id)
        if attribute is None:
            raise HTTPException(404, "Свойство не найдено")
        column = VALUE_COLUMNS[attribute.value_type]
        rows = db.execute(select(column, func.count(ProductAttribute.id))
                          .join(Product, Product.id == ProductAttribute.product_id)
                          .where(Product.source_id == _source_id(db),
                                 ProductAttribute.attribute_id == attribute_id,
                                 ProductAttribute.value_state == "known", column.is_not(None))
                          .group_by(column).order_by(func.count(ProductAttribute.id).desc())).all()
        items = {value_key(value, attribute.value_type):
                 {"key": value_key(value, attribute.value_type),
                  "value": stored_value(value, attribute.value_type), "count": count, "registered": False}
                 for value, count in rows}
        for entry in db.scalars(select(PropertyValue).where(PropertyValue.attribute_id == attribute_id)):
            if entry.value_key in items:
                items[entry.value_key]["registered"] = True
            else:
                items[entry.value_key] = {"key": entry.value_key, "value": entry.value_json,
                                          "count": 0, "registered": True}
        return {"attribute": {"id": attribute.id, "code": attribute.code, "label": attribute.label,
                               "value_type": attribute.value_type},
                "items": sorted(items.values(), key=lambda item: (-item["count"], item["key"])),
                "total_products": sum(item["count"] for item in items.values()),
                "linked_products": db.scalar(select(func.count(ProductAttribute.id)).where(
                    ProductAttribute.organization_id == attribute.organization_id,
                    ProductAttribute.attribute_id == attribute_id)),
                "merge_supported": True}

    @router.delete("/{attribute_id}", dependencies=[Depends(csrf_dependency)])
    def delete_attribute(attribute_id: int, body: DeleteAttributeInput, db: Session = Depends(get_db),
                         user=Depends(admin_dependency)):
        lock_validation(db)
        attribute = db.scalar(select(Attribute).where(
            Attribute.id == attribute_id, Attribute.organization_id == user.organization_id).with_for_update())
        if attribute is None:
            raise HTTPException(404, "Свойство не найдено")
        if db.scalar(select(PropertyRule.id).where(
                PropertyRule.organization_id == user.organization_id, PropertyRule.scope == "global",
                PropertyRule.code == attribute.code).limit(1)) is not None:
            raise HTTPException(409, "Базовое свойство нельзя удалить")
        product_ids = set(db.scalars(select(ProductAttribute.product_id).where(
            ProductAttribute.organization_id == user.organization_id,
            ProductAttribute.attribute_id == attribute_id)))
        if attribute.code != body.code or len(product_ids) != body.expected_product_count:
            raise HTTPException(409, "Свойство или число связанных товаров изменилось. Обновите страницу")
        rules_filter = ((PropertyRule.attribute_id == attribute_id) |
                        ((PropertyRule.source == "internal") & (PropertyRule.code == attribute.code)))
        category_ids = set(db.scalars(select(CategoryAttribute.category_id).where(
            CategoryAttribute.organization_id == user.organization_id,
            CategoryAttribute.attribute_id == attribute_id)))
        category_ids.update(db.scalars(select(PropertyRule.category_id).where(
            PropertyRule.organization_id == user.organization_id, rules_filter,
            PropertyRule.category_id.is_not(None))))
        if category_ids:
            product_ids.update(db.scalars(select(product_categories.c.product_id).where(
                product_categories.c.category_id.in_(category_ids))))
        linked_products = body.expected_product_count
        db.execute(delete(ProductAttribute).where(
            ProductAttribute.organization_id == user.organization_id,
            ProductAttribute.attribute_id == attribute_id))
        db.execute(delete(PropertyValue).where(
            PropertyValue.organization_id == user.organization_id,
            PropertyValue.attribute_id == attribute_id))
        db.execute(delete(CategoryAttribute).where(
            CategoryAttribute.organization_id == user.organization_id,
            CategoryAttribute.attribute_id == attribute_id))
        db.execute(delete(PropertyRule).where(
            PropertyRule.organization_id == user.organization_id, rules_filter))
        db.delete(attribute)
        db.flush()
        for product_id in sorted(product_ids):
            product = db.get(Product, product_id)
            if product is not None and product.organization_id == user.organization_id:
                revalidate_product(db, product)
        db.add(AuditLog(user_id=user.id, action="properties.attribute_deleted", object_type="attribute",
                        object_id=str(attribute_id), details={"code": attribute.code, "label": attribute.label,
                                                              "linked_products": linked_products,
                                                              "categories": sorted(category_ids)}))
        db.commit()
        return {"deleted": True, "linked_products": linked_products}

    @router.post("/{attribute_id}/values", dependencies=[Depends(csrf_dependency)])
    def create_value(attribute_id: int, body: CreateValueInput, db: Session = Depends(get_db),
                     user=Depends(admin_dependency)):
        lock_validation(db)
        attribute = db.get(Attribute, attribute_id)
        if attribute is None:
            raise HTTPException(404, "Свойство не найдено")
        value = prepare_value(attribute, body.value)
        key = value_key(value, attribute.value_type)
        column = VALUE_COLUMNS[attribute.value_type]
        rows = attribute_rows(db, attribute_id, column)
        if any(value_key(getattr(row, column.key), attribute.value_type) == key for row in rows) or db.scalar(
                select(PropertyValue.id).where(PropertyValue.attribute_id == attribute_id,
                                               PropertyValue.value_key == key)) is not None:
            raise HTTPException(409, "Такое значение уже существует")
        db.add(PropertyValue(attribute_id=attribute_id, value_key=key,
                             value_json=stored_value(value, attribute.value_type)))
        db.add(AuditLog(user_id=user.id, action="properties.value_created", object_type="attribute",
                        object_id=str(attribute_id), details={"code": attribute.code, "value": key}))
        db.commit()
        return {"key": key, "value": stored_value(value, attribute.value_type), "count": 0}

    @router.patch("/{attribute_id}/values", dependencies=[Depends(csrf_dependency)])
    def update_value(attribute_id: int, body: UpdateValueInput, db: Session = Depends(get_db),
                     user=Depends(admin_dependency)):
        lock_validation(db)
        attribute = db.get(Attribute, attribute_id)
        if attribute is None:
            raise HTTPException(404, "Свойство не найдено")
        value = prepare_value(attribute, body.value)
        new_key = value_key(value, attribute.value_type)
        if new_key == body.key:
            raise HTTPException(422, "Укажите новое значение")
        column = VALUE_COLUMNS[attribute.value_type]
        rows = attribute_rows(db, attribute_id, column)
        keyed = [(row, value_key(getattr(row, column.key), attribute.value_type)) for row in rows]
        old_entry = db.scalar(select(PropertyValue).where(PropertyValue.attribute_id == attribute_id,
                                                          PropertyValue.value_key == body.key).with_for_update())
        if not old_entry and not any(key == body.key for _, key in keyed):
            raise HTTPException(404, "Значение не найдено")
        affected = [row for row, key in keyed if key == body.key]
        if len(affected) != body.expected_count:
            raise HTTPException(409, "Количество товаров изменилось. Обновите список")
        if any(key == new_key for _, key in keyed) or db.scalar(select(PropertyValue.id).where(
                PropertyValue.attribute_id == attribute_id, PropertyValue.value_key == new_key)) is not None:
            raise HTTPException(409, "Новое значение уже существует. Используйте объединение")
        now = datetime.now(timezone.utc)
        for row in affected:
            setattr(row, column.key, value)
            row.updated_at = now
        if old_entry:
            old_entry.value_key = new_key
            old_entry.value_json = stored_value(value, attribute.value_type)
        else:
            db.add(PropertyValue(attribute_id=attribute_id, value_key=new_key,
                                 value_json=stored_value(value, attribute.value_type)))
        db.flush()
        for product_id in sorted({row.product_id for row in affected}):
            revalidate_product(db, db.get(Product, product_id))
        db.add(AuditLog(user_id=user.id, action="properties.value_updated", object_type="attribute",
                        object_id=str(attribute_id), details={"code": attribute.code, "old": body.key,
                                                              "new": new_key, "products": len(affected)}))
        db.commit()
        return {"key": new_key, "updated_products": len(affected)}

    @router.delete("/{attribute_id}/values", dependencies=[Depends(csrf_dependency)])
    def delete_value(attribute_id: int, body: DeleteValueInput, db: Session = Depends(get_db),
                     user=Depends(admin_dependency)):
        lock_validation(db)
        attribute = db.get(Attribute, attribute_id)
        if attribute is None:
            raise HTTPException(404, "Свойство не найдено")
        column = VALUE_COLUMNS[attribute.value_type]
        rows = attribute_rows(db, attribute_id, column)
        affected = [row for row in rows if value_key(getattr(row, column.key), attribute.value_type) == body.key]
        entry = db.scalar(select(PropertyValue).where(PropertyValue.attribute_id == attribute_id,
                                                       PropertyValue.value_key == body.key).with_for_update())
        if not entry and not affected:
            raise HTTPException(404, "Значение не найдено")
        if len(affected) != body.expected_count:
            raise HTTPException(409, "Количество товаров изменилось. Обновите список")
        product_ids = sorted({row.product_id for row in affected})
        for row in affected:
            db.delete(row)
        if entry:
            db.delete(entry)
        db.flush()
        for product_id in product_ids:
            revalidate_product(db, db.get(Product, product_id))
        db.add(AuditLog(user_id=user.id, action="properties.value_deleted", object_type="attribute",
                        object_id=str(attribute_id), details={"code": attribute.code, "value": body.key,
                                                              "products": len(affected)}))
        db.commit()
        return {"key": body.key, "updated_products": len(affected)}

    @router.post("/{attribute_id}/merge", dependencies=[Depends(csrf_dependency)])
    def merge(attribute_id: int, body: MergeValuesInput, db: Session = Depends(get_db),
              user=Depends(admin_dependency)):
        lock_validation(db)
        attribute = db.get(Attribute, attribute_id)
        if attribute is None:
            raise HTTPException(404, "Свойство не найдено")
        column = VALUE_COLUMNS[attribute.value_type]
        if len(set(body.sources)) != len(body.sources) or body.target in body.sources:
            raise HTTPException(422, "Выберите разные исходные и целевое значения")
        involved = set(body.sources) | {body.target}
        if set(body.expected_counts) != involved or any(count < 0 for count in body.expected_counts.values()):
            raise HTTPException(422, "Количество товаров для выбранных значений указано неверно")
        rows = attribute_rows(db, attribute_id, column)
        keyed = [(row, value_key(getattr(row, column.key), attribute.value_type)) for row in rows]
        counts = Counter(key for _, key in keyed if key in involved)
        entries = {entry.value_key: entry for entry in db.scalars(select(PropertyValue).where(
            PropertyValue.attribute_id == attribute_id, PropertyValue.value_key.in_(involved)).with_for_update())}
        if any(key not in counts and key not in entries for key in involved) or {
                key: counts.get(key, 0) for key in involved} != body.expected_counts:
            raise HTTPException(409, "Значения изменились. Обновите список и повторите объединение")
        target_value = (prepare_value(attribute, entries[body.target].value_json) if body.target in entries else
                        next(getattr(row, column.key) for row, key in keyed if key == body.target))
        affected = [row for row, key in keyed if key in body.sources]
        now = datetime.now(timezone.utc)
        for row in affected:
            setattr(row, column.key, target_value)
            row.updated_at = now
        for key in body.sources:
            if key in entries:
                db.delete(entries[key])
        db.flush()
        for product_id in sorted({row.product_id for row in affected}):
            revalidate_product(db, db.get(Product, product_id))
        db.add(AuditLog(user_id=user.id, action="properties.values_merged", object_type="attribute",
                        object_id=str(attribute.id), details={"code": attribute.code, "sources": body.sources,
                                                              "target": body.target, "products": len(affected)}))
        db.commit()
        return {"attribute_id": attribute.id, "target": body.target, "updated_products": len(affected)}

    return router
