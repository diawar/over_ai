"""Read-only, paginated admin journal built from durable audit and job rows."""

from datetime import date, datetime, time, timezone
import re
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from .db import get_db
from .models import AuditLog, ImportLog, Job, JobItem, User


SAFE_LOAD_REASONS = {
    "Товар больше не относится к выбранной категории",
    "Для загрузки свойств товар должен быть связан ровно с одной категорией",
    "Структура категории изменилась или не прошла проверку",
    "Карточка уже содержит технические свойства; загрузка разрешена только при их отсутствии",
    "Нет точного производителя или артикула",
    "Нет разрешённых для ИИ технических свойств",
    "Не задан ключ OpenAI в настройках",
    "На официальном сайте нет подтверждённых значений",
    "На официальном сайте нет подтверждённых технических свойств категории",
    "Наименование или модель товара изменились во время исследования",
    "Блокировки свойств изменились во время исследования",
    "Производное значение разрешено только для описания",
    "Код производителя не совпадает с артикулом",
    "Непредвиденная ошибка загрузчика; проверьте журнал",
}


def _safe_reason(value):
    return value if isinstance(value, str) and value in SAFE_LOAD_REASONS else None


def _safe_count(value):
    return value if type(value) is int and 0 <= value <= 1_000_000 else None


def _source_sites(details):
    raw_urls = details.get("source_urls")
    if not isinstance(raw_urls, list):
        models = details.get("models") if isinstance(details.get("models"), list) else []
        raw_urls = [model.get("url") for model in models if isinstance(model, dict)]
    sites = {}
    for value in raw_urls:
        if not isinstance(value, str) or len(value) > 1000:
            continue
        try:
            parts = urlsplit(value)
            host = parts.hostname
        except ValueError:
            continue
        if parts.scheme != "https" or not host or parts.username or parts.password:
            continue
        host = host.casefold().rstrip(".")
        if host:
            sites.setdefault(host, {"url": value, "label": host})
    return list(sites.values())[:10]


SYSTEM_ACTIONS = {"product.validity_changed", "properties.ai_load_completed",
                  "properties.ai_load_skipped", "properties.ai_load_failed",
                  "properties.ai_structure_started", "properties.ai_structure_failed"}


def _initiators(db, job_ids):
    if not job_ids:
        return {}
    rows = db.execute(select(AuditLog.details["job_id"].as_integer(), User.username)
                      .join(User, User.id == AuditLog.user_id)
                      .where(AuditLog.action == "properties.ai_load_queued",
                             AuditLog.details["job_id"].as_integer().in_(job_ids)))
    return {job_id: username for job_id, username in rows}


def _event(row, username=None, initiated_by=None):
    details = row.details if isinstance(row.details, dict) else {}
    action = row.action
    kind = ("structure" if action.startswith("properties.structure_") or action.startswith("properties.ai_structure_") else
            "property" if action.startswith("properties.rule_") or action.startswith("properties.value_") or action in ("properties.template_applied", "properties.values_merged", "product.attribute_changed", "product.attribute_deleted", "product.bulk_attribute_changed") else
            "load" if action.startswith("properties.ai_load_") else
            "validation" if action in ("properties.product_checked", "product.validity_changed") else
            "selection" if action.endswith("selection_changed") else
            "settings" if action.startswith("settings.") else "other")
    status = (action.removeprefix("properties.ai_load_") if kind == "load" else
              details.get("status") if kind == "structure" and details.get("status") in ("queued", "running", "completed", "failed", "success", "warning", "error") else
              "failed" if action == "properties.ai_structure_failed" else
              "running" if action == "properties.ai_structure_started" else "completed")
    reason = (_safe_reason(details.get("reason")) if kind == "load" else
              details.get("error")[:1000] if kind == "structure" and isinstance(details.get("error"), str) else None)
    property_count = _safe_count(details.get("property_count")) if kind == "load" else None
    sources = _source_sites(details) if action == "properties.ai_structure_generated" else []
    job_id = details.get("job_id") if type(details.get("job_id")) is int and details["job_id"] > 0 else None
    object_id = row.object_id if row.object_id and (
        row.object_id.isdecimal() or row.object_id == "openai" or
        row.object_type == "product_attribute" and re.fullmatch(r"\d+:[\w.-]+", row.object_id)
    ) else None
    return {"id": row.id, "action": action, "kind": kind, "status": status,
            "object_type": row.object_type, "object_id": object_id,
            "author": username or details.get("actor_username") or ("Система" if action in SYSTEM_ACTIONS else "Не указан"),
            "initiated_by": initiated_by,
            "created_at": row.created_at.isoformat(), "reason": reason,
            "property_count": property_count, "job_id": job_id,
            "sources": sources,
            "error_count": len(details.get("errors", [])) if isinstance(details.get("errors"), list) else None,
            "warning_count": len(details.get("warnings", [])) if isinstance(details.get("warnings"), list) else None}


def journal_router(admin_dependency):
    router = APIRouter(prefix="/api/v1/admin/logs", dependencies=[Depends(admin_dependency)])

    @router.get("")
    def events(kind: Literal["all", "structure", "property", "load", "validation", "selection", "settings"] = "all",
               status: Literal["all", "completed", "queued", "running", "skipped", "failed", "success", "warning", "error"] = "all",
               date_from: date | None = None, date_to: date | None = None,
               product_id: int | None = Query(default=None, ge=1),
               q: str = Query(default="", max_length=80), page: int = Query(default=1, ge=1),
               page_size: int = Query(default=25, ge=1, le=100), db: Session = Depends(get_db)):
        query = select(AuditLog)
        if kind == "structure":
            query = query.where(or_(AuditLog.action.startswith("properties.structure_"),
                                    AuditLog.action.startswith("properties.ai_structure_")))
        elif kind == "property":
            query = query.where(or_(AuditLog.action.startswith("properties.rule_"),
                                    AuditLog.action.startswith("properties.value_"),
                                    AuditLog.action == "properties.template_applied",
                                    AuditLog.action.in_(("properties.values_merged", "product.attribute_changed", "product.attribute_deleted", "product.bulk_attribute_changed"))))
        elif kind == "load":
            query = query.where(AuditLog.action.startswith("properties.ai_load_"))
        elif kind == "validation":
            query = query.where(AuditLog.action.in_(("properties.product_checked", "product.validity_changed")))
        elif kind == "selection":
            query = query.where(or_(AuditLog.action.endswith("selection_changed"),
                                    AuditLog.action == "category.build_requirement_changed"))
        elif kind == "settings":
            query = query.where(AuditLog.action.startswith("settings."))
        if status != "all":
            if status in ("queued", "skipped", "failed"):
                if status in ("queued", "failed"):
                    query = query.where(or_(AuditLog.action == f"properties.ai_load_{status}",
                                            and_(AuditLog.action.startswith("properties.ai_structure_"),
                                                 AuditLog.details["status"].astext == status)))
                else:
                    query = query.where(AuditLog.action == f"properties.ai_load_{status}")
            elif status == "running":
                query = query.where(AuditLog.action == "properties.ai_structure_started")
            elif status in ("success", "warning", "error"):
                query = query.where(AuditLog.action.startswith("properties.structure_"),
                                    AuditLog.details["status"].astext == status)
            else:
                query = query.where(and_(~AuditLog.action.in_(("properties.ai_load_queued", "properties.ai_load_skipped", "properties.ai_load_failed",
                                                               "properties.ai_structure_queued", "properties.ai_structure_started", "properties.ai_structure_failed")),
                                          or_(~AuditLog.action.startswith("properties.structure_"),
                                              AuditLog.details["status"].astext == "success")))
        if date_from:
            query = query.where(AuditLog.created_at >= datetime.combine(date_from, time.min, timezone.utc))
        if date_to:
            query = query.where(AuditLog.created_at <= datetime.combine(date_to, time.max, timezone.utc))
        if product_id:
            product = str(product_id)
            query = query.where(or_(and_(AuditLog.object_type == "product", AuditLog.object_id == product),
                                    and_(AuditLog.action == "product.attribute_changed",
                                         AuditLog.object_id.startswith(f"{product}:"))))
        if q.strip():
            term = q.strip()
            query = query.where(or_(AuditLog.action.contains(term, autoescape=True),
                                    AuditLog.object_id.contains(term, autoescape=True),
                                    AuditLog.details["error"].astext.contains(term, autoescape=True),
                                    AuditLog.details["rejected_model"].astext.contains(term, autoescape=True)))
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        rows = db.execute(query.outerjoin(User, User.id == AuditLog.user_id)
                          .with_only_columns(AuditLog, User.username)
                          .order_by(AuditLog.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
        job_ids = {row.details.get("job_id") for row, _ in rows if isinstance(row.details, dict)
                   and type(row.details.get("job_id")) is int}
        initiators = _initiators(db, job_ids)
        return {"items": [_event(row, username, initiators.get(row.details.get("job_id"))
                                 if isinstance(row.details, dict) else None) for row, username in rows],
                "total": total, "page": page, "page_size": page_size}

    @router.get("/imports")
    def imports(page: int = Query(default=1, ge=1), page_size: int = Query(default=10, ge=1, le=50),
                db: Session = Depends(get_db)):
        query = select(ImportLog)
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        rows = db.scalars(query.order_by(ImportLog.id.desc()).offset((page - 1) * page_size).limit(page_size))
        return {"items": [{"id": row.id, "source_id": row.source_id, "status": row.status,
                            "expected": row.records_expected, "imported": row.records_imported,
                            "started_at": row.started_at.isoformat(),
                            "finished_at": row.finished_at.isoformat() if row.finished_at else None}
                           for row in rows], "total": total, "page": page, "page_size": page_size}

    @router.get("/jobs")
    def jobs(page: int = Query(default=1, ge=1), page_size: int = Query(default=10, ge=1, le=50),
             db: Session = Depends(get_db)):
        query = select(Job).where(Job.job_type == "property_load")
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        rows = list(db.scalars(query.order_by(Job.id.desc()).offset((page - 1) * page_size).limit(page_size)))
        job_ids = [row.id for row in rows]
        initiators = _initiators(db, job_ids)
        items = list(db.scalars(select(JobItem).where(JobItem.job_id.in_(job_ids)).order_by(JobItem.id))) if job_ids else []
        by_job = {job_id: [] for job_id in job_ids}
        for item in items:
            details = item.details if isinstance(item.details, dict) else {}
            by_job[item.job_id].append({"product_id": item.product_id,
                                        "status": item.status if item.status in ("queued", "running", "completed", "skipped", "failed") else "unknown",
                                        "reason": _safe_reason(details.get("reason")),
                                        "property_count": _safe_count(details.get("property_count"))})
        return {"items": [{"id": row.id, "status": row.status, "total": row.total,
                            "initiated_by": initiators.get(row.id),
                            "completed": row.completed, "skipped": row.skipped, "failed": row.failed,
                            "created_at": row.created_at.isoformat(), "items": by_job[row.id]} for row in rows],
                "total": total, "page": page, "page_size": page_size}

    return router
