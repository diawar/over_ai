"""List required selection rules that are neither compared nor explicitly soft."""
import re
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Attribute, Category, CategoryAttribute, PropertyRule


source = Path('/tmp/pc-builder.cjs').read_text(encoding='utf-8')
handled = set()
for name in ('CHECKED_ATTRIBUTES', 'NON_BLOCKING_ATTRIBUTES'):
    block = re.search(rf'const {name} = new Set\(\[([\s\S]*?)\]\)', source)
    if not block:
        raise RuntimeError(f'{name} not found')
    handled.update(re.findall(r"'([a-z][a-z0-9_]+)'", block.group(1)))

with SessionLocal() as db:
    rows = db.execute(select(Category.name, Attribute.code).join(
        CategoryAttribute, CategoryAttribute.category_id == Category.id).join(
        Attribute, Attribute.id == CategoryAttribute.attribute_id).where(
        Category.organization_id == 1,
        Category.selection_category.is_(True),
        CategoryAttribute.required_for_selection.is_(True))).all()
    missing = sorted((category, code) for category, code in rows if code not in handled)
    for category, code in missing:
        print(f'{category}: {code}')
    print(f'UNHANDLED {len(missing)}')
