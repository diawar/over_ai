"""Persistence adapters; the evaluator itself remains category-independent."""
import hashlib
import json
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select

from .models import (Attribute, CategoryAttribute, CategoryStructureCheck, ProductAttribute,
                     PropertyRule, ProductSourceLink, SupplierOffer)
from .property_engine import RuleDefinition, evaluate, unpack

GLOBAL_FIELD_CODES = frozenset({"description", "image_link", "additional_image_link", "warranty_months",
                               "mpn", "condition", "product_length_cm", "product_width_cm",
                               "product_height_cm", "product_weight_kg"})


def has_technical_values(db, product_id):
    return db.scalar(select(ProductAttribute.id).join(Attribute).where(
        ProductAttribute.product_id == product_id, Attribute.code.notin_(GLOBAL_FIELD_CODES)).limit(1)) is not None


def defaults():
    data = json.loads(Path(__file__).with_name("property_defaults.json").read_text(encoding="utf-8"))
    extra = json.loads(Path(__file__).with_name("pc_property_templates.json").read_text(encoding="utf-8"))
    existing = {template["code"] for template in data["templates"]}
    data["templates"].extend(template for template in extra if template["code"] not in existing)
    return data


def definition(rule):
    return RuleDefinition.model_validate(rule.definition).model_dump(mode="json")


def rules_for(db, category_ids):
    return list(db.scalars(select(PropertyRule).where(
        PropertyRule.active.is_(True),
        (PropertyRule.scope == "global") | PropertyRule.category_id.in_(category_ids)
    ).order_by(PropertyRule.scope, PropertyRule.source, PropertyRule.code)))


def ensure_defaults(db):
    """Seed selected global feed rules; restore only these from the old archive."""
    for data in defaults()["rules"]:
        d = RuleDefinition.model_validate(data).model_dump(mode="json")
        row = db.scalar(select(PropertyRule).where(PropertyRule.scope == "global",
                            PropertyRule.code == d["code"], PropertyRule.source == d["source"]))
        if row is None:
            db.add(PropertyRule(scope="global", code=d["code"], source=d["source"], definition=d,
                                active=True, revision=1))
        elif not row.active:
            row.definition, row.active = d, True
            row.revision += 1


def attach_rule(db, category_id, d: RuleDefinition, existing=None):
    attribute_id = None
    if d.source == "internal" and category_id is not None:
        attr = db.scalar(select(Attribute).where(Attribute.code == d.code))
        if attr:
            if attr.value_type != d.value_type or attr.unit != d.unit or (attr.normalization or {}) != d.normalization:
                raise HTTPException(409, "Код уже используется с другим типом, единицей или нормализацией; существующие значения сохранены")
        else:
            attr = Attribute(code=d.code, label=d.label, value_type=d.value_type, unit=d.unit,
                             normalization=d.normalization)
            db.add(attr); db.flush()
        attribute_id = attr.id
        link = db.get(CategoryAttribute, (category_id, attr.id))
        if link is None:
            link = CategoryAttribute(category_id=category_id, attribute_id=attr.id)
            db.add(link)
        link.required_for_selection = d.required_for_selection
        link.ai_blocked = d.ai_blocked
    if existing is None:
        existing = PropertyRule(scope=str(category_id) if category_id is not None else "global",
                                category_id=category_id, code=d.code, source=d.source, revision=1)
        db.add(existing)
    else:
        existing.revision += 1
    existing.definition = d.model_dump(mode="json")
    existing.attribute_id = attribute_id
    existing.active = True
    return existing


def structure_report(db, category_id):
    rows = rules_for(db, [category_id])
    links = list(db.scalars(select(CategoryAttribute).where(CategoryAttribute.category_id == category_id)))
    payload = {"rules": [(r.id, r.revision, r.definition) for r in rows],
               "links": sorted((r.attribute_id, r.ai_blocked, r.required_for_selection) for r in links)}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    errors, warnings = [], []
    local = [r for r in rows if r.category_id == category_id]
    if not any(r.source == "internal" for r in local):
        errors.append("Не задана техническая структура категории")
    by_code = {}
    for r in rows:
        d = definition(r)
        shape = (d["value_type"], d["unit"])
        if r.code in by_code and by_code[r.code] != shape:
            errors.append(f"Противоречивые тип или единица: {r.code}")
        by_code[r.code] = shape
        if d["required_for_selection"] and d["ai_blocked"]:
            warnings.append(f"{d['label']}: обязательно для подбора, но закрыто для ИИ")
    previous = db.get(CategoryStructureCheck, category_id)
    current = previous is not None and previous.fingerprint == digest
    return {"fingerprint": digest, "status": "error" if errors else "warning" if warnings else "success",
            "structure_status": "error" if errors else "success",
            "errors": list(dict.fromkeys(errors)), "warnings": list(dict.fromkeys(warnings)),
            "current": current,
            "ai_load_allowed": False,
            "load_reason": "Платная загрузка удалена",
            "scope": "Покрытие сохранённой структуры внутренних правил категории"}


def product_data(db, product):
    # Only known, explicitly mapped fields. Supplier status is not availability.
    values = {"id": product.sku, "title": product.name, "brand": product.manufacturer,
              "mpn": product.manufacturer_article, "image_link": product.image_url}
    default_codes = {rule["code"] for rule in defaults()["rules"] if rule.get("default_value") is not None}
    for rule in defaults()["rules"]:
        if rule.get("default_value") is not None:
            values[rule["code"]] = rule["default_value"]
    offers = list(db.scalars(select(SupplierOffer).join(ProductSourceLink,
                   ProductSourceLink.offer_id == SupplierOffer.id).where(
                   ProductSourceLink.product_id == product.id, SupplierOffer.is_current.is_(True),
                   SupplierOffer.price > 0).order_by(SupplierOffer.price, SupplierOffer.id)))
    if offers and len({o.currency for o in offers}) == 1:
        values.update(price=str(offers[0].price), currency=offers[0].currency)
    rows = db.execute(select(ProductAttribute, Attribute).join(Attribute).where(
        ProductAttribute.product_id == product.id))
    for value, attr in rows:
        actual = next((v for v in (value.value_string, value.value_number, value.value_boolean, value.value_json)
                       if v is not None), None)
        if actual is not None and attr.value_type == "number":
            actual = str(actual)
        # Never let a technical field overwrite canonical price, title, brand, etc.
        if attr.code not in values or attr.code in default_codes:
            values[attr.code] = {"state": value.value_state, "value": actual}
    return values


def product_report(db, product, context):
    category_ids = [c.id for c in product.categories]
    rows = rules_for(db, category_ids)
    definitions = [definition(r) for r in rows]
    # Preserve legacy requirements set before the new editor existed.
    links = db.execute(select(CategoryAttribute, Attribute).join(Attribute).where(
        CategoryAttribute.category_id.in_(category_ids), CategoryAttribute.required_for_selection.is_(True)))
    for link, attr in links:
        if any(r.category_id == link.category_id and r.attribute_id == attr.id for r in rows):
            continue
        definitions.append(RuleDefinition(code=attr.code, label=attr.label, source="internal", level="required",
                           value_type=attr.value_type, unit=attr.unit, normalization=attr.normalization or {}).model_dump(mode="json"))
    report = evaluate(definitions, product_data(db, product), context)
    extra = []
    if not category_ids:
        extra.append("Категория товара не определена")
    for cat in product.categories:
        if not any(r.category_id == cat.id for r in rows):
            extra.append(f"Нет правил категории «{cat.name}»")
    for message in extra:
        report["groups"].setdefault("internal", {"status": "success", "findings": []})
        report["groups"]["internal"]["findings"].append(dict(source="internal", code="coverage", label="Покрытие правил",
                      severity="warning", reason="rules_missing", message=message, level="optional", evidence_url=None))
    if extra:
        if report["groups"]["internal"]["status"] == "success":
            report["groups"]["internal"]["status"] = "warning"
        if report["status"] == "success":
            report["status"] = "warning"
    return report
