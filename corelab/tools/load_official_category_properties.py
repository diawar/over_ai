"""Load reviewed exact-model properties from manufacturer or approved retail pages.

Run from the backend container with --evidence /evidence/<batch>.json.
The data and loader directories are mounted read-only by Docker Compose.
This script makes no network or AI calls.
For shop.kz, dns-shop.kz or technodom.kz evidence, set
"official_unavailable": true and "source_kind": "retailer_site" on that product.
Each product row must identify the exact manufacturer and article and include
the reviewed source URL and checked_at date.
User-directed defaults may use source_kind="user_default", source_url=null,
and source_note; these are stored as manual values without source attribution.
"""
import argparse
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import func, select

from app.db import SessionLocal
from app.ai_research import _approved_retailer, _official_for_manufacturer
from app.models import (Attribute, AuditLog, Category, CategoryAttribute, Product,
                        ProductAttribute, ProductSourceLink, PropertyRule, SupplierOffer)
from app.property_engine import RuleDefinition, normalize
from app.connector_inventory import normalize_connector_inventory
from app.property_service import definition, has_technical_values
from app.validity import lock_validation, revalidate_product
from app.cooling_inventory import COOLING_CODES
from app.product_loader import _merge_header_evidence

EVIDENCE_PATH = Path('/tmp/official-category-properties.json')


def offers(db, product_id):
    return db.scalar(select(func.count(SupplierOffer.id)).join(ProductSourceLink,
        ProductSourceLink.offer_id == SupplierOffer.id).where(
        ProductSourceLink.product_id == product_id, SupplierOffer.is_current.is_(True),
        SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0)) or 0


def prepare(db, document, fill_missing=False, enrich_cooling=False):
    result = []
    for item in document['products']:
        product = db.get(Product, item['product_id'])
        category = db.get(Category, item['category_id'])
        if product is None or category is None:
            raise RuntimeError(f"Missing product/category for product_id={item['product_id']}")
        if (product.status != 'active' or product.is_archived or not product.selection_enabled or
            len(product.categories) != 1 or product.categories[0].id != category.id or offers(db, product.id) == 0):
            raise RuntimeError(f"Product {product.id} is not currently eligible")
        if (product.manufacturer or '').casefold() != item['manufacturer'].casefold() or \
           (product.manufacturer_article or '').casefold() != item['article'].casefold():
            raise RuntimeError(f"Exact identity mismatch for product {product.id}")
        user_default = item.get('source_kind') == 'user_default'
        source_url = item.get('source_url')
        if user_default:
            if source_url is not None or not isinstance(item.get('source_note'), str) or not item['source_note'].strip():
                raise RuntimeError(f"User-default evidence needs a source_note and no source_url for product {product.id}")
            retailer = False
        else:
            if not isinstance(source_url, str):
                raise RuntimeError(f"Invalid HTTPS source for product {product.id}")
            retailer = _approved_retailer(source_url)
            if not retailer and not _official_for_manufacturer(source_url, item['manufacturer']):
                raise RuntimeError(f"Source is not the manufacturer or an approved retailer for product {product.id}")
            if retailer and item.get('official_unavailable') is not True:
                raise RuntimeError(f"Retail fallback requires official_unavailable for product {product.id}")
            if item.get('source_kind') == 'retailer_site' and not retailer:
                raise RuntimeError(f"Unapproved retail source for product {product.id}")
            if item.get('source_kind') not in (None, 'manufacturer_site', 'retailer_site'):
                raise RuntimeError(f"Unknown source_kind for product {product.id}")
            if retailer and item.get('source_kind') == 'manufacturer_site':
                raise RuntimeError(f"Retail source mislabeled as manufacturer for product {product.id}")
        if not fill_missing and has_technical_values(db, product.id):
            raise RuntimeError(f"Product {product.id} already has technical values")
        rules = {r.code: r for r in db.scalars(select(PropertyRule).where(
            PropertyRule.category_id == category.id, PropertyRule.source == 'internal', PropertyRule.active.is_(True)))}
        blocked = set(db.scalars(select(CategoryAttribute.attribute_id).where(
            CategoryAttribute.category_id == category.id, CategoryAttribute.ai_blocked.is_(True))))
        normalized = []
        existing_codes = set(db.scalars(select(Attribute.code).join(ProductAttribute,
            ProductAttribute.attribute_id == Attribute.id).where(
                ProductAttribute.product_id == product.id,
                ProductAttribute.value_state == 'known')))
        raw_values = dict(item['values'])
        if (category.id == 432 and 'case_drive_bays_shared_25_35' not in raw_values and
                type(raw_values.get('case_drive_bays_25')) is int and
                type(raw_values.get('case_drive_bays_35')) is int and
                raw_values['case_drive_bays_25'] >= 0 and raw_values['case_drive_bays_35'] >= 0):
            raw_values['case_drive_bays_shared_25_35'] = min(
                raw_values['case_drive_bays_25'], raw_values['case_drive_bays_35'])
            item['_derived_shared_bound'] = True
        for code, raw in raw_values.items():
            rule = rules.get(code)
            if rule is None:
                raise RuntimeError(f"No active internal rule {code} for category {category.id}")
            if rule.attribute_id in blocked or definition(rule)['ai_blocked']:
                continue
            if enrich_cooling and (category.id not in (359, 437, 246) or code not in COOLING_CODES):
                raise RuntimeError('Cooling enrichment is limited to cooling connection properties')
            existing = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
                ProductAttribute.attribute_id == rule.attribute_id))
            refresh = enrich_cooling and existing is not None and (code == 'motherboard_fan_headers' or
                any(row.get('kind') == 'unresolved' for row in (existing.value_json or []) if isinstance(row, dict)))
            if fill_missing and code in existing_codes and not refresh:
                continue
            value_url = item.get('value_sources', {}).get(code, item.get('source_url'))
            if not user_default and not (_official_for_manufacturer(value_url, item['manufacturer']) or
                    (item.get('official_unavailable') is True and _approved_retailer(value_url))):
                raise RuntimeError(f'Unapproved source for {product.id}:{code}')
            norm = normalize(normalize_connector_inventory(code, raw),
                             RuleDefinition.model_validate(definition(rule)))
            if refresh and code == 'motherboard_fan_headers':
                norm = _merge_header_evidence(existing.value_json, norm)
            if refresh and existing.value_json == norm:
                continue
            normalized.append((rule, norm))
        if not normalized:
            if fill_missing:
                continue
            raise RuntimeError(f"No unblocked properties for product {product.id}")
        result.append((item, product, category, normalized))
    if len({(x[2].id, x[1].id) for x in result}) != len(result):
        raise RuntimeError('Duplicate product/category evidence rows')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--fill-missing', action='store_true',
                        help='add only absent properties to already populated eligible products')
    parser.add_argument('--enrich-cooling', action='store_true',
                        help='also enrich existing board headers and unresolved cooling connections')
    parser.add_argument('--evidence', default=str(EVIDENCE_PATH),
                        help='path to a reviewed evidence JSON file')
    args = parser.parse_args()
    args.fill_missing = args.fill_missing or args.enrich_cooling
    evidence_path = Path(args.evidence)
    document = json.loads(evidence_path.read_text(encoding='utf-8'))
    with SessionLocal() as db:
        prepared = prepare(db, document, args.fill_missing, args.enrich_cooling)
        for item, product, category, values in prepared:
            print(f"product={product.id} category={category.id} model={item['official_model']} "
                  f"values={','.join(rule.code for rule, _ in values)}")
        count = sum(len(x[3]) for x in prepared)
        if not args.apply:
            print(f"DRY RUN: {len(prepared)} products, {count} properties, no writes.")
            return
        lock_validation(db)
        now = datetime.now(timezone.utc)
        for item, product, category, values in prepared:
            current = db.scalar(select(Product).where(Product.id == product.id).with_for_update())
            if current is None or current.status != 'active' or current.is_archived or \
               not current.selection_enabled or len(current.categories) != 1 or \
               current.categories[0].id != category.id or (not args.fill_missing and has_technical_values(db, current.id)) or offers(db, current.id) == 0:
                raise RuntimeError(f"Eligibility changed for product {product.id}; transaction cancelled")
            codes = []
            for rule, value in values:
                link = db.get(CategoryAttribute, (category.id, rule.attribute_id))
                if link is None or link.ai_blocked or definition(rule)['ai_blocked']:
                    continue
                attribute = db.get(Attribute, rule.attribute_id)
                existing = db.scalar(select(ProductAttribute).where(
                    ProductAttribute.product_id == product.id,
                    ProductAttribute.attribute_id == attribute.id)) if args.fill_missing else None
                if existing is not None and existing.value_state == 'known':
                    if not args.enrich_cooling or (attribute.code != 'motherboard_fan_headers' and not any(
                            entry.get('kind') == 'unresolved' for entry in (existing.value_json or []) if isinstance(entry, dict))):
                        continue
                    if attribute.code == 'motherboard_fan_headers':
                        try:
                            value = _merge_header_evidence(existing.value_json, value)
                        except Exception as exc:
                            raise RuntimeError(f'Header enrichment conflict for product {product.id}: {exc}') from exc
                    if value == existing.value_json:
                        continue
                    db.add(AuditLog(action='properties.cooling_local_enriched', object_type='product',
                        object_id=str(product.id), details={'code': attribute.code,
                            'previous': existing.value_json, 'previous_source_url': existing.source_url}))
                row = existing or ProductAttribute(product_id=product.id, attribute_id=attribute.id)
                row.value_state = 'known'
                value_url = item.get('value_sources', {}).get(attribute.code, item.get('source_url'))
                row.source_kind = 'manual' if item.get('source_kind') == 'user_default' else (
                    'conservative_bound' if item.get('_derived_shared_bound') and
                    attribute.code == 'case_drive_bays_shared_25_35' else
                    'retailer_site' if _approved_retailer(value_url) else 'manufacturer_site')
                row.source_url = value_url
                row.updated_at = now
                if attribute.value_type in ('string', 'enum', 'url'):
                    row.value_string = value
                elif attribute.value_type in ('number', 'integer'):
                    row.value_number = Decimal(str(value))
                elif attribute.value_type == 'boolean':
                    row.value_boolean = value
                else:
                    row.value_json = value
                db.add(row)
                codes.append(attribute.code)
            revalidate_product(db, current)
            db.add(AuditLog(action='properties.verified_local_fill', object_type='product',
                object_id=str(product.id), details={
                    'category_id': category.id, 'manufacturer': item['manufacturer'],
                    'article': item['article'], 'official_model': item['official_model'],
                    'property_codes': codes, 'source_url': item['source_url'],
                    'source_kind': 'user_default' if item.get('source_kind') == 'user_default' else
                        'retailer_site' if _approved_retailer(item['source_url']) else 'manufacturer_site',
                    'source_note': item.get('source_note'),
                    'official_unavailable': item.get('official_unavailable') is True,
                    'evidence_file': evidence_path.name,
                    'evidence_reviewed_at': item['checked_at'],
                    'evidence_reviewed_by': item.get('reviewed_by', 'Codex'),
                }))
        db.commit()
        print(f"LOADED: {count} properties for {len(prepared)} products across "
              f"{len({x[2].id for x in prepared})} categories.")


if __name__ == '__main__':
    main()
