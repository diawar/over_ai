"""Add the verified-data fields consumed by the PC configurator; no API key."""
import argparse
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, CategoryStructureCheck, PropertyRule
from app.property_engine import RuleDefinition
from app.property_service import attach_rule, structure_report
from app.validity import lock_validation, revalidate_category


RULES = {
    44: [
        ("cpu_tdp_w", "Тепловыделение (TDP)", "number", "W"),
        ("cpu_max_turbo_power_w", "Максимальная мощность Turbo", "number", "W"),
        ("cpu_series", "Серия процессора для проверки совместимости", "string", None),
    ],
    359: [
        ("motherboard_supported_cpu_series", "Поддерживаемые серии процессоров", "list", None),
        ("motherboard_dimensions_mm", "Размеры платы", "string", "mm"),
        ("motherboard_dimensions_reported", "Размеры платы подтверждены производителем", "boolean", None),
    ],
    432: [
        ("case_preinstalled_fans", "Предустановленные вентиляторы и расположение", "string", None),
    ],
    146: [
        ("psu_pcie_6plus2_count", "Разъёмы PCIe 6+2 pin", "integer", None),
        ("psu_connector12v2x6_count", "Разъёмы 12V-2x6", "integer", None),
    ],
    246: [
        ("cpu_cooler_tdp_w", "Заявленная тепловая мощность СЖО (TDP)", "number", "W"),
    ],
    437: [
        ("cpu_cooler_tdp_w", "Заявленная тепловая мощность кулера (TDP)", "number", "W"),
        ("cpu_cooler_type", "Конструкция кулера", "string", None),
    ],
}

REQUIRED_SELECTION = {
}
OPTIONAL_SELECTION = {
    146: {"psu_pcie_6plus2_count", "psu_connector12v2x6_count"},
    246: {"cpu_cooler_tdp_w"},
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with SessionLocal() as db:
        additions = []
        updates = []
        for category_id, specs in RULES.items():
            existing = {r.code: r for r in db.scalars(select(PropertyRule).where(
                PropertyRule.category_id == category_id, PropertyRule.source == "internal",
                PropertyRule.active.is_(True)))}
            for code, label, value_type, unit in specs:
                if code in existing:
                    row = existing[code]
                    if code in REQUIRED_SELECTION.get(category_id, set()) and not row.definition.get("required_for_selection"):
                        definition = RuleDefinition.model_validate({**row.definition,
                            "level": "required", "required_for_selection": True})
                        updates.append((category_id, definition, row))
                        print(f"REQUIRE category={category_id} code={code}")
                    elif code in OPTIONAL_SELECTION.get(category_id, set()) and row.definition.get("required_for_selection"):
                        definition = RuleDefinition.model_validate({**row.definition,
                            "level": "recommended", "required_for_selection": False})
                        updates.append((category_id, definition, row))
                        print(f"RELEASE category={category_id} code={code}")
                    else:
                        print(f"EXISTS category={category_id} code={code}")
                    continue
                required = code in REQUIRED_SELECTION.get(category_id, set())
                additions.append((category_id, RuleDefinition(
                    code=code, label=label, source="internal", level="required" if required else "recommended",
                    value_type=value_type, unit=unit,
                    minimum=(1 if code == "cpu_cooler_tdp_w" else 0)
                    if value_type in ("number", "integer") else None,
                    required_for_selection=required)))
                print(f"ADD category={category_id} code={code} required={required}")
        if not args.apply:
            print(f"DRY RUN: {len(additions)} additions, {len(updates)} updates, no writes")
            return
        lock_validation(db)
        for category_id, rule in additions:
            attach_rule(db, category_id, rule)
        for category_id, rule, existing in updates:
            attach_rule(db, category_id, rule, existing=existing)
        db.flush()
        affected_categories = {category_id for category_id, _, _ in updates}
        for category_id in affected_categories:
            revalidate_category(db, category_id)
            check = db.get(CategoryStructureCheck, category_id)
            previous_research = (check.report or {}).get("research") if check else None
            report = structure_report(db, category_id)
            if check is None:
                check = CategoryStructureCheck(category_id=category_id,
                                               fingerprint=report["fingerprint"], report={})
                db.add(check)
            check.fingerprint = report["fingerprint"]
            check.report = {**report, **({"research": previous_research} if previous_research else {})}
            check.checked_at = datetime.now(timezone.utc)
        db.add(AuditLog(action="properties.configurator_rules_added", object_type="category",
                        object_id=",".join(map(str, RULES)),
                        details={"added": [r.code for _, r in additions],
                                 "updated": [r.code for _, r, _ in updates]}))
        db.commit()
        print(f"SAVED: {len(additions)} additions, {len(updates)} updates")


if __name__ == "__main__":
    main()
