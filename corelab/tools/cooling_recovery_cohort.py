"""Read-only identities for offline cooling evidence export; no API calls."""
from sqlalchemy import select
from app.models import AuditLog, Product

CODES = {
    359: ['motherboard_fan_headers', 'motherboard_lighting_headers'],
    437: ['cooler_fan_connectors', 'cooling_lighting_connectors'],
    246: ['cooler_fan_connectors', 'aio_pump_connectors', 'cooling_lighting_connectors'],
}


def cohort(db, audit_id):
    migration = db.get(AuditLog, audit_id)
    if not migration or migration.action != 'properties.cooling_connectors_added':
        raise RuntimeError('Expected cooling connector migration audit')
    ids = [int(row.object_id) for row in db.scalars(select(AuditLog).where(
        AuditLog.created_at == migration.created_at, AuditLog.action == 'product.validity_changed'))
        if (row.details or {}).get('previous') is True and (row.details or {}).get('validity_check') is False]
    products = list(db.scalars(select(Product).where(Product.id.in_(ids)).order_by(Product.id)))
    for product in products:
        if product.organization_id != migration.organization_id or len(product.categories) != 1 or product.categories[0].id not in CODES:
            raise RuntimeError('Recovery cohort identity changed')
    return products
