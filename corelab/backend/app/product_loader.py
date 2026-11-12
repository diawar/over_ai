"""Durable property-loading jobs with an approved retail fallback."""
from .kimi import active_provider
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .ai_research import _approved_retailer, decrypt_key
from .catalog_views import _source_id
from .db import SessionLocal, get_db
from .models import (AIProviderSetting, Attribute, AuditLog, Category, CategoryAttribute,
                     Job, JobItem, Product, ProductAttribute, PropertyRule, product_categories)
from .product_research import research_product
from .property_engine import RuleDefinition, normalize
from .connector_inventory import normalize_connector_inventory
from .property_service import GLOBAL_FIELD_CODES, definition, has_technical_values, structure_report
from .validity import lock_validation, revalidate_product
from .cooling_inventory import COOLING_CODES, normalize_cooling_inventory


PILOT_LIMIT = 5
MAX_ATTEMPTS = 3


def _job_view(db, job):
    items = list(db.scalars(select(JobItem).where(JobItem.job_id == job.id).order_by(JobItem.id)))
    return {"id": job.id, "status": job.status, "total": job.total, "completed": job.completed,
            "skipped": job.skipped, "failed": job.failed,
            "items": [{"product_id": item.product_id, "status": item.status,
                       "reason": (item.details or {}).get("reason"),
                       "property_count": (item.details or {}).get("property_count", 0)} for item in items]}


def _finish(db, item, status, reason, count=0):
    item.status = status
    item.details = {**(item.details or {}), "reason": reason[:500], "property_count": count}
    job = db.get(Job, item.job_id)
    db.flush()
    states = dict(db.execute(select(JobItem.status, func.count(JobItem.id)).where(
        JobItem.job_id == job.id).group_by(JobItem.status)).all())
    job.completed = states.get("completed", 0)
    job.skipped = states.get("skipped", 0)
    job.failed = states.get("failed", 0)
    job.status = "completed" if sum(states.get(s, 0) for s in ("completed", "skipped", "failed")) == job.total else "running"
    db.add(AuditLog(action=f"properties.ai_load_{status}", object_type="product", object_id=str(item.product_id),
                    details={"job_id": job.id, "category_id": (item.details or {}).get("category_id"),
                             "reason": reason[:500], "property_count": count,
                             "source_url": (item.details or {}).get("source_url")}))
    db.commit()


def _eligible_rules(db, category_id):
    rows = list(db.scalars(select(PropertyRule).where(
        PropertyRule.category_id == category_id, PropertyRule.source == "internal", PropertyRule.active.is_(True))))
    blocked_links = set(db.scalars(select(CategoryAttribute.attribute_id).where(
        CategoryAttribute.category_id == category_id, CategoryAttribute.ai_blocked.is_(True))))
    selected = {r.code: (r, RuleDefinition.model_validate(definition(r))) for r in rows
                if r.attribute_id is not None and r.attribute_id not in blocked_links and not definition(r)["ai_blocked"]}
    globals_ = list(db.scalars(select(PropertyRule).where(PropertyRule.scope == "global",
        PropertyRule.source == "gmc", PropertyRule.active.is_(True))))
    for row in globals_:
        if row.code not in selected and not definition(row)["ai_blocked"]:
            selected[row.code] = (row, RuleDefinition.model_validate(definition(row)))
    return selected


def _value_snapshot(db, product_id, codes):
    return {attr.code: (row.value_state, row.value_string, row.value_number, row.value_boolean,
                       row.value_json, row.source_url, row.source_kind, row.updated_at)
            for row, attr in db.execute(select(ProductAttribute, Attribute).join(Attribute).where(
                ProductAttribute.product_id == product_id, Attribute.code.in_(codes)))}


def _merge_header_evidence(old, new):
    """New evidence may enrich a count, never silently contradict an old count."""
    old = normalize_cooling_inventory('motherboard_fan_headers', old)
    new = normalize_cooling_inventory('motherboard_fan_headers', new)
    # A shorter specification may omit a previously verified pump capability.
    # Retain the richer physical group instead of appending it a second time.
    for previous in old:
        previous_roles = set(previous.get('roles', []))
        candidates = [index for index, row in enumerate(new) if previous_roles and
            set(row.get('roles', [])) < previous_roles and row['count'] == previous['count'] and
            (not previous.get('header_ids') or not row.get('header_ids') or
             set(previous['header_ids']) & set(row['header_ids']))]
        if len(candidates) == 1:
            new[candidates[0]] = previous
    for role in ('system_fan', 'cpu_fan', 'cpu_opt', 'pump'):
        previous = [row for row in old if role in row.get('roles', []) or row['kind'] == role + '_header']
        if not previous:
            continue
        current = [row for row in new if role in row.get('roles', []) or row['kind'] == role + '_header']
        if not current:
            new.extend(previous)
        elif sum(row['count'] for row in previous) not in {
                sum(row['count'] for row in current),
                sum(row['count'] for row in current if role == 'system_fan' and 'pump' not in row.get('roles', []))}:
            raise HTTPException(409, f'Новый перечень разъёмов противоречит сохранённому количеству {role}')
    return normalize_cooling_inventory('motherboard_fan_headers', new)


def _preflight(db, product_id, category_id, expected_fingerprint=None, fill_missing_codes=None):
    lock_validation(db)
    product = db.scalar(select(Product).where(Product.id == product_id).with_for_update())
    category = db.get(Category, category_id)
    if product is None or category is None or category not in product.categories:
        raise HTTPException(409, "Товар больше не относится к выбранной категории")
    if len(product.categories) != 1:
        raise HTTPException(409, "Для загрузки свойств товар должен быть связан ровно с одной категорией")
    report = structure_report(db, category_id)
    if not report["ai_load_allowed"] or expected_fingerprint and report["fingerprint"] != expected_fingerprint:
        raise HTTPException(409, "Структура категории изменилась или не прошла проверку")
    if fill_missing_codes is not None and (not isinstance(fill_missing_codes, list) or not fill_missing_codes or
            not all(isinstance(code, str) and code in COOLING_CODES for code in fill_missing_codes)):
        raise HTTPException(422, 'Некорректный перечень подключений для дозаполнения')
    if fill_missing_codes is None and has_technical_values(db, product_id):
        raise HTTPException(409, "Карточка уже содержит технические свойства; загрузка разрешена только при их отсутствии")
    if not product.manufacturer or not product.manufacturer_article:
        raise HTTPException(422, "Нет точного производителя или артикула")
    rules = _eligible_rules(db, category_id)
    if fill_missing_codes is not None:
        known = set(db.scalars(select(Attribute.code).join(ProductAttribute).where(
            ProductAttribute.product_id == product_id, ProductAttribute.value_state == 'known')))
        rules = {code: value for code, value in rules.items() if code in fill_missing_codes and
                 (code not in known or code == 'motherboard_fan_headers')}
    if not rules:
        raise HTTPException(409, "Нет разрешённых для ИИ технических свойств")
    return product, category, report["fingerprint"], rules


def enqueue(db, product_ids, category_id, user_id, *, fill_missing_codes=None):
    if active_provider(db, db.info.get("organization_id", 1)) is None:
        raise HTTPException(409, "ИИ выключен или API-ключ не задан в настройках")
    if len(product_ids) > PILOT_LIMIT:
        raise HTTPException(422, "За один запуск можно проверить не более пяти товаров")
    job = Job(job_type="property_load", status="queued", total=len(product_ids))
    db.add(job); db.flush()
    for product_id in product_ids:
        db.add(JobItem(job_id=job.id, product_id=product_id, status="queued",
                       details={"category_id": category_id, "attempt": 0,
                                **({'fill_missing_codes': fill_missing_codes} if fill_missing_codes is not None else {})}))
    db.add(AuditLog(user_id=user_id, action="properties.ai_load_queued", object_type="category",
                    object_id=str(category_id), details={"job_id": job.id, "product_ids": product_ids,
                        **({'fill_missing_codes': fill_missing_codes} if fill_missing_codes is not None else {})}))
    db.commit()
    return _job_view(db, job)


def process_one(db_factory=SessionLocal, *, researcher=None):
    with db_factory() as db:
        item = db.scalar(select(JobItem).join(Job).where(Job.job_type == "property_load",
                         JobItem.status == "queued").order_by(JobItem.id).with_for_update(skip_locked=True))
        if item is None:
            return False
        db.info["organization_id"] = item.organization_id
        item.status = "running"
        details = dict(item.details or {})
        details["attempt"] = details.get("attempt", 0) + 1
        item.details = details
        db.get(Job, item.job_id).status = "running"
        db.commit()
        item_id = item.id

    with db_factory() as db:
        item = db.get(JobItem, item_id)
        db.info["organization_id"] = item.organization_id
        category_id = item.details["category_id"]
        fill_missing_codes = item.details.get('fill_missing_codes')
        result = None
        try:
            product, category, fingerprint, rules = _preflight(db, item.product_id, category_id,
                fill_missing_codes=fill_missing_codes)
            before_values = _value_snapshot(db, product.id, fill_missing_codes) if fill_missing_codes is not None else None
            snapshot = {"name": product.name, "manufacturer": product.manufacturer,
                        "article": product.manufacturer_article}
            if fill_missing_codes is not None:
                snapshot["known_sources"] = list(db.scalars(select(ProductAttribute.source_url).where(
                    ProductAttribute.product_id == product.id, ProductAttribute.source_url.is_not(None)).distinct()))
            category_name = category.name
            provider = active_provider(db, db.info.get("organization_id", 1))
            if provider is None:
                raise HTTPException(409, "Не задан ключ ИИ в настройках")
            api_key, model_id = decrypt_key(provider.encrypted_api_key), provider.model_id
            provider_options = {"provider": provider.provider} if provider.provider != "openai" else {}
            db.rollback()

            result = (researcher or research_product)(api_key, model_id, snapshot, category_name,
                                      [r.model_dump(mode="json") for _, r in rules.values()], **provider_options)
            if not result["values"]:
                raise HTTPException(422, "В разрешённых источниках нет подтверждённых значений")
            normalized = []
            conservative_shared_bound = False
            for found in result["values"]:
                row, rule = rules[found["code"]]
                try:
                    value = normalize(normalize_connector_inventory(found["code"], found["value"]), rule)
                except (TypeError, ValueError) as exc:
                    raise HTTPException(422, f"Свойство {rule.code} не прошло нормализацию: {exc}") from exc
                normalized.append((found["code"], value, found["source_url"], bool(found.get("derived"))))
            if category_id == 432 and 'case_drive_bays_shared_25_35' in rules and not any(
                    code == 'case_drive_bays_shared_25_35' for code, _, _, _ in normalized):
                case_counts = {code: value for code, value, _, _ in normalized
                               if code in ('case_drive_bays_25', 'case_drive_bays_35')}
                if len(case_counts) == 2 and all(type(value) is int and value >= 0
                                                 for value in case_counts.values()):
                    bound = min(case_counts.values())
                    normalized.append(('case_drive_bays_shared_25_35', bound,
                                       result['source_url'], False))
                    conservative_shared_bound = True
            if not any(rules[code][0].category_id == category_id for code, _, _, _ in normalized):
                raise HTTPException(422, "В разрешённых источниках нет подтверждённых технических свойств категории")

            product, _, _, current_rules = _preflight(db, item.product_id, category_id, fingerprint,
                fill_missing_codes=fill_missing_codes)
            if before_values is not None and before_values != _value_snapshot(db, product.id, fill_missing_codes):
                raise HTTPException(409, 'Подключения товара изменились во время исследования; новые значения не записаны')
            if (product.name, product.manufacturer, product.manufacturer_article) != (
                    snapshot["name"], snapshot["manufacturer"], snapshot["article"]):
                raise HTTPException(409, "Наименование или модель товара изменились во время исследования")
            if any(code not in current_rules for code, _, _, _ in normalized):
                raise HTTPException(409, "Блокировки свойств изменились во время исследования")
            saved_count = 0
            for code, value, url, derived in normalized:
                rule_row, rule = current_rules[code]
                if derived and code != "description":
                    raise HTTPException(422, "Производное значение разрешено только для описания")
                if code == "image_link":
                    if not product.image_url:
                        product.image_url = value
                        saved_count += 1
                    continue
                if code == "mpn":
                    if str(value).strip().casefold() != product.manufacturer_article.strip().casefold():
                        raise HTTPException(422, "Код производителя не совпадает с артикулом")
                    continue
                if code in ("condition", "warranty_months") and rule.default_value is not None and value == rule.default_value:
                    continue
                attr = db.get(Attribute, rule_row.attribute_id) if rule_row.attribute_id else db.scalar(
                    select(Attribute).where(Attribute.code == code))
                if attr is None:
                    attr = Attribute(code=code, label=rule.label, value_type=rule.value_type,
                                     unit=rule.unit, normalization=rule.normalization)
                    db.add(attr); db.flush()
                elif attr.value_type != rule.value_type or attr.unit != rule.unit:
                    raise HTTPException(409, f"Тип глобального свойства {code} изменился")
                if rule_row.category_id is None and db.scalar(select(ProductAttribute.id).where(
                        ProductAttribute.product_id == product.id,
                        ProductAttribute.attribute_id == attr.id).limit(1)):
                    continue
                retailer = _approved_retailer(url)
                source_kind = ('conservative_bound' if conservative_shared_bound and
                               code == 'case_drive_bays_shared_25_35' else
                               ("ai_retailer" if derived else "retailer_site") if retailer else
                               ("ai_official" if derived else "manufacturer_site"))
                row = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
                    ProductAttribute.attribute_id == attr.id)) if fill_missing_codes is not None else None
                if row is not None and row.value_state == 'known':
                    if code != 'motherboard_fan_headers':
                        continue
                    previous = row.value_json
                    value = _merge_header_evidence(previous, value)
                    db.add(AuditLog(action='properties.cooling_headers_enriched', object_type='product',
                        object_id=str(product.id), details={'previous': previous, 'previous_source_url': row.source_url,
                                                          'value': value, 'source_url': url, 'job_id': item.job_id}))
                row = row or ProductAttribute(product_id=product.id, attribute_id=attr.id)
                row.value_state, row.source_kind, row.source_url = 'known', source_kind, url
                row.updated_at = datetime.now(timezone.utc)
                row.value_string = row.value_number = row.value_boolean = row.value_json = None
                if rule.value_type in ("string", "enum", "url"):
                    row.value_string = value
                elif rule.value_type in ("number", "integer"):
                    row.value_number = value
                elif rule.value_type == "boolean":
                    row.value_boolean = value
                else:
                    row.value_json = value
                db.add(row)
                saved_count += 1
            revalidate_product(db, product)
            db.flush()
            item.details = {**(item.details or {}), "source_url": result.get("source_url") or normalized[0][2],
                            **({"researched_values": result["values"]} if fill_missing_codes is not None else {})}
            _finish(db, item, "completed", "Свойства сохранены из разрешённого источника", saved_count)
        except HTTPException as exc:
            db.rollback()
            item = db.get(JobItem, item_id)
            if result is not None and fill_missing_codes is not None:
                item.details = {**item.details, "researched_values": result.get("values", [])}
            reason = str(exc.detail)[:500]
            if exc.status_code in (502, 503, 504) and item.details.get("attempt", 0) < MAX_ATTEMPTS:
                item.status = "queued"
                item.details = {**item.details, "reason": reason}
                db.commit()
            else:
                _finish(db, item, "failed" if exc.status_code in (429, 500, 502, 503, 504) else "skipped", reason)
        except Exception:
            db.rollback()
            item = db.get(JobItem, item_id)
            _finish(db, item, "failed", "Непредвиденная ошибка загрузчика; проверьте журнал")
    return True


async def run_worker(stop):
    while not stop.is_set():
        try:
            worked = await asyncio.to_thread(process_one)
        except Exception:
            worked = False
        if not worked:
            try:
                await asyncio.wait_for(stop.wait(), timeout=3)
            except asyncio.TimeoutError:
                pass


def load_router(admin_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/properties", dependencies=[Depends(admin_dependency)])

    @router.get("/categories/{category_id}/load")
    def category_load_status(category_id: int, db: Session = Depends(get_db)):
        job = db.scalar(select(Job).join(JobItem).where(Job.job_type == "property_load",
            JobItem.details["category_id"].as_integer() == category_id).order_by(Job.id.desc()).limit(1))
        return {"job": _job_view(db, job) if job else None}

    @router.get("/products/{product_id}/load")
    def product_load_status(product_id: int, db: Session = Depends(get_db)):
        job = db.scalar(select(Job).join(JobItem).where(Job.job_type == "property_load",
            JobItem.product_id == product_id).order_by(Job.id.desc()).limit(1))
        return {"job": _job_view(db, job) if job else None}

    @router.post("/categories/{category_id}/load", dependencies=[Depends(csrf_dependency)])
    def load_category(category_id: int, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        category = db.get(Category, category_id)
        if category is None or category.source_id != _source_id(db):
            raise HTTPException(404, "Категория не найдена")
        if not structure_report(db, category_id)["ai_load_allowed"]:
            raise HTTPException(409, "Сначала проверьте структуру категории")
        ids = list(db.scalars(select(Product.id).join(product_categories).where(
            product_categories.c.category_id == category_id, Product.is_archived.is_not(True),
            ~Product.id.in_(select(ProductAttribute.product_id).join(Attribute).where(
                Attribute.code.notin_(GLOBAL_FIELD_CODES))),
            ~Product.id.in_(select(JobItem.product_id).join(Job).where(Job.job_type == "property_load",
                                                       JobItem.status.in_(["queued", "running"]))))
            .order_by(Product.id).limit(PILOT_LIMIT)))
        if not ids:
            raise HTTPException(409, "Нет пустых карточек для пробной загрузки")
        return enqueue(db, ids, category_id, user.id)

    @router.post("/products/{product_id}/load", dependencies=[Depends(csrf_dependency)])
    def load_product(product_id: int, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        product = db.get(Product, product_id)
        if product is None or product.source_id != _source_id(db):
            raise HTTPException(404, "Товар не найден")
        if has_technical_values(db, product_id):
            raise HTTPException(409, "Карточка уже содержит технические свойства")
        eligible = [c.id for c in product.categories if structure_report(db, c.id)["ai_load_allowed"]]
        if len(eligible) != 1 or len(product.categories) != 1:
            raise HTTPException(409, "Для товара нужна одна категория с проверенной структурой")
        existing = db.scalar(select(JobItem.id).join(Job).where(Job.job_type == "property_load",
            JobItem.product_id == product_id, JobItem.status.in_(["queued", "running"])))
        if existing:
            raise HTTPException(409, "Товар уже ожидает загрузки")
        return enqueue(db, [product_id], eligible[0], user.id)

    @router.get("/jobs/{job_id}")
    def get_job(job_id: int, db: Session = Depends(get_db)):
        job = db.get(Job, job_id)
        if job is None or job.job_type != "property_load":
            raise HTTPException(404, "Задание не найдено")
        return _job_view(db, job)

    return router
