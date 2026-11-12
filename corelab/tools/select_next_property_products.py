"""Read-only picker for the next 20 eligible, price-diverse products per category."""
from collections import defaultdict
import argparse
import json
from pathlib import Path

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import (AuditLog, Attribute, Category, CategoryAttribute, Product,
                        ProductAttribute, ProductSourceLink, PropertyRule,
                        SupplierOffer, product_categories)
from app.property_service import GLOBAL_FIELD_CODES, has_technical_values

DEFAULT_BATCH_SIZE = 2
parser = argparse.ArgumentParser(description='Select price-diverse exact models for offline property research.')
parser.add_argument('--batch-size', type=int, default=DEFAULT_BATCH_SIZE,
                    help='number of products to select per category (default: 2)')
args = parser.parse_args()
if args.batch_size < 1:
    parser.error('--batch-size must be at least 1')

# Exclude products that may be valid catalog records but do not belong in a
# practical desktop build sample (service parts, server gear, clearance stock,
# and conspicuously obsolete or non-PC products).
EXCLUDE = {
    17: r'GT\s*(?:210|220|240|710|730|1030)\b|\bN210\b|GTX\s*(?:750|950|960|970|980|1050|1060|1070|1080|1630)\b|RX\s*5\d{2}\b|RTX\s*PRO|RTX\s*A\d{3}|workstation|сервер|ai\s*pro|a400|dhahab',
    44: r'threadripper|threadripper\s*pro|athlon|celeron|pentium|xeon|server|сервер|workstation',
    146: r'3000\s*w|2000\s*w|server|сервер|workstation|redundant|pro\s*ws|уцен|витрин|б/у',
    246: r'workstation|server|сервер|уцен|витрин|б/у',
    253: r'для ноутбука|so[- ]?dimm|rdimm|registered|ecc|server|сервер|уцен|витрин|б/у',
    256: r'\bsas\b|\bexos\b|\benterprise\b|\bserver\b|сервер|\bmg\d{2}\b|\bhat\d{4}\b|2\.5\s*\(|(?:16|18|20|22|24)\s*tb|уцен|витрин|б/у',
    343: r'portable|портативн|studio display|dahua|npc|\b43[" ]',
    359: r'wrx90|trx50|threadripper|\bepyc\b|server|сервер|workstation|pro ws|p13r|d1500|919-s3551',
    432: r'tinker|fanless|безвентилятор|server|сервер|rackmount|rack\s*case|\b4u\b|workstation|\bdk07\b|уцен|витрин|б/у|^$',
    437: r'bracket|mount|креплен|кронштейн|\b4u\b|server|сервер|\b4677\b|\bsp3\b',
    442: r'no\s*name|без\s*бренда|разветвитель|splitter|fan\s*hub|40\s*[xх×]\s*40|50\s*[xх×]\s*50|60\s*[xх×]\s*60|70\s*[xх×]\s*70|уцен|витрин|б/у',
    458: r'enterprise|datacenter|\bdc\d+|\b7\.68\s*tb|\b8\s*tb|\b16\s*tb|\bserver\b|сервер|brain\s*sphere|\b80\s*gb|\b128\s*gb|уцен|витрин|б/у',
}
PRICE_CEILING = {
    17: 1_800_000, 44: 600_000, 146: 200_000, 246: 200_000,
    253: 600_000, 256: 500_000, 343: 550_000, 359: 350_000,
    432: 120_000, 437: 75_000, 442: 60_000, 458: 300_000,
}
PREFERRED_MANUFACTURERS = {
    17: {'MSI', 'ASUS', 'GIGABYTE', 'PALIT', 'PNY', 'INNO3D', 'SAPPHIRE', 'ZOTAC', 'ASROCK', 'XFX', 'POWERCOLOR', 'COLORFUL', 'MAXSUN'},
    44: {'AMD', 'INTEL'},
    146: {'PCCOOLER', 'COOLER MASTER', '1STPLAYER', 'GAMEMAX', 'GAMERSTORM', 'CHIEFTEC', 'HUNTKEY', 'AEROCOOL', 'ASUS', 'MONTECH', 'LIAN LI', 'SEASONIC', 'FSP', 'BE QUIET!', 'THERMALTAKE', 'MSI', 'DEEPCOOL', 'ZALMAN', 'CORSAIR'},
    246: {'ID-COOLING', 'PCCOOLER', 'DEEPCOOL', 'ARCTIC', 'COUGAR', 'LIAN LI', 'THERMALTAKE', 'ADATA', 'SAMA', 'BE QUIET!', 'MSI', 'ASUS', 'GIGABYTE', 'CORSAIR', 'NZXT', 'OCYPUS', 'ZALMAN', 'AEROCOOL'},
    253: {'AMD', 'GEIL', 'KINGSTON', 'LEXAR', 'PATRIOT', 'G.SKILL', 'CORSAIR', 'TEAM', 'APACER', 'TRANSCEND', 'SILICON POWER', 'CRUCIAL', 'HIKSEMI'},
    256: {'SEAGATE', 'WESTERN DIGITAL', 'TOSHIBA'},
    343: {'MSI', 'PHILIPS', 'AOC', 'ACER', 'LENOVO', 'LG', 'IIYAMA', 'ZOWIE', 'ASUS', 'BENQ', 'SAMSUNG', 'DELL'},
    359: {'ASUS', 'ASROCK', 'MSI', 'GIGABYTE', 'BIOSTAR', 'MAXSUN'},
    432: {'1STPLAYER', 'PCCOOLER', 'GAMEMAX', 'SHARKOON', 'FSP', 'DEEPCOOL', 'CORSAIR', 'LIAN LI', 'BE QUIET!', 'THERMALTAKE', 'ASUS', 'ZALMAN', 'COUGAR', 'MONTECH', 'OCYPUS', 'RAIJINTEK', 'HUNTKEY'},
    437: {'ID-COOLING', 'DEEPCOOL', 'PCCOOLER', 'THERMALTAKE', 'SAMA', 'OCYPUS', 'JONSBO', 'MONTECH', 'AEROCOOL', 'BE QUIET!', 'ARCTIC', 'NOCTUA', 'COUGAR', 'ZALMAN'},
    442: {'ID-COOLING', 'SAMA', 'DEEPCOOL', 'ARCTIC', 'GELID SOLUTIONS', 'PCCOOLER', 'GAMEMAX', 'OCYPUS', 'BE QUIET!', '1STPLAYER', 'NZXT', 'LIAN LI', 'THERMALTAKE', 'ASUS', 'CORSAIR', 'COUGAR'},
    458: {'KINGSTON', 'WESTERN DIGITAL', 'SAMSUNG', 'MSI', 'TEAM', 'TRANSCEND', 'PATRIOT', 'LEXAR', 'SILICON POWER', 'ADATA', 'APACER', 'NETAC', 'COLORFUL', 'HIKSEMI', 'CRUCIAL'},
}

with SessionLocal() as db:
    selected_products = []
    filled_category_ids = set()
    for audit in db.scalars(select(AuditLog).where(
            AuditLog.action == 'properties.verified_local_fill')):
        category_id = (audit.details or {}).get('category_id')
        if category_id is not None:
            filled_category_ids.add(int(category_id))
    categories = list(db.scalars(select(Category).where(
        Category.id.in_(EXCLUDE.keys())).order_by(Category.name)))
    current_offers = select(
        ProductSourceLink.product_id.label('product_id'),
        func.min(SupplierOffer.price).label('price'),
    ).join(SupplierOffer, ProductSourceLink.offer_id == SupplierOffer.id).where(
        SupplierOffer.is_current.is_(True), SupplierOffer.is_archived.is_not(True),
        SupplierOffer.price > 0,
    ).group_by(ProductSourceLink.product_id).subquery()
    for category in categories:
        has_rules = db.scalar(select(func.count(PropertyRule.id)).where(
            PropertyRule.category_id == category.id,
            PropertyRule.source == 'internal', PropertyRule.active.is_(True),
        )) or 0
        if not has_rules:
            continue
        candidates = list(db.execute(select(Product, current_offers.c.price).join(
            product_categories, product_categories.c.product_id == Product.id
        ).join(current_offers, current_offers.c.product_id == Product.id).where(
            product_categories.c.category_id == category.id,
            Product.status == 'active', Product.is_archived.is_not(True),
            Product.selection_enabled.is_(True),
            Product.manufacturer.is_not(None), Product.manufacturer != '',
            Product.manufacturer_article.is_not(None), Product.manufacturer_article != '',
            Product.id.in_(select(product_categories.c.product_id).group_by(
                product_categories.c.product_id).having(
                    func.count(product_categories.c.category_id) == 1)),
        ).order_by(current_offers.c.price, Product.id)))
        import re
        excluded = re.compile(EXCLUDE.get(category.id, r'(?!)'), re.IGNORECASE)
        candidates = [(product, price) for product, price in candidates
                      if not has_technical_values(db, product.id)
                      and price <= PRICE_CEILING.get(category.id, float('inf'))
                      and product.manufacturer.upper() in PREFERRED_MANUFACTURERS.get(category.id, set())
                      and not excluded.search(' '.join((product.name or '',
                                                       product.manufacturer or '',
                                                       product.manufacturer_article or '')))]
        target_count = args.batch_size
        take = min(target_count, len(candidates))
        indexes = [round(i * (len(candidates) - 1) / (take - 1))
                   for i in range(take)] if take > 1 else ([0] if take else [])
        print(f'\nCATEGORY\t{category.id}\t{category.name}\teligible={len(candidates)}\tselected={take}')
        for index in indexes:
            product, price = candidates[index]
            selected_products.append({
                'product_id': product.id, 'category_id': category.id,
                'sku': product.sku,
                'manufacturer': product.manufacturer,
                'article': product.manufacturer_article,
                'price': str(price), 'name': product.name,
            })
            print(f'{product.id}\t{product.manufacturer}\t{product.manufacturer_article}\t'
                  f'{price}\t{product.name}')
    Path('/tmp/selected-next-20.json').write_text(
        json.dumps({'products': selected_products}, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8')
    print(f'\nWROTE {len(selected_products)} product identities to /tmp/selected-next-20.json')
