"""One-time, idempotent official-source fill for CoreLab product 22592."""
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (Attribute, AuditLog, CategoryAttribute, CategoryStructureCheck,
                        Product, ProductAttribute, PropertyRule)
from app.property_engine import RuleDefinition, normalize
from app.property_service import definition, has_technical_values, structure_report
from app.validity import lock_validation, revalidate_product


PRODUCT_ID = 22592
CATEGORY_ID = 17
ARTICLE = "NE65050019P1-GB2070F"
SOURCE = "https://www.palit.com/palit/vgapro.php?id=5695&lang=en&pn=NE65050019P1-GB2070F&tab=sp"
OVERVIEW = "https://www.palit.com/palit/vgapro.php?id=5695&lang=en&pn=NE65050019P1-GB2070F&tab=ov"
VALUES = {
    "gpu_board_power_w": 130,
    "gpu_graphics_processor": "GeForce RTX 5050",
    "gpu_length_mm": 169.9,
    "gpu_memory_bus_bit": 128,
    "gpu_memory_gb": 8,
    "gpu_memory_type": "GDDR6",
    "gpu_pcie_interface": "PCI-E 5.0",
    "gpu_power_connectors": ["8-pin x 1"],
    "gpu_recommended_psu_w": 550,
    "gpu_slot_width": 2,
}
DESCRIPTION = ("Palit GeForce RTX 5050 StormX — компактная видеокарта с 8 ГБ памяти GDDR6 "
               "и интерфейсом PCI-E 5.0. Длина 169,9 мм, толщина 2 слота, энергопотребление "
               "130 Вт. Для системы рекомендован блок питания мощностью 550 Вт.")


def main():
    with SessionLocal() as db:
        lock_validation(db)
        product = db.scalar(select(Product).where(Product.id == PRODUCT_ID).with_for_update())
        if product is None or product.manufacturer.casefold() != "palit" or product.manufacturer_article != ARTICLE:
            raise RuntimeError("Точная модель товара изменилась; запись отменена")
        if [category.id for category in product.categories] != [CATEGORY_ID]:
            raise RuntimeError("Категория товара изменилась; запись отменена")
        if has_technical_values(db, PRODUCT_ID):
            raise RuntimeError("Технические свойства уже заполнены; запись отменена")

        report = structure_report(db, CATEGORY_ID)
        if report["structure_status"] != "success":
            raise RuntimeError("Структура категории содержит ошибки; запись отменена")
        check = db.get(CategoryStructureCheck, CATEGORY_ID)
        if check is None:
            check = CategoryStructureCheck(category_id=CATEGORY_ID)
            db.add(check)
        research = (check.report or {}).get("research") if isinstance(check.report, dict) else None
        check.fingerprint = report["fingerprint"]
        check.report = {**report, **({"research": research} if research else {})}
        check.checked_at = datetime.now(timezone.utc)
        db.flush()
        report = structure_report(db, CATEGORY_ID)
        if not report["current"] or report["structure_status"] != "success":
            raise RuntimeError("Структура не прошла проверку для загрузки")

        rules = {row.code: row for row in db.scalars(select(PropertyRule).where(
            PropertyRule.category_id == CATEGORY_ID, PropertyRule.source == "internal",
            PropertyRule.active.is_(True)))}
        if set(rules) != set(VALUES):
            raise RuntimeError("Список свойств категории изменился; запись отменена")
        saved = []
        for code, raw in VALUES.items():
            row = rules[code]
            rule = RuleDefinition.model_validate(definition(row))
            link = db.get(CategoryAttribute, (CATEGORY_ID, row.attribute_id))
            if rule.ai_blocked or link is None or link.ai_blocked:
                raise RuntimeError(f"Свойство {code} заблокировано; запись отменена")
            value = normalize(raw, rule)
            item = ProductAttribute(product_id=PRODUCT_ID, attribute_id=row.attribute_id,
                                    value_state="known", source_kind="manufacturer_site", source_url=SOURCE,
                                    updated_at=datetime.now(timezone.utc))
            if rule.value_type in ("number", "integer"):
                item.value_number = value
            elif rule.value_type == "list":
                item.value_json = value
            else:
                item.value_string = value
            db.add(item)
            saved.append(code)

        for code, raw, source in (("description", DESCRIPTION, OVERVIEW),
                                  ("product_length_cm", 16.99, SOURCE)):
            rule_row = db.scalar(select(PropertyRule).where(PropertyRule.scope == "global",
                PropertyRule.source == "gmc", PropertyRule.code == code, PropertyRule.active.is_(True)))
            if rule_row is None or definition(rule_row)["ai_blocked"]:
                continue
            rule = RuleDefinition.model_validate(definition(rule_row))
            value = normalize(raw, rule)
            attr = db.scalar(select(Attribute).where(Attribute.code == code))
            if attr is None:
                attr = Attribute(code=code, label=rule.label, value_type=rule.value_type,
                                 unit=rule.unit, normalization=rule.normalization)
                db.add(attr)
                db.flush()
            if attr.value_type != rule.value_type or attr.unit != rule.unit:
                raise RuntimeError(f"Тип поля {code} изменился; запись отменена")
            if db.scalar(select(ProductAttribute.id).where(ProductAttribute.product_id == PRODUCT_ID,
                         ProductAttribute.attribute_id == attr.id).limit(1)):
                continue
            item = ProductAttribute(product_id=PRODUCT_ID, attribute_id=attr.id,
                                    value_state="known", source_kind="ai_official" if code == "description" else "manufacturer_site",
                                    source_url=source, updated_at=datetime.now(timezone.utc))
            if rule.value_type == "number":
                item.value_number = value
            else:
                item.value_string = value
            db.add(item)
            saved.append(code)

        revalidate_product(db, product)
        db.add(AuditLog(action="properties.official_verified_fill", object_type="product",
                        object_id=str(PRODUCT_ID), details={"category_id": CATEGORY_ID,
                        "manufacturer_article": ARTICLE, "property_codes": saved,
                        "source_urls": [SOURCE, OVERVIEW], "checked_at": datetime.now(timezone.utc).isoformat()}))
        db.commit()
        print(f"Saved {len(saved)} properties for product {PRODUCT_ID}: {', '.join(saved)}")


if __name__ == "__main__":
    main()
