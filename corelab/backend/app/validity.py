"""Selection eligibility. Call in the same transaction as the data mutation."""
from sqlalchemy import delete, select, text

from .models import (Attribute, AuditLog, CatalogSource, CategoryAttribute, Product,
                     ProductAttribute, ValidationReason)
from .property_engine import RuleDefinition, condition_value, evaluate
from .property_service import definition, rules_for


def lock_validation(db):
    # All eligibility mutations acquire this before row locks, including the worker.
    db.execute(text("SELECT pg_advisory_xact_lock(642807)"))


def revalidate_product(db, product):
    db.flush()
    reasons = []
    result = None
    if any(c.selection_category for c in product.categories):
        ids = [c.id for c in product.categories]
        rules = [r for r in rules_for(db, ids) if r.source == "internal" and r.category_id is not None]
        links = list(db.execute(select(CategoryAttribute, Attribute).join(Attribute).where(
            CategoryAttribute.category_id.in_(ids), CategoryAttribute.required_for_selection.is_(True))))
        definitions = []
        for link, attr in links:
            matches = [r for r in rules if r.category_id == link.category_id and r.attribute_id == attr.id]
            definitions.extend([definition(r) for r in matches] or [RuleDefinition(
                code=attr.code, label=attr.label, level="required", value_type=attr.value_type,
                unit=attr.unit, normalization=attr.normalization or {}).model_dump(mode="json")])
        for cat in product.categories:
            if cat.selection_category and not any(r.category_id == cat.id for r in rules) and not any(
                    link.category_id == cat.id for link, _ in links):
                reasons.append(("rules_missing", f"Не задана структура категории «{cat.name}»"))
        values = {}
        for value, attr in db.execute(select(ProductAttribute, Attribute).join(Attribute).where(
                ProductAttribute.product_id == product.id)):
            actual = next((v for v in (value.value_string, value.value_number, value.value_boolean,
                                      value.value_json) if v is not None), None)
            values[attr.code] = {"state": value.value_state, "value": actual}
        # Detect mutually exclusive constraints independently of the current value.
        grouped = {}
        for data in definitions:
            rule = RuleDefinition.model_validate(data)
            if rule.applies_when and condition_value(rule.applies_when, values, {}) is not True:
                continue
            grouped.setdefault(rule.code, []).append(rule)
        for code, constraints in grouped.items():
            lower = max((r.minimum for r in constraints if r.minimum is not None), default=float("-inf"))
            upper = min((r.maximum for r in constraints if r.maximum is not None), default=float("inf"))
            enums = [set(r.allowed_values) for r in constraints if r.allowed_values]
            if lower > upper or (enums and not set.intersection(*enums)):
                reasons.append(("rule_conflict", f"{constraints[0].label}: требования категорий противоречат друг другу; согласуйте правила"))
        report = evaluate(definitions, values, {})
        for group in report["groups"].values():
            for item in group["findings"]:
                if item["severity"] == "error" or item["reason"] in ("condition_unknown", "applicability_unknown"):
                    reasons.append((item["reason"], f"{item['label']}: {item['message']}"))
        result = not reasons
    reasons = sorted(set((code[:120], message[:1000]) for code, message in reasons))
    old = sorted(db.execute(select(ValidationReason.code, ValidationReason.message).where(
        ValidationReason.product_id == product.id)).all())
    if product.validity_check != result or old != reasons:
        previous = product.validity_check
        product.validity_check = result
        db.execute(delete(ValidationReason).where(ValidationReason.product_id == product.id))
        db.add_all([ValidationReason(product_id=product.id, code=code, message=message) for code, message in reasons])
        db.add(AuditLog(action="product.validity_changed", object_type="product", object_id=str(product.id),
                        details={"previous": previous, "validity_check": result, "reasons": [m for _, m in reasons]}))
    return {"validity_check": result, "validation_reasons": [m for _, m in reasons]}


def revalidate_category(db, category_id=None):
    db.flush()
    query = select(Product).join(CatalogSource).where(CatalogSource.code == "corelab")
    if category_id is not None:
        query = query.where(Product.categories.any(id=category_id))
    for product in db.scalars(query.order_by(Product.id)):
        revalidate_product(db, product)
