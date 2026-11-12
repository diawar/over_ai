"""Organization request budgets shared across sessions, processes and restarts."""
import logging
import secrets
import time

from fastapi import HTTPException
from sqlalchemy import delete, func, select, text

from . import db as database
from .config import get_settings
from .models import AIRequestLease, AIUsageBudget

logger = logging.getLogger(__name__)
LEASE_SECONDS = 600


def acquire(db, organization_id, *, now=None, settings=None):
    stamp = int(time.time() if now is None else now)
    limits = settings or get_settings()
    # Serialize quota decisions for one organization across all backend workers.
    db.execute(text('SELECT pg_advisory_xact_lock(19360, :organization_id)'), {'organization_id': organization_id})
    db.execute(delete(AIRequestLease).where(AIRequestLease.organization_id == organization_id,
                                           AIRequestLease.expires_at <= stamp))
    row = db.get(AIUsageBudget, organization_id)
    minute, day = stamp // 60, stamp // 86400
    minute_count = row.minute_count if row is not None and row.minute == minute else 0
    day_count = row.day_count if row is not None and row.day == day else 0
    def reject(code, retry):
        db.rollback()
        raise HTTPException(429, {'code': code}, headers={'Retry-After': str(max(1, retry))})
    if day_count >= limits.ai_requests_per_day:
        reject('ai_daily_limit', (day + 1) * 86400 - stamp)
    if minute_count >= limits.ai_requests_per_minute:
        reject('ai_rate_limit', (minute + 1) * 60 - stamp)
    active = db.scalar(select(func.count()).select_from(AIRequestLease).where(
        AIRequestLease.organization_id == organization_id, AIRequestLease.expires_at > stamp))
    if active >= limits.ai_max_concurrent:
        reject('ai_concurrency_limit', 5)
    if row is None:
        row = AIUsageBudget(organization_id=organization_id)
        db.add(row)
    row.minute, row.minute_count = minute, minute_count + 1
    row.day, row.day_count = day, day_count + 1
    lease = secrets.token_hex(32)
    db.add(AIRequestLease(id=lease, organization_id=organization_id, expires_at=stamp + LEASE_SECONDS))
    db.commit()
    return lease


def execute(organization_id, generate):
    # Reserve before contacting a paid provider; DB errors fail closed.
    with database.SessionLocal() as db:
        lease = acquire(db, organization_id)
    try:
        return generate()
    finally:
        try:
            with database.SessionLocal() as db:
                db.execute(delete(AIRequestLease).where(AIRequestLease.id == lease,
                                                       AIRequestLease.organization_id == organization_id))
                db.commit()
        except Exception:
            # A crashed/failed release retains its slot until the lease expires.
            logger.error('Could not release AI request lease')
