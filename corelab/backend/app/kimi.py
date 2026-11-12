"""Moonshot dialogue API adapter and provider selection."""
import logging
import re
import time

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from .models import AIProviderSetting, Organization

KIMI_MODEL_DEFAULT = "kimi-k2.6"
BASE_URL = "https://api.moonshot.ai/v1"
logger = logging.getLogger(__name__)




def active_provider(db, organization_id, *, include_disabled=False):
    # Saving/selecting a provider makes it current; old credentials remain available.
    if not include_disabled and db.scalar(select(Organization.ai_enabled).where(Organization.id == organization_id)) is not True:
        return None
    return db.scalar(select(AIProviderSetting).where(
        AIProviderSetting.organization_id == organization_id,
        AIProviderSetting.provider.in_(["openai", "kimi", "openrouter"]),
    ).order_by(AIProviderSetting.updated_at.desc(), AIProviderSetting.provider).limit(1))


def request(api_key, path, payload=None, method="POST", timeout_seconds=120):
    started_at = time.monotonic()
    try:
        response = httpx.request(method, BASE_URL + path,
                                headers={"Authorization": f"Bearer {api_key}"},
                                json=payload, timeout=httpx.Timeout(timeout_seconds, connect=15))
    except httpx.TimeoutException as exc:
        logger.warning("Kimi request timed out: path=%s elapsed_seconds=%.1f limit_seconds=%s",
                       path, time.monotonic() - started_at, timeout_seconds)
        if path == "/tools/search_pro":
            message = "Kimi Search не завершил поиск за отведённое время"
        else:
            message = "Kimi не завершил генерацию за отведённое время"
        raise HTTPException(504, message) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Не удалось связаться с Kimi") from exc
    if response.status_code >= 400:
        if response.status_code in (401, 403):
            raise HTTPException(422, "Kimi отклонил ключ или доступ к сервису")
        if response.status_code == 429:
            # Do not log raw provider messages: they can contain request data.
            error_code = "unspecified"
            try:
                error = response.json().get("error", {})
                candidate = error.get("type") or error.get("code")
                if candidate in {"rate_limit_reached", "rate_limit_exceeded", "insufficient_quota",
                                 "insufficient_balance", "exceeded_current_quota", "engine_overloaded",
                                 "rate_limit_reached_error", "engine_overloaded_error", "exceeded_current_quota_error"}:
                    error_code = candidate
            except (ValueError, AttributeError, TypeError):
                pass
            retry_after = response.headers.get("Retry-After", "")
            if not re.fullmatch(r"[0-9]{1,5}", retry_after) or int(retry_after) > 86400:
                retry_after = "unspecified"
            logger.warning("Kimi request limited: code=%s retry_after_seconds=%s", error_code, retry_after)
            raise HTTPException(429, "Kimi ограничил запрос: проверьте лимит или баланс",
                                headers={"Retry-After": retry_after} if retry_after != "unspecified" else None)
        raise HTTPException(502, f"Kimi вернул ошибку ({response.status_code})")
    try:
        result = response.json()
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except ValueError as exc:
        raise HTTPException(502, "Kimi вернул некорректный ответ") from exc


def verify_model_access(api_key, model_id):
    result = request(api_key, "/models", method="GET")
    if not any(isinstance(row, dict) and row.get("id") == model_id for row in result.get("data", [])):
        raise HTTPException(422, "Ключ Kimi работает, но указанная модель недоступна аккаунту")
    return True
