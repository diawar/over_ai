"""Load reviewed local manufacturer facts into exact matching CoreLab products.

Run in the backend container with --dry-run first. No OpenAI or other API calls.
"""
import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import (Attribute, AuditLog, CatalogSource, Category, CategoryAttribute, Product,
                        ProductAttribute, ProductSourceLink, PropertyRule, SupplierOffer,
                        ValidationReason)
from app.property_engine import RuleDefinition, normalize
from app.connector_inventory import normalize_connector_inventory
from app.property_service import definition, has_technical_values
from app.validity import lock_validation, revalidate_product


EVIDENCE_PATH = Path('/tmp/component-characteristics.json')
M2_EVIDENCE_PATH = Path('/tmp/motherboard-m2-interfaces.json')
def fact_values(record):
    fact = next(iter((record.get('facts') or {}).values()), {})
    return fact.get('value') or {}, fact.get('source') or {}


def list_value(value):
    if isinstance(value, list):
        return value if value else None
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return None


def map_values(category_name, value):
    if category_name == 'Процессоры':
        values = {code: value[key] for code, key in {
            'socket': 'socket', 'cores': 'cores', 'threads': 'threads',
            'max_boost_clock_ghz': 'maxBoostGHz',
        }.items() if value.get(key) is not None}
        if value.get('memoryTypes'):
            types = value['memoryTypes']
            values['cpu_memory_type'] = ' / '.join(types) if isinstance(types, list) else types
        if 'integratedGraphics' in value and value['integratedGraphics'] is not None:
            values['integrated_graphics'] = bool(value['integratedGraphics'])
        return values

    if category_name == 'Материнские платы':
        mapped = {code: value[key] for code, key in {
            'motherboard_socket': 'socket', 'motherboard_chipset': 'chipset',
            'motherboard_form_factor': 'formFactor', 'memory_type': 'memoryType',
            'motherboard_memory_slots': 'memorySlots', 'motherboard_max_memory_gb': 'maxMemoryGB',
            'motherboard_pcie_x16': 'pcieX16', 'motherboard_m2_slots': 'm2Slots',
            'motherboard_sata_ports': 'sataPorts',
        }.items() if value.get(key) is not None}
        interfaces = value.get('m2Interfaces')
        if not interfaces and value.get('m2Interface'):
            interfaces = [value['m2Interface']]
        if interfaces:
            mapped['motherboard_m2_interfaces'] = interfaces
        return mapped

    if category_name == 'Оперативная память':
        return {code: value[key] for code, key in {
            'capacity': 'capacityGB', 'module_count': 'moduleCount', 'memory_type': 'memoryType',
            'memory_frequency': 'speedMTs', 'memory_form_factor': 'formFactor',
        }.items() if value.get(key) is not None}

    if category_name == 'Видеокарты':
        values = {code: value[key] for code, key in {
            'gpu_graphics_processor': 'gpu', 'gpu_memory_gb': 'memoryGB',
            'gpu_memory_type': 'memoryType', 'gpu_memory_bus_bit': 'memoryBusBit',
            'gpu_pcie_interface': 'interface', 'gpu_board_power_w': 'powerW',
            'gpu_recommended_psu_w': 'recommendedPsuW',
        }.items() if value.get(key) is not None}
        dimensions = value.get('dimensions')
        if isinstance(dimensions, dict) and dimensions.get('lengthMm') is not None:
            values['gpu_length_mm'] = dimensions['lengthMm']
        if value.get('slotWidth') is not None:
            match = re.search(r'\d+(?:[.,]\d+)?', str(value['slotWidth']))
            if match:
                values['gpu_slot_width'] = match.group().replace(',', '.')
        connectors = list_value(value.get('powerConnectors'))
        if connectors:
            values['gpu_power_connectors'] = connectors
        return values

    if category_name == 'Блоки питания':
        values = {code: value[key] for code, key in {
            'psu_power_w': 'ratedPowerW', 'psu_form_factor': 'formFactor',
            'psu_efficiency_rating': 'efficiencyCertification', 'psu_modularity': 'modularity',
            'psu_atx_version': 'atxStandard', 'psu_length_mm': 'lengthMm',
        }.items() if value.get(key) is not None}
        connectors = []
        for key, label in (
            ('pciE6Plus2Count', 'PCIe 6+2-pin'), ('pciE8PinCount', 'PCIe 8-pin'),
            ('pciE12Plus4Count', '12VHPWR 12+4-pin'), ('connector12V2x6Count', '12V-2x6'),
            ('connector16PinCount', '16-pin'),
        ):
            count = value.get(key)
            if isinstance(count, (int, float)) and count > 0:
                connectors.append(f'{label} × {int(count)}')
        if connectors:
            values['psu_pcie_connectors'] = connectors
        if value.get('cpuEpsConnectors') is not None:
            cpu = list_value(value['cpuEpsConnectors'])
            if cpu:
                values['psu_cpu_connectors'] = cpu
        return values

    if category_name == 'Корпуса':
        values = {}
        if value.get('motherboardFormFactors') is not None:
            values['case_motherboard_form_factors'] = list_value(value['motherboardFormFactors'])
        for code, key in {
            'case_gpu_max_length_mm': 'maxGpuLengthMm',
            'case_cpu_cooler_max_height_mm': 'maxCpuCoolerHeightMm',
            'case_psu_max_length_mm': 'maxPsuLengthMm',
        }.items():
            if value.get(key) is not None:
                values[code] = value[key]
        if value.get('radiatorSupport') is not None:
            values['case_radiator_support'] = list_value(value['radiatorSupport'])
        return {code: raw for code, raw in values.items() if raw is not None}

    if category_name == 'Жесткие диски 3.5" (для ПК)':
        values = {code: value[key] for code, key in {
            'storage_interface': 'interface', 'storage_form_factor': 'formFactor',
            'hdd_rpm': 'rotationalSpeedRpm', 'hdd_cache_mb': 'cacheMB',
            'hdd_recording_technology': 'recordingTechnology',
        }.items() if value.get(key) is not None}
        if value.get('capacityTB') is not None:
            values['capacity'] = Decimal(str(value['capacityTB'])) * 1000
        return values

    if category_name == 'Твердотельные диски (SSD)':
        return {code: value[key] for code, key in {
            'capacity': 'capacityGB', 'storage_interface': 'interface',
            'storage_form_factor': 'formFactor',
        }.items() if value.get(key) is not None}

    if category_name == 'Кулеры для процессоров':
        values = {}
        if value.get('mountingSockets') is not None:
            values['cpu_cooler_sockets'] = list_value(value['mountingSockets'])
        if value.get('coolerType') is not None:
            values['cpu_cooler_type'] = str(value['coolerType'])
        dimensions = value.get('dimensionsMm')
        if isinstance(dimensions, dict) and dimensions.get('heightMm') is not None:
            values['cpu_cooler_height_mm'] = dimensions['heightMm']
        return {code: raw for code, raw in values.items() if raw is not None}

    if category_name == 'Системы водяного / жидкостного охлаждения (СЖО)':
        values = {}
        if value.get('mountingSockets') is not None:
            values['cpu_cooler_sockets'] = list_value(value['mountingSockets'])
        if value.get('tdpW') is not None:
            values['cpu_cooler_tdp_w'] = value['tdpW']
        if value.get('radiatorSizeMm') is not None:
            values['aio_radiator_size_mm'] = value['radiatorSizeMm']
        return {code: raw for code, raw in values.items() if raw is not None}

    return {}


def min_offer_price(db, product_id):
    return db.scalar(select(func.min(SupplierOffer.price)).join(ProductSourceLink,
        ProductSourceLink.offer_id == SupplierOffer.id).where(
        ProductSourceLink.product_id == product_id, SupplierOffer.is_current.is_(True),
        SupplierOffer.is_archived.is_not(True), SupplierOffer.price > 0))


def prepare_m2_interfaces(db):
    """Prepare only verified M.2 interface facts for every currently eligible board."""
    base = json.loads(EVIDENCE_PATH.read_text(encoding='utf-8'))['components']
    added = json.loads(M2_EVIDENCE_PATH.read_text(encoding='utf-8'))['components']
    evidence = {str(row.get('skuOver')): row for row in [*base, *added]
                if row.get('status') == 'verified' and row.get('category') == 'Материнские платы'}
    categories = list(db.scalars(select(Category).where(Category.name == 'Материнские платы',
                                                       Category.selection_category.is_(True))))
    if len(categories) != 1:
        raise RuntimeError(f'Expected one selection category Материнские платы, got {len(categories)}')
    category = categories[0]
    rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category.id,
        PropertyRule.code == 'motherboard_m2_interfaces', PropertyRule.source == 'internal',
        PropertyRule.active.is_(True)))
    if rule is None or rule.attribute_id is None:
        raise RuntimeError('No active motherboard_m2_interfaces property rule')
    link = db.get(CategoryAttribute, (category.id, rule.attribute_id))
    if link is None or link.ai_blocked or definition(rule)['ai_blocked']:
        raise RuntimeError('motherboard_m2_interfaces is missing or blocked for the motherboard category')

    source_id = db.scalar(select(CatalogSource.id).where(CatalogSource.code == 'corelab'))
    if source_id is None:
        raise RuntimeError('CoreLab catalog source not found')
    products = list(db.scalars(select(Product).where(Product.source_id == source_id,
        Product.status == 'active', Product.is_archived.is_not(True),
        Product.selection_enabled.is_(True),
        Product.categories.any(id=category.id)).order_by(Product.id)))

    prepared, targets, missing, conflicts, ineligible = [], [], [], [], []
    seen = set()
    for product in products:
        if len(product.categories) != 1 or product.categories[0].id != category.id:
            continue
        if min_offer_price(db, product.id) is None:
            continue
        reasons = list(db.scalars(select(ValidationReason.message).where(
            ValidationReason.product_id == product.id)))
        other_reasons = [message for message in reasons if message !=
                         'Интерфейсы M.2: Обязательное значение отсутствует']
        if product.validity_check is not True and other_reasons:
            ineligible.append((product.sku, '; '.join(other_reasons)))
            continue
        targets.append(product)
        sku = product.sku.removeprefix('p1:')
        record = evidence.get(sku)
        if record is None:
            missing.append((sku, product.manufacturer_article, 'no verified evidence'))
            continue
        if product.manufacturer != record.get('manufacturer') or \
                product.manufacturer_article != record.get('article'):
            missing.append((sku, product.manufacturer_article, 'manufacturer/article mismatch'))
            continue
        if sku in seen:
            raise RuntimeError(f'Duplicate exact evidence for board SKU {sku}')
        seen.add(sku)
        facts = next(iter((record.get('facts') or {}).values()), {}).get('value') or {}
        interfaces = facts.get('m2Interfaces')
        if not interfaces and facts.get('m2Interface'):
            interfaces = [facts['m2Interface']]
        if not isinstance(interfaces, list) or not interfaces or \
                not all(isinstance(value, str) and value.strip() for value in interfaces):
            missing.append((sku, product.manufacturer_article, 'M.2 interfaces absent'))
            continue
        value = normalize(interfaces, RuleDefinition.model_validate(definition(rule)))
        current = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
            ProductAttribute.attribute_id == rule.attribute_id))
        if current is not None:
            old = next((v for v in (current.value_string, current.value_number,
                                    current.value_boolean, current.value_json) if v is not None), None)
            if current.value_state == 'known' and old is not None:
                if old == value:
                    continue
                conflicts.append((sku, product.manufacturer_article, old, value))
                continue
        prepared.append((record, product, category, rule, value, current))
    return prepared, targets, missing, conflicts, ineligible


def apply_m2_interfaces(db, prepared):
    lock_validation(db)
    now = datetime.now(timezone.utc)
    applied = 0
    for record, product, category, rule, value, old in prepared:
        current = db.scalar(select(Product).where(Product.id == product.id).with_for_update())
        if current is None or current.status != 'active' or current.is_archived or \
                not current.selection_enabled or \
                len(current.categories) != 1 or current.categories[0].id != category.id or \
                min_offer_price(db, current.id) is None:
            raise RuntimeError(f'Eligibility changed for board {product.sku}; transaction cancelled')
        reasons = list(db.scalars(select(ValidationReason.message).where(
            ValidationReason.product_id == current.id)))
        if current.validity_check is not True and any(message !=
                'Интерфейсы M.2: Обязательное значение отсутствует' for message in reasons):
            raise RuntimeError(f'Board {product.sku} has another eligibility issue; transaction cancelled')
        row = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == current.id,
            ProductAttribute.attribute_id == rule.attribute_id).with_for_update())
        if row is None:
            row = ProductAttribute(product_id=current.id, attribute_id=rule.attribute_id,
                value_json=value, value_state='known', source_kind='manufacturer_site', source_url=None,
                updated_at=now)
            db.add(row)
        else:
            existing_value = next((v for v in (row.value_string, row.value_number,
                row.value_boolean, row.value_json) if v is not None), None)
            if row.value_state == 'known' and existing_value is not None:
                if existing_value == value:
                    continue
                raise RuntimeError(f'Existing M.2 value changed for {product.sku}; transaction cancelled')
            row.value_string = row.value_number = row.value_boolean = None
            row.value_json = value
            row.value_state = 'known'
            row.source_kind = 'manufacturer_site'
            row.source_url = None
            row.updated_at = now
        revalidate_product(db, current)
        source = next(iter((record.get('facts') or {}).values()), {}).get('source') or {}
        db.add(AuditLog(action='properties.verified_local_fill', object_type='product',
            object_id=str(current.id), details={
                'category_id': category.id, 'sku_over': record['skuOver'],
                'manufacturer': record['manufacturer'], 'article': record['article'],
                'official_model': record['officialModel'],
                'property_codes': ['motherboard_m2_interfaces'],
                'evidence_file': ('data/motherboard-m2-interfaces.json'
                                  if str(record.get('skuOver')) in {
                                      str(item.get('skuOver')) for item in json.loads(
                                          M2_EVIDENCE_PATH.read_text(encoding='utf-8'))['components']
                                  } else 'data/component-characteristics.json'),
                'evidence_page_title': source.get('pageTitle'),
                'evidence_reviewed_at': source.get('checkedAt'),
                'evidence_reviewed_by': record.get('reviewedBy'),
                'source_url_available': False,
            }))
        applied += 1
    return applied


def prepare(db):
    evidence = json.loads(EVIDENCE_PATH.read_text(encoding='utf-8'))['components']
    category_map = {row.name: row for row in db.scalars(select(Category))}
    products = list(db.scalars(select(Product).where(Product.is_archived.is_not(True))))
    by_sku = {p.sku: p for p in products}
    matches = defaultdict(list)
    unavailable = defaultdict(int)
    for record in evidence:
        if record.get('status') != 'verified':
            continue
        category = category_map.get(record['category'])
        if category is None:
            continue
        sku = 'p1:' + str(record.get('skuOver', ''))
        product = by_sku.get(sku)
        if product is None or len(product.categories) != 1 or product.categories[0].id != category.id:
            unavailable[record['category']] += 1
            continue
        if (product.manufacturer or '').casefold() != record['manufacturer'].casefold() or \
                (product.manufacturer_article or '').casefold() != record['article'].casefold():
            unavailable[record['category']] += 1
            continue
        if product.status != 'active' or not product.selection_enabled:
            unavailable[record['category']] += 1
            continue
        price = min_offer_price(db, product.id)
        if price is None:
            unavailable[record['category']] += 1
            continue
        facts, source = fact_values(record)
        raw_values = map_values(record['category'], facts)
        rules = list(db.scalars(select(PropertyRule).where(PropertyRule.category_id == category.id,
            PropertyRule.source == 'internal', PropertyRule.active.is_(True))))
        by_code = {row.code: row for row in rules}
        blocked = set(db.scalars(select(CategoryAttribute.attribute_id).where(
            CategoryAttribute.category_id == category.id, CategoryAttribute.ai_blocked.is_(True))))
        known_codes = set(db.scalars(select(Attribute.code).join(ProductAttribute,
            ProductAttribute.attribute_id == Attribute.id).where(
                ProductAttribute.product_id == product.id,
                ProductAttribute.value_state == 'known')))
        normalized = {}
        for code, raw in raw_values.items():
            row = by_code.get(code)
            if code in known_codes or row is None or row.attribute_id in blocked or definition(row)['ai_blocked']:
                continue
            rule = RuleDefinition.model_validate(definition(row))
            try:
                normalized[code] = (row, normalize(normalize_connector_inventory(code, raw), rule))
            except (ValueError, TypeError):
                continue
        if normalized:
            matches[category.name].append({
                'record': record, 'product': product, 'category': category, 'price': Decimal(str(price)),
                'source': source, 'values': normalized,
            })
        else:
            unavailable[category.name] += 1

    chosen = {}
    seen_products = set()
    for name, rows in matches.items():
        rows.sort(key=lambda item: (item['price'], item['product'].id))
        unique_rows = []
        for item in rows:
            if item['product'].id in seen_products:
                raise RuntimeError(f"Duplicate evidence row for product {item['product'].id}")
            seen_products.add(item['product'].id)
            unique_rows.append(item)
        if unique_rows:
            chosen[name] = unique_rows
    return evidence, chosen, unavailable


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='write verified values; default is a read-only dry run')
    parser.add_argument('--m2-interfaces', action='store_true',
                        help='load only verified M.2 interfaces for all eligible motherboard products')
    args = parser.parse_args()
    with SessionLocal() as db:
        if args.m2_interfaces:
            prepared, products, missing, conflicts, ineligible = prepare_m2_interfaces(db)
            existing = len(products) - len(prepared) - len(missing) - len(conflicts)
            print(f'MOTHERBOARDS targets={len(products)} already_confirmed={existing} to_add={len(prepared)} '
                  f'missing_evidence={len(missing)} conflicts={len(conflicts)} other_ineligible={len(ineligible)}')
            for record, product, category, rule, value, _ in prepared:
                print(f"  ADD sku={record['skuOver']} article={record['article']} interfaces={value}")
            for sku, article, reason in missing:
                print(f'  MISSING sku={sku} article={article} reason={reason}')
            for sku, article, old, new in conflicts:
                print(f'  CONFLICT sku={sku} article={article} existing={old} evidence={new}')
            for sku, reasons in ineligible:
                print(f'  SKIP sku={sku} reason={reasons}')
            if not args.apply:
                print('DRY RUN: no writes.')
                return
            if missing or conflicts:
                raise RuntimeError('Refusing partial M.2 import: every target motherboard must have matching evidence and no conflicts')
            applied = apply_m2_interfaces(db, prepared)
            db.commit()
            print(f'LOADED: {applied} M.2 interface values; already confirmed {existing}.')
            return
        evidence, chosen, unavailable = prepare(db)
        total = 0
        for name, rows in sorted(chosen.items()):
            category = rows[0]['category']
            print(f'CATEGORY {category.id} {name}: {len(rows)} products with missing verified values')
            for item in rows:
                total += 1
                print(f"  product_id={item['product'].id} article={item['product'].manufacturer_article} "
                      f"price={item['price']} values={','.join(item['values'])}")
        missing = sorted(set(row['category'] for row in evidence if row.get('status') == 'verified') - set(chosen))
        for name in sorted(set(unavailable) | set(missing)):
            if name not in chosen:
                print(f'CATEGORY {name}: no eligible exact product with missing verified values')
        if not args.apply:
            print(f'DRY RUN: {total} products, no writes. Add --apply to load.')
            return

        lock_validation(db)
        now = datetime.now(timezone.utc)
        saved_products = 0
        saved_values = 0
        for name, rows in sorted(chosen.items()):
            for item in rows:
                product_id = item['product'].id
                product = db.scalar(select(Product).where(Product.id == product_id).with_for_update())
                if product is None or product.status != 'active' or not product.selection_enabled or \
                        len(product.categories) != 1 or product.categories[0].id != item['category'].id or \
                        min_offer_price(db, product_id) is None:
                    raise RuntimeError(f'Eligibility changed for product {product_id}; transaction cancelled')
                current_record = item['record']
                details = []
                for code, (rule_row, value) in item['values'].items():
                    attribute_id = rule_row.attribute_id
                    link = db.get(CategoryAttribute, (item['category'].id, attribute_id))
                    if link is None or link.ai_blocked or definition(rule_row)['ai_blocked']:
                        continue
                    attribute = db.get(Attribute, attribute_id)
                    row = db.scalar(select(ProductAttribute).where(
                        ProductAttribute.product_id == product_id,
                        ProductAttribute.attribute_id == attribute_id).with_for_update())
                    if row is not None and row.value_state == 'known':
                        continue
                    if row is None:
                        row = ProductAttribute(product_id=product_id, attribute_id=attribute_id)
                    row.value_string = row.value_number = row.value_boolean = row.value_json = None
                    row.value_state = 'known'
                    row.source_kind = 'manufacturer_site'
                    row.source_url = item['source'].get('url') or None
                    row.updated_at = now
                    if attribute.value_type in ('string', 'enum', 'url'):
                        row.value_string = value
                    elif attribute.value_type in ('number', 'integer'):
                        row.value_number = value
                    elif attribute.value_type == 'boolean':
                        row.value_boolean = value
                    else:
                        row.value_json = value
                    db.add(row)
                    details.append(code)
                    saved_values += 1
                if not details:
                    continue
                revalidate_product(db, product)
                source = item['source']
                db.add(AuditLog(action='properties.verified_local_fill', object_type='product',
                    object_id=str(product_id), details={
                        'category_id': item['category'].id, 'sku_over': current_record['skuOver'],
                        'manufacturer': current_record['manufacturer'], 'article': current_record['article'],
                        'official_model': current_record['officialModel'], 'property_codes': details,
                        'evidence_file': 'data/component-characteristics.json',
                        'evidence_page_title': source.get('pageTitle'),
                        'evidence_reviewed_at': source.get('checkedAt'),
                        'evidence_reviewed_by': current_record.get('reviewedBy'),
                        'source_url_available': bool(source.get('url')),
                    }))
                saved_products += 1
        db.commit()
        print(f'LOADED: {saved_values} values for {saved_products} products across {len(chosen)} categories.')


if __name__ == '__main__':
    main()
