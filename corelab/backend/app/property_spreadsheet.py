"""Offline XLS exchange of missing required catalog properties. No AI calls."""
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from io import BytesIO
import hashlib
import hmac
import json
from zipfile import ZipFile, ZIP_DEFLATED, BadZipFile

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload
import xlrd
import xlwt

from .catalog_views import ProductAttributeInput, _source_id, _stored_attribute_value
from .ai_research import _approved_retailer
from .config import get_settings
from .db import get_db
from .models import Attribute, AuditLog, Category, Product, ProductAttribute, PropertyRule
from .property_engine import RuleDefinition, condition_value, normalize
from .validity import lock_validation, revalidate_product

MAX_BYTES = 20 * 1024 * 1024
MAX_ROWS = 100000
MAX_ARCHIVE_FILES = 1000
MAX_EXPANDED_BYTES = 100 * 1024 * 1024
PRODUCTS_PER_FILE = 10
HEADERS = ['ID товара', 'SKU', 'Товар', 'Производитель', 'Артикул', 'Категория',
           'Код свойства', 'Свойство', 'Обязательное', 'Для подбора ПК', 'Тип', 'Единица',
           'Формат и ограничения', 'Текущее значение', 'Новое значение', 'Ссылка на источник',
           'Примечание', '_данные', '_подпись']
VALUE, SOURCE, NOTE, META, SIGNATURE = 14, 15, 16, 17, 18


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def signature(value):
    return hmac.new(get_settings().session_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def snapshot(row):
    if row is None:
        return None
    return {c: getattr(row, c) for c in ('value_string', 'value_number', 'value_boolean',
            'value_json', 'value_state', 'source_url', 'source_kind', 'updated_at')}


def rules_for(db, product):
    return list(db.scalars(select(PropertyRule).where(PropertyRule.active.is_(True),
        PropertyRule.source == 'internal', PropertyRule.category_id.in_([c.id for c in product.categories]))
        .order_by(PropertyRule.id)))


def applicable(rule, values):
    return not rule.applies_when or condition_value(rule.applies_when, values, {}) is True


def required(rule, values):
    return rule.level == 'required' or (rule.level == 'conditional' and
        condition_value(rule.condition, values, {}) is True)


def missing(row, attribute, definitions):
    if row is None or row.value_state != 'known':
        return True
    value = _stored_attribute_value(row, attribute)
    if value is None or value == '' or value == []:
        return True
    try:
        for rule in definitions:
            normalized = normalize(value, rule)
            if isinstance(normalized, list):
                for entry in normalized:
                    if not isinstance(entry, dict):
                        continue
                    if entry.get('kind') == 'unresolved':
                        return True
                    if attribute.code == 'motherboard_fan_headers' and any(
                            entry.get(key) in (None, '', []) for key in ('pins', 'control', 'max_current_a')):
                        return True
                    if attribute.code == 'psu_pcie_connectors' and entry.get('kind') in ('pcie_8', 'pcie_16') and entry.get('cables') is None:
                        return True
    except (ValueError, TypeError):
        return True
    return False


def preserves_known_details(before, after):
    """A partial inventory may be completed, but confirmed entries cannot disappear."""
    if not isinstance(before, list) or not isinstance(after, list):
        return True
    for old in before:
        if not isinstance(old, dict) or old.get('kind') == 'unresolved':
            continue
        candidates = [new for new in after if isinstance(new, dict) and
            new.get('kind') == old.get('kind') and new.get('roles') == old.get('roles')]
        if not any(all(key == 'raw' or value in (None, '', []) or
                       (isinstance(value, list) and isinstance(new.get(key), list) and
                        all(item in new[key] for item in value)) or new.get(key) == value
                       for key, value in old.items()) for new in candidates):
            return False
    return True


def parse_value(raw, value_type):
    if value_type == 'list':
        value = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(value, list):
            raise ValueError('Ожидается JSON-массив, например ["AM4", "AM5"]')
        return value
    if value_type == 'boolean':
        if isinstance(raw, str):
            text = raw.strip().lower()
            if text in ('да', 'true', '1'):
                return True
            if text in ('нет', 'false', '0'):
                return False
        if raw in (0, 1) and not isinstance(raw, str):
            return bool(raw)
        raise ValueError('Укажите Да или Нет')
    if value_type in ('integer', 'number'):
        value = Decimal(str(raw).strip().replace(',', '.'))
        if not value.is_finite() or abs(value) >= Decimal('100000000000000'):
            raise ValueError('Число вне допустимого диапазона')
        if value_type == 'integer' and value != value.to_integral_value():
            raise ValueError('Ожидается целое число')
        if value != value.quantize(Decimal('0.01')):
            raise ValueError('Допускается не более двух знаков после запятой')
        return int(value) if value_type == 'integer' else float(value)
    return str(raw).strip()


def export_xls(db, category_id=None, q='', scope='either', archive=False):
    source_id = _source_id(db)
    query = select(Product).where(Product.source_id == source_id).options(selectinload(Product.categories))
    if category_id is not None:
        categories = list(db.scalars(select(Category).where(Category.source_id == source_id)))
        ids = {category_id}
        while True:
            expanded = ids | {c.id for c in categories if c.parent_id in ids}
            if expanded == ids:
                break
            ids = expanded
        query = query.where(Product.categories.any(Category.id.in_(ids)))
    if q.strip():
        from sqlalchemy import or_
        text = '%' + q.strip() + '%'
        query = query.where(or_(Product.name.ilike(text), Product.sku.ilike(text),
            Product.manufacturer.ilike(text), Product.manufacturer_article.ilike(text)))
    products = list(db.scalars(query.order_by(Product.id)))
    attrs = {a.id: a for a in db.scalars(select(Attribute))}
    all_rules = defaultdict(list)
    for r in db.scalars(select(PropertyRule).where(PropertyRule.active.is_(True), PropertyRule.source == 'internal')):
        all_rules[r.category_id].append(r)
    rows = defaultdict(dict)
    ids = [p.id for p in products]
    for start in range(0, len(ids), 2000):
        for r in db.scalars(select(ProductAttribute).where(ProductAttribute.product_id.in_(ids[start:start+2000]))):
            rows[r.product_id][r.attribute_id] = r
    output_rows = []
    for product in products:
        grouped = defaultdict(list)
        for category in product.categories:
            for r in all_rules[category.id]:
                if r.attribute_id in attrs:
                    grouped[r.attribute_id].append(r)
        values = {attrs[aid].code: {'state': row.value_state, 'value': _stored_attribute_value(row, attrs[aid])}
                  for aid, row in rows[product.id].items() if aid in attrs}
        for aid, rules in grouped.items():
            rules.sort(key=lambda rule: rule.id)
            definitions = [RuleDefinition.model_validate(r.definition) for r in rules]
            active = [d for d in definitions if applicable(d, values)]
            is_required = any(required(d, values) for d in active)
            is_selection = any(d.required_for_selection for d in active)
            if not (is_required if scope == 'required' else is_selection if scope == 'selection' else is_required or is_selection):
                continue
            attr, old = attrs[aid], rows[product.id].get(aid)
            if not missing(old, attr, active):
                continue
            if len(output_rows) >= MAX_ROWS:
                raise HTTPException(422, 'Слишком много строк. Выберите категорию или уточните поиск.')
            meta = canonical(dict(v=1, org=db.info['organization_id'], pid=product.id,
                sku=product.sku, article=product.manufacturer_article, name=product.name, aid=aid,
                code=attr.code, old=digest(snapshot(old)), rules=digest([r.definition for r in rules])))
            hints = canonical([dict(type=d.value_type, allowed=d.allowed_values, min=d.minimum,
                max=d.maximum, format=d.format, note=d.note) for d in active])
            output_rows.append([str(product.id), product.sku, product.name, product.manufacturer or '',
                product.manufacturer_article or '', '; '.join(c.name for c in product.categories),
                attr.code, attr.label, 'Да' if is_required else 'Нет', 'Да' if is_selection else 'Нет',
                attr.value_type, attr.unit or '', hints,
                canonical(_stored_attribute_value(old, attr)) if old else '', '', '', '', meta, signature(meta)])
    if archive:
        if not output_rows:
            raise HTTPException(422, 'В выбранной категории и поиске нет незаполненных обязательных свойств.')
        return archive_xls_rows(output_rows), len(output_rows)
    return render_xls_rows(output_rows), len(output_rows)


def archive_xls_rows(rows, instructions=None):
    """Keep every property's signed row together with its product, including partial JSON."""
    products = defaultdict(list)
    for row in rows:
        products[str(row[0])].append(row)
    batches = list(products.values())
    output = BytesIO()
    with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
        for start in range(0, len(batches), PRODUCTS_PER_FILE):
            batch = [row for product_rows in batches[start:start + PRODUCTS_PER_FILE] for row in product_rows]
            archive.writestr(f'corelab-missing-properties-{start // PRODUCTS_PER_FILE + 1:03d}.xls',
                            render_xls_rows(batch, instructions))
    return output.getvalue()


def render_xls_rows(rows, instructions=None):
    book = xlwt.Workbook(encoding='utf-8')
    info = book.add_sheet('Инструкция')
    instructions = instructions if instructions is not None else [
        'Заполнение отсутствующих обязательных характеристик CoreLab',
        'Одна строка — одно свойство товара. Сохраните файл в формате XLS (Excel 97–2003).',
        'Заполните только «Новое значение», «Ссылка на источник» и при необходимости «Примечание».',
        'Не меняйте ID, SKU, артикул, код свойства, служебные столбцы, названия листов и заголовки.',
        'Список/разъёмы: JSON-массив; логическое: Да/Нет; числа — без единиц измерения.',
        'Соблюдайте ограничения из таблицы и проверяйте точную модель/ревизию по источнику.',
        'Неизвестное оставьте пустым. Пустые строки не применяются. Ноль и Нет являются значениями.',
        'Для неполного JSON дополните текущий массив, сохранив уже подтверждённые разъёмы и параметры.',
        'Обязательные для подбора ПК и обязательные характеристики объединены без повторов.',
        'После загрузки проверьте предварительный результат, затем нажмите «Применить».',
        'Изменившиеся после выгрузки карточки/правила защищены от перезаписи. Нормализация выполняется сервером.',
        'Выгрузка учитывает выбранную категорию (включая вложенные) и поиск; охватывает все страницы.',
    ]
    info.col(0).width = 24000
    for i, text in enumerate(instructions):
        info.write(i, 0, text)
    header = xlwt.easyxf('font: bold on, colour white; pattern: pattern solid, fore_colour dark_blue; alignment: wrap on, vert centre')
    editable = xlwt.easyxf('pattern: pattern solid, fore_colour light_yellow; alignment: wrap on, vert top')
    normal = xlwt.easyxf('alignment: wrap on, vert top')
    count = 0
    sheet = None
    for cells in rows:
        if count % 60000 == 0:
            sheet = book.add_sheet(f'Характеристики {count // 60000 + 1}')
            sheet.set_panes_frozen(True); sheet.set_horz_split_pos(1)
            for col, label in enumerate(HEADERS):
                sheet.write(0, col, label, header)
                sheet.col(col).width = (48 if col in (2, 12, 13, 14, 15, 16) else 22) * 256
            sheet.col(META).hidden = True; sheet.col(SIGNATURE).hidden = True
        for col, value in enumerate(cells):
            # xlwt writes strings literally, including text starting with '='.
            sheet.write(count % 60000 + 1, col, value, editable if VALUE <= col <= NOTE else normal)
        count += 1
    buffer = BytesIO(); book.save(buffer)
    return buffer.getvalue()


def import_sheets(data):
    """Read XLS or bounded ZIP contents in memory; never extract archive paths."""
    def sheets(content, filename=''):
        try:
            book = xlrd.open_workbook(file_contents=content)
        except Exception as exc:
            raise HTTPException(422, f'{filename}: Не удалось прочитать XLS. Используйте шаблон Excel 97–2003.') from exc
        if book.nsheets > 10:
            raise HTTPException(422, f'{filename}: В файле слишком много листов')
        if not any(sheet.name.startswith('Характеристики ') for sheet in book.sheets()):
            raise HTTPException(422, f'{filename}: В файле нет листов с характеристиками')
        for sheet in book.sheets():
            if sheet.name.startswith('Характеристики '):
                yield (f'{filename} / {sheet.name}' if filename else sheet.name), sheet
        book.release_resources()

    if not data.startswith(b'PK'):
        yield from sheets(data)
        return
    try:
        with ZipFile(BytesIO(data)) as archive:
            files = [item for item in archive.infolist() if not item.is_dir()]
            if not files or len(files) > MAX_ARCHIVE_FILES:
                raise HTTPException(422, 'Архив должен содержать от 1 до 1000 файлов XLS.')
            if sum(item.file_size for item in files) > MAX_EXPANDED_BYTES:
                raise HTTPException(413, 'Распакованный архив превышает 100 МБ.')
            for item in files:
                if not item.filename.lower().endswith('.xls'):
                    raise HTTPException(422, f'В архиве разрешены только XLS: {item.filename[:200]}')
                if item.file_size > MAX_BYTES:
                    raise HTTPException(413, f'XLS в архиве превышает 20 МБ: {item.filename[:200]}')
                with archive.open(item) as source:
                    content = source.read(MAX_BYTES + 1)
                if len(content) > MAX_BYTES:
                    raise HTTPException(413, 'XLS в архиве превышает 20 МБ.')
                yield from sheets(content, item.filename[:200])
    except (BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError) as exc:
        raise HTTPException(422, 'Не удалось прочитать ZIP. Используйте исправный архив без пароля.') from exc


def import_plan(db, data):
    changes, errors, seen, skipped = [], [], set(), 0
    total = 0
    for sheet_name, sheet in import_sheets(data):
        if sheet.nrows == 0 or sheet.ncols != len(HEADERS) or sheet.row_values(0) != HEADERS:
            raise HTTPException(422, f'Лист «{sheet_name}»: заголовки изменены')
        for index in range(1, sheet.nrows):
            total += 1
            if total > MAX_ROWS:
                raise HTTPException(422, 'В файле слишком много строк')
            cells = sheet.row_values(index)
            if cells[VALUE] == '' or cells[VALUE] is None:
                skipped += 1; continue
            try:
                raw_meta = cells[META]
                if not isinstance(raw_meta, str) or not hmac.compare_digest(signature(raw_meta), str(cells[SIGNATURE])):
                    raise ValueError('Служебные данные изменены; скачайте шаблон заново')
                meta = json.loads(raw_meta)
                if meta['org'] != db.info['organization_id'] or meta['v'] != 1:
                    raise ValueError('Файл принадлежит другой организации')
                key = (meta['pid'], meta['aid'])
                if key in seen:
                    raise ValueError('Повтор строки товара и свойства')
                seen.add(key)
                p = db.scalar(select(Product).where(Product.id == meta['pid'], Product.source_id == _source_id(db)).with_for_update())
                if p is None or (p.sku, p.manufacturer_article, p.name) != (meta['sku'], meta['article'], meta['name']):
                    raise ValueError('Карточка товара изменилась или недоступна')
                if (str(cells[0]), str(cells[1]), str(cells[2]), str(cells[4]), str(cells[6])) != (
                        str(p.id), p.sku, p.name, p.manufacturer_article or '', meta['code']):
                    raise ValueError('Идентификаторы в строке изменены')
                attr = db.get(Attribute, meta['aid'])
                if attr is None or attr.code != meta['code']:
                    raise ValueError('Свойство недоступно')
                rules = [r for r in rules_for(db, p) if r.attribute_id == attr.id]
                if not rules or digest([r.definition for r in rules]) != meta['rules']:
                    raise ValueError('Структура категории изменилась; выгрузите новый файл')
                definitions = [RuleDefinition.model_validate(r.definition) for r in rules]
                if not any(d.level in ('required', 'conditional') or d.required_for_selection for d in definitions):
                    raise ValueError('Свойство больше не относится к обязательным')
                value = parse_value(cells[VALUE], attr.value_type)
                normalized = [normalize(value, d) for d in definitions]
                if any(v != normalized[0] for v in normalized):
                    raise ValueError('Противоречивые правила нормализации категорий')
                value = normalized[0]
                if value in (None, '', []):
                    raise ValueError('Нормализованное значение не должно быть пустым')
                source = str(cells[SOURCE]).strip()
                entry = ProductAttributeInput(value_state='known', value=value, source_url=source,
                    source_kind='retailer_site' if _approved_retailer(source) else
                    'manufacturer_document' if '.pdf' in source.lower() else 'manufacturer_site')
                row = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == p.id,
                    ProductAttribute.attribute_id == attr.id).with_for_update())
                if row and row.value_state == 'known' and _stored_attribute_value(row, attr) == value:
                    skipped += 1; continue
                if digest(snapshot(row)) != meta['old'] or not missing(row, attr, definitions):
                    raise ValueError('Значение изменилось после выгрузки; перезапись запрещена')
                if row and not preserves_known_details(_stored_attribute_value(row, attr), value):
                    raise ValueError('Нельзя удалять или изменять подтверждённые параметры JSON')
                changes.append(dict(product=p, attribute=attr, row=row, before=snapshot(row),
                    value=value, source_url=entry.source_url, source_kind=entry.source_kind,
                    note=str(cells[NOTE])[:2000], rules=definitions, sheet=sheet_name, line=index+1))
            except (ValueError, TypeError, KeyError, ArithmeticError) as exc:
                errors.append(dict(sheet=sheet_name, row=index+1, message=str(exc)[:500]))
    if total == 0:
        raise HTTPException(422, 'В файле нет листов с характеристиками')
    # Conditions are checked against the complete proposed batch, including dependent values.
    by_product = defaultdict(list)
    for item in changes:
        by_product[item['product'].id].append(item)
    for pid, items in by_product.items():
        values = {a.code: {'state': r.value_state, 'value': _stored_attribute_value(r, a)}
            for r, a in db.execute(select(ProductAttribute, Attribute).join(Attribute)
                .where(ProductAttribute.product_id == pid))}
        values.update({x['attribute'].code: {'state': 'known', 'value': x['value']} for x in items})
        for item in items:
            if not all(applicable(d, values) for d in item['rules']):
                errors.append(dict(sheet=item['sheet'], row=item['line'], message='Условие применимости свойства не подтверждено'))
    return changes, errors, skipped


def spreadsheet_router(admin_dependency, csrf_dependency):
    router = APIRouter(prefix='/api/v1/admin/catalog/property-file', dependencies=[Depends(admin_dependency)])

    @router.get('/export')
    def download(category_id: int | None = None, q: str = '', scope: str = 'either', archive: bool = False, db=Depends(get_db)):
        if scope not in ('required', 'selection', 'either'):
            raise HTTPException(422, 'Неизвестный вид обязательных свойств')
        data, count = export_xls(db, category_id, q, scope, archive=archive)
        extension = 'zip' if archive else 'xls'
        return Response(data, media_type='application/zip' if archive else 'application/vnd.ms-excel', headers={
            'Content-Disposition': f'attachment; filename="corelab-missing-properties.{extension}"',
            'X-Property-Rows': str(count), 'Cache-Control': 'no-store'})

    @router.post('/import', dependencies=[Depends(csrf_dependency)])
    async def upload(request: Request, apply: bool = False, user=Depends(admin_dependency), db=Depends(get_db)):
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > MAX_BYTES:
                raise HTTPException(413, 'Максимальный размер XLS или ZIP — 20 МБ')
        lock_validation(db)
        changes, errors, skipped = import_plan(db, bytes(data))
        plan_key = canonical(dict(file=hashlib.sha256(data).hexdigest(), org=db.info['organization_id'],
            user=user.id, changes=[(x['product'].id, x['attribute'].id, x['value'], digest(x['before'])) for x in changes]))
        token = signature(plan_key)
        if apply and not hmac.compare_digest(token, request.headers.get('X-Import-Preview', '')):
            raise HTTPException(409, 'Предварительный результат изменился. Проверьте файл ещё раз.')
        if errors or not apply:
            return dict(applied=0, properties=len(changes), products=len({x['product'].id for x in changes}),
                skipped=skipped, errors=errors[:200], error_count=len(errors), can_apply=bool(changes) and not errors,
                preview_token=token, items=[dict(product=x['product'].name, property=x['attribute'].label,
                    value=x['value']) for x in changes[:100]])
        audit_changes = []
        for item in changes:
            row, attr = item['row'], item['attribute']
            if row is None:
                row = ProductAttribute(product_id=item['product'].id, attribute_id=attr.id)
                db.add(row)
            for field in ('value_string', 'value_number', 'value_boolean', 'value_json'):
                setattr(row, field, None)
            column = 'value_json' if attr.value_type == 'list' else 'value_number' if attr.value_type in ('number', 'integer') else 'value_boolean' if attr.value_type == 'boolean' else 'value_string'
            setattr(row, column, item['value'])
            row.value_state, row.source_url, row.source_kind = 'known', item['source_url'], item['source_kind']
            row.updated_at = datetime.now(timezone.utc)
            audit_changes.append(dict(product_id=item['product'].id, code=attr.code, before=item['before'],
                after=item['value'], source_url=row.source_url, note=item['note']))
        db.flush()
        for item in changes:
            actual = _stored_attribute_value(db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == item['product'].id,
                ProductAttribute.attribute_id == item['attribute'].id)), item['attribute'])
            if any(normalize(actual, d) != item['value'] for d in item['rules']):
                raise HTTPException(422, 'Сохранённое значение не прошло повторную нормализацию')
        products = {x['product'].id: x['product'] for x in changes}
        for product in products.values():
            revalidate_product(db, product)
        db.add(AuditLog(user_id=user.id, action='properties.xls_missing_imported', object_type='products',
            object_id=','.join(map(str, products))[:160], details=json.loads(canonical(dict(
                file_sha256=hashlib.sha256(data).hexdigest(), product_ids=list(products),
                api_calls=0, changes=audit_changes)))))
        db.commit()
        return dict(applied=len(changes), products=len(products), skipped=skipped, errors=[], error_count=0)

    return router
