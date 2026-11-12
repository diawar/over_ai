"""Require three builder ventilation fields in the case and motherboard categories.

Run in the backend container; pass --apply after reviewing the dry run.
"""
import argparse
import json
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Category, CategoryAttribute, PropertyRule
from app.property_engine import RuleDefinition
from app.property_service import attach_rule
from app.validity import lock_validation, revalidate_category


FIELDS = {
    359: ("Материнские платы", "motherboard", ("motherboard_fan_headers",)),
    432: ("Корпуса", "pc_case", ("case_preinstalled_fans", "case_fan_mounts",
                               "case_drive_bays_25", "case_drive_bays_35",
                               "case_drive_bays_shared_25_35")),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    templates = {row["code"]: row for row in json.loads(
        Path("/tmp/pc_property_templates.json").read_text(encoding="utf-8"))}
    with SessionLocal() as db:
        pending = []
        for category_id, (name, template_code, codes) in FIELDS.items():
            category = db.get(Category, category_id)
            if category is None or category.organization_id != 1 or category.name != name:
                raise RuntimeError(f"Category {category_id} identity mismatch")
            definitions = {row["code"]: row for row in templates[template_code]["attributes"]}
            for code in codes:
                rule = db.scalar(select(PropertyRule).where(
                    PropertyRule.category_id == category_id,
                    PropertyRule.code == code,
                    PropertyRule.source == "internal"))
                if rule is not None and rule.active:
                    definition = RuleDefinition.model_validate(rule.definition).model_copy(
                        update={"level": "required", "required_for_selection": True})
                    link = db.get(CategoryAttribute, (category_id, rule.attribute_id)) if rule.attribute_id else None
                    if (rule.definition.get("level") == "required" and
                            rule.definition.get("required_for_selection") is True and
                            link is not None and link.required_for_selection):
                        print(f"EXISTS: {name}: {code} (required)")
                        continue
                    action = "UPDATE"
                else:
                    definition = RuleDefinition.model_validate(definitions[code])
                    action = "ADD"
                pending.append((category_id, name, definition, rule))
                print(f"{action}: {name}: {code}")
        if not args.apply:
            print(f"DRY RUN: {len(pending)} rules, no writes.")
            return
        if not pending:
            print("UNCHANGED: all rules already active.")
            return
        lock_validation(db)
        changed_categories = set()
        for category_id, _, definition, previous in pending:
            attach_rule(db, category_id, definition, existing=previous)
            changed_categories.add(category_id)
            db.add(AuditLog(action="properties.builder_mapping_added",
                            object_type="category", object_id=str(category_id),
                            details={"code": definition.code, "value_type": definition.value_type,
                                     "required_for_selection": True}))
        for category_id in changed_categories:
            revalidate_category(db, category_id)
        db.commit()
        print(f"APPLIED: {len(pending)} rules across {len(changed_categories)} categories.")


if __name__ == "__main__":
    main()
