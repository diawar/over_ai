"""Build offline loader input from already reviewed exact-model evidence.

Only explicit WHITE/SNOW/БЕЛЫЙ names are accepted. No catalog-title guessing,
network access, or AI research is performed here. Products without an explicit
color in reviewed evidence remain unknown and are excluded from white builds.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'data'
OUTPUT = Path(__file__).with_name('component-color-evidence-2026-10-25.json')
CATEGORIES = {17, 146, 253, 359, 432, 437, 246, 442}
WHITE = re.compile(r'(?<![a-z])(?:white|snow)(?![a-z])|бел(?:ый|ая|ое|ые|ого|ую|ым|ом|ых)?', re.I)
SUPPLEMENTAL = [{
    'product_id': 31001, 'category_id': 359, 'manufacturer': 'ASRock',
    'article': 'Z890 PRO RS WIFI WHITE', 'official_model': 'ASRock Z890 Pro RS WiFi White',
    'source_url': 'https://www.asrock.com/mb/Intel/Z890%20Pro%20RS%20WiFi%20White/',
    'checked_at': '2026-10-25', 'values': {}
}, {
    'product_id': 3580, 'category_id': 359, 'manufacturer': 'Gigabyte',
    'article': 'B650M AORUS ELITE AX ICE',
    'official_model': 'Материнская плата Gigabyte B650M AORUS ELITE AX ICE',
    'source_url': 'https://www.gigabyte.com/us/press/news/2119',
    'checked_at': '2026-10-25', 'values': {}
}, {
    'product_id': 6070, 'category_id': 359, 'manufacturer': 'MSI',
    'article': 'MPG X870I EDGE TI EVO WIFI',
    'official_model': 'Материнская плата MSI MPG X870I EDGE TI EVO WIFI',
    'source_url': 'https://www.msi.com/Motherboard/MPG-X870I-EDGE-TI-EVO-WIFI',
    'checked_at': '2026-10-25', 'values': {}
}, {
    'product_id': 11511, 'category_id': 359, 'manufacturer': 'ASUS',
    'article': 'ROG STRIX X870E-A GAMING NEO',
    'official_model': 'ROG STRIX X870E-A GAMING WIFI7 NEO',
    'source_url': 'https://rog.asus.com/us/motherboards/rog-strix/rog-strix-x870e-a-gaming-wifi7-neo/',
    'checked_at': '2026-10-25', 'values': {}
}]


def main():
    reviewed = {}
    for path in sorted(DATA.glob('official-*.json')):
        try:
            products = json.loads(path.read_text(encoding='utf-8')).get('products', [])
        except (OSError, json.JSONDecodeError):
            continue
        for row in products:
            if row.get('category_id') not in CATEGORIES:
                continue
            identity = ' '.join(str(row.get(field) or '') for field in
                                ('article', 'official_model', 'source_title'))
            if not WHITE.search(identity) or not row.get('source_url') or not row.get('checked_at'):
                continue
            current = reviewed.get(row['product_id'])
            if current is None or row['checked_at'] > current['checked_at']:
                reviewed[row['product_id']] = row

    for row in SUPPLEMENTAL:
        reviewed[row['product_id']] = row

    output = []
    for row in sorted(reviewed.values(), key=lambda item: (item['category_id'], item['product_id'])):
        output.append({key: row[key] for key in (
            'product_id', 'category_id', 'manufacturer', 'article', 'official_model',
            'source_url', 'checked_at', 'source_kind', 'official_unavailable', 'reviewed_by'
        ) if key in row} | {'values': {'component_color': 'Белый'}})
    document = {'products': output}
    OUTPUT.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    by_category = {}
    for row in output:
        by_category[row['category_id']] = by_category.get(row['category_id'], 0) + 1
    print(f'CREATED {OUTPUT.name}: {len(output)} exact-model rows; category counts={by_category}')


if __name__ == '__main__':
    main()
