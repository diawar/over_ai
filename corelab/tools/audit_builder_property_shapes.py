"""Read-only scan for compound and duplicate list entries used by the builder."""
import re
from collections import Counter, defaultdict
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Attribute, ProductAttribute


source = Path('/tmp/pc-builder.cjs').read_text(encoding='utf-8')
block = re.search(r'const CHECKED_ATTRIBUTES = new Set\(\[(.*?)\]\)', source, re.S)
codes = set(re.findall(r"'([a-z][a-z0-9_]+)'", block.group(1)))
with SessionLocal() as db:
    rows = db.execute(select(ProductAttribute.product_id, Attribute.code,
                             ProductAttribute.value_json).join(Attribute).where(
                             Attribute.code.in_(codes), Attribute.value_type == 'list',
                             ProductAttribute.value_state == 'known'))
    counts = defaultdict(Counter)
    examples = defaultdict(list)
    for product_id, code, value in rows:
        counts[code]['products'] += 1
        if not isinstance(value, list):
            counts[code]['non_list'] += 1
            continue
        if len({str(entry) for entry in value}) != len(value):
            counts[code]['duplicate_entries'] += 1
            if len(examples[code]) < 2:
                examples[code].append((product_id, value))
        if any(isinstance(entry, str) and re.search(r'\b\d+\s*[x×]\s*\d+\b|[;/]', entry)
               for entry in value):
            counts[code]['compound_text'] += 1
            if len(examples[code]) < 2:
                examples[code].append((product_id, value))
    for code in sorted(counts):
        print(code, dict(counts[code]))
        for product_id, value in examples[code]:
            print('  ', product_id, str(value)[:250])
