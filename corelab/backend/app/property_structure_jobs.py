"""Durable background jobs for AI-generated category property structures."""
import asyncio
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session

from .ai_research import decrypt_key, research_category
from .catalog_views import _source_id
from .db import SessionLocal, get_db
from .kimi import active_provider
from .models import (Attribute, AuditLog, Category, CategoryStructureCheck,
                     Job, JobItem, Product, PropertyRule, User, product_categories)
from .property_engine import RuleDefinition
from .property_service import attach_rule, definition, structure_report
from .validity import lock_validation, revalidate_category


def _job_view(job, item):
    details = item.details or {}
    return {"id": job.id, "status": item.status, "stage": details.get("stage"),
            "error": details.get("error"), "diagnostics": details.get("diagnostics"),
            "result": details.get("result"),
            "created_at": job.created_at.isoformat() if job.created_at else None}


def _latest_job(db, category_id):
    return db.scalar(select(Job).join(JobItem).where(
        Job.job_type == "property_structure",
        JobItem.details["category_id"].as_integer() == category_id,
    ).order_by(Job.id.desc()).limit(1))


def _job_item(db, job):
    return db.scalar(select(JobItem).where(JobItem.job_id == job.id).limit(1)) if job else None


def popular_category_manufacturers(db, category_id: int, limit: int = 5) -> list[str]:
    rows = db.execute(
        select(Product.manufacturer, func.count(distinct(Product.id)).label("product_count"))
        .join(product_categories, product_categories.c.product_id == Product.id)
        .where(product_categories.c.category_id == category_id,
               Product.manufacturer.is_not(None), func.trim(Product.manufacturer) != "")
        .group_by(Product.manufacturer)
        .order_by(func.count(distinct(Product.id)).desc(), func.lower(Product.manufacturer), Product.manufacturer)
        .limit(limit)
    )
    return [manufacturer for manufacturer, _ in rows]


def structure_job_router(admin_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/properties", dependencies=[Depends(admin_dependency)])

    @router.get("/categories/{category_id}/generate")
    def get_structure_job(category_id: int, db: Session = Depends(get_db)):
        cat = db.get(Category, category_id)
        if cat is None or cat.source_id != _source_id(db):
            raise HTTPException(404, "Категория не найдена")
        job = _latest_job(db, category_id)
        return {"job": _job_view(job, _job_item(db, job)) if job else None}

    @router.post("/categories/{category_id}/generate", dependencies=[Depends(csrf_dependency)])
    def enqueue_structure(category_id: int, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        lock_validation(db)
        cat = db.scalar(select(Category).where(Category.id == category_id).with_for_update())
        if cat is None or cat.source_id != _source_id(db):
            raise HTTPException(404, "Категория не найдена")
        active = db.scalar(select(Job).join(JobItem).where(
            Job.job_type == "property_structure",
            JobItem.details["category_id"].as_integer() == category_id,
            JobItem.status.in_(["queued", "running"]),
        ).order_by(Job.id.desc()).limit(1))
        if active:
            return _job_view(active, _job_item(db, active))
        local_rules = list(db.scalars(select(PropertyRule).where(
            PropertyRule.scope == str(category_id), PropertyRule.source == "internal", PropertyRule.active.is_(True))))
        if local_rules:
            raise HTTPException(409, "ИИ-формирование доступно для пустой категории. Сначала проверьте существующие свойства")
        provider = active_provider(db, db.info.get("organization_id", 1))
        if provider is None:
            raise HTTPException(409, "ИИ выключен или API-ключ не задан в разделе «Настройки»")
        job = Job(job_type="property_structure", status="queued", total=1)
        db.add(job)
        db.flush()
        item = JobItem(job_id=job.id, status="queued", details={
            "category_id": category_id, "user_id": user.id, "stage": "queued",
        })
        db.add(item)
        db.add(AuditLog(user_id=user.id, action="properties.ai_structure_queued",
                        object_type="category", object_id=str(category_id),
                        details={"job_id": job.id, "status": "queued"}))
        db.commit()
        return _job_view(job, item)

    @router.get("/structure-jobs/{job_id}")
    def get_structure_job_by_id(job_id: int, db: Session = Depends(get_db)):
        job = db.get(Job, job_id)
        if job is None or job.job_type != "property_structure":
            raise HTTPException(404, "Задание не найдено")
        item = _job_item(db, job)
        if item is None:
            raise HTTPException(404, "Задание не найдено")
        return _job_view(job, item)

    return router


def process_one(db_factory=SessionLocal):
    with db_factory() as db:
        item = db.scalar(select(JobItem).join(Job).where(
            Job.job_type == "property_structure", JobItem.status == "queued"
        ).order_by(JobItem.id).with_for_update(skip_locked=True))
        if item is None:
            return False
        db.info["organization_id"] = item.organization_id
        item.status = "running"
        item.details = {**(item.details or {}), "stage": "researching"}
        db.get(Job, item.job_id).status = "running"
        db.add(AuditLog(user_id=(item.details or {}).get("user_id"),
                        action="properties.ai_structure_started", object_type="category",
                        object_id=str((item.details or {}).get("category_id")),
                        details={"job_id": item.job_id, "status": "running"}))
        db.commit()
        item_id = item.id

    with db_factory() as db:
        item = db.get(JobItem, item_id)
        db.info["organization_id"] = item.organization_id
        details = dict(item.details or {})
        category_id = details["category_id"]
        try:
            lock_validation(db)
            cat = db.scalar(select(Category).where(Category.id == category_id).with_for_update())
            if cat is None or cat.source_id != _source_id(db):
                raise HTTPException(404, "Категория не найдена")
            category_name = cat.name
            local_rules = list(db.scalars(select(PropertyRule).where(
                PropertyRule.scope == str(category_id), PropertyRule.source == "internal",
                PropertyRule.active.is_(True))))
            if local_rules:
                raise HTTPException(409, "В категории появились свойства, пока шло исследование. Результат не записан")
            manufacturers = popular_category_manufacturers(db, category_id)
            provider = active_provider(db, db.info.get("organization_id", 1))
            if provider is None:
                raise HTTPException(409, "Не задан ключ ИИ в настройках")
            api_key, model_id = decrypt_key(provider.encrypted_api_key), provider.model_id
            provider_options = {"provider": provider.provider} if provider.provider != "openai" else {}
            db.rollback()

            research = research_category(api_key, model_id, category_name, manufacturers, **provider_options)
            result = research["result"]
            model_names = {model["model"] for model in result["models"]}
            definitions = []
            skipped_properties = []
            for found in result["properties"]:
                named_models = found.get("model_names")
                cited_models = ([name for name in named_models if name in model_names]
                                if isinstance(named_models, list) else [])
                if not cited_models:
                    skipped_properties.append({"code": found.get("code"), "label": found.get("label"),
                                                "reason": "Не указана подтверждающая модель из исследования",
                                                "reported_model_names": [name[:120] for name in named_models[:5]
                                                                         if isinstance(name, str)]
                                                if isinstance(named_models, list) else [],
                                                "evidence_url": str(found.get("evidence_url") or "")[:300]})
                    continue
                try:
                    definitions.append(RuleDefinition.model_validate({
                        "code": found["code"], "label": found["label"].strip(), "source": "internal",
                        "level": "recommended", "value_type": found["value_type"], "unit": found["unit"],
                        "evidence_url": found["evidence_url"], "checked_on": date.today().isoformat(),
                        "note": found["description"].strip() + " Подтверждено на моделях: " + ", ".join(cited_models),
                        "required_for_selection": False, "ai_blocked": False,
                    }))
                except (ValidationError, KeyError, AttributeError) as exc:
                    raise HTTPException(422, "Одно из предложенных ИИ свойств не прошло проверку") from exc
            if not definitions:
                raise HTTPException(422, {"message": "ИИ не указал подтверждающие модели ни для одного свойства",
                                          "considered_models": [str(model.get("model") or "")[:120]
                                                                for model in result["models"][:5]],
                                          "model_pages": [{"model": str(model.get("model") or "")[:120],
                                                           "url": str(model.get("url") or "")[:300]}
                                                          for model in result["models"][:5]],
                                          "skipped_properties": skipped_properties[:10]})

            lock_validation(db)
            cat = db.scalar(select(Category).where(Category.id == category_id).with_for_update())
            if cat is None or cat.source_id != _source_id(db):
                raise HTTPException(404, "Категория не найдена")
            local_rules = list(db.scalars(select(PropertyRule).where(
                PropertyRule.scope == str(category_id), PropertyRule.source == "internal",
                PropertyRule.active.is_(True))))
            if local_rules:
                raise HTTPException(409, "Пока шло исследование, структура категории изменилась. Результат не записан")
            compatible_definitions = []
            for definition_item in definitions:
                attr = db.scalar(select(Attribute).where(Attribute.code == definition_item.code))
                if attr and (attr.value_type != definition_item.value_type or attr.unit != definition_item.unit
                             or (attr.normalization or {}) != definition_item.normalization):
                    skipped_properties.append({"code": definition_item.code, "label": definition_item.label,
                                                "reason": "Код занят атрибутом с другим типом, единицей или нормализацией"})
                    continue
                compatible_definitions.append(definition_item)
            if not compatible_definitions:
                raise HTTPException(422, {"message": "Все свойства конфликтуют с существующими атрибутами",
                                          "skipped_properties": skipped_properties[:10]})
            created = []
            for definition_item in compatible_definitions:
                collision = db.scalar(select(PropertyRule).where(
                    PropertyRule.scope == str(category_id), PropertyRule.source == "internal",
                    PropertyRule.code == definition_item.code))
                if collision and collision.active:
                    raise HTTPException(409, f"Код свойства {definition_item.code} уже появился в категории; результат не записан")
                created.append(attach_rule(db, category_id, definition_item, existing=collision))
            revalidate_category(db, category_id)
            research_record = {"models": result["models"], "citations": research["citations"],
                               "model_id": model_id, "property_count": len(created),
                               "skipped_properties": skipped_properties,
                               "checked_at": datetime.now(timezone.utc).isoformat()}
            saved = db.get(CategoryStructureCheck, category_id)
            if saved is None:
                saved = CategoryStructureCheck(category_id=category_id, fingerprint="", report={})
                db.add(saved)
            saved.report = {"research": research_record}
            db.flush()
            report = structure_report(db, category_id)
            saved.fingerprint = report["fingerprint"]
            saved.report = {**report, "research": research_record}
            user = db.get(User, details.get("user_id")) if details.get("user_id") else None
            source_urls = list(dict.fromkeys(
                [model["url"] for model in result["models"] if isinstance(model, dict) and model.get("url")] +
                [definition_item.evidence_url for definition_item in compatible_definitions if definition_item.evidence_url]
            ))
            db.add(AuditLog(user_id=user.id if user else None, action="properties.ai_structure_generated",
                            object_type="category", object_id=str(category_id), details={
                                "job_id": item.job_id, "status": "completed", "model_id": model_id, "models": result["models"],
                                "citations": research["citations"], "source_urls": source_urls,
                                "property_codes": [row.code for row in compatible_definitions],
                            }))
            saved_result = {"created": len(created), "models": result["models"],
                            "properties": [definition(row) for row in created],
                            "skipped_properties": skipped_properties,
                            "research": research_record, "check": structure_report(db, category_id)}
            item.status = "completed"
            item.details = {**details, "stage": "completed", "result": saved_result}
            job = db.get(Job, item.job_id)
            job.status = "completed"
            job.completed = 1
            db.commit()
        except HTTPException as exc:
            db.rollback()
            item = db.get(JobItem, item_id)
            job = db.get(Job, item.job_id)
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            message = detail.get("message", "Ошибка исследования свойств") if detail else str(exc.detail)
            diagnostics = {key: detail[key] for key in ("rejected_model", "considered_models", "reason", "url",
                                                       "model_pages", "skipped_properties") if detail.get(key)}
            error = message
            if diagnostics.get("rejected_model"):
                error += f"; отклонена модель: {diagnostics['rejected_model']}"
            if diagnostics.get("reason"):
                error += f"; причина: {diagnostics['reason']}"
            if diagnostics.get("considered_models"):
                error += "; рассмотрены: " + ", ".join(diagnostics["considered_models"])
            item.status = "failed"
            item.details = {**(item.details or {}), "stage": "failed", "error": error[:1000], "diagnostics": diagnostics}
            job.status = "failed"
            job.failed = 1
            db.add(AuditLog(user_id=(item.details or {}).get("user_id"),
                            action="properties.ai_structure_failed", object_type="category",
                            object_id=str((item.details or {}).get("category_id")),
                            details={"job_id": item.job_id, "status": "failed", "error": error[:1000], **diagnostics}))
            db.commit()
        except Exception as exc:
            db.rollback()
            item = db.get(JobItem, item_id)
            job = db.get(Job, item.job_id)
            error = "Не удалось завершить исследование. Проверьте журналы сервера."
            item.status = "failed"
            item.details = {**(item.details or {}), "stage": "failed",
                            "error": error}
            job.status = "failed"
            job.failed = 1
            db.add(AuditLog(user_id=(item.details or {}).get("user_id"),
                            action="properties.ai_structure_failed", object_type="category",
                            object_id=str((item.details or {}).get("category_id")),
                            details={"job_id": item.job_id, "status": "failed", "error": error,
                                     "exception_type": type(exc).__name__}))
            db.commit()
    return True


async def run_worker(stop):
    while not stop.is_set():
        try:
            worked = await asyncio.to_thread(process_one)
        except Exception:
            worked = False
        if not worked:
            try:
                await asyncio.wait_for(stop.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
