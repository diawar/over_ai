"""Durable, at-most-once explanation attempts; client disconnect never restarts AI."""
import asyncio
import hashlib
import json
import logging
import time

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from .db import SessionLocal
from .models import AIExplanationReceipt

logger = logging.getLogger(__name__)
_tasks = set()
RUN_LIMIT_SECONDS = 600
RESULT_RETENTION_SECONDS = 7 * 86400


def payload_hash(instructions, turns, schema):
    body = json.dumps([instructions, turns, schema], sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()


def read(db, organization_id, request_id):
    row = db.get(AIExplanationReceipt, (organization_id, request_id))
    if row is None:
        raise HTTPException(404, "Explanation not found")
    age = time.time() - row.started_at
    if row.status == "running" and age > RUN_LIMIT_SECONDS:
        db.execute(update(AIExplanationReceipt).where(
            AIExplanationReceipt.organization_id == organization_id,
            AIExplanationReceipt.request_id == request_id,
            AIExplanationReceipt.status == "running",
        ).values(status="failed", error_code="ai_explanation_interrupted"))
        db.commit()
        db.refresh(row)
    if row.result is not None and age > RESULT_RETENTION_SECONDS:
        row.result, row.status, row.error_code = None, "failed", "ai_explanation_expired"
        db.commit()
    return {"request_id": request_id, "status": row.status,
            **({"result": row.result} if row.status == "completed" else {}),
            **({"error": row.error_code} if row.status == "failed" else {})}


def reserve(db, organization_id, request_id, digest):
    """Unique DB key wins across workers. Existing attempts are never re-executed."""
    existing = db.get(AIExplanationReceipt, (organization_id, request_id))
    if existing is not None:
        if existing.payload_hash != digest:
            raise HTTPException(409, "Explanation request ID was reused with different content")
        return False
    row = AIExplanationReceipt(organization_id=organization_id, request_id=request_id,
        payload_hash=digest, status="running", started_at=int(time.time()))
    db.add(row)
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        existing = db.get(AIExplanationReceipt, (organization_id, request_id))
        if existing is None:
            raise
        if existing.payload_hash != digest:
            raise HTTPException(409, "Explanation request ID was reused with different content") from None
        return False


def execute(organization_id, request_id, generate, session_factory=SessionLocal):
    started = time.monotonic()
    # A queued task may outlive its receipt (shutdown or an exhausted worker pool).
    # Never start billing for an attempt already marked interrupted.
    with session_factory() as db:
        if read(db, organization_id, request_id)["status"] != "running":
            return
    try:
        result = generate()
        status, code = "completed", None
    except HTTPException as exc:
        result, status = None, "failed"
        code = ("ai_invalid_response" if isinstance(exc.detail, dict)
                and exc.detail.get("code") == "ai_invalid_response"
                else f"ai_http_{exc.status_code}" if exc.status_code in (402, 404, 409, 422, 429, 502, 503, 504)
                else "ai_explanation_failed")
    except Exception:
        result, status, code = None, "failed", "ai_explanation_failed"
    with session_factory() as db:
        db.execute(update(AIExplanationReceipt).where(
            AIExplanationReceipt.organization_id == organization_id,
            AIExplanationReceipt.request_id == request_id,
            AIExplanationReceipt.status == "running",
        ).values(status=status, result=result, error_code=code))
        db.commit()
    logger.warning("AI explanation finished: status=%s elapsed_seconds=%.3f", status, time.monotonic() - started)


def start(organization_id, request_id, generate):
    # Strong references prevent collection; the task is independent of the HTTP waiter.
    task = asyncio.create_task(run_in_threadpool(execute, organization_id, request_id, generate))
    _tasks.add(task)
    def finished(task):
        _tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            # A DB failure leaves a tombstone; do not retry a possibly paid call.
            logger.error("AI explanation result persistence failed")
    task.add_done_callback(finished)
