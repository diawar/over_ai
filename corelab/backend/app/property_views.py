from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .catalog_views import _source_id
from .db import get_db
from .models import (AuditLog, Category, CategoryAttribute, CategoryStructureCheck,
                     Product, PropertyRule)
from .property_engine import RuleDefinition, evaluate
from .validity import lock_validation, revalidate_category
from .property_service import (attach_rule, defaults, definition, ensure_defaults,
                               product_report, rules_for, structure_report)


class CheckInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    values: dict[str, Any] = Field(default_factory=dict, max_length=300)
    context: dict[str, Any] = Field(default_factory=dict, max_length=100)


class TemplateInput(BaseModel):
    template: str = Field(max_length=80)


def property_router(admin_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/properties", dependencies=[Depends(admin_dependency)])

    def category(db, category_id):
        lock_validation(db)
        cat = db.scalar(select(Category).where(Category.id == category_id).with_for_update())
        if cat is None or cat.source_id != _source_id(db):
            raise HTTPException(404, "Категория не найдена")
        return cat

    def audit(db, user, action, object_id, details):
        db.add(AuditLog(user_id=user.id, action=action, object_type="property_rules", object_id=str(object_id), details=details))

    def commit(db):
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "Свойство или правило с таким кодом уже существует")

    @router.get("/templates")
    def templates():
        return {"items": defaults()["templates"]}

    @router.get("/categories")
    def property_categories(db: Session = Depends(get_db)):
        source_id = _source_id(db)
        categories = list(db.scalars(select(Category).where(Category.source_id == source_id)
                                     .order_by(Category.name, Category.id)))
        counts = dict(db.execute(select(PropertyRule.category_id, func.count(PropertyRule.id))
                                 .where(PropertyRule.category_id.in_([row.id for row in categories]),
                                        PropertyRule.source == "internal", PropertyRule.active.is_(True))
                                 .group_by(PropertyRule.category_id)).all()) if categories else {}
        return {"items": [{"id": row.id, "parent_id": row.parent_id, "name": row.name,
                           "selection_category": row.selection_category,
                           "required_for_build": row.required_for_build,
                           "property_count": counts.get(row.id, 0)} for row in categories]}

    @router.get("/categories/{category_id}")
    def get_rules(category_id: int, db: Session = Depends(get_db)):
        cat = category(db, category_id)
        rows = rules_for(db, [category_id])
        has_local_properties = any(r.scope == str(category_id) and r.source == "internal" for r in rows)
        return {"category": {"id": cat.id, "name": cat.name, "selection_category": cat.selection_category,
                              "required_for_build": cat.required_for_build,
                              "template_code": cat.property_template_code,
                              "can_generate_structure": not has_local_properties},
                "items": [{"id": r.id, "attribute_id": r.attribute_id, "scope": r.scope,
                           "revision": r.revision, **definition(r)}
                          for r in rows],
                "check": structure_report(db, category_id)}

    @router.post("/categories/{category_id}/defaults", dependencies=[Depends(csrf_dependency)])
    def install(category_id: int, body: TemplateInput, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        cat = category(db, category_id)
        template = next((t for t in defaults()["templates"] if t["code"] == body.template), None)
        if template is None and body.template != "empty":
            raise HTTPException(422, "Неизвестный шаблон")
        ensure_defaults(db)
        for data in template["attributes"] if template else []:
            exists = db.scalar(select(PropertyRule).where(PropertyRule.scope == str(category_id),
                PropertyRule.code == data["code"], PropertyRule.source == data["source"]))
            if exists is None or not exists.active:
                attach_rule(db, category_id, RuleDefinition.model_validate(data), existing=exists)
        previous_template = cat.property_template_code
        cat.property_template_code = template["code"] if template else None
        audit(db, user, "properties.template_applied", category_id,
              {"previous_template": previous_template, "template": cat.property_template_code})
        revalidate_category(db, category_id)
        commit(db)
        return get_rules(category_id, db)

    @router.post("/categories/{category_id}/rules", dependencies=[Depends(csrf_dependency)])
    def create(category_id: int, body: RuleDefinition, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        category(db, category_id)
        exists = db.scalar(select(PropertyRule).where(PropertyRule.scope == str(category_id),
                PropertyRule.code == body.code, PropertyRule.source == body.source))
        if exists and exists.active:
            raise HTTPException(409, "Правило существует; используйте редактирование")
        row = attach_rule(db, category_id, body, existing=exists)
        audit(db, user, "properties.rule_created", category_id, {"new": body.model_dump(mode="json")})
        revalidate_category(db, category_id)
        commit(db)
        return {"id": row.id}

    @router.patch("/rules/{rule_id}", dependencies=[Depends(csrf_dependency)])
    def update(rule_id: int, body: RuleDefinition, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        lock_validation(db)
        row = db.scalar(select(PropertyRule).where(PropertyRule.id == rule_id).with_for_update())
        if row is None:
            raise HTTPException(404, "Правило не найдено")
        if row.category_id is not None:
            category(db, row.category_id)
        if row.code != body.code or row.source != body.source:
            raise HTTPException(409, "Код и источник существующего правила неизменны")
        old = row.definition
        attach_rule(db, row.category_id, body, row)
        audit(db, user, "properties.rule_updated", rule_id, {"old": old, "new": row.definition})
        if row.category_id is not None:
            revalidate_category(db, row.category_id)
        commit(db)
        return {"id": row.id, "revision": row.revision}

    @router.delete("/rules/{rule_id}", dependencies=[Depends(csrf_dependency)])
    def remove(rule_id: int, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        lock_validation(db)
        row = db.scalar(select(PropertyRule).where(PropertyRule.id == rule_id).with_for_update())
        if row is None:
            raise HTTPException(404, "Правило не найдено")
        if row.scope == "global":
            raise HTTPException(409, "Базовые правила нельзя удалить; уточните условие или уровень")
        category(db, row.category_id)
        row.active = False
        row.revision += 1
        if row.attribute_id:
            link = db.get(CategoryAttribute, (row.category_id, row.attribute_id))
            if link:
                # Keep the AI exclusion, while removing the selection requirement.
                link.required_for_selection = False
                link.ai_blocked = True
        audit(db, user, "properties.rule_archived", rule_id, {"old": row.definition, "values_preserved": True})
        revalidate_category(db, row.category_id)
        commit(db)
        return {"status": "archived", "values_preserved": True}

    @router.post("/categories/{category_id}/check", dependencies=[Depends(csrf_dependency)])
    def check(category_id: int, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        category(db, category_id)
        report = structure_report(db, category_id)
        saved = db.get(CategoryStructureCheck, category_id)
        if saved is None:
            saved = CategoryStructureCheck(category_id=category_id)
            db.add(saved)
        research = (saved.report or {}).get("research") if isinstance(saved.report, dict) else None
        saved.fingerprint, saved.report = report["fingerprint"], {**report, **({"research": research} if research else {})}
        saved.checked_at = datetime.now(timezone.utc)
        audit(db, user, "properties.structure_checked", category_id, report)
        commit(db)
        return structure_report(db, category_id)

    @router.post("/categories/{category_id}/preview", dependencies=[Depends(csrf_dependency)])
    def preview(category_id: int, body: CheckInput, db: Session = Depends(get_db)):
        category(db, category_id)
        return evaluate([definition(r) for r in rules_for(db, [category_id])], body.values, body.context)

    @router.post("/products/{product_id}/validate", dependencies=[Depends(csrf_dependency)])
    def validate_product(product_id: int, body: CheckInput, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        product = db.get(Product, product_id)
        if product is None or product.source_id != _source_id(db):
            raise HTTPException(404, "Товар не найден")
        if body.values:
            raise HTTPException(422, "Проверка карточки использует сохранённые значения; для примеров используйте preview")
        report = product_report(db, product, body.context)
        audit(db, user, "properties.product_checked", product_id, report)
        commit(db)
        return report

    return router
