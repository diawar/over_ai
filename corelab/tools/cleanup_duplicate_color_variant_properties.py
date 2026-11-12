"""Remove duplicated model-wide cooler fields from reviewed white variants.

This one-time correction keeps the shared specification on the black base
variant and leaves only the per-variant color on the white product.
Values are removed only when their source_url matches the reviewed batch URL.
"""
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Attribute, AuditLog, Product, ProductAttribute
from app.validity import revalidate_product

TARGETS = {
    1903: {
        "manufacturer": "Ocypus",
        "article": "Iota-A40-WH2NNWD00X-GL",
        "source_url": "https://www.ocypus.com/specification/cooling/iota-a40-dual-fan--1.html",
        "expected_codes": {
            "cooler_fan_connectors", "cpu_cooler_fan_count",
            "cpu_cooler_fan_noise_dba", "cpu_cooler_tdp_w", "cpu_cooler_type",
        },
    },
    4907: {
        "manufacturer": "Montech",
        "article": "NX400-ARGB-W",
        "source_url": "https://www.montechpc.com/nx400-argb",
        "expected_codes": {
            "cooler_fan_connectors", "cooling_lighting_connectors",
            "cpu_cooler_fan_count", "cpu_cooler_fan_noise_dba", "cpu_cooler_type",
        },
    },
    4909: {
        "manufacturer": "Montech",
        "article": "NX600-ARGB-W",
        "source_url": "https://www.montechpc.com/nx600-argb",
        "expected_codes": {
            "cooler_fan_connectors", "cooling_lighting_connectors",
            "cpu_cooler_fan_count", "cpu_cooler_fan_noise_dba", "cpu_cooler_type",
        },
    },
}


def value_snapshot(row):
    return {
        "value_state": row.value_state,
        "value_string": row.value_string,
        "value_number": str(row.value_number) if row.value_number is not None else None,
        "value_boolean": row.value_boolean,
        "value_json": row.value_json,
        "source_kind": row.source_kind,
        "source_url": row.source_url,
    }


def main():
    with SessionLocal() as db:
        changes = []
        for product_id, target in TARGETS.items():
            product = db.get(Product, product_id)
            if product is None or product.manufacturer != target["manufacturer"] or \
                    product.manufacturer_article != target["article"]:
                raise RuntimeError(f"Product identity changed for {product_id}")
            rows = db.scalars(select(ProductAttribute).join(Attribute,
                Attribute.id == ProductAttribute.attribute_id).where(
                    ProductAttribute.product_id == product_id,
                    ProductAttribute.source_url == target["source_url"],
                    Attribute.code.in_(target["expected_codes"]))).all()
            codes = {db.get(Attribute, row.attribute_id).code for row in rows}
            if codes != target["expected_codes"]:
                raise RuntimeError(f"Expected exact batch fields for {product_id}; got {sorted(codes)}")
            changes.append((product, rows))

        for product, rows in changes:
            removed = []
            for row in rows:
                code = db.get(Attribute, row.attribute_id).code
                removed.append({"code": code, **value_snapshot(row)})
                db.delete(row)
            db.add(AuditLog(action="properties.color_variant_duplicate_cleanup",
                object_type="product", object_id=str(product.id), details={
                    "kept_variant_color": "Белый",
                    "removed_batch_source_values": removed,
                    "reason": "User instruction: for an alternate color of the same model, record only the color difference.",
                }))
            revalidate_product(db, product)
        db.commit()
        print(f"CLEANED: {sum(len(rows) for _, rows in changes)} duplicate values from "
              f"{len(changes)} white variants; audit entries recorded.")


if __name__ == "__main__":
    main()
