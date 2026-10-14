"""Summarize PC-relevant categories and identifier/price/stock field coverage."""
from collections import Counter
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'data/p1-catalog.json'
SUPPLIER_POLICY = ROOT / 'config/supplier-delivery.json'

FIELDS = ('skuOver', 'article', 'manufacturer', 'priceLoan', 'priceBonus',
          'priceSpecial', 'code1C', 'dealersData', 'guarantee',
          'quarantineStatus', 'isArchived')
CATEGORY_MAP = {
    'Процессоры': ('Процессоры',),
    'Материнские платы': ('Материнские платы',),
    'Оперативная память': ('Оперативная память',),
    'Видеокарты': ('Видеокарты',),
    'Блоки питания': ('Блоки питания',),
    'Корпуса': ('Корпуса',),
    'Жесткие диски 3.5" для ПК': ('Жесткие диски 3.5" (для ПК)',),
    'Твердотельные диски (SSD)': ('Твердотельные диски (SSD)',),
    'Кулеры для процессоров': ('Кулеры для процессоров',),
    'Системы водяного / жидкостного охлаждения (СЖО)': ('Системы водяного / жидкостного охлаждения (СЖО)',),
    'Охлаждение для корпусов ПК': ('Охлаждение для корпусов ПК',),
}


def present(product, field):
    value = product.get(field)
    if value is None or value == '' or value == []:
        return False
    # The owner confirmed that zero means the price was not calculated.
    if field.startswith('price') and value == 0:
        return False
    if isinstance(value, str) and not value.strip():
        return False
    return True


def has_positive_dealer_quantity(product, excluded_suppliers=()):
    data = product.get('dealersData')
    if not isinstance(data, list):
        return False
    excluded = {name.casefold() for name in excluded_suppliers}
    for dealer in data:
        parsed = parse_dealer_row(dealer)
        if parsed and parsed[0].casefold() not in excluded and parsed[1] > 0:
            return True
    return False


def all_dealer_quantities_positive(product, excluded_suppliers=()):
    data = product.get('dealersData')
    if not isinstance(data, list) or not data:
        return False
    excluded = {name.casefold() for name in excluded_suppliers}
    included = []
    for row in data:
        parsed = parse_dealer_row(row)
        if parsed is None:
            return False
        if parsed[0].casefold() not in excluded:
            included.append(parsed)
    if not included:
        return False
    for _, quantity in included:
        if quantity <= 0:
            return False
    return True


def parse_dealer_row(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r'\s*(.*?)\s*\(\s*(\d+)\s*\)\s*-\s*.+', value)
    if not match or not match.group(1).strip():
        return None
    return match.group(1).strip(), int(match.group(2))


def main():
    catalog = json.loads(CATALOG.read_text(encoding='utf-8-sig'))
    policy = json.loads(SUPPLIER_POLICY.read_text(encoding='utf-8'))
    excluded_suppliers = policy['availabilityPolicy']['excludedSupplierLabels']
    products = catalog['items']
    categories = Counter(product.get('category') or '(без категории)' for product in products)
    selected = {name: [actual for actual in names if actual in categories]
                for name, names in CATEGORY_MAP.items()}
    found = {actual for names in selected.values() for actual in names}
    missing = [name for name, names in selected.items() if not names]
    matches = [product for product in products if product.get('category') in found]
    available = [product for product in matches if has_positive_dealer_quantity(product, excluded_suppliers)]
    all_suppliers_available = [product for product in matches if all_dealer_quantities_positive(product, excluded_suppliers)]
    priced_available = [product for product in available if present(product, 'priceLoan')]
    print(f"Catalog: {len(products)} products; {len(categories)} categories")
    print(f"Owner-selected PC parts: {len(matches)} products; {len(found)}/{len(selected)} categories found")
    print(f"At least one supplier has quantity > 0: {len(available)} products")
    print(f"Every listed supplier has quantity > 0: {len(all_suppliers_available)} products")
    print(f"Available and priceLoan is nonzero: {len(priced_available)} products")
    print(f"Available but priceLoan is null/zero: {len(available) - len(priced_available)} products")
    if missing:
        print('Categories not found in p1:', ', '.join(missing))
    if matches:
        print('Core field coverage:', ' '.join(
            f"{field}={sum(present(row, field) for row in matches)}/{len(matches)}"
            for field in FIELDS
        ))
    supplier_products = {}
    malformed_dealer_rows = 0
    products_with_dealer_rows = 0
    excluded_supplier_keys = {name.casefold() for name in excluded_suppliers}
    for product in matches:
        rows = product.get('dealersData')
        if not isinstance(rows, list) or not rows:
            continue
        products_with_dealer_rows += 1
        for row in rows:
            parsed = parse_dealer_row(row)
            if parsed is None:
                malformed_dealer_rows += 1
                continue
            supplier, quantity = parsed
            if supplier.casefold() in excluded_supplier_keys:
                continue
            stats = supplier_products.setdefault(supplier, {'products': set(), 'in_stock': set(), 'rows': 0, 'per_product_rows': Counter()})
            sku = product.get('skuOver')
            stats['products'].add(sku)
            stats['rows'] += 1
            stats['per_product_rows'][sku] += 1
            if quantity > 0:
                stats['in_stock'].add(sku)
    for requested, actual_names in selected.items():
        count = sum(categories[name] for name in actual_names)
        rows = [product for product in products if product.get('category') in actual_names]
        coverage = ' '.join(f"{field}={sum(present(row, field) for row in rows)}/{len(rows)}" for field in FIELDS)
        stocked = sum(has_positive_dealer_quantity(row, excluded_suppliers) for row in rows)
        priced_stocked = sum(has_positive_dealer_quantity(row, excluded_suppliers) and present(row, 'priceLoan') for row in rows)
        print(f"{requested}\t{count}\tstock>0={stocked}\tstock+priceLoan={priced_stocked}\t{coverage}")
    print(f"Products with dealer rows: {products_with_dealer_rows}/{len(matches)}; malformed dealer rows: {malformed_dealer_rows}")
    print(f"Distinct supplier labels: {len(supplier_products)}")
    print('Supplier\tproducts\tproducts with quantity > 0\tdealer rows\tproducts with multiple rows')
    for supplier, stats in sorted(supplier_products.items(), key=lambda item: (-len(item[1]['in_stock']), item[0].casefold())):
        multiple = sum(count > 1 for count in stats['per_product_rows'].values())
        print(f"{supplier}\t{len(stats['products'])}\t{len(stats['in_stock'])}\t{stats['rows']}\t{multiple}")
    all_fields = sorted({key for product in products for key in product})
    print('Fields:', ', '.join(all_fields))
    print('Excluded stock labels:', ', '.join(excluded_suppliers))
    print('Price values, stock quantities and credentials are intentionally omitted.')


if __name__ == '__main__':
    main()
