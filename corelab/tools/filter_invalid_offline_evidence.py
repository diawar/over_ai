"""Keep only reviewed evidence for products currently blocked from selection.

Runs inside the backend container and makes no network or API calls. The
official category loader performs its own exact identity, source, rule and
normalization checks before any values can be written.
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import Category, Product, ProductSourceLink, SupplierOffer


def active_offers(db, product_id):
    return db.scalar(select(func.count(SupplierOffer.id)).join(ProductSourceLink,
        ProductSourceLink.offer_id == SupplierOffer.id).where(
        ProductSourceLink.product_id == product_id, SupplierOffer.is_current.is_(True),
        SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0)) or 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', default='/tmp/official-properties-merged-current.json')
    parser.add_argument('--supplemental', action='append', default=[],
                        help='additional locally reviewed JSON evidence file')
    parser.add_argument('--output', default='/tmp/invalid-products-evidence.json')
    args = parser.parse_args()
    documents = [json.loads(Path(path).read_text(encoding='utf-8'))
                 for path in [args.input, *args.supplemental]]
    evidence = defaultdict(list)
    for document in documents:
        for row in document.get('products', []):
            if isinstance(row, dict) and isinstance(row.get('product_id'), int):
                evidence[row['product_id']].append(row)

    counts = Counter()
    output = []
    with SessionLocal() as db:
        invalid = db.execute(select(Product, Category).join(Product.categories).where(
            Product.organization_id == 1, Product.validity_check.is_(False),
            Product.status == 'active', Product.is_archived.is_not(True),
            Product.selection_enabled.is_(True))).all()
        for product, category in invalid:
            if len(product.categories) != 1 or product.categories[0].id != category.id:
                counts[f'{category.id}:multiple_categories'] += 1
                continue
            if active_offers(db, product.id) == 0:
                counts[f'{category.id}:no_current_offer'] += 1
                continue
            counts[f'{category.id}:invalid_eligible'] += 1
            matches = [row for row in evidence.get(product.id, [])
                       if row.get('category_id') == category.id and
                       (row.get('manufacturer') or '').casefold() == (product.manufacturer or '').casefold() and
                       (row.get('article') or '').casefold() == (product.manufacturer_article or '').casefold() and
                       isinstance(row.get('values'), dict) and row['values'] and
                       isinstance(row.get('source_url'), str) and row.get('checked_at')]
            if not matches:
                counts[f'{category.id}:no_exact_local_evidence'] += 1
                continue
            # The loader stores one source URL per product. Prefer the single
            # reviewed page with the broadest set of properties, then newest review.
            chosen = max(matches, key=lambda row: (len(row['values']), row['checked_at'], row['source_url']))
            output.append(chosen)
            counts[f'{category.id}:evidence_candidates'] += 1

    output.sort(key=lambda row: (row['category_id'], row['product_id']))
    Path(args.output).write_text(json.dumps({'products': output}, ensure_ascii=False, indent=2) + '\n',
                                 encoding='utf-8')
    totals = Counter()
    for key, value in counts.items():
        category, state = key.split(':', 1)
        totals[state] += value
    print(f'INVALID_ELIGIBLE={totals["invalid_eligible"]}')
    print(f'LOCAL_EXACT_EVIDENCE_CANDIDATES={totals["evidence_candidates"]}')
    print(f'NO_EXACT_LOCAL_EVIDENCE={totals["no_exact_local_evidence"]}')
    print(f'NO_CURRENT_OFFER={totals["no_current_offer"]}')
    print(f'PER_CATEGORY={dict(sorted(counts.items()))}')
    print(f'OUTPUT={args.output} ROWS={len(output)}')


if __name__ == '__main__':
    main()
