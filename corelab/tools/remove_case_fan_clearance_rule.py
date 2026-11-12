"""Remove the unpublished case clearance field after checking that it has no values."""
import argparse
from datetime import datetime, timezone

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import (Attribute, AuditLog, CategoryAttribute, CategoryStructureCheck,
                        ProductAttribute, PropertyRule, PropertyValue)
from app.property_service import structure_report

CATEGORY_ID = 432
CODE = "case_motherboard_fan_clearance_mm"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with SessionLocal() as db:
        attrs = list(db.scalars(select(Attribute).where(Attribute.code == CODE)))
        rules = list(db.scalars(select(PropertyRule).where(PropertyRule.code == CODE)))
        if not attrs and not rules:
            print("ALREADY ABSENT")
            return
        if len(attrs) != 1 or len(rules) != 1 or rules[0].category_id != CATEGORY_ID or \
                rules[0].attribute_id != attrs[0].id:
            raise RuntimeError("Unexpected field scope; no deletion")
        attr = attrs[0]
        links = list(db.scalars(select(CategoryAttribute).where(CategoryAttribute.attribute_id == attr.id)))
        product_count = db.scalar(select(func.count(ProductAttribute.id)).where(
            ProductAttribute.attribute_id == attr.id)) or 0
        value_count = db.scalar(select(func.count(PropertyValue.id)).where(
            PropertyValue.attribute_id == attr.id)) or 0
        if len(links) != 1 or links[0].category_id != CATEGORY_ID or product_count or value_count:
            raise RuntimeError(f"Field is used: links={len(links)}, products={product_count}, values={value_count}")
        print(f"REMOVE category={CATEGORY_ID} code={CODE} products=0 values=0")
        if not args.apply:
            print("DRY RUN: no writes")
            return
        check = db.get(CategoryStructureCheck, CATEGORY_ID)
        previous_research = (check.report or {}).get("research") if check else None
        db.delete(rules[0])
        db.delete(links[0])
        db.flush()
        db.delete(attr)
        db.flush()
        if check:
            report = structure_report(db, CATEGORY_ID)
            check.fingerprint = report["fingerprint"]
            check.report = {**report, **({"research": previous_research} if previous_research else {})}
            check.checked_at = datetime.now(timezone.utc)
        db.add(AuditLog(action="properties.case_fan_clearance_rule_removed",
                        object_type="category", object_id=str(CATEGORY_ID),
                        details={"code": CODE, "product_values_removed": 0}))
        db.commit()
        print("REMOVED")


if __name__ == "__main__":
    main()
