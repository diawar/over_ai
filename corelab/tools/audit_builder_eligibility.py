"""Read-only eligibility counts for categories touched by connector migration."""
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Category, Product


with SessionLocal() as db:
    for category_id in (359, 432, 442, 146):
        category = db.get(Category, category_id)
        products = list(db.scalars(select(Product).join(Product.categories).where(
            Category.id == category_id)))
        eligible = [row for row in products if row.validity_check]
        print(category_id, category.name, 'catalog', len(products), 'eligible', len(eligible))
        if category_id in (359, 432):
            print('  eligible IDs:', sorted(row.id for row in eligible))
