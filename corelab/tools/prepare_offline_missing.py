"""Prepare missing values from local reviewed cooling evidence; no AI or network.

Writes a candidate file for the normal loader. Conflicting values, corrupted
text and rejected values remain in the report and are never guessed.
"""
import json
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

from sqlalchemy import select
from app.db import SessionLocal
from app.models import Attribute, ProductAttribute, Product, PropertyRule
from load_official_category_properties import prepare


def main():
    choices = defaultdict(list)
    rejected = []
    with SessionLocal() as db:
        states = {(pid, code): state for pid, code, state in db.execute(
            select(ProductAttribute.product_id, Attribute.code, ProductAttribute.value_state)
            .join(Attribute))}
        identities = {p.id: p for p in db.scalars(select(Product).where(
            Product.organization_id == 1, Product.status == 'active',
            Product.is_archived.is_not(True), Product.selection_enabled.is_(True)))}
        for path in sorted(Path('/evidence').glob('offline-core-cooling-properties-*.json')):
            for row in json.loads(path.read_text(encoding='utf-8-sig')).get('products', []):
                pid = row['product_id']
                if pid not in identities:
                    continue
                for code, raw in row.get('values', {}).items():
                    if states.get((pid, code)) in ('known', 'not_applicable'):
                        continue
                    if row.get('checked_at', '') > date.today().isoformat():
                        rejected.append([pid, code, path.name, 'future review date'])
                        continue
                    encoded = json.dumps(raw, ensure_ascii=False)
                    if any(mark in encoded for mark in ('Рџ', 'Рѕ', 'СЂ', 'Г—', '\ufffd')):
                        rejected.append([pid, code, path.name, 'corrupted text'])
                        continue
                    candidate = dict(row, values={code: raw})
                    try:
                        prepared = prepare(db, {'products': [candidate]}, fill_missing=True)
                        if prepared:
                            normalized = prepared[0][3][0][1]
                            choices[(pid, code)].append((candidate, normalized, path.name))
                    except Exception as exc:
                        rejected.append([pid, code, path.name, str(exc)])
        products = {}
        conflicts = []
        for (pid, code), entries in choices.items():
            distinct = {json.dumps(norm, sort_keys=True, ensure_ascii=False) for _, norm, _ in entries}
            if len(distinct) != 1:
                conflicts.append([pid, code, [name for _, _, name in entries]])
                continue
            row, _, filename = max(entries, key=lambda e: e[0]['checked_at'])
            target = products.setdefault(pid, dict(row, values={}, value_sources={}, evidence_files=[]))
            target['values'][code] = row['values'][code]
            target['value_sources'][code] = row.get('value_sources', {}).get(code, row['source_url'])
            target['checked_at'] = min(target['checked_at'], row['checked_at'])
            target['evidence_files'].append(filename)
        document = {'products': list(products.values())}
        # Validate the complete batch, including duplicate identities, before export.
        prepared = prepare(db, document, fill_missing=True)
        counts = Counter(str(cat.id) for _, _, cat, _ in prepared)
    Path('/tmp/offline-missing-candidates.json').write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report = {'products': len(prepared), 'properties': sum(len(v) for _, _, _, v in prepared),
              'categories': dict(counts), 'conflicts': conflicts, 'rejected': rejected}
    Path('/tmp/offline-missing-report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
