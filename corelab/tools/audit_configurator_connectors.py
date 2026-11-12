"""Read-only inventory of connector parsing and other PC builder list fields."""
from collections import Counter, defaultdict
from sqlalchemy import select

from app.connector_inventory import CONNECTOR_CODES, normalize_connector_inventory
from app.db import SessionLocal
from app.models import Attribute, Product, ProductAttribute


with SessionLocal() as db:
    rows = db.execute(select(ProductAttribute.product_id, Attribute.code,
                             ProductAttribute.value_string, ProductAttribute.value_json)
                      .join(Attribute, Attribute.id == ProductAttribute.attribute_id)
                      .where(Attribute.code.in_(CONNECTOR_CODES)))
    tally = defaultdict(Counter)
    errors = defaultdict(Counter)
    for product_id, code, string, value_json in rows:
        value = value_json if value_json is not None else string
        if value is None:
            continue
        tally[code]['total'] += 1
        if isinstance(value, list) and all(isinstance(item, dict) for item in value):
            tally[code]['structured'] += 1
            continue
        try:
            normalize_connector_inventory(code, value)
            tally[code]['parsable'] += 1
        except ValueError as exc:
            tally[code]['review'] += 1
            errors[code][str(exc) + ': ' + str(value)[:100]] += 1
    for code in sorted(CONNECTOR_CODES):
        print(code, dict(tally[code]))
        for message, count in errors[code].most_common(8):
            print('  ', count, message)
    print('ELIGIBLE PSU CABLE FACTS')
    rows = db.execute(select(Product, ProductAttribute).join(ProductAttribute,
        ProductAttribute.product_id == Product.id).join(Attribute,
        Attribute.id == ProductAttribute.attribute_id).where(
        Attribute.code == 'psu_pcie_connectors', Product.validity_check.is_(True)))
    for product, value in rows:
        print(product.id, product.name[:75],
              [(entry['kind'], entry['count'], entry.get('cables'))
               for entry in value.value_json or []], value.source_url)
