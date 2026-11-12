"""Assemble locally reviewed motherboard evidence for the no-API loader."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'data'
OUTPUT = Path(__file__).with_name('motherboard-properties-evidence-2026-10-25.json')


def main():
    products = {}
    for path in sorted(DATA.glob('official-*.json')):
        try:
            rows = json.loads(path.read_text(encoding='utf-8')).get('products', [])
        except (OSError, json.JSONDecodeError):
            continue
        for row in rows:
            if row.get('category_id') != 359 or not isinstance(row.get('product_id'), int):
                continue
            if not isinstance(row.get('values'), dict) or not row['values']:
                continue
            product_id = row['product_id']
            current = products.get(product_id)
            if current is None:
                current = {key: row[key] for key in (
                    'product_id', 'category_id', 'manufacturer', 'article', 'official_model',
                    'source_url', 'checked_at', 'source_kind', 'official_unavailable', 'reviewed_by'
                ) if key in row}
                current['values'] = {}
                products[product_id] = current
            elif (current.get('manufacturer', '').casefold() != row.get('manufacturer', '').casefold() or
                  current.get('article', '').casefold() != row.get('article', '').casefold()):
                raise RuntimeError(f'Conflicting exact identity for motherboard {product_id}')
            for code, value in row['values'].items():
                if code in current['values'] and current['values'][code] != value:
                    raise RuntimeError(f'Conflicting reviewed value for motherboard {product_id}: {code}')
                current['values'][code] = value
            if row.get('checked_at', '') > current.get('checked_at', ''):
                for key in ('official_model', 'source_url', 'checked_at', 'source_kind',
                            'official_unavailable', 'reviewed_by'):
                    if key in row:
                        current[key] = row[key]

    rows = sorted(products.values(), key=lambda row: row['product_id'])
    OUTPUT.write_text(json.dumps({'products': rows}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    codes = sorted({code for row in rows for code in row['values']})
    print(f'CREATED {OUTPUT.name}: {len(rows)} exact motherboard models, {len(codes)} distinct properties')
    print('CODES ' + ', '.join(codes))


if __name__ == '__main__':
    main()
